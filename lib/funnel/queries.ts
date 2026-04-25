import { createClient } from "@/lib/supabase/server";

export type FunnelCard = {
  id: string;
  company_name: string;
  domain: string | null;
  market: "CA" | "MX" | "US" | "LATAM";
  status: string;
  match_score: number | null;
  icp_name: string | null;
  industry: string | null;
  created_at: string;
  updated_at: string;
};

/**
 * All prospects for the tenant in compact "card" shape for the kanban board.
 * Capped at 500 — beyond that the board UX degrades and the user should
 * filter on /companies. RLS handles tenant scope.
 */
export async function listFunnelCards(tenantId: string): Promise<FunnelCard[]> {
  const supabase = await createClient();
  type Row = Omit<FunnelCard, "icp_name"> & { icps: { name: string } | null };

  const { data, error } = await supabase
    .from("prospects")
    .select(
      `
      id, company_name, domain, market, status, match_score,
      industry, created_at, updated_at,
      icps(name)
    `,
    )
    .eq("tenant_id", tenantId)
    .order("updated_at", { ascending: false })
    .limit(500)
    .returns<Row[]>();

  if (error) throw new Error(`Failed to load funnel: ${error.message}`);
  return (data ?? []).map((r) => ({
    id: r.id,
    company_name: r.company_name,
    domain: r.domain,
    market: r.market,
    status: r.status,
    match_score: r.match_score,
    industry: r.industry,
    created_at: r.created_at,
    updated_at: r.updated_at,
    icp_name: r.icps?.name ?? null,
  }));
}
