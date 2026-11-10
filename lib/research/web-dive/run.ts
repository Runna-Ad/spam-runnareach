/**
 * One /api/research/web-dive run: claim one due prospect at a time, check the
 * budget for its tenant, dive, save. Dependencies are injected so the budget
 * and the outcomes are testable without a network or a database
 * (tests/web-dive-run.test.ts).
 *
 * Budget, before each dive (else the claim is given back and the run stops):
 *   - Claude spend: cap − spent in the rolling 24h ≥ $1 (MIN_CAP_LEFT_USD), so
 *     the dive never eats the last of the day's budget for drafts and replies;
 *     a read error is "do not dive" (isUnderDailyCap fails open, so spent is
 *     re-read failing closed);
 *   - the dive's own ceiling: dives spent ≤ $1.70 in the rolling 24h
 *     (DIVE_BUDGET_24H_USD − DIVE_COST_ALLOWANCE_USD), so with one more dive
 *     (~$0.19-0.22 measured, 2026-11-09) they stay under about $2 a day. It
 *     is "about": a dive with a long search context (~$0.40), or a hand call
 *     with the cron secret running beside the scheduled one, can end a few
 *     cents over $2;
 *   - fewer than 25 dives started for the tenant in the last 24h.
 * Time (vercel.json gives the route 120 s), worst case from the handler's start:
 *   dive 1   claim 5 s + budget reads 5 s (cap, spend and count in parallel,
 *            each bounded) + Claude call 50 s + save 5 s                 = 65 s
 *   dive 2   only when ≥ 55 s remain before the 105 s deadline, checked again
 *            right before the call: it ends by 100 s, its save by 105 s
 *   heartbeat write 3 s                                                  → 108 s
 * A run killed mid-dive leaves its row pending; the next claim marks it
 * abandoned after 10 minutes (counts as one of the prospect's two tries).
 */

import { CALL_TIMEOUT_MS, MIN_REMAINING_TO_START_MS, RUN_DEADLINE_MS } from "../../benchmarks/research.ts";
import type { DiveOutcome, DiveStatus } from "./dive.ts";
import type { DueDive } from "./store.ts";

export const DIVES_PER_RUN = 2;
export const MIN_CAP_LEFT_USD = 1;
/** The web dive's own rolling-24h ceiling (Pedro's brief, 2026-11-09: "about $2"). */
export const DIVE_BUDGET_24H_USD = 2;
/** What one more dive may cost: a dive starts only while this much is left under the ceiling. */
export const DIVE_COST_ALLOWANCE_USD = 0.3;
export const MAX_DIVES_PER_24H = 25;
export const DB_TIMEOUT_MS = 5_000;
export const HEARTBEAT_MS = 3_000;
export const ROUTE_MAX_DURATION_S = 120;
export { CALL_TIMEOUT_MS, MIN_REMAINING_TO_START_MS, RUN_DEADLINE_MS };

/** spentUsd: all Claude spend in 24h; diveSpentUsd: the web dive's part of it (cost entity web_research). */
export type CapState = { spentUsd: number; capUsd: number; diveSpentUsd: number } | { error: string };

export type RunDeps = {
  /** Claims at most one due prospect (sweeping stale claims first). Throws on a database error. */
  claim: () => Promise<DueDive[]>;
  capState: (tenantId: string) => Promise<CapState>;
  /** Dives started for the tenant in the last 24h, the given claim excluded. */
  startedLast24h: (tenantId: string, excludeResearchId: string) => Promise<{ count: number } | { error: string }>;
  release: (researchId: string) => Promise<{ ok: boolean; error?: string }>;
  dive: (due: DueDive) => Promise<DiveOutcome>;
  save: (researchId: string, outcome: DiveOutcome) => Promise<{ ok: boolean; error?: string }>;
  /** Milliseconds; injectable so the time budget is testable. */
  now?: () => number;
};

export type StopReason = "none_due" | "deadline" | "cap" | "dive_budget" | "cap_read" | "daily_limit" | "count_read" | "search_disabled";

export type RunReport = {
  claimed: number;
  dived: number;
  saved: number;
  released: number;
  outcomes: Partial<Record<DiveStatus, number>>;
  costUsd: number;
  stopped: StopReason | null;
  /** What the budget saw when it stopped the run (a designed stop, not an error). */
  stopDetail: string | null;
  errors: string[];
};

/** Why a dive may not start for this tenant now, or null when it may. Pure (tested). */
export function budgetStop(cap: CapState, started: { count: number } | { error: string }): { reason: StopReason; detail: string } | null {
  if ("error" in cap) return { reason: "cap_read", detail: cap.error };
  const left = cap.capUsd - cap.spentUsd;
  if (!(left >= MIN_CAP_LEFT_USD)) {
    return { reason: "cap", detail: `AI budget: $${cap.spentUsd.toFixed(2)} of $${cap.capUsd.toFixed(2)} used in 24h (a dive needs $${MIN_CAP_LEFT_USD.toFixed(2)} left)` };
  }
  if (!(DIVE_BUDGET_24H_USD - cap.diveSpentUsd >= DIVE_COST_ALLOWANCE_USD)) {
    return {
      reason: "dive_budget",
      detail: `web search budget: $${cap.diveSpentUsd.toFixed(2)} of $${DIVE_BUDGET_24H_USD.toFixed(2)} used in 24h (a dive needs $${DIVE_COST_ALLOWANCE_USD.toFixed(2)} left)`,
    };
  }
  if ("error" in started) return { reason: "count_read", detail: started.error };
  if (started.count >= MAX_DIVES_PER_24H) return { reason: "daily_limit", detail: `${started.count} dives started in the last 24h (max ${MAX_DIVES_PER_24H})` };
  return null;
}

/** Enough time left (from the handler's start) to begin a Claude call and save it. */
export const timeToStart = (start: number, now: number): boolean => RUN_DEADLINE_MS - (now - start) >= MIN_REMAINING_TO_START_MS;

export async function runWebDives(deps: RunDeps, start: number): Promise<RunReport> {
  const now = deps.now ?? Date.now;
  const report: RunReport = { claimed: 0, dived: 0, saved: 0, released: 0, outcomes: {}, costUsd: 0, stopped: null, stopDetail: null, errors: [] };

  const giveBack = async (due: DueDive, reason: StopReason, detail: string) => {
    const r = await deps.release(due.research_id).catch((e: unknown) => ({ ok: false, error: String(e) }));
    if (r.ok) report.released++;
    // Not released: the row stays pending and is swept as abandoned (one of the prospect's two tries).
    else report.errors.push(`${due.id}: claim not released (${r.error ?? "unknown"})`);
    report.stopped = reason;
    report.stopDetail = detail.slice(0, 300) || null;
  };

  for (let i = 0; i < DIVES_PER_RUN; i++) {
    if (i > 0 && !timeToStart(start, now())) {
      report.stopped = "deadline";
      break;
    }
    let claimed: DueDive[];
    try {
      claimed = await deps.claim();
    } catch (err) {
      // The first claim failing is the run failing (the route answers 500, the heartbeat records it).
      if (i === 0) throw err;
      report.errors.push(`claim: ${err instanceof Error ? err.message : String(err)}`.slice(0, 300));
      break;
    }
    const due = claimed[0];
    report.claimed += claimed.length;
    // claim() asks for one; anything more goes straight back.
    for (const extra of claimed.slice(1)) await deps.release(extra.research_id).catch(() => undefined);
    if (!due) {
      if (i === 0) report.stopped = "none_due";
      break;
    }

    const [cap, started] = await Promise.all([
      deps.capState(due.tenant_id).catch((e: unknown): CapState => ({ error: `cap read threw: ${String(e)}` })),
      deps.startedLast24h(due.tenant_id, due.research_id).catch((e: unknown) => ({ error: `count threw: ${String(e)}` })),
    ]);
    const stop = budgetStop(cap, started);
    if (stop) {
      await giveBack(due, stop.reason, stop.detail);
      break;
    }
    if (!timeToStart(start, now())) {
      await giveBack(due, "deadline", "too little time left for a Claude call");
      break;
    }

    report.dived++;
    // A dive that throws is a bug, not a page fact: saved as failed (one of the two tries), never left pending.
    const outcome = await deps.dive(due).catch(
      (err: unknown): DiveOutcome => ({
        status: "failed", facts: [], dropped: [], searches: 0, costUsd: null, model: "", searchDisabled: false,
        error: `dive threw: ${err instanceof Error ? err.message : String(err)}`.slice(0, 300),
      }),
    );
    report.outcomes[outcome.status] = (report.outcomes[outcome.status] ?? 0) + 1;
    report.costUsd += outcome.costUsd ?? 0;
    const saved = await deps.save(due.research_id, outcome).catch((e: unknown) => ({ ok: false, error: String(e) }));
    if (saved.ok) report.saved++;
    else report.errors.push(`${due.id}: not saved (${saved.error ?? "unknown"})`.slice(0, 300));
    if (outcome.status === "failed" && outcome.error) report.errors.push(`${due.id}: ${outcome.error}`.slice(0, 300));
    if (outcome.searchDisabled) {
      // Every dive would fail the same way: stop here, the rest stay unclaimed.
      report.stopped = "search_disabled";
      break;
    }
  }
  report.costUsd = Math.round(report.costUsd * 1_000_000) / 1_000_000;
  return report;
}
