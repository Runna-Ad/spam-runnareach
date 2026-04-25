import { createClient } from "@/lib/supabase/server";

export type IcpSuggestionLists = {
  industry_tags: string[];
  business_types: string[];
  geo_regions: string[];
  google_places_types: string[];
  search_keywords: string[];
  excluded_keywords: string[];
};

const EMPTY_LISTS: IcpSuggestionLists = {
  industry_tags: [],
  business_types: [],
  geo_regions: [],
  google_places_types: [],
  search_keywords: [],
  excluded_keywords: [],
};

/**
 * Aggregate values that are *already in use* across this tenant's existing
 * ICPs and case studies. Powers the "used by your team" suggestion group
 * in the TagInput dropdown — gives consistency without forcing a hard
 * allowlist.
 *
 * Combined with the canonical curated lists in option-sources.ts to form
 * the full suggestion set shown in the drawer.
 */
export async function getIcpSuggestionLists(
  tenantId: string,
): Promise<IcpSuggestionLists> {
  const supabase = await createClient();

  // ICP arrays — pull the array columns directly and aggregate in JS.
  type IcpRow = {
    industry_tags: string[] | null;
    business_types: string[] | null;
    geo_regions: string[] | null;
    google_places_types: string[] | null;
    search_keywords: string[] | null;
    excluded_keywords: string[] | null;
  };
  const { data: icps, error: icpErr } = await supabase
    .from("icps")
    .select(
      `industry_tags, business_types, geo_regions, google_places_types,
       search_keywords, excluded_keywords`,
    )
    .eq("tenant_id", tenantId)
    .returns<IcpRow[]>();

  if (icpErr) {
    console.warn(`[icp suggestions] icps load failed: ${icpErr.message}`);
    return EMPTY_LISTS;
  }

  // Case studies contribute industries — these are good signal for
  // "industries your wins came from".
  type CaseStudyRow = { industry: string | null };
  const { data: caseStudies } = await supabase
    .from("case_studies")
    .select("industry")
    .eq("tenant_id", tenantId)
    .eq("is_active", true)
    .returns<CaseStudyRow[]>();

  const out: IcpSuggestionLists = {
    industry_tags: aggregate(icps, "industry_tags"),
    business_types: aggregate(icps, "business_types"),
    geo_regions: aggregate(icps, "geo_regions"),
    google_places_types: aggregate(icps, "google_places_types"),
    search_keywords: aggregate(icps, "search_keywords"),
    excluded_keywords: aggregate(icps, "excluded_keywords"),
  };

  // Stitch case-study industries into industry_tags suggestions.
  for (const cs of caseStudies ?? []) {
    if (cs.industry) {
      const lower = cs.industry.toLowerCase().trim();
      if (lower && !out.industry_tags.some((t) => t.toLowerCase() === lower)) {
        out.industry_tags.push(cs.industry.trim());
      }
    }
  }

  return out;
}

function aggregate(rows: { [k: string]: string[] | null }[] | null, field: string): string[] {
  if (!rows) return [];
  const seen = new Map<string, string>(); // lowercase → first-seen casing
  for (const row of rows) {
    const arr = row[field];
    if (!Array.isArray(arr)) continue;
    for (const v of arr) {
      const trimmed = v.trim();
      if (!trimmed) continue;
      const key = trimmed.toLowerCase();
      if (!seen.has(key)) seen.set(key, trimmed);
    }
  }
  // Sort alphabetically; case-insensitive. The drawer can re-sort by
  // frequency later if we add usage counts.
  return Array.from(seen.values()).sort((a, b) =>
    a.localeCompare(b, undefined, { sensitivity: "base" }),
  );
}
