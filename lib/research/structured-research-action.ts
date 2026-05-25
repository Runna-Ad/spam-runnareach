"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { ANTHROPIC_DEFAULT_MODEL, claudeIsAvailable } from "@/lib/anthropic/client";
import { isUnderDailyCap, recordClaudeCall } from "@/lib/anthropic/cost-tracking";
import { writeAuditLog } from "@/lib/audit/log";
import { requireUser } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import type { Database } from "@/lib/supabase/types";
import { runResearchWithClaude } from "./claude-research";

const inputSchema = z.object({
  prospect_id: z.string().uuid(),
});

export type StructuredResearchResult =
  | {
      ok: true;
      method: "heuristic" | "claude";
      pain_points_added: number;
      contacts_added: number;
      reasoning: string;
    }
  | { ok: false; error: string };

type PainPoint = {
  pain_id?: string;
  pain_label?: string;
  evidence_quote?: string;
  evidence_url?: string;
  confidence?: number;
};

type PainOption = {
  id: string;
  code: string;
  display_name: string;
  evidence_phrases: string[];
};

/**
 * Heuristic structured-research action. Reads scraped notes + research
 * editor state, classifies pain points against the pain_taxonomy via
 * `evidence_phrases_en` substring matching, and stubs a decision-maker
 * by extracting the best contact email from the scraper's notes.
 *
 * The output shape (cleanedPainPoints, decisionMakerEmail) is exactly
 * what Phase-2 Claude will return — when ANTHROPIC_API_KEY is funded
 * we swap the body to call Claude with the same inputs and parse a
 * JSON response into the same shape, and nothing else changes.
 *
 * Side effects:
 *   1. Merges new pain_points into prospect_research.pain_points
 *      (preserves any existing pains; dedupes by pain_id)
 *   2. Upserts a row in prospect_contacts for the chosen email
 *      (priority_rank = 1 for non-role-based, 5 for role-based)
 *   3. audit_log: prospect.research_structured
 *   4. revalidates the prospect page
 */
export async function runStructuredResearch(
  prospectId: string,
): Promise<StructuredResearchResult> {
  const user = await requireUser();
  if (user.role === "viewer") {
    return { ok: false, error: "Viewers cannot run research." };
  }

  const parsed = inputSchema.safeParse({ prospect_id: prospectId });
  if (!parsed.success) return { ok: false, error: "Invalid prospect id." };

  const supabase = await createClient();

  // ── Load research (need it to even attempt classification) ────────────
  type ResearchRow = {
    id: string;
    what_they_do: string | null;
    pain_points: unknown;
    notes: string | null;
  };
  const { data: research, error: researchErr } = await supabase
    .from("prospect_research")
    .select("id, what_they_do, pain_points, notes")
    .eq("tenant_id", user.tenantId)
    .eq("prospect_id", parsed.data.prospect_id)
    .maybeSingle<ResearchRow>();

  if (researchErr) {
    if (researchErr.code === "42P01" || researchErr.code === "PGRST205") {
      return {
        ok: false,
        error:
          "Research table not found. Run migration 0004_prospect_research.sql first.",
      };
    }
    return { ok: false, error: `Lookup failed: ${researchErr.message}` };
  }
  if (!research) {
    return {
      ok: false,
      error: "Scrape the website first — there's nothing to classify yet.",
    };
  }

  // ── Load pain taxonomy for matching ───────────────────────────────────
  type TaxRow = {
    id: string;
    code: string;
    display_name_en: string;
    evidence_phrases_en: string[];
  };
  const { data: taxonomy, error: taxErr } = await supabase
    .from("pain_taxonomy")
    .select("id, code, display_name_en, evidence_phrases_en")
    .eq("tenant_id", user.tenantId)
    .eq("is_active", true)
    .returns<TaxRow[]>();

  if (taxErr) return { ok: false, error: `Lookup failed: ${taxErr.message}` };

  const options: PainOption[] = (taxonomy ?? []).map((t) => ({
    id: t.id,
    code: t.code,
    display_name: t.display_name_en,
    evidence_phrases: t.evidence_phrases_en ?? [],
  }));

  if (options.length === 0) {
    return {
      ok: false,
      error: "Pain taxonomy is empty. Seed it via supabase/seed.sql first.",
    };
  }

  const existingPains = normalizePainPoints(research.pain_points);

  // ── PHASE 2: try Claude first, fall back to heuristic ────────────────
  // Claude (Sonnet) does semantic pain classification — far better than
  // substring matching when the research talks around the problem.
  // Any failure (auth, rate-limit, parse, cap, hallucinated pain_id)
  // falls through to the deterministic heuristic so the user always
  // gets a result.
  const haystack = [research.what_they_do ?? "", research.notes ?? ""]
    .join("\n")
    .trim();

  let newPains: PainPoint[] = [];
  let decisionMakerEmail: string | null = null;
  let method: "heuristic" | "claude" = "heuristic";
  let claudeFallbackReason: string | null = null;
  let claudeReasoning: string | null = null;
  let claudeCostUsd: number | null = null;

  if (claudeIsAvailable() && haystack) {
    const cap = await isUnderDailyCap(user.tenantId);
    if (!cap.under) {
      claudeFallbackReason = `daily cap hit (spent $${cap.spent_today_usd.toFixed(2)} of $${cap.cap_usd.toFixed(2)})`;
    } else {
      const claudeResult = await runResearchWithClaude({
        what_they_do: research.what_they_do,
        notes: research.notes,
        options,
        existingPainIds: existingPains
          .map((p) => p.pain_id)
          .filter((id): id is string => Boolean(id)),
      });
      if (claudeResult.ok) {
        newPains = claudeResult.result.pain_points.map((p) => ({
          pain_id: p.pain_id,
          pain_label: p.pain_label,
          evidence_quote: p.evidence_quote,
          confidence: p.confidence,
        }));
        decisionMakerEmail = claudeResult.result.decision_maker_email;
        method = "claude";
        claudeReasoning = claudeResult.result.reasoning;
        claudeCostUsd = claudeResult.result.usage.cost_usd;
        await recordClaudeCall({
          tenantId: user.tenantId,
          model: ANTHROPIC_DEFAULT_MODEL,
          entity_type: "research",
          entity_id: parsed.data.prospect_id,
          usage: claudeResult.result.usage,
          metadata: {
            prospect_id: parsed.data.prospect_id,
            pain_count: claudeResult.result.pain_points.length,
            picked_email: claudeResult.result.decision_maker_email,
          },
        });
      } else {
        claudeFallbackReason = `${claudeResult.reason}: ${claudeResult.error.slice(0, 200)}`;
        if (claudeResult.usage) {
          await recordClaudeCall({
            tenantId: user.tenantId,
            model: ANTHROPIC_DEFAULT_MODEL,
            entity_type: "research",
            entity_id: parsed.data.prospect_id,
            usage: claudeResult.usage,
            metadata: {
              prospect_id: parsed.data.prospect_id,
              fallback_reason: claudeResult.reason,
            },
          });
        }
      }
    }
  } else if (!claudeIsAvailable()) {
    claudeFallbackReason = "ANTHROPIC_API_KEY not set";
  }

  if (method === "heuristic") {
    newPains = haystack
      ? classifyPainsHeuristic(haystack, options, existingPains)
      : [];
    decisionMakerEmail = research.notes
      ? pickDecisionMakerEmail(research.notes)
      : null;
  }

  // ── Merge pain points back into research row ──────────────────────────
  const mergedPains: PainPoint[] = [...existingPains, ...newPains];
  if (newPains.length > 0) {
    const { error: updErr } = await supabase
      .from("prospect_research")
      .update({
        pain_points: mergedPains as unknown as object[],
        last_edited_by_user_id: user.id,
      } as never)
      .eq("id", research.id);
    if (updErr) {
      return { ok: false, error: `Could not save pains: ${updErr.message}` };
    }
  }

  // ── Decision-maker contact upsert ─────────────────────────────────────
  let contactsAdded = 0;
  if (decisionMakerEmail) {
    const isRoleBased = isRoleBasedEmail(decisionMakerEmail);
    type ContactInsert =
      Database["public"]["Tables"]["prospect_contacts"]["Insert"];
    const insertPayload: ContactInsert = {
      tenant_id: user.tenantId,
      prospect_id: parsed.data.prospect_id,
      email: decisionMakerEmail.toLowerCase(),
      email_is_role_based: isRoleBased,
      priority_rank: isRoleBased ? 5 : 1,
      selected_at: new Date().toISOString(),
      selected_by: "engine",
    };
    // Idempotent: unique index is (tenant_id, email) where email is not null.
    // Use upsert via insert-then-handle-conflict.
    const { error: contactErr } = await supabase
      .from("prospect_contacts")
      .insert(insertPayload as never);
    if (contactErr) {
      // 23505 = unique violation (email already exists for this tenant);
      // that's fine — means we previously selected it.
      if (contactErr.code !== "23505") {
        return {
          ok: false,
          error: `Could not save contact: ${contactErr.message}`,
        };
      }
    } else {
      contactsAdded = 1;
    }
  }

  // ── Audit ─────────────────────────────────────────────────────────────
  await writeAuditLog({
    tenantId: user.tenantId,
    actorId: user.id,
    action: "prospect.scored", // reuse closest existing action; Phase 2 adds a dedicated one
    entityType: "prospect",
    entityId: parsed.data.prospect_id,
    metadata: {
      kind: "structured_research",
      method,
      pain_points_added: newPains.length,
      contacts_added: contactsAdded,
      claude_fallback_reason: claudeFallbackReason,
      claude_cost_usd: claudeCostUsd,
      claude_reasoning: claudeReasoning?.slice(0, 300) ?? null,
    },
  });

  revalidatePath(`/companies/${parsed.data.prospect_id}`);

  const reasoning = buildReasoning(
    newPains,
    decisionMakerEmail,
    contactsAdded,
    method,
    claudeReasoning,
  );
  return {
    ok: true,
    method,
    pain_points_added: newPains.length,
    contacts_added: contactsAdded,
    reasoning,
  };
}

/**
 * Substring-match each canonical pain's evidence_phrases against the
 * research haystack. For each match, capture a short evidence_quote
 * (the sentence containing the matched phrase).
 */
function classifyPainsHeuristic(
  haystack: string,
  options: PainOption[],
  existingPains: PainPoint[],
): PainPoint[] {
  const lowerHay = haystack.toLowerCase();
  const seenIds = new Set(existingPains.map((p) => p.pain_id).filter(Boolean));
  const out: PainPoint[] = [];

  for (const opt of options) {
    if (seenIds.has(opt.id)) continue;
    let matchedPhrase: string | null = null;
    for (const phrase of opt.evidence_phrases) {
      if (lowerHay.includes(phrase.toLowerCase())) {
        matchedPhrase = phrase;
        break;
      }
    }
    if (!matchedPhrase) continue;
    const quote = extractEvidenceQuote(haystack, matchedPhrase);
    out.push({
      pain_id: opt.id,
      pain_label: opt.display_name,
      evidence_quote: quote,
      confidence: 0.6, // conservative — heuristic substring match
    });
  }

  return out;
}

/**
 * Return the sentence containing the matched phrase, capped at 240 chars.
 * If we can't find a sentence boundary, return the surrounding 60 chars.
 */
function extractEvidenceQuote(haystack: string, phrase: string): string {
  const lowerHay = haystack.toLowerCase();
  const lowerPhrase = phrase.toLowerCase();
  const idx = lowerHay.indexOf(lowerPhrase);
  if (idx === -1) return phrase;

  // Find sentence boundaries (. ! ? or newline) before/after the match.
  const lookback = 200;
  const lookahead = 200;
  const start = Math.max(0, idx - lookback);
  const end = Math.min(haystack.length, idx + phrase.length + lookahead);
  const window = haystack.slice(start, end);

  // Trim to nearest sentence boundary on each side.
  const sentenceStartMatch = window.match(/[.!?\n][^.!?\n]*$/);
  const left = sentenceStartMatch ? sentenceStartMatch[0].replace(/^[.!?\n]\s*/, "") : window;
  const sentenceEndMatch = left.match(/^([^.!?\n]+[.!?])/);
  const sentence = (sentenceEndMatch ? sentenceEndMatch[1] : left) ?? "";
  return sentence.trim().slice(0, 240);
}

/**
 * The scraper writes a "Contact emails: a@x, b@x, ..." line into notes.
 * Pull the first non-role-based one; fall back to the first role-based.
 * Returns null if nothing parseable.
 */
function pickDecisionMakerEmail(notes: string): string | null {
  const line = notes
    .split("\n")
    .find((l) => /^contact emails:/i.test(l.trim()));
  if (!line) return null;
  const list = line.replace(/^contact emails:\s*/i, "");
  const candidates = list
    .split(/[,\s]+/)
    .map((s) => s.trim().toLowerCase())
    .filter((s) => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(s));
  if (candidates.length === 0) return null;

  const nonRole = candidates.find((c) => !isRoleBasedEmail(c));
  return nonRole ?? candidates[0] ?? null;
}

function isRoleBasedEmail(email: string): boolean {
  const local = email.split("@")[0];
  if (!local) return true;
  const lower = local.toLowerCase();
  return [
    "info",
    "hello",
    "contact",
    "sales",
    "support",
    "admin",
    "team",
    "office",
    "hi",
    "hey",
    "marketing",
    "press",
    "media",
    "billing",
  ].includes(lower);
}

function normalizePainPoints(raw: unknown): PainPoint[] {
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((entry) => {
    if (!entry || typeof entry !== "object") return [];
    const e = entry as Record<string, unknown>;
    const out: PainPoint = {};
    if (typeof e.pain_id === "string") out.pain_id = e.pain_id;
    if (typeof e.pain_label === "string") out.pain_label = e.pain_label;
    if (typeof e.evidence_quote === "string") out.evidence_quote = e.evidence_quote;
    if (typeof e.evidence_url === "string") out.evidence_url = e.evidence_url;
    if (typeof e.confidence === "number") out.confidence = e.confidence;
    return Object.keys(out).length > 0 ? [out] : [];
  });
}

function buildReasoning(
  newPains: PainPoint[],
  email: string | null,
  contactsAdded: number,
  method: "heuristic" | "claude",
  claudeReasoning: string | null,
): string {
  const parts: string[] = [];
  if (newPains.length > 0) {
    parts.push(
      `Classified ${newPains.length} pain point${newPains.length === 1 ? "" : "s"}: ${newPains.map((p) => p.pain_label).join(", ")}.`,
    );
  } else {
    parts.push("No new pain points matched the taxonomy from current research.");
  }
  if (email) {
    parts.push(
      contactsAdded > 0
        ? `Selected ${email} as decision-maker contact.`
        : `${email} already saved as contact.`,
    );
  } else {
    parts.push("No contact email found in notes — try scraping again.");
  }
  if (method === "claude" && claudeReasoning) {
    // Surface Claude's own explanation so reviewers can sanity-check
    // the picks. Trimmed to keep the toast readable.
    parts.push(`(Claude) ${claudeReasoning.slice(0, 220)}`);
  } else {
    parts.push("Heuristic — fell back from Claude.");
  }
  return parts.join(" ");
}
