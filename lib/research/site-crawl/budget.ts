/**
 * Time budget of one /api/research/observe run, at the largest designed load.
 * Pure numbers; tests/site-crawl-budget.test.ts checks the sums.
 *
 *   load       100 researched prospects a day (MAX_PROSPECTS_PER_DAY, the volume
 *              rule) = 700 a week, crawled on weekdays only = 140 a weekday.
 *   schedule   pg_cron 12,42 15-22 * * 1-5 (0054) = 16 runs a weekday, 80 a week.
 *   per run    SITES_PER_RUN sites, all in parallel; per site the crawl (one
 *              request at a time) and PageSpeed run side by side.
 *
 *   worst case, every site and PageSpeed hanging to their timeouts:
 *     claim RPC        CLAIM_TIMEOUT_MS                  5 s
 *     crawl ∥ PSI      max(SITE_BUDGET_MS, PSI)         35 s  (PSI timeout = what is left before the save reserve)
 *     saves (parallel) SAVE_TIMEOUT_MS                   5 s
 *     heartbeat write  (heartbeat.ts WRITE_TIMEOUT_MS)   3 s
 *     ─────────────────────────────────────────────────────
 *                                                      48 s  of the 60 s maxDuration (app/** default),
 *   leaving 12 s for the cold start and the scheduler-token check.
 */

import { SITE_BUDGET_MS } from "./crawl.ts";

/** vercel.json `app/**` default; the route needs no entry of its own. */
export const ROUTE_MAX_DURATION_S = 60;
/** Everything the run does fits in this, measured from the handler's start. */
export const ROUTE_BUDGET_MS = 45_000;
export const CLAIM_TIMEOUT_MS = 5_000;
export const SAVE_TIMEOUT_MS = 5_000;
/** PageSpeed takes 10-40 s; past this it is recorded as psi_status "timeout". */
export const PSI_TIMEOUT_MS = 35_000;
/** heartbeat.ts WRITE_TIMEOUT_MS (runs after the response is built). */
export const HEARTBEAT_MS = 3_000;

export const SITES_PER_RUN = 12;
export const RUNS_PER_WEEKDAY = 16;
export const WEEKDAYS = 5;
export const DESIGNED_PROSPECTS_PER_DAY = 100;

/** Time the crawl and PageSpeed may use, from when the claim returns. */
export function workWindowMs(claimDoneAt: number, start: number): number {
  return Math.max(0, start + ROUTE_BUDGET_MS - SAVE_TIMEOUT_MS - claimDoneAt);
}

export const plan = {
  weeklyLoad: DESIGNED_PROSPECTS_PER_DAY * 7,
  weeklyCapacity: SITES_PER_RUN * RUNS_PER_WEEKDAY * WEEKDAYS,
  callsPerWeek: RUNS_PER_WEEKDAY * WEEKDAYS,
  worstCaseMs: CLAIM_TIMEOUT_MS + Math.max(SITE_BUDGET_MS, PSI_TIMEOUT_MS) + SAVE_TIMEOUT_MS + HEARTBEAT_MS,
};
