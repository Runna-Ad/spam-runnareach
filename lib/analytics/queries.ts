import { createClient } from "@/lib/supabase/server";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type PipelineStageCount = {
  status: string;
  count: number;
};

export type PitchStats = {
  total: number;
  sent: number;
  autoRejected: number;
  reviewerRejected: number;
  avgQualityScore: number | null;
  claudeGenerated: number; // had a prompt_variant_id (AI draft accepted)
  heuristicFallback: number; // auto_rejected = true (heuristic rejected AI)
};

export type CostByCategory = {
  category: string;
  total_usd: number;
};

export type CostSummary = {
  totalUsd: number;
  last30DaysUsd: number;
  byCategory: CostByCategory[];
  perPitchUsd: number | null; // last30Days / sent pitches in last 30d
};

export type ReplyIntentCount = {
  intent: string;
  count: number;
};

export type IcpRow = {
  icp_id: string | null;
  icp_name: string;
  prospects: number;
  pitched: number;
  replied: number;
  won: number;
};

export type DailySpend = {
  date: string; // YYYY-MM-DD
  total_usd: number;
};

// ---------------------------------------------------------------------------
// Pipeline funnel
// ---------------------------------------------------------------------------

export async function getPipelineCounts(
  tenantId: string,
): Promise<PipelineStageCount[]> {
  const supabase = await createClient();

  const { data, error } = await supabase
    .from("prospects")
    .select("status")
    .eq("tenant_id", tenantId)
    .returns<{ status: string }[]>();

  if (error) throw new Error(`getPipelineCounts: ${error.message}`);

  const counts: Record<string, number> = {};
  for (const row of data ?? []) {
    counts[row.status] = (counts[row.status] ?? 0) + 1;
  }

  // Return in canonical funnel order
  const ORDER = [
    "raw",
    "researched",
    "pitched",
    "replied",
    "booked",
    "won",
    "lost",
  ];
  return ORDER.map((s) => ({ status: s, count: counts[s] ?? 0 }));
}

// ---------------------------------------------------------------------------
// Pitch stats
// ---------------------------------------------------------------------------

export async function getPitchStats(tenantId: string): Promise<PitchStats> {
  const supabase = await createClient();

  type PitchRow = {
    status: string;
    auto_rejected: boolean;
    prompt_variant_id: string | null;
    quality_self_score: number | null;
  };

  const { data, error } = await supabase
    .from("pitches")
    .select("status, auto_rejected, prompt_variant_id, quality_self_score")
    .eq("tenant_id", tenantId)
    .returns<PitchRow[]>();

  if (error) throw new Error(`getPitchStats: ${error.message}`);

  const rows = data ?? [];
  const total = rows.length;
  const sent = rows.filter((r) => r.status === "sent").length;
  const autoRejected = rows.filter((r) => r.auto_rejected === true).length;
  const reviewerRejected = rows.filter(
    (r) => r.status === "reviewer_rejected",
  ).length;
  // Claude generated = had a prompt_variant (AI wrote it) AND was not auto_rejected
  const claudeGenerated = rows.filter(
    (r) => r.prompt_variant_id !== null && !r.auto_rejected,
  ).length;
  const heuristicFallback = autoRejected;

  const scores = rows
    .map((r) => r.quality_self_score)
    .filter((s): s is number => s !== null);
  const avgQualityScore =
    scores.length > 0
      ? Math.round(
          (scores.reduce((a, b) => a + b, 0) / scores.length) * 10,
        ) / 10
      : null;

  return {
    total,
    sent,
    autoRejected,
    reviewerRejected,
    avgQualityScore,
    claudeGenerated,
    heuristicFallback,
  };
}

// ---------------------------------------------------------------------------
// Cost summary
// ---------------------------------------------------------------------------

export async function getCostSummary(tenantId: string): Promise<CostSummary> {
  const supabase = await createClient();

  const thirtyDaysAgo = new Date(
    Date.now() - 30 * 24 * 60 * 60 * 1000,
  ).toISOString();

  type CostRow = { category: string; cost_usd: number; incurred_at: string };

  // Fetch all costs (small table, no pagination needed yet)
  const { data, error } = await supabase
    .from("cost_tracking")
    .select("category, cost_usd, incurred_at")
    .eq("tenant_id", tenantId)
    .returns<CostRow[]>();

  if (error) throw new Error(`getCostSummary: ${error.message}`);

  const rows = data ?? [];
  const totalUsd = rows.reduce((a, r) => a + r.cost_usd, 0);

  const last30 = rows.filter((r) => r.incurred_at >= thirtyDaysAgo);
  const last30DaysUsd = last30.reduce((a, r) => a + r.cost_usd, 0);

  // Group by category
  const catMap: Record<string, number> = {};
  for (const r of rows) {
    catMap[r.category] = (catMap[r.category] ?? 0) + r.cost_usd;
  }
  const byCategory: CostByCategory[] = Object.entries(catMap)
    .sort((a, b) => b[1] - a[1])
    .map(([category, total_usd]) => ({ category, total_usd }));

  // Cost per sent pitch in last 30d (rough metric)
  const sentLast30 = last30.filter((r) => r.category === "pitch").length;
  const perPitchUsd =
    sentLast30 > 0
      ? Math.round((last30DaysUsd / sentLast30) * 1000) / 1000
      : null;

  return { totalUsd, last30DaysUsd, byCategory, perPitchUsd };
}

// ---------------------------------------------------------------------------
// Daily spend — last 14 days for sparkline
// ---------------------------------------------------------------------------

export async function getDailySpend(tenantId: string): Promise<DailySpend[]> {
  const supabase = await createClient();

  const fourteenDaysAgo = new Date(
    Date.now() - 14 * 24 * 60 * 60 * 1000,
  ).toISOString();

  const { data, error } = await supabase
    .from("cost_tracking")
    .select("cost_usd, incurred_at")
    .eq("tenant_id", tenantId)
    .gte("incurred_at", fourteenDaysAgo)
    .order("incurred_at", { ascending: true })
    .returns<{ cost_usd: number; incurred_at: string }[]>();

  if (error) throw new Error(`getDailySpend: ${error.message}`);

  const dayMap: Record<string, number> = {};
  for (const r of data ?? []) {
    const day = r.incurred_at.slice(0, 10); // YYYY-MM-DD
    dayMap[day] = (dayMap[day] ?? 0) + r.cost_usd;
  }

  // Fill in all 14 days (even if zero)
  const result: DailySpend[] = [];
  for (let i = 13; i >= 0; i--) {
    const d = new Date(Date.now() - i * 24 * 60 * 60 * 1000);
    const key = d.toISOString().slice(0, 10);
    result.push({ date: key, total_usd: dayMap[key] ?? 0 });
  }
  return result;
}

// ---------------------------------------------------------------------------
// Reply intent breakdown
// ---------------------------------------------------------------------------

export async function getReplyIntents(
  tenantId: string,
): Promise<ReplyIntentCount[]> {
  const supabase = await createClient();

  const { data, error } = await supabase
    .from("replies")
    .select("intent")
    .eq("tenant_id", tenantId)
    .returns<{ intent: string | null }[]>();

  if (error) throw new Error(`getReplyIntents: ${error.message}`);

  const counts: Record<string, number> = {};
  for (const r of data ?? []) {
    const key = r.intent ?? "unclassified";
    counts[key] = (counts[key] ?? 0) + 1;
  }

  const ORDER = [
    "wants_meeting",
    "wants_info",
    "not_now",
    "wrong_person",
    "hard_no",
    "auto_reply",
    "unclassified",
  ];
  return ORDER.filter((k) => counts[k] !== undefined).map((intent) => ({
    intent,
    count: counts[intent] ?? 0,
  }));
}

// ---------------------------------------------------------------------------
// ICP leaderboard
// ---------------------------------------------------------------------------

export async function getIcpLeaderboard(
  tenantId: string,
): Promise<IcpRow[]> {
  const supabase = await createClient();

  // Fetch ICPs + their prospect stats in parallel
  const [icpsResult, prospectsResult] = await Promise.all([
    supabase
      .from("icps")
      .select("id, name")
      .eq("tenant_id", tenantId)
      .eq("is_active", true)
      .returns<{ id: string; name: string }[]>(),
    supabase
      .from("prospects")
      .select("icp_id, status")
      .eq("tenant_id", tenantId)
      .returns<{ icp_id: string | null; status: string }[]>(),
  ]);

  if (icpsResult.error) throw new Error(`getIcpLeaderboard icps: ${icpsResult.error.message}`);
  if (prospectsResult.error) throw new Error(`getIcpLeaderboard prospects: ${prospectsResult.error.message}`);

  const prospects = prospectsResult.data ?? [];
  const icps = icpsResult.data ?? [];

  // Count prospects per ICP
  const countMap: Record<
    string,
    { prospects: number; pitched: number; replied: number; won: number }
  > = {};

  for (const p of prospects) {
    const key = p.icp_id ?? "__none__";
    if (!countMap[key]) {
      countMap[key] = { prospects: 0, pitched: 0, replied: 0, won: 0 };
    }
    countMap[key].prospects++;
    if (
      p.status === "pitched" ||
      p.status === "replied" ||
      p.status === "booked" ||
      p.status === "won"
    ) {
      countMap[key].pitched++;
    }
    if (p.status === "replied" || p.status === "booked" || p.status === "won") {
      countMap[key].replied++;
    }
    if (p.status === "won") {
      countMap[key].won++;
    }
  }

  const rows: IcpRow[] = icps
    .map((icp) => ({
      icp_id: icp.id,
      icp_name: icp.name,
      ...(countMap[icp.id] ?? { prospects: 0, pitched: 0, replied: 0, won: 0 }),
    }))
    .sort((a, b) => b.prospects - a.prospects);

  // Add unassigned if any
  if (countMap["__none__"]) {
    rows.push({
      icp_id: null,
      icp_name: "No ICP assigned",
      ...countMap["__none__"],
    });
  }

  return rows;
}
