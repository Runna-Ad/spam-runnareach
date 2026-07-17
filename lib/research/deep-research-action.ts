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
import { requireUser } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import {
  claudeIsAvailable,
  getClient,
  ANTHROPIC_DEFAULT_MODEL,
  computeCostUsd,
} from "@/lib/anthropic/client";
import { isUnderDailyCap, recordClaudeCall } from "@/lib/anthropic/cost-tracking";
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
  options?: { skipScore?: boolean },
): Promise<DeepResearchResult> {
  if (!claudeIsAvailable()) {
    return { ok: false, error: "ANTHROPIC_API_KEY not set — deep research requires Claude." };
  }

  const user = await requireUser();
  if (user.role === "viewer") return { ok: false, error: "Viewers cannot run deep research." };

  // Daily-cap safety net. Deep research (scrape + 4 Brave queries + a Sonnet
  // call) was previously invisible to the cap; gate it here so we skip the
  // whole expensive chain when the tenant is over budget. The pipeline
  // try/catches this and continues on already-scraped data.
  const cap = await isUnderDailyCap(user.tenantId);
  if (!cap.under) {
    return {
      ok: false,
      error: `Daily Anthropic cap reached ($${cap.spent_today_usd.toFixed(2)} of $${cap.cap_usd}).`,
    };
  }

  const supabase = await createClient();

  // Load prospect
  type ProspectRow = {
    id: string;
    company_name: string;
    website_url: string | null;
    domain: string | null;
    status: string;
    city: string | null;
  };
  const { data: prospect, error: pErr } = await supabase
    .from("prospects")
    .select("id, company_name, website_url, domain, status, city")
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

  // ── Step 2: Brave intel (4 targeted queries, including people-intel) ───────
  const braveSnippets: string[] = [];
  const peopleSnippets: string[] = []; // kept separate so we can write to notes explicitly
  if (braveIsAvailable()) {
    // Disambiguate with city (or domain) — a bare name query returns snippets
    // about same-named businesses anywhere in the world, and those snippets
    // become quotable "evidence" about the WRONG company.
    const disambig = prospect.city ?? prospect.domain ?? "";
    const scope = disambig ? ` ${disambig}` : "";
    const queries = [
      `"${prospect.company_name}"${scope} reviews`,
      `"${prospect.company_name}"${scope} problems OR complaints`,
      `"${prospect.company_name}"${scope} instagram OR linkedin`,
      // People-intel: find founders/owners/decision-makers by name
      `"${prospect.company_name}"${scope} founder OR owner OR CEO OR "co-founder" OR director`,
    ];

    for (const q of queries) {
      const r = await searchBrave({ query: q, count: 5 });
      if (r.ok) {
        for (const listing of r.listings.slice(0, 3)) {
          if (listing.description) {
            const snippet = `[${listing.company_name}] ${listing.description}`;
            braveSnippets.push(snippet);
            // Flag people-intel snippets separately (last query)
            if (q.includes("founder OR owner")) peopleSnippets.push(snippet);
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

  // No gathered context at all (scrape failed AND Brave returned nothing) —
  // do NOT call the model. The prompt reads "search their website, reviews…"
  // but the model has no web access, so with an empty context it confabulates
  // a plausible company snapshot that then flows into pitches as "facts".
  if (!contextBlock.trim()) {
    return {
      ok: false,
      error:
        "No research material could be gathered (site unreachable, no web results) — skipping AI synthesis to avoid invented facts.",
    };
  }

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
    const client = getClient();
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
    // Record to cost_tracking so the daily cap accounts for deep research —
    // previously this (one Sonnet call per prospect) was entirely uncapped.
    await recordClaudeCall({
      tenantId: user.tenantId,
      model: ANTHROPIC_DEFAULT_MODEL,
      entity_type: "research",
      entity_id: prospectId,
      usage: {
        input_tokens: msg.usage.input_tokens,
        output_tokens: msg.usage.output_tokens,
        cache_read_input_tokens: msg.usage.cache_read_input_tokens ?? 0,
        cache_creation_input_tokens: msg.usage.cache_creation_input_tokens ?? 0,
        cost_usd: costUsd,
      },
    });
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

  // Build a structured people block so SnapVerify's Claude Haiku can reliably
  // extract named decision-makers. Two sources:
  //   1. The WHO TO CONTACT line Claude extracted from research
  //   2. Raw people-intel Brave snippets (founder/CEO/owner search)
  const peopleBlockLines: string[] = [];
  if (parsed.contactLine) {
    const { name, title } = parseContactLine(parsed.contactLine);
    const guidancePattern = /not publicly|reach out|check linkedin|via linkedin/i;
    if (name && !guidancePattern.test(parsed.contactLine)) {
      peopleBlockLines.push(`Name: ${name}${title ? ` / Role: ${title}` : ""}`);
    }
  }
  // Add any people-intel Brave snippets that mention a real name pattern
  for (const snippet of peopleSnippets.slice(0, 3)) {
    peopleBlockLines.push(snippet);
  }
  const peopleBlock =
    peopleBlockLines.length > 0
      ? `[Decision Makers — for contact enrichment]\n${peopleBlockLines.join("\n")}`
      : null;

  const notesAddendum = [
    peopleBlock,
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
  // Skipped in pipeline context (skipScore) — processSingleProspect scores
  // AGAIN right after this on the same enriched data (pain extraction runs in
  // between), so this internal re-score was pure waste: computed, then
  // immediately overwritten. Standalone UI callers keep it (default) so the
  // "deep research this prospect" button stays self-contained.
  let score = 0;
  let outcome: "pitched_ready" | "needs_review" | "low_score" = "needs_review";
  if (!options?.skipScore) {
    const scoreResult = await scoreProspect(prospectId);
    score = scoreResult.ok ? scoreResult.composite_score : 0;
    outcome =
      score >= 70 ? "pitched_ready" : score >= 40 ? "needs_review" : "low_score";

    // ── Step 12: Apply the same triage as the full pipeline ─────────────────
    // A standalone deep-research re-score must honor the <40 → suppress gate,
    // just like processSingleProspect does. Otherwise a prospect that drops to
    // e.g. 28 here stays visible in the active list with a failing score. We
    // only suppress (never un-suppress or downgrade a manually-advanced status)
    // — and only from the early funnel states, so we don't yank a replied/
    // booked/won prospect.
    const SUPPRESSIBLE = new Set(["raw", "researched", "needs_review"]);
    if (score < 40 && SUPPRESSIBLE.has(prospect.status)) {
      await supabase
        .from("prospects")
        .update({
          status: "suppressed",
          suppressed_reason: `Auto: deep-research score ${score} below threshold`,
          suppressed_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        })
        .eq("id", prospectId)
        .eq("tenant_id", user.tenantId);
    }
  }

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
