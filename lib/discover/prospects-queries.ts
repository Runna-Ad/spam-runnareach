import { createClient } from "@/lib/supabase/server";

export type Prospect = {
  id: string;
  company_name: string;
  domain: string | null;
  website_url: string | null;
  industry: string | null;
  city: string | null;
  region: string | null;
  market: "CA" | "MX" | "US" | "LATAM";
  status: string;
  match_score: number | null;
  red_flags: string[];
  discovery_source: string;
  icp_id: string | null;
  icp_name: string | null;
  created_at: string;
};

export type ProspectFilters = {
  status?: string;
  market?: "CA" | "MX" | "US" | "LATAM";
  icpId?: string;
  search?: string;
};

export type ProspectSort = "score_desc" | "score_asc" | "newest" | "oldest" | "name";

export async function listProspects(
  tenantId: string,
  filters: ProspectFilters = {},
  sort: ProspectSort = "newest",
  limit = 100,
): Promise<Prospect[]> {
  const supabase = await createClient();

  type Row = {
    id: string;
    company_name: string;
    domain: string | null;
    website_url: string | null;
    industry: string | null;
    city: string | null;
    region: string | null;
    market: "CA" | "MX" | "US" | "LATAM";
    status: string;
    match_score: number | null;
    red_flags: string[];
    discovery_source: string;
    icp_id: string | null;
    created_at: string;
    icps: { name: string } | null;
  };

  let query = supabase
    .from("prospects")
    .select(
      `
      id, company_name, domain, website_url, industry, city, region, market,
      status, match_score, red_flags, discovery_source, icp_id, created_at,
      icps(name)
    `,
    )
    .eq("tenant_id", tenantId)
    .limit(limit);

  if (filters.status) query = query.eq("status", filters.status);
  if (filters.market) query = query.eq("market", filters.market);
  if (filters.icpId) query = query.eq("icp_id", filters.icpId);
  if (filters.search) {
    const term = filters.search.replace(/[%_]/g, " ").trim();
    if (term.length > 0) {
      query = query.or(`company_name.ilike.%${term}%,domain.ilike.%${term}%`);
    }
  }

  switch (sort) {
    case "score_desc":
      query = query.order("match_score", { ascending: false, nullsFirst: false });
      break;
    case "score_asc":
      query = query.order("match_score", { ascending: true, nullsFirst: true });
      break;
    case "oldest":
      query = query.order("created_at", { ascending: true });
      break;
    case "name":
      query = query.order("company_name", { ascending: true });
      break;
    case "newest":
    default:
      query = query.order("created_at", { ascending: false });
      break;
  }

  const { data, error } = await query.returns<Row[]>();
  if (error) throw new Error(`Failed to load prospects: ${error.message}`);
  if (!data) return [];

  return data.map((r) => ({
    id: r.id,
    company_name: r.company_name,
    domain: r.domain,
    website_url: r.website_url,
    industry: r.industry,
    city: r.city,
    region: r.region,
    market: r.market,
    status: r.status,
    match_score: r.match_score,
    red_flags: r.red_flags,
    discovery_source: r.discovery_source,
    icp_id: r.icp_id,
    icp_name: r.icps?.name ?? null,
    created_at: r.created_at,
  }));
}

export async function countProspects(tenantId: string): Promise<number> {
  const supabase = await createClient();
  const { count, error } = await supabase
    .from("prospects")
    .select("id", { count: "exact", head: true })
    .eq("tenant_id", tenantId);
  if (error) throw new Error(`Failed to count prospects: ${error.message}`);
  return count ?? 0;
}
