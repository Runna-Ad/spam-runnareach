import { createClient } from "@/lib/supabase/server";
import type { DiscoverySource } from "./source-meta";

export type { DiscoverySource };

export type DiscoveryRun = {
  id: string;
  source: DiscoverySource;
  status: string;
  candidates_found: number;
  candidates_new: number;
  candidates_duplicate: number;
  cost_usd: number;
  error_message: string | null;
  started_at: string | null;
  completed_at: string | null;
  created_at: string;
  icp_id: string | null;
  icp_name: string | null;
  triggered_by_name: string | null;
};

export async function listDiscoveryRuns(tenantId: string, limit = 50): Promise<DiscoveryRun[]> {
  const supabase = await createClient();

  type Row = Omit<DiscoveryRun, "icp_name" | "triggered_by_name"> & {
    icps: { name: string } | null;
    users: { full_name: string | null } | null;
  };

  const { data, error } = await supabase
    .from("discovery_runs")
    .select(
      `
      id, source, status, candidates_found, candidates_new, candidates_duplicate,
      cost_usd, error_message, started_at, completed_at, created_at, icp_id,
      icps(name),
      users(full_name)
    `,
    )
    .eq("tenant_id", tenantId)
    .order("created_at", { ascending: false })
    .limit(limit)
    .returns<Row[]>();

  if (error) throw new Error(`Failed to load runs: ${error.message}`);
  if (!data) return [];

  return data.map((r) => ({
    id: r.id,
    source: r.source,
    status: r.status,
    candidates_found: r.candidates_found,
    candidates_new: r.candidates_new,
    candidates_duplicate: r.candidates_duplicate,
    cost_usd: r.cost_usd,
    error_message: r.error_message,
    started_at: r.started_at,
    completed_at: r.completed_at,
    created_at: r.created_at,
    icp_id: r.icp_id,
    icp_name: r.icps?.name ?? null,
    triggered_by_name: r.users?.full_name ?? null,
  }));
}

// SOURCE_META lives in `./source-meta.ts` so client components can import it
// without dragging this file's server-only `createClient` into the bundle.
