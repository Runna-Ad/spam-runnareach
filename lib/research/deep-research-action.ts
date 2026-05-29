"use server";

/**
 * Deep Research — Brave web intel + Claude-sonnet synthesis.
 *
 * Gathers external signals about a prospect (website scrape + Brave
 * search snippets) and feeds them to Claude with Pedro's research
 * prompt.  Claude returns a structured 5-section analysis that maps
 * directly into our DB fields:
 *
 *   COMPANY SNAPSHOT    → what_they_do, tech_stack hints
 *   TOP 5 PAIN POINTS   → pain_points (JSONB)
 *   TOP 3 OPPORTUNITIES → notes (appended section)
 *   ELEVATOR PITCH HOOK → notes (appended section)
 *   WHO TO CONTACT      → prospect_contacts
 *
 * After saving, auto-runs scoreProspect() so the score reflects the
 * enriched data immediately.
 *
 * Cost estimate: ~$0.003 Brave + ~$0.02 Claude-sonnet ≈ $0.023/prospect.
 */

import { revalidatePath } from "next/cache";
import Anthropic from "@anthropic-ai/sdk";
import { requireUser } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { claudeIsAvailable, ANTHROPIC_DEFAULT_MODEL, computeCostUsd } from "@/lib/anthropic/client";
import { scrapeSite } from "./scraper";
import { scoreProspect } from "./score-action";
import { searchBrave, braveIsAvailable } from "@/lib/discover/sources/brave-search";
import { buildDeepResearchPrompt, type TaxonomyEntry } from "./deep-research-prompt";

// ── Types ─────────────────────────────────────────────────────────────────────

export type DeepResearchResult =
  | {
      ok: true;
      score: number;
      outcome: "pitched_ready" | "needs_review" | "low_score";
      what_they_do: string | null;
      pain_points_added: number;
      contact_found: string | null;
      cost_usd: number;
      raw_response: string; // full Claude text for transparency
    }
  | { ok: false; error: string };

// ── Entry point ───────────────────────────────────────────────────────────────

export async function deepResearchProspect(
  prospectId: string,
): Promise<DeepResearchResult> {
  if (!claudeIsAvailable()) {
    return { ok: false, error: "ANTHROPIC_API_KEY not set — deep research requires Claude." };
  }

  const user = await requireUser();
  if (user.role === "viewer") return { ok: false, error: "Viewers cannot run deep research." };

  const supabase = await createClient();

  // Load prospect
  type ProspectRow = {
    id: string;
    company_name: string;
    website_url: string | null;
    domain: string | null;
  };
  const { data: prospect, error: pErr } = await supabase
    .from("prospects")
    .select("id, company_name, website_url, domain")
    .eq("id", prospectId)
    .eq("tenant_id", user.tenantId)
    .maybeSingle<ProspectRow>();

  if (pErr || !prospect) return { ok: false, error: pErr?.message ?? "Prospect not found." };

  const targetUrl =
    prospect.website_url ??
    (prospect.domain ? `https://${prospect.domain}` : null);

  if (!targetUrl) {
    return { ok: false, error: "Prospect has no URL or domain. Add one in Overview first." };
  }

  // ── Step 1: Multi-page website scrape ────────────────────────────────────
  let scrapedContext = "";
  const scrapeResult = await scrapeSite(targetUrl);
  if (scrapeResult.ok) {
    const s = scrapeResult.site;
    const parts: string[] = [];
    if (s.what_they_do) parts.push(`What they do: ${s.what_they_do}`);
    if (s.tech_stack.length > 0) parts.push(`Tech stack detected: ${s.tech_stack.join(", ")}`);
    for (const sp of s.sub_page_extracts) {
      parts.push(`[${sp.label} page]: ${sp.text}`);
    }
    scrapedContext = parts.join("\n\n");
  }

  // ── Step 2: Brave intel (3 targeted queries) ─────────────────────────────
  const braveSnippets: string[] = [];
  if (braveIsAvailable()) {
    const queries = [
      `"${prospect.company_name}" reviews`,
      `"${prospect.company_name}" problems OR complaints`,
      `"${prospect.company_name}" instagram OR linkedin`,
    ];

    for (const q of queries) {
      const r = await searchBrave({ query: q, count: 5 });
      if (r.ok) {
        for (const listing of r.listings.slice(0, 3)) {
          if (listing.description) {
            braveSnippets.push(`[${listing.company_name}] ${listing.description}`);
          }
        }
      }
    }
  }

  // ── Step 3: Build context block (capped at 6,000 chars) ──────────────────
  const contextParts: string[] = [];
  if (scrapedContext) contextParts.push(`=== WEBSITE CONTENT ===\n${scrapedContext}`);
  if (braveSnippets.length > 0) {
    contextParts.push(`=== WEB INTEL (reviews & social signals) ===\n${braveSnippets.join("\n")}`);
  }
  const contextBlock = contextParts.join("\n\n").slice(0, 6_000);

  // ── Step 4a: Load pain taxonomy so Claude can tag pains directly ────────
  type TaxRow = { id: string; display_name_en: string };
  const { data: taxonomy } = await supabase
    .from("pain_taxonomy")
    .select("id, display_name_en")
    .eq("tenant_id", user.tenantId)
    .eq("is_active", true)
    .returns<TaxRow[]>();
  const taxonomyEntries: TaxonomyEntry[] = taxonomy ?? [];

  // ── Step 4b: Call Claude-sonnet ──────────────────────────────────────────
  const basePrompt = buildDeepResearchPrompt(prospect.company_name, targetUrl, taxonomyEntries);
  const fullPrompt = contextBlock
    ? `${basePrompt}\n\n--- RESEARCH CONTEXT (gathered automatically) ---\n${contextBlock}`
    : basePrompt;

  let rawResponse = "";
  let costUsd = 0;

  try {
    const client = new Anthropic();
    const msg = await client.messages.create({
      model: ANTHROPIC_DEFAULT_MODEL,
      max_tokens: 1_200,
      messages: [{ role: "user", content: fullPrompt }],
    });
    rawResponse = msg.content
      .filter((b) => b.type === "text")
      .map((b) => (b as { type: "text"; text: string }).text)
      .join("");
    costUsd = computeCostUsd(ANTHROPIC_DEFAULT_MODEL, msg.usage.input_tokens, msg.usage.output_tokens);
  } catch (err) {
    return {
      ok: false,
      error: `Claude call failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  // ── Step 5: Parse the 5 sections ─────────────────────────────────────────
  const parsed = parseDeepResearchResponse(rawResponse);

  // ── Step 6: Map pain points → DB format ──────────────────────────────────
  // Claude tagged each pain with [ID: <canonical_id>] — extract directly.
  // Validate the ID exists in the taxonomy we passed to avoid hallucinated IDs.
  const taxonomyIds = new Set(taxonomyEntries.map((t) => t.id));
  const painPoints = parsed.painPoints.map(({ pain_id, label, evidence_quote }) => {
    const validId = pain_id && taxonomyIds.has(pain_id) ? pain_id : null;
    const canonicalLabel =
      validId
        ? (taxonomyEntries.find((t) => t.id === validId)?.display_name_en ?? label)
        : label;
    return {
      pain_id: validId,
      pain_label: canonicalLabel,
      // Only keep real quotes from scraped source text.
      // Recycling the pain label as a fake quote (old behaviour: label.slice(0,240))
      // was a silent data-quality bug — fabricated "quotes" slipped through scoring
      // and into pitches. Now: no quote → evidence_quote stays null, confidence drops.
      // Pains with null evidence_quote are filtered at the scoring + pitch gate.
      evidence_quote: evidence_quote ?? null,
      confidence: evidence_quote ? 0.7 : 0.5, // no quote = lower confidence, filtered at gate
    };
  });

  // ── Step 8: Merge what_they_do + notes ───────────────────────────────────
  const whatTheyDo = parsed.snapshot
    ? parsed.snapshot.slice(0, 500)
    : null;

  const notesAddendum = [
    parsed.opportunities.length > 0
      ? `[Deep Research — Opportunities]\n${parsed.opportunities.join("\n")}`
      : null,
    parsed.pitchHook
      ? `[Deep Research — Pitch Hook]\n${parsed.pitchHook}`
      : null,
  ]
    .filter(Boolean)
    .join("\n\n");

  // ── Step 9: Upsert prospect_research ────────────────────────────────────
  type ResearchRow = {
    id: string;
    what_they_do: string | null;
    notes: string | null;
    pain_points: unknown;
    tech_stack: string[];
  };
  const { data: existing } = await supabase
    .from("prospect_research")
    .select("id, what_they_do, notes, pain_points, tech_stack")
    .eq("tenant_id", user.tenantId)
    .eq("prospect_id", prospectId)
    .maybeSingle<ResearchRow>();

  const existingNotes = existing?.notes ?? null;
  const mergedNotes = existingNotes
    ? `${existingNotes}\n\n${notesAddendum}`.trim()
    : notesAddendum || null;

  // Merge tech stack hints from snapshot
  const existingTech: string[] = existing?.tech_stack ?? [];
  const mergedTech = scrapeResult.ok
    ? [...new Set([...existingTech, ...scrapeResult.site.tech_stack])]
    : existingTech;

  if (existing) {
    await supabase
      .from("prospect_research")
      .update({
        what_they_do: whatTheyDo ?? existing.what_they_do,
        notes: mergedNotes,
        pain_points: painPoints,
        tech_stack: mergedTech,
        research_method: "claude_assisted",
        last_scraped_at: new Date().toISOString(),
        last_edited_by_user_id: user.id,
        updated_at: new Date().toISOString(),
      })
      .eq("id", existing.id);
  } else {
    await supabase.from("prospect_research").insert({
      tenant_id: user.tenantId,
      prospect_id: prospectId,
      what_they_do: whatTheyDo,
      notes: mergedNotes,
      pain_points: painPoints,
      tech_stack: mergedTech,
      evidence_urls: [targetUrl],
      research_method: "claude_assisted",
      last_scraped_at: new Date().toISOString(),
      last_edited_by_user_id: user.id,
    });
  }

  // ── Step 10: Save contact if found ───────────────────────────────────────
  let contactFound: string | null = null;
  if (parsed.contactLine) {
    const { name, title } = parseContactLine(parsed.contactLine);
    // Sanitize: reject guidance/suggestion text that Claude stuffs into title
    // (e.g. "Not publicly listed; reach out to..." or "check LinkedIn for...")
    const guidancePattern = /not publicly|reach out|check linkedin|via linkedin|target\s+\w+\s+director/i;
    const cleanTitle = title && !guidancePattern.test(title) && title.length < 80 ? title : null;
    // Only insert if we have a real name — no-name + no-email rows are useless
    if (name) {
      contactFound = [name, cleanTitle].filter(Boolean).join(", ");
      // Insert name+title contact (no email yet — SnapVerify/Anymail/Hunter add email later).
      // Ignore duplicate errors (23505) — contact may already exist.
      const { error: contactErr } = await supabase.from("prospect_contacts").insert({
        tenant_id: user.tenantId,
        prospect_id: prospectId,
        full_name: name,
        role_title: cleanTitle,
        priority_rank: 2, // lower priority than confirmed email contacts
      });
      if (contactErr && contactErr.code !== "23505") {
        console.warn("[deep-research] Could not save contact:", contactErr.message);
      }
    }
  }

  // ── Step 11: Auto-score ───────────────────────────────────────────────────
  const scoreResult = await scoreProspect(prospectId);
  const score = scoreResult.ok ? scoreResult.composite_score : 0;

  const outcome =
    score >= 70 ? "pitched_ready" : score >= 40 ? "needs_review" : "low_score";

  revalidatePath(`/companies/${prospectId}`);
  revalidatePath("/companies");

  return {
    ok: true,
    score,
    outcome,
    what_they_do: whatTheyDo,
    pain_points_added: painPoints.length,
    contact_found: contactFound,
    cost_usd: costUsd,
    raw_response: rawResponse,
  };
}

// ── Response parsers ──────────────────────────────────────────────────────────

type ParsedResearch = {
  snapshot: string | null;
  painPoints: { pain_id: string | null; label: string; evidence_quote: string | null }[];
  opportunities: string[];
  pitchHook: string | null;
  contactLine: string | null;
};

function parseDeepResearchResponse(text: string): ParsedResearch {
  // Split on the bold section headers
  const sectionPattern =
    /\*\*(COMPANY SNAPSHOT|TOP 5 PAIN POINTS|TOP 3 OPPORTUNITIES FOR US|ELEVATOR PITCH HOOK|WHO TO CONTACT)\*\*/gi;

  const sections: Record<string, string> = {};
  const parts = text.split(sectionPattern);

  // parts alternates: [pre-match, header, content, header, content, ...]
  for (let i = 1; i < parts.length - 1; i += 2) {
    const header = (parts[i] ?? "").toUpperCase().trim();
    const content = (parts[i + 1] ?? "").trim();
    sections[header] = content;
  }

  // Extract snapshot (first paragraph, ~3 lines)
  const snapshotRaw = sections["COMPANY SNAPSHOT"] ?? "";
  const snapshotLines = snapshotRaw
    .split("\n")
    .map((l) => l.replace(/^[-•*]\s*/, "").trim())
    .filter(Boolean);
  const snapshot = snapshotLines.slice(0, 3).join(" ").slice(0, 500) || null;

  // Extract top 5 pain points — parse [ID: <id>] tags + | Evidence: "..." Claude writes.
  // Falls back gracefully to plain text if Claude doesn't follow the format.
  const painRaw = sections["TOP 5 PAIN POINTS"] ?? "";
  const painPoints = painRaw
    .split("\n")
    .map((l) => l.replace(/^\d+\.\s*|-\s*|\*\s*/, "").trim())
    .filter((l) => l.length > 5)
    .slice(0, 5)
    .map((l) => {
      const idMatch = l.match(/^\[ID:\s*([^\]]+)\]/i);
      const pain_id = idMatch ? (idMatch[1] ?? "").trim() : null;
      const withoutId = l.replace(/^\[ID:\s*[^\]]+\]\s*/i, "").trim();

      // Split on | Evidence: to extract the real quote
      const evidenceSepIdx = withoutId.search(/\|\s*Evidence:\s*/i);
      let label: string;
      let evidence_quote: string | null;

      if (evidenceSepIdx !== -1) {
        label = withoutId.slice(0, evidenceSepIdx).trim();
        const rawEvidence = withoutId.slice(evidenceSepIdx).replace(/^\|\s*Evidence:\s*/i, "").trim();
        // Strip surrounding quotes if Claude wrapped the quote in "..."
        const stripped = rawEvidence.replace(/^["']|["']$/g, "").trim();
        // If it's the "(inferred)" fallback, store null so the pitch generator knows there's no real quote
        evidence_quote =
          stripped.toLowerCase().startsWith("(inferred") || stripped.length < 5
            ? null
            : stripped.slice(0, 240);
      } else {
        label = withoutId;
        evidence_quote = null;
      }

      return { pain_id: pain_id === "none" ? null : pain_id, label, evidence_quote };
    });

  // Extract top 3 opportunities
  const oppRaw = sections["TOP 3 OPPORTUNITIES FOR US"] ?? "";
  const opportunities = oppRaw
    .split("\n")
    .map((l) => l.replace(/^\d+\.\s*|-\s*|\*\s*/, "").trim())
    .filter((l) => l.length > 5)
    .slice(0, 3);

  // Extract pitch hook (paragraph)
  const hookRaw = sections["ELEVATOR PITCH HOOK"] ?? "";
  const pitchHook = hookRaw.trim().slice(0, 600) || null;

  // Extract contact line (single line)
  const contactRaw = sections["WHO TO CONTACT"] ?? "";
  const contactLine =
    contactRaw
      .split("\n")
      .find((l) => l.trim().length > 3)
      ?.trim() ?? null;

  return { snapshot, painPoints, opportunities, pitchHook, contactLine };
}

/** Parse "John Smith, CEO" or "Sarah Lee — Head of Marketing" */
function parseContactLine(line: string): { name: string | null; title: string | null } {
  // Remove leading bullets/dashes
  const clean = line.replace(/^[-•*]\s*/, "").trim();

  // Try "Name, Title" or "Name — Title" or "Name - Title"
  const separators = [",", "—", "–", " - "];
  for (const sep of separators) {
    const idx = clean.indexOf(sep);
    if (idx > 2 && idx < clean.length - 2) {
      const name = clean.slice(0, idx).trim();
      const title = clean.slice(idx + sep.length).trim();
      // Basic sanity: name should look like a name (no special chars)
      if (/^[A-Za-zÀ-ÿ\s.'-]{2,50}$/.test(name)) {
        return { name, title: title.slice(0, 100) };
      }
    }
  }

  // Fallback: treat whole line as title (e.g., "CEO / founder")
  return { name: null, title: clean.slice(0, 100) };
}
