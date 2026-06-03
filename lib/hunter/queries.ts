import { createServiceRoleClient } from "@/lib/supabase/service-role";
import type {
  HunterAnalytics,
  HunterFinding,
  HunterListOptions,
  HunterResults,
  HunterScan,
  HunterSignals,
} from "./types";

// ── Row shape returned by Supabase ─────────────────────────────────────────────

type HunterScanRow = {
  id: string;
  created_at: string;
  market: string;
  industry: string;
  team_size: string;
  timesink: string;
  tools: string[];
  website_url: string | null;
  signals: HunterSignals | null;
  results: HunterResults | null;
  contacted: boolean;
  contacted_at: string | null;
};

// ── listHunterScans ────────────────────────────────────────────────────────────

export async function listHunterScans(
  options: HunterListOptions = {},
): Promise<{ scans: HunterScan[]; total: number }> {
  const {
    market,
    industry,
    contacted,
    hasWebsite,
    page = 1,
    pageSize = 50,
  } = options;

  const supabase = createServiceRoleClient();

  // hunter_scans is not yet in the generated types — cast to any for raw access
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const base = (supabase as any).from("hunter_scans");

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let query: any = base
    .select("*", { count: "exact" })
    .order("created_at", { ascending: false });

  if (market !== undefined) query = query.eq("market", market);
  if (industry !== undefined) query = query.eq("industry", industry);
  if (contacted !== undefined) query = query.eq("contacted", contacted);
  if (hasWebsite === true) query = query.not("website_url", "is", null);
  if (hasWebsite === false) query = query.is("website_url", null);

  const from = (page - 1) * pageSize;
  query = query.range(from, from + pageSize - 1);

  const { data, error, count } = (await query) as {
    data: HunterScanRow[] | null;
    error: { message: string } | null;
    count: number | null;
  };

  if (error) throw new Error(`listHunterScans: ${error.message}`);

  return {
    scans: (data ?? []).map((row) => ({
      id: row.id,
      created_at: row.created_at,
      market: row.market,
      industry: row.industry,
      team_size: row.team_size,
      timesink: row.timesink,
      tools: row.tools ?? [],
      website_url: row.website_url,
      signals: row.signals,
      results: row.results,
      contacted: row.contacted ?? false,
      contacted_at: row.contacted_at,
    })),
    total: count ?? 0,
  };
}

// ── getHunterAnalytics ─────────────────────────────────────────────────────────

type AnalyticsRow = {
  id: string;
  created_at: string;
  market: string;
  industry: string;
  team_size: string;
  timesink: string;
  website_url: string | null;
  signals: HunterSignals | null;
  results: HunterResults | null;
  contacted: boolean;
};

export async function getHunterAnalytics(): Promise<HunterAnalytics> {
  const supabase = createServiceRoleClient();

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const analyticsResult = (await (supabase as any)
    .from("hunter_scans")
    .select(
      "id, created_at, market, industry, team_size, timesink, website_url, signals, results, contacted",
    )) as { data: AnalyticsRow[] | null; error: { message: string } | null };

  const { data, error } = analyticsResult;
  if (error) throw new Error(`getHunterAnalytics: ${error.message}`);

  const rows = data ?? [];
  const now = new Date();
  const weekAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);

  const totalScans = rows.length;
  const scansThisWeek = rows.filter(
    (r) => new Date(r.created_at) >= weekAgo,
  ).length;
  const totalContacted = rows.filter((r) => r.contacted).length;
  const contactRate =
    totalScans > 0 ? Math.round((totalContacted / totalScans) * 100) / 100 : 0;

  // byMarket
  const marketMap = new Map<string, { count: number; contacted: number }>();
  for (const r of rows) {
    const entry = marketMap.get(r.market) ?? { count: 0, contacted: 0 };
    entry.count++;
    if (r.contacted) entry.contacted++;
    marketMap.set(r.market, entry);
  }
  const byMarket = Array.from(marketMap.entries()).map(
    ([market, { count, contacted }]) => ({ market, count, contacted }),
  );

  // byIndustry
  const industryMap = new Map<string, { count: number; contacted: number }>();
  for (const r of rows) {
    const entry = industryMap.get(r.industry) ?? { count: 0, contacted: 0 };
    entry.count++;
    if (r.contacted) entry.contacted++;
    industryMap.set(r.industry, entry);
  }
  const byIndustry = Array.from(industryMap.entries()).map(
    ([industry, { count, contacted }]) => ({ industry, count, contacted }),
  );

  // byTeamSize
  const teamSizeMap = new Map<string, number>();
  for (const r of rows) {
    teamSizeMap.set(r.team_size, (teamSizeMap.get(r.team_size) ?? 0) + 1);
  }
  const byTeamSize = Array.from(teamSizeMap.entries()).map(
    ([team_size, count]) => ({ team_size, count }),
  );

  // byTimesink
  const timesinkMap = new Map<string, number>();
  for (const r of rows) {
    timesinkMap.set(r.timesink, (timesinkMap.get(r.timesink) ?? 0) + 1);
  }
  const byTimesink = Array.from(timesinkMap.entries()).map(
    ([timesink, count]) => ({ timesink, count }),
  );

  // topFindings
  const findingKey = (f: HunterFinding, industry: string) =>
    `${f.title}||${industry}`;
  const findingMap = new Map<
    string,
    { title: string; industry: string; count: number }
  >();
  for (const r of rows) {
    if (!r.results?.findings) continue;
    for (const f of r.results.findings) {
      const key = findingKey(f, r.industry);
      const entry = findingMap.get(key) ?? {
        title: f.title,
        industry: r.industry,
        count: 0,
      };
      entry.count++;
      findingMap.set(key, entry);
    }
  }
  const topFindings = Array.from(findingMap.values())
    .sort((a, b) => b.count - a.count)
    .slice(0, 10);

  // signalGaps — only for scans where signals is not null
  const scansWithSignals = rows.filter((r) => r.signals !== null);
  const signalGaps = {
    noMetaPixel: scansWithSignals.filter((r) => r.signals?.metaPixel === false)
      .length,
    noAnalytics: scansWithSignals.filter((r) => r.signals?.analytics === false)
      .length,
    noEmailCapture: scansWithSignals.filter(
      (r) => r.signals?.emailCapture === false,
    ).length,
    notReachable: scansWithSignals.filter((r) => r.signals?.reachable === false)
      .length,
  };

  const withWebsite = rows.filter((r) => r.website_url !== null).length;
  const withoutWebsite = rows.filter((r) => r.website_url === null).length;

  // Totals by market (market values from DB are lowercase: 'ca' | 'mx')
  const caScans = rows.filter(
    (r) => r.market.toLowerCase() === "ca" && r.results !== null,
  );
  const mxScans = rows.filter(
    (r) => r.market.toLowerCase() === "mx" && r.results !== null,
  );

  const totalValueCAD = caScans.reduce(
    (sum, r) => sum + (r.results?.total ?? 0),
    0,
  );
  const totalValueMXN = mxScans.reduce(
    (sum, r) => sum + (r.results?.total ?? 0),
    0,
  );
  const avgValueCAD =
    caScans.length > 0 ? Math.round(totalValueCAD / caScans.length) : 0;
  const avgValueMXN =
    mxScans.length > 0 ? Math.round(totalValueMXN / mxScans.length) : 0;

  return {
    totalScans,
    scansThisWeek,
    totalContacted,
    contactRate,
    byMarket,
    byIndustry,
    byTeamSize,
    byTimesink,
    topFindings,
    signalGaps,
    withWebsite,
    withoutWebsite,
    totalValueCAD,
    totalValueMXN,
    avgValueCAD,
    avgValueMXN,
  };
}
