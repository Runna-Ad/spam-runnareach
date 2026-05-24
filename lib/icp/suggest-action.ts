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

import { ANTHROPIC_HAIKU_MODEL, claudeIsAvailable, getClient } from "@/lib/anthropic/client";
import {
  BUSINESS_TYPES,
  EXCLUDED_KEYWORDS,
  GEO_REGIONS,
  GOOGLE_PLACES_TYPES,
  INDUSTRY_TAGS,
  SEARCH_KEYWORDS,
} from "./option-sources";
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

  return `You are helping configure an Ideal Customer Profile (ICP) for Runna, a B2B digital marketing agency focused on email marketing, paid media, and growth for ecommerce/DTC brands in ${market}.

The user typed this ICP name: "${input.name}"
Market: ${input.market} | Language: ${input.language}

Based on the ICP name, suggest the best-fit values for ALL fields below.
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

    return {
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
