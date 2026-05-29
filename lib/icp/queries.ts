import { createClient } from "@/lib/supabase/server";

export type IcpMarket = "CA" | "MX" | "US" | "LATAM";
export type IcpLanguage = "en" | "es";

export type Icp = {
  id: string;
  tenant_id: string;
  name: string;
  market: IcpMarket;
  language: IcpLanguage;
  industry_tags: string[];
  geo_regions: string[];
  employee_size_min: number | null;
  employee_size_max: number | null;
  revenue_min_usd: number | null;
  revenue_max_usd: number | null;
  business_types: string[];
  google_places_types: string[];
  search_keywords: string[];
  excluded_keywords: string[];
  is_active: boolean;
  reachable_pool_count: number | null;
  reachable_pool_computed_at: string | null;
  /** Count of prospects in the DB assigned to this ICP. Always available — no API key needed. */
  prospect_count: number;
  created_at: string;
  updated_at: string;
};

/**
 * List all ICPs for the tenant — active + inactive. The UI filters client-side
 * based on the "show inactive" toggle so a single query covers both states.
 *
 * Also returns `prospect_count` — the number of prospects in the tenant's DB
 * that have been assigned to each ICP. This is always available (no Places API
 * needed) and gives Pedro immediate signal on which ICPs have been targeted.
 */
export async function listIcps(tenantId: string): Promise<Icp[]> {
  const supabase = await createClient();

  // Run ICP list + prospect counts in parallel
  const [icpsResult, prospectsResult] = await Promise.all([
    supabase
      .from("icps")
      .select(
        `
        id, tenant_id, name, market, language,
        industry_tags, geo_regions,
        employee_size_min, employee_size_max,
        revenue_min_usd, revenue_max_usd,
        business_types, google_places_types,
        search_keywords, excluded_keywords,
        is_active, reachable_pool_count, reachable_pool_computed_at,
        created_at, updated_at
      `,
      )
      .eq("tenant_id", tenantId)
      .order("is_active", { ascending: false })
      .order("created_at", { ascending: true })
      .returns<Omit<Icp, "prospect_count">[]>(),

    supabase
      .from("prospects")
      .select("icp_id")
      .eq("tenant_id", tenantId)
      .not("icp_id", "is", null)
      .returns<{ icp_id: string }[]>(),
  ]);

  if (icpsResult.error) throw new Error(`Failed to load ICPs: ${icpsResult.error.message}`);

  // Build count map from prospects
  const countMap: Record<string, number> = {};
  for (const p of prospectsResult.data ?? []) {
    countMap[p.icp_id] = (countMap[p.icp_id] ?? 0) + 1;
  }

  return (icpsResult.data ?? []).map((icp) => ({
    ...icp,
    prospect_count: countMap[icp.id] ?? 0,
  }));
}
