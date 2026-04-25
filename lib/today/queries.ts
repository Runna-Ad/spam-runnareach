import { createClient } from "@/lib/supabase/server";

/**
 * Counts grouped by prospect.status for the dashboard pipeline strip.
 * RLS filters to the user's tenant automatically.
 */
export async function getStatusCounts(
  tenantId: string,
): Promise<Record<string, number>> {
  const supabase = await createClient();
  type Row = { status: string };
  const { data, error } = await supabase
    .from("prospects")
    .select("status")
    .eq("tenant_id", tenantId)
    .returns<Row[]>();

  if (error) throw new Error(`Failed to load status counts: ${error.message}`);
  const out: Record<string, number> = {};
  for (const row of data ?? []) {
    out[row.status] = (out[row.status] ?? 0) + 1;
  }
  return out;
}

export type AttentionRow = {
  id: string;
  company_name: string;
  domain: string | null;
  market: "CA" | "MX" | "US" | "LATAM";
  status: string;
  match_score: number | null;
  age_days: number;
  reason: "needs_research" | "stale_research" | "ready_to_pitch";
};

/**
 * Build the "Needs your attention" queue. Three buckets, surfaced in priority
 * order:
 *   1. ready_to_pitch — researched + match_score >= 60, not yet pitched
 *   2. needs_research — status='raw' (oldest first — these are rotting)
 *   3. stale_research — status='researched' but research is older than 14d
 *
 * Capped at 12 rows so the panel stays compact. Pedro can drill into
 * /companies for the full list.
 */
export async function getAttentionQueue(
  tenantId: string,
  limit = 12,
): Promise<AttentionRow[]> {
  const supabase = await createClient();

  type Row = {
    id: string;
    company_name: string;
    domain: string | null;
    market: "CA" | "MX" | "US" | "LATAM";
    status: string;
    match_score: number | null;
    created_at: string;
  };

  // Pull a wider net, then bucket+rank in JS — avoids 3 round-trips and the
  // dataset is small (current pipeline ~hundreds, not thousands).
  const { data, error } = await supabase
    .from("prospects")
    .select("id, company_name, domain, market, status, match_score, created_at")
    .eq("tenant_id", tenantId)
    .in("status", ["raw", "researched"])
    .order("created_at", { ascending: true })
    .returns<Row[]>();

  if (error) throw new Error(`Failed to load attention queue: ${error.message}`);

  const now = Date.now();
  const dayMs = 86_400_000;
  const out: AttentionRow[] = [];

  for (const r of data ?? []) {
    const ageDays = Math.floor((now - new Date(r.created_at).getTime()) / dayMs);
    let reason: AttentionRow["reason"] | null = null;

    if (r.status === "researched" && (r.match_score ?? 0) >= 60) {
      reason = "ready_to_pitch";
    } else if (r.status === "raw") {
      reason = "needs_research";
    } else if (r.status === "researched" && ageDays >= 14) {
      reason = "stale_research";
    }

    if (reason) {
      out.push({
        id: r.id,
        company_name: r.company_name,
        domain: r.domain,
        market: r.market,
        status: r.status,
        match_score: r.match_score,
        age_days: ageDays,
        reason,
      });
    }
  }

  // Priority ordering: ready_to_pitch first, then oldest needs_research,
  // then stale_research.
  const priority: Record<AttentionRow["reason"], number> = {
    ready_to_pitch: 0,
    needs_research: 1,
    stale_research: 2,
  };
  out.sort((a, b) => {
    if (priority[a.reason] !== priority[b.reason]) {
      return priority[a.reason] - priority[b.reason];
    }
    if (a.reason === "ready_to_pitch") {
      return (b.match_score ?? 0) - (a.match_score ?? 0);
    }
    return b.age_days - a.age_days;
  });

  return out.slice(0, limit);
}

export type RecentProspect = {
  id: string;
  company_name: string;
  domain: string | null;
  market: "CA" | "MX" | "US" | "LATAM";
  status: string;
  discovery_source: string;
  created_at: string;
};

/**
 * Last N prospects added to the pipeline, regardless of status. Powers the
 * "Recently added" sidebar.
 */
export async function getRecentProspects(
  tenantId: string,
  limit = 6,
): Promise<RecentProspect[]> {
  const supabase = await createClient();
  type Row = RecentProspect;
  const { data, error } = await supabase
    .from("prospects")
    .select("id, company_name, domain, market, status, discovery_source, created_at")
    .eq("tenant_id", tenantId)
    .order("created_at", { ascending: false })
    .limit(limit)
    .returns<Row[]>();
  if (error) throw new Error(`Failed to load recent prospects: ${error.message}`);
  return data ?? [];
}

/**
 * Count of prospects added in the last 7 days — for the "this week" stat tile.
 */
export async function countAddedThisWeek(tenantId: string): Promise<number> {
  const supabase = await createClient();
  const since = new Date(Date.now() - 7 * 86_400_000).toISOString();
  const { count, error } = await supabase
    .from("prospects")
    .select("id", { count: "exact", head: true })
    .eq("tenant_id", tenantId)
    .gte("created_at", since);
  if (error) throw new Error(`Failed to count this-week: ${error.message}`);
  return count ?? 0;
}

/**
 * Count of distinct prospects with research scraped in the last 7 days.
 * If the prospect_research table isn't migrated yet, returns 0.
 */
export async function countScrapedThisWeek(tenantId: string): Promise<number> {
  const supabase = await createClient();
  const since = new Date(Date.now() - 7 * 86_400_000).toISOString();
  const { count, error } = await supabase
    .from("prospect_research")
    .select("id", { count: "exact", head: true })
    .eq("tenant_id", tenantId)
    .gte("last_scraped_at", since);
  if (error) {
    if (
      error.code === "42P01" ||
      error.code === "PGRST205" ||
      error.message?.includes("schema cache")
    ) {
      return 0;
    }
    throw new Error(`Failed to count scrapes: ${error.message}`);
  }
  return count ?? 0;
}
