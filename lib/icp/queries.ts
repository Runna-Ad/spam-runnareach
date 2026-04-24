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
  created_at: string;
  updated_at: string;
};

/**
 * List all ICPs for the tenant — active + inactive. The UI filters client-side
 * based on the "show inactive" toggle so a single query covers both states.
 */
export async function listIcps(tenantId: string): Promise<Icp[]> {
  const supabase = await createClient();

  const { data, error } = await supabase
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
    .returns<Icp[]>();

  if (error) throw new Error(`Failed to load ICPs: ${error.message}`);
  return data ?? [];
}
