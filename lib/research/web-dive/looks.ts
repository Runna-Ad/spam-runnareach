/**
 * "Look twice before the first email" (brief tasks/briefs/web-dive.md): a
 * prospect that passed every gate waits in status `match` until both looks are
 * finished, its own website (site_observations, 0054) and the rest of the web
 * (web_research, 0055). Pure decisions; the tick step that acts on them is
 * ready.ts.
 */

import { scheduledRuns } from "../../reports/health.ts";
import { cronsOf } from "../../reports/heartbeat.ts";
import type { LookState } from "./store.ts";

/** audit_log metadata.kind the pipeline writes when a prospect enters `match` (action prospect.scored). */
export const WAITING_FOR_LOOKS = "waiting_for_looks";

/** The site look counts a finished crawl this recent (the crawler re-crawls after 30 days). */
export const SITE_LOOK_DAYS = 30;
/** site_observations: a pending row older than this was killed (0054 sweeps it to abandoned). */
const SITE_PENDING_ABANDON_MS = 15 * 60_000;

/**
 * Waiting longer than this, the first email is drafted anyway ("looks timed out").
 * The clock counts only while the looks can run: both jobs run on weekdays in
 * 15-22 UTC, so the timeout also needs LOOK_TIMEOUT_DIVE_RUNS scheduled dive
 * runs since the prospect entered `match`. Any 24 h that starts Monday to
 * Thursday holds exactly 32 (8 hours × 4), so on weekdays this is the plain
 * 24 h; over a weekend the clock waits for Monday's looks instead of drafting
 * on Saturday with neither look done. Set LOOK_TIMEOUT_DIVE_RUNS to 0 for a
 * plain 24 h.
 */
export const LOOKS_TIMEOUT_MS = 24 * 3_600_000;
export const LOOK_TIMEOUT_DIVE_RUNS = 32;

const DAY_MS = 86_400_000;

export type SiteLook = "done" | "waiting";
export type SiteRow = { status: string; crawled_at: string };

/**
 * The site look is finished when the prospect has no website or domain to read,
 * a FINISHED crawl (any status but pending and abandoned) in the last 30 days,
 * or two abandoned crawls in 30 days (the crawler gives up on that site).
 */
export function siteLookState(p: { domain: string | null; website_url: string | null }, rows: readonly SiteRow[], now: Date): SiteLook {
  if (!p.domain?.trim() && !p.website_url?.trim()) return "done";
  const since = now.getTime() - SITE_LOOK_DAYS * DAY_MS;
  let abandoned = 0;
  for (const r of rows) {
    const at = Date.parse(r.crawled_at);
    if (!Number.isFinite(at) || at <= since) continue;
    if (r.status === "abandoned" || (r.status === "pending" && at < now.getTime() - SITE_PENDING_ABANDON_MS)) abandoned++;
    else if (r.status !== "pending") return "done";
  }
  return abandoned >= 2 ? "done" : "waiting";
}

/** Waited past the timeout, counted as above. */
export function looksTimedOut(enteredAtMs: number, nowMs: number, diveRuns: number = LOOK_TIMEOUT_DIVE_RUNS): boolean {
  if (!Number.isFinite(enteredAtMs) || nowMs - enteredAtMs <= LOOKS_TIMEOUT_MS) return false;
  return diveRuns <= 0 || scheduledRuns(cronsOf("web-dive"), enteredAtMs, nowMs, diveRuns) >= diveRuns;
}

export type FirstDraftReason = "looks done" | "looks timed out";
export type FirstDraftDecision = { draft: true; reason: FirstDraftReason } | { draft: false };
/** The web look, or "off" when the web dive is switched off (flag.ts): nothing to wait for, counted as done. */
export type WebLook = LookState | "off";

/** Draft once the site look is finished and the web look is done, gave up or off; else only after the timeout. */
export function firstDraftDecision(i: { site: SiteLook; web: WebLook; enteredAtMs: number; nowMs: number }): FirstDraftDecision {
  if (i.site === "done" && (i.web === "done" || i.web === "gave_up" || i.web === "off")) return { draft: true, reason: "looks done" };
  if (looksTimedOut(i.enteredAtMs, i.nowMs)) return { draft: true, reason: "looks timed out" };
  return { draft: false };
}
