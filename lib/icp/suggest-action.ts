"use server";

/**
 * Server action for "Suggest with AI" on the ICP form.
 *
 * Calls Claude Haiku when ANTHROPIC_API_KEY is present. Falls back to the
 * deterministic heuristic (suggest-fields.ts) so the button always works.
 *
 * Returns suggestions for ALL form fields — tag arrays, size ranges, revenue
 * ranges, excluded keywords — so one click can populate the whole ICP.
 */

import { z } from "zod";
import {
  ANTHROPIC_HAIKU_MODEL,
  claudeIsAvailable,
  getClient,
  structuredCall,
} from "@/lib/anthropic/client";
import { requireUser } from "@/lib/auth";
import {
  BUSINESS_TYPES,
  EXCLUDED_KEYWORDS,
  GEO_REGIONS,
  GOOGLE_PLACES_TYPES,
  INDUSTRY_TAGS,
  SEARCH_KEYWORDS,
} from "./option-sources";
import { createClient } from "@/lib/supabase/server";
import { gatherIcpEvidence } from "./refine-evidence";
import type { IcpEvidence, IcpProposed, IcpRefinement } from "./refine-types";
import { suggestIcpFields, type SuggestInput, type SuggestOutput } from "./suggest-fields";

// ── Entry point ───────────────────────────────────────────────────────────────

export async function suggestIcpFieldsAction(
  input: SuggestInput,
): Promise<SuggestOutput> {
  if (!claudeIsAvailable()) {
    return suggestIcpFields(input); // graceful fallback
  }

  const client = getClient();

  try {
    const response = await client.messages.create({
      model: ANTHROPIC_HAIKU_MODEL,
      max_tokens: 1000,
      messages: [{ role: "user", content: buildPrompt(input) }],
    });

    const raw = response.content
      .filter((b) => b.type === "text")
      .map((b) => (b as { type: "text"; text: string }).text)
      .join("");

    return parseResponse(raw, input);
  } catch (err) {
    console.error("[icp-suggest] Claude call failed — falling back to heuristic:", err);
    return suggestIcpFields(input);
  }
}

// ── Prompt builder ────────────────────────────────────────────────────────────

function buildPrompt(input: SuggestInput): string {
  const market =
    input.market === "CA" ? "Canada" :
    input.market === "MX" ? "Mexico" :
    input.market === "US" ? "United States" : "Latin America";

  const alreadyHas = (k: keyof SuggestInput["existing"]) =>
    input.existing[k].length > 0
      ? `Already set (do NOT repeat): ${input.existing[k].join(", ")}`
      : "None set yet";

  const hasDescription = Boolean(input.description?.trim());
  const seed = hasDescription
    ? `The user described their ideal customer in plain English:\n"""\n${input.description!.trim()}\n"""${input.name.trim() ? `\nThey also gave this name: "${input.name}"` : "\nThey have NOT given a name yet — propose a concise, descriptive one (e.g. \"Alberta Boutique Fitness — DTC\")."}`
    : `The user typed this ICP name: "${input.name}"`;

  return `You are helping configure an Ideal Customer Profile (ICP) for Runna, a B2B digital marketing agency focused on email marketing, paid media, and growth for ecommerce/DTC brands in ${market}.

${seed}
Market: ${input.market} | Language: ${input.language}

Based on the above, suggest the best-fit values for ALL fields below.
Prefer canonical values from each list; only invent new ones when nothing fits.
Do not suggest values already set.

CANONICAL INDUSTRY_TAGS: ${INDUSTRY_TAGS.join(", ")}
CANONICAL BUSINESS_TYPES: ${BUSINESS_TYPES.join(", ")}
CANONICAL GEO_REGIONS: ${GEO_REGIONS.join(", ")}
CANONICAL GOOGLE_PLACES_TYPES: ${GOOGLE_PLACES_TYPES.join(", ")}
CANONICAL SEARCH_KEYWORDS: ${SEARCH_KEYWORDS.join(", ")}
CANONICAL EXCLUDED_KEYWORDS: ${EXCLUDED_KEYWORDS.join(", ")}

Current form state:
- industry_tags: ${alreadyHas("industry_tags")}
- business_types: ${alreadyHas("business_types")}
- geo_regions: ${alreadyHas("geo_regions")}
- google_places_types: ${alreadyHas("google_places_types")}
- search_keywords: ${alreadyHas("search_keywords")}
- excluded_keywords: ${alreadyHas("excluded_keywords")}

SIZE/REVENUE GUIDANCE — suggest ranges appropriate for the ICP name:
- employee_size_min/max: integer headcount (e.g. 5/50 for SMB, 50/500 for mid-market, 500/null for enterprise). Use null if the range is open-ended or you have no signal.
- revenue_min_usd/revenue_max_usd: annual revenue in USD (e.g. 500000/5000000 for SMB ecommerce). Use null if no clear signal.

Return ONLY valid JSON — no markdown fences, no extra text:
{
  "name": "<concise ICP name if the user gave a description and no name, else null>",
  "industry_tags": ["<from canonical list>"],
  "business_types": ["<from canonical list>"],
  "geo_regions": ["<from canonical list, match market>"],
  "google_places_types": ["<from canonical list, or empty if not physical biz>"],
  "search_keywords": ["<from canonical list or short phrase>"],
  "excluded_keywords": ["<from canonical list, or empty>"],
  "employee_size_min": <integer or null>,
  "employee_size_max": <integer or null>,
  "revenue_min_usd": <number or null>,
  "revenue_max_usd": <number or null>,
  "reasoning": "<1–2 sentence explanation of your suggestions>"
}`;
}

// ── Response parser ───────────────────────────────────────────────────────────

function parseResponse(raw: string, input: SuggestInput): SuggestOutput {
  try {
    const cleaned = raw
      .replace(/^```(?:json)?\s*/i, "")
      .replace(/\s*```\s*$/, "")
      .trim();

    let obj: unknown;
    try {
      obj = JSON.parse(cleaned);
    } catch {
      const match = cleaned.match(/\{[\s\S]+\}/);
      if (!match) throw new Error("No JSON in response");
      obj = JSON.parse(match[0]);
    }

    if (!obj || typeof obj !== "object") throw new Error("Not an object");
    const r = obj as Record<string, unknown>;

    const toStrArr = (v: unknown): string[] =>
      Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];

    const toNullableInt = (v: unknown): string | null => {
      if (v === null || v === undefined) return null;
      const n = typeof v === "number" ? v : Number.parseInt(String(v), 10);
      return Number.isFinite(n) && n > 0 ? String(n) : null;
    };

    const toNullableFloat = (v: unknown): string | null => {
      if (v === null || v === undefined) return null;
      const n = typeof v === "number" ? v : Number.parseFloat(String(v));
      return Number.isFinite(n) && n > 0 ? String(n) : null;
    };

    // Dedupe against already-existing values
    const existing = input.existing;
    const dedupeAgainst = (arr: string[], existingArr: string[]): string[] => {
      const seen = new Set(existingArr.map((s) => s.toLowerCase()));
      return arr.filter((s) => !seen.has(s.toLowerCase()));
    };

    // Only surface a suggested name when the user hasn't already typed one.
    const suggestedName =
      !input.name.trim() && typeof r.name === "string" && r.name.trim()
        ? r.name.trim()
        : null;

    return {
      name: suggestedName,
      industry_tags: dedupeAgainst(toStrArr(r.industry_tags), existing.industry_tags),
      business_types: dedupeAgainst(toStrArr(r.business_types), existing.business_types),
      geo_regions: dedupeAgainst(toStrArr(r.geo_regions), existing.geo_regions),
      google_places_types: dedupeAgainst(
        toStrArr(r.google_places_types),
        existing.google_places_types,
      ),
      search_keywords: dedupeAgainst(toStrArr(r.search_keywords), existing.search_keywords),
      excluded_keywords: dedupeAgainst(toStrArr(r.excluded_keywords), existing.excluded_keywords),
      employee_size_min: toNullableInt(r.employee_size_min),
      employee_size_max: toNullableInt(r.employee_size_max),
      revenue_min_usd: toNullableFloat(r.revenue_min_usd),
      revenue_max_usd: toNullableFloat(r.revenue_max_usd),
      reasoning:
        typeof r.reasoning === "string"
          ? `✦ ${r.reasoning}`
          : "Suggested by Claude.",
    };
  } catch (err) {
    console.error("[icp-suggest] Failed to parse Claude response:", err);
    // Last-resort: fall back to heuristic
    return suggestIcpFields(input);
  }
}

// ════════════════════════════════════════════════════════════════════════════
// ICP REFINEMENT ADVISOR (Learning Loop — PHASE 1)
//
// Different intent from suggestIcpFieldsAction above:
//   - suggestIcpFieldsAction → "suggest from a name/description" (cold start).
//   - refineIcpFromEvidenceAction → "improve an EXISTING ICP from the evidence
//     we already have" — aggregate deep research + scores across the prospects
//     assigned to this ICP, cross-reference where Runna is strongest, and
//     PROPOSE sharper field values.
//
// GUARDRAILS: suggest-only, never auto-apply. Pedro reviews every proposed value
// in the drawer and Saves manually. This is HYPOTHESIS generation (no outcome
// data yet), NOT validated learning. The scoring rubric is never touched.
// ════════════════════════════════════════════════════════════════════════════

const HYPOTHESIS_NOTE =
  "Hypothesis from current evidence (research + fit scores) — not validated by reply/booking outcomes yet. Review each suggestion before saving.";

const EMPTY_PROPOSED: IcpProposed = {
  industry_tags: [],
  business_types: [],
  search_keywords: [],
  excluded_keywords: [],
  employee_size_min: null,
  employee_size_max: null,
};

type IcpRow = {
  id: string;
  name: string;
  market: "CA" | "MX" | "US" | "LATAM";
  language: "en" | "es";
  industry_tags: string[];
  business_types: string[];
  search_keywords: string[];
  excluded_keywords: string[];
  employee_size_min: number | null;
  employee_size_max: number | null;
};

export async function refineIcpFromEvidenceAction(icpId: string): Promise<IcpRefinement> {
  const idParse = z.string().uuid().safeParse(icpId);
  if (!idParse.success) {
    return {
      ok: false,
      evidence: emptyEvidence(),
      proposed: EMPTY_PROPOSED,
      fieldRationales: {},
      summary: "Invalid ICP id.",
      method: "insufficient_data",
      note: HYPOTHESIS_NOTE,
    };
  }

  const user = await requireUser();
  const supabase = await createClient();

  const { data: icp } = await supabase
    .from("icps")
    .select(
      `id, name, market, language, industry_tags, business_types,
       search_keywords, excluded_keywords, employee_size_min, employee_size_max`,
    )
    .eq("id", idParse.data)
    .eq("tenant_id", user.tenantId)
    .single<IcpRow>();

  if (!icp) {
    return {
      ok: false,
      evidence: emptyEvidence(),
      proposed: EMPTY_PROPOSED,
      fieldRationales: {},
      summary: "ICP not found.",
      method: "insufficient_data",
      note: HYPOTHESIS_NOTE,
    };
  }

  const evidence = await gatherIcpEvidence(user.tenantId, icp.id);

  // Need a meaningful base of research to refine from — otherwise the "advice"
  // would just be noise. Be explicit about it instead of inventing suggestions.
  if (evidence.researchedCount < 3) {
    return {
      ok: false,
      evidence,
      proposed: EMPTY_PROPOSED,
      fieldRationales: {},
      summary:
        evidence.prospectCount === 0
          ? "No prospects are assigned to this ICP yet. Run Discovery + research first, then come back to refine it from evidence."
          : `Only ${evidence.researchedCount} researched prospect(s) so far — need at least 3 to refine reliably. Research more prospects in this ICP first.`,
      method: "insufficient_data",
      note: HYPOTHESIS_NOTE,
    };
  }

  if (!claudeIsAvailable()) {
    return heuristicRefinement(icp, evidence);
  }

  const claudeResult = await claudeRefinement(icp, evidence);
  return claudeResult ?? heuristicRefinement(icp, evidence);
}

// ── Claude-backed refinement (Haiku — cheap synthesis) ──────────────────────────

const refineSchema = z.object({
  industry_tags: z.array(z.string().trim().min(1).max(60)).max(12),
  business_types: z.array(z.string().trim().min(1).max(60)).max(12),
  search_keywords: z.array(z.string().trim().min(1).max(60)).max(12),
  excluded_keywords: z.array(z.string().trim().min(1).max(60)).max(12),
  employee_size_min: z.number().int().min(0).max(1_000_000).nullable(),
  employee_size_max: z.number().int().min(0).max(1_000_000).nullable(),
  field_rationales: z.object({
    industry_tags: z.string().max(240).optional(),
    business_types: z.string().max(240).optional(),
    search_keywords: z.string().max(240).optional(),
    excluded_keywords: z.string().max(240).optional(),
    employee_size_min: z.string().max(240).optional(),
    employee_size_max: z.string().max(240).optional(),
  }),
  summary: z.string().trim().min(1).max(800),
});

async function claudeRefinement(
  icp: IcpRow,
  evidence: IcpEvidence,
): Promise<IcpRefinement | null> {
  const fmt = (arr: { name: string; count: number }[]) =>
    arr.length ? arr.map((c) => `${c.name} (${c.count})`).join(", ") : "(none observed)";

  const system = `You are a B2B targeting analyst refining an EXISTING Ideal Customer Profile (ICP) for Runna, a creative + digital marketing agency.

You are given the aggregated EVIDENCE from the prospects already assigned to this ICP — the pains found in their deep research, their tech stacks, the industries they actually fall into, sample descriptions of what they do, and Claude's own fit-score reasoning — plus a summary of where Runna's case studies + services are STRONGEST.

Your job: propose SHARPER values for the ICP's targeting fields so future discovery finds more prospects like the ones that scored well AND that Runna can credibly win. This is a hypothesis from current data, not a proven rule — be specific but conservative.

Principles:
- Lean toward industries/keywords where the observed prospects OVERLAP with Runna's proven strengths (case-study industries + covered pains).
- Propose excluded_keywords for patterns that clearly waste effort (competitors like agencies, already-served businesses) — never exclude valid customer types just because they sell services.
- Only suggest an employee-size range when the evidence genuinely points to one; otherwise return null for both.
- Prefer canonical values from the provided lists; invent new ones only when nothing fits.
- Keep each field's rationale to ONE sentence grounded in the evidence (e.g. "5 of 8 prospects are on Shopify").`;

  const user = `EXISTING ICP "${icp.name}" (market ${icp.market}, language ${icp.language})
Current values:
- industry_tags: ${icp.industry_tags.join(", ") || "(none)"}
- business_types: ${icp.business_types.join(", ") || "(none)"}
- search_keywords: ${icp.search_keywords.join(", ") || "(none)"}
- excluded_keywords: ${icp.excluded_keywords.join(", ") || "(none)"}
- employee_size: ${icp.employee_size_min ?? "—"} to ${icp.employee_size_max ?? "—"}

EVIDENCE from ${evidence.prospectCount} assigned prospects (${evidence.researchedCount} researched, avg fit score ${evidence.avgScore ?? "n/a"}):
- Common pains: ${fmt(evidence.topPains)}
- Common tech stacks: ${fmt(evidence.topTech)}
- Industries actually present: ${fmt(evidence.industriesPresent)}
- What they do (samples): ${evidence.whatTheyDoSamples.map((s) => `"${s}"`).join(" | ") || "(none)"}
- Fit-score reasoning (samples): ${evidence.scoreReasoningSamples.map((s) => `"${s}"`).join(" | ") || "(none)"}

WHERE RUNNA IS STRONGEST:
- Case-study industries: ${evidence.runnaStrength.caseStudyIndustries.join(", ") || "(none)"}
- Pains Runna has proof for: ${fmt(evidence.runnaStrength.coveredPains)}
- Services offered: ${evidence.runnaStrength.services.join(", ") || "(none)"}

CANONICAL INDUSTRY_TAGS: ${INDUSTRY_TAGS.join(", ")}
CANONICAL BUSINESS_TYPES: ${BUSINESS_TYPES.join(", ")}
CANONICAL SEARCH_KEYWORDS: ${SEARCH_KEYWORDS.join(", ")}
CANONICAL EXCLUDED_KEYWORDS: ${EXCLUDED_KEYWORDS.join(", ")}

Return the proposed refined values as JSON matching the schema. Suggest only values that ADD signal beyond what's already set.`;

  const result = await structuredCall({
    model: ANTHROPIC_HAIKU_MODEL,
    system,
    user,
    max_tokens: 900,
    schema: refineSchema,
  });

  if (!result.ok) {
    console.error(`[icp-refine] Claude call failed (${result.reason}): ${result.error}`);
    return null;
  }

  const d = result.data;
  // Dedupe proposals against what's already on the ICP — only surface net-new.
  const dedupe = (arr: string[], existing: string[]): string[] => {
    const seen = new Set(existing.map((s) => s.toLowerCase()));
    const out: string[] = [];
    for (const v of arr) {
      const key = v.trim().toLowerCase();
      if (!key || seen.has(key)) continue;
      seen.add(key);
      out.push(v.trim());
    }
    return out;
  };

  return {
    ok: true,
    evidence,
    proposed: {
      industry_tags: dedupe(d.industry_tags, icp.industry_tags),
      business_types: dedupe(d.business_types, icp.business_types),
      search_keywords: dedupe(d.search_keywords, icp.search_keywords),
      excluded_keywords: dedupe(d.excluded_keywords, icp.excluded_keywords),
      employee_size_min: d.employee_size_min != null ? String(d.employee_size_min) : null,
      employee_size_max: d.employee_size_max != null ? String(d.employee_size_max) : null,
    },
    fieldRationales: d.field_rationales,
    summary: d.summary,
    method: "claude",
    note: HYPOTHESIS_NOTE,
  };
}

// ── Deterministic fallback — frequency-driven, no API key needed ────────────────

function heuristicRefinement(icp: IcpRow, evidence: IcpEvidence): IcpRefinement {
  const existing = (arr: string[]) => new Set(arr.map((s) => s.toLowerCase()));
  const indSet = existing(icp.industry_tags);
  const kwSet = existing(icp.search_keywords);

  // Industries actually present that aren't already targeted.
  const industry_tags = evidence.industriesPresent
    .filter((c) => c.count >= 2 && !indSet.has(c.name.toLowerCase()))
    .map((c) => c.name)
    .slice(0, 6);

  // Search keywords: industries + recurring tech that aren't already set.
  const kwCandidates = [
    ...evidence.industriesPresent.map((c) => c.name),
    ...evidence.topTech.filter((c) => c.count >= 2).map((c) => c.name),
  ];
  const search_keywords: string[] = [];
  for (const k of kwCandidates) {
    const key = k.toLowerCase();
    if (kwSet.has(key) || search_keywords.some((s) => s.toLowerCase() === key)) continue;
    search_keywords.push(k);
    if (search_keywords.length >= 6) break;
  }

  const fieldRationales: IcpRefinement["fieldRationales"] = {};
  if (industry_tags.length) {
    fieldRationales.industry_tags = `Industries that recur across the assigned prospects (${industry_tags.join(", ")}).`;
  }
  if (search_keywords.length) {
    fieldRationales.search_keywords = "Pulled from the most common industries + tech stacks observed.";
  }

  const topPainNames = evidence.topPains.slice(0, 3).map((p) => p.name).join(", ");
  const summary =
    `${evidence.researchedCount} researched prospects in "${icp.name}" (avg fit ${evidence.avgScore ?? "n/a"}). ` +
    (topPainNames ? `Most common pains: ${topPainNames}. ` : "") +
    (evidence.runnaStrength.caseStudyIndustries.length
      ? `Runna's strongest proof is in ${evidence.runnaStrength.caseStudyIndustries.slice(0, 3).join(", ")}. `
      : "") +
    "Suggestions below come from frequency only (no API key for deeper synthesis).";

  return {
    ok: industry_tags.length > 0 || search_keywords.length > 0,
    evidence,
    proposed: {
      industry_tags,
      business_types: [],
      search_keywords,
      excluded_keywords: [],
      employee_size_min: null,
      employee_size_max: null,
    },
    fieldRationales,
    summary,
    method: "heuristic",
    note: HYPOTHESIS_NOTE,
  };
}

function emptyEvidence(): IcpEvidence {
  return {
    prospectCount: 0,
    researchedCount: 0,
    avgScore: null,
    topPains: [],
    topTech: [],
    industriesPresent: [],
    whatTheyDoSamples: [],
    scoreReasoningSamples: [],
    runnaStrength: { caseStudyIndustries: [], coveredPains: [], services: [] },
  };
}
