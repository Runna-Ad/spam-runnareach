/**
 * The scout: where to search next, learned from what each search paid off.
 *
 * A search cell is ICP × keyword × place ("Calgary law firms" via one ICP's
 * keyword and region). Each cell is a bandit arm. Its reward per discovered
 * prospect blends the cheap early signals with the real one:
 *
 *   0.15  survived research and triage (a real SMB in the ICP, not a chain)
 *   0.15  produced a pitch that passed the gate with a trusted address
 *   0.70  the pitch's outcome value (reply, Hunter scan, asking to talk)
 *
 * so a cell that only yields chains and dead websites sinks within days,
 * long before replies could say so, while replies dominate once they exist.
 * Cells that keep producing nothing new (exhausted) are skipped.
 *
 * New cells come from active ICPs' keywords × regions; later the ICP learner
 * proposes keywords and regions from the segments that convert (including the
 * Hunter's organic visitors), and they enter here as fresh arms.
 *
 * Pure — tested in tests/scout.test.ts.
 */

import { chooseArm, type Arm, type Rng } from "./bandit.ts";

export type SearchCell = { icpId: string; keyword: string; region: string | null };

export function cellKey(c: SearchCell): string {
  return [c.icpId, c.keyword.trim().toLowerCase(), (c.region ?? "").trim().toLowerCase()].join("|");
}

export function parseCellKey(key: string): SearchCell {
  const [icpId = "", keyword = "", region = ""] = key.split("|");
  return { icpId, keyword, region: region || null };
}

/** What happened to one prospect a cell discovered. */
export type ProspectFunnel = {
  /** Research/triage finished (true/false), or still running (null). */
  qualified: boolean | null;
  /** A gate-passing pitch with a trusted address was produced. */
  pitchReady: boolean;
  /** Settled outcome value 0..1 of its first email; null while pending or never sent. */
  outcomeValue: number | null;
  /** Opt-out or hard no. */
  negative?: boolean;
};

export const SCOUT_WEIGHTS = { qualified: 0.15, pitchReady: 0.15, outcome: 0.7 } as const;

/**
 * Reward 0..1 for one discovered prospect, or null while it is still being
 * researched. A qualified, pitched prospect whose email hasn't settled yet is
 * scored on what is known (0.3), the early signals the scout can already use.
 */
export function prospectReward(f: ProspectFunnel): number | null {
  if (f.qualified === null) return null;
  if (!f.qualified) return 0;
  let r = SCOUT_WEIGHTS.qualified;
  if (f.pitchReady) r += SCOUT_WEIGHTS.pitchReady;
  if (f.outcomeValue !== null) r += SCOUT_WEIGHTS.outcome * f.outcomeValue;
  return r;
}

export type CellStats = {
  key: string;
  status: Arm["status"];
  funnels: ProspectFunnel[];
  /** Consecutive runs that found no new prospects. */
  emptyRuns: number;
};

/** A cell's arm: settled prospects only, so running research doesn't read as failure. */
export function cellArm(c: CellStats): Arm {
  let reward = 0;
  let trials = 0;
  let negatives = 0;
  for (const f of c.funnels) {
    const r = prospectReward(f);
    if (r === null) continue;
    reward += r;
    trials += 1;
    if (f.negative) negatives += 1;
  }
  return { key: c.key, status: c.status, reward, trials, negatives };
}

export const EXHAUSTED_AFTER_EMPTY_RUNS = 3;

/** Pick the next cell to search, skipping exhausted ones. Null when none is left. */
export function chooseCell(cells: readonly CellStats[], opts: { rng?: Rng } = {}): SearchCell | null {
  const live = cells.filter((c) => c.status !== "retired" && c.emptyRuns < EXHAUSTED_AFTER_EMPTY_RUNS);
  const arm = chooseArm(live.map(cellArm), { rng: opts.rng, controlShare: 0 });
  return arm ? parseCellKey(arm.key) : null;
}

/**
 * The same choice from stored arms (learning_arms rows, whose reward/trials a
 * learner keeps current from cellArm) plus each cell's consecutive empty runs.
 */
export function chooseCellFromArms(
  cells: ReadonlyArray<{ arm: Arm; emptyRuns: number }>,
  opts: { rng?: Rng } = {},
): SearchCell | null {
  const live = cells.filter((c) => c.arm.status !== "retired" && c.emptyRuns < EXHAUSTED_AFTER_EMPTY_RUNS);
  const arm = chooseArm(live.map((c) => c.arm), { rng: opts.rng, controlShare: 0 });
  return arm ? parseCellKey(arm.key) : null;
}

// Technologies and bare attributes describe a business but can't be searched
// for: "direct to consumer Alberta" returned news sites and government pages.
// Manual runs still use them; the scout doesn't spend jobs on them.
const NOT_A_SEARCH = new Set([
  "shopify", "shopify plus", "woocommerce", "bigcommerce", "squarespace", "wix", "magento",
  "prestashop", "wordpress", "google tag manager", "meta pixel", "google analytics", "klaviyo",
  "hubspot", "premium", "luxury", "sustainable", "handmade", "small batch", "made in canada",
  "subscription", "online store", "dtc brand", "direct to consumer", "ecommerce", "e-commerce",
]);

export function isSearchableKeyword(keyword: string): boolean {
  return !NOT_A_SEARCH.has(keyword.trim().toLowerCase());
}

/** Candidate cells from active ICPs: each searchable keyword × each region (or no region). */
export function candidateCells(
  icps: ReadonlyArray<{ id: string; search_keywords: string[] | null; geo_regions: string[] | null }>,
): SearchCell[] {
  const out = new Map<string, SearchCell>();
  for (const icp of icps) {
    const keywords = (icp.search_keywords ?? []).map((k) => k.trim()).filter(Boolean).filter(isSearchableKeyword);
    const regions = (icp.geo_regions ?? []).map((r) => r.trim()).filter(Boolean);
    for (const keyword of keywords) {
      for (const region of regions.length ? regions : [null]) {
        const cell = { icpId: icp.id, keyword, region };
        out.set(cellKey(cell), cell);
      }
    }
  }
  return [...out.values()];
}

/**
 * How many new prospects to discover today: enough to keep tomorrow's send
 * capacity fed, no more (research costs AI money and stale drafts rot).
 *
 *   needed = capacity × days of buffer − pitches already waiting
 *   prospects = needed ÷ (share of discovered prospects that become a pitch)
 */
export function discoveryBudget(i: {
  dailySendCapacity: number;
  pitchesWaiting: number;
  /** Share of discovered prospects that end up pitch-ready (from cell history). */
  pitchYield: number;
  bufferDays?: number;
  maxPerDay?: number;
}): number {
  const buffer = i.bufferDays ?? 2;
  const needed = Math.max(0, i.dailySendCapacity * buffer - i.pitchesWaiting);
  if (needed === 0) return 0;
  const yieldRate = Math.min(Math.max(i.pitchYield, 0.05), 1);
  return Math.min(Math.ceil(needed / yieldRate), i.maxPerDay ?? 200);
}

/** Autopilot discovery jobs per rolling day: each one crawls its sources even when it finds nothing. */
export const MAX_DISCOVERY_JOBS_PER_DAY = 6;

/**
 * What's left of today's budget. The budget is a daily figure, so prospects the
 * autopilot already researched in the last 24h count against it, and the jobs
 * are capped too: a cell that turns up nothing would otherwise start a fresh
 * crawl every tick.
 */
export function dailyAllowance(i: {
  budget: number;
  researchedToday: number;
  jobsToday: number;
  maxJobs?: number;
}): { prospects: number; reason: string } {
  const maxJobs = i.maxJobs ?? MAX_DISCOVERY_JOBS_PER_DAY;
  if (i.jobsToday >= maxJobs) {
    return { prospects: 0, reason: `${i.jobsToday} discovery jobs in the last 24h (max ${maxJobs})` };
  }
  const prospects = Math.max(0, i.budget - i.researchedToday);
  if (prospects === 0) return { prospects, reason: `today's budget of ${i.budget} prospects is spent` };
  return { prospects, reason: `${prospects} of today's ${i.budget} prospects left` };
}
