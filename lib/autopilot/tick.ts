import "server-only";

/**
 * One autopilot tick for one tenant. Called by /api/autopilot/tick on a
 * schedule (Supabase pg_cron, migration 0041). Every decision comes from the
 * pure, tested modules; this file only gathers data and applies results.
 *
 *   1. breakers   pause inboxes / all sending on bounces, opt-out spikes, bad
 *                 placement, DMARC or blocklist trouble (governor.evaluateBreakers)
 *   2. watchdog   restart discovery jobs whose self-chain died
 *   3. supply     when tomorrow's sending needs pitches, the scout picks one
 *                 search cell and starts a discovery job for it
 *   4. label      every new draft gets AUTO / REVIEW / DROP (governor.laneFor),
 *                 verifying the recipient first if it hasn't been
 *   4b. resolve   nothing waits on a person: a held draft gets one rewrite if a
 *                 rewrite can fix what held it, else it is dropped
 *                 (governor.heldAction); an address the verifier doubts is
 *                 fixed by writing to the prospect's next unflagged contact
 *   4c. redraft   a prospect whose only draft was thrown away for its writing
 *                 gets one fresh draft 14 days later (governor.redraftOf),
 *                 at most 3 a tick and 10 a day, inside the AI cap
 *   5. schedule   veto stage: AUTO pitches approved and scheduled 18h out, with
 *                 a digest so a person can hold any; auto stage: scheduled now
 *   6. stage      promote / demote the autonomy stage on measured results;
 *                 only pitch quality acts (a factual error, an opt-out
 *                 spike), never a delivery breaker: auto drops to veto, veto
 *                 restarts its clock (never down to shadow automatically)
 *   7. learn      re-score writer variants and search cells from outcomes;
 *                 weekly AI review proposes new guidance to test (learn.ts)
 *
 * With the autopilot off (kill switch, stage off) only the safety steps run:
 * the pull-back of automatic approvals still waiting, the veto digest, and
 * 1 (breakers). The route ticks every tenant with a state row for this.
 *
 * Every autonomous change writes a learning_insights row; breaker trips and
 * stage changes also email the notify address. A tick that hit errors leaves
 * an audit_log row (recordTickErrors) for the health check.
 */

import type { Actor } from "@/lib/actor";
import { isUnderDailyCap } from "@/lib/anthropic/cost-tracking";
import { evolveSearchSpace, learnFromOutcomes, weeklyReview } from "./learn";
import { bouncesTodayAfterResume, inboxBounceStats } from "./bounce-breaker";
import { gmailFailuresToday } from "./send-failures";
import { optOutMetrics } from "./opt-out-count";
import {
  buildVetoDigest,
  DIGEST_HORIZON_HOURS,
  digestDue,
  demotionHoldReason,
  holdAutoApprovals,
  KILL_SWITCH_HOLD_REASON,
  lastDigestSlot,
  pullbackSentence,
  pullsBackApprovals,
  relabelFinderDrafts,
  stageQualityTrips,
  VETO_WINDOW_HOURS,
  type DigestItem,
  type PullbackResult,
} from "./hold";
import { holdSecret } from "./hold-token";
import { resumeDiscoveryJobWith, startDiscoveryJobWith } from "@/lib/discover/job-stage";
import { EMPTY_JOB_STATS } from "@/lib/discover/job-types";
import type { Arm } from "@/lib/learning/bandit";
import {
  aiBudgetAllowance,
  candidateCells,
  cellKey,
  chooseCellFromArms,
  dailyAllowance,
  discoveryBudget,
  type SearchCell,
} from "@/lib/learning/scout";
import { editRatio } from "@/lib/pitches/decision";
import { fetchTopUsableContact, hasAlternativeRecipient, RECIPIENT_COLUMNS, type VerdictContact } from "@/lib/pitches/contacts";
import { generatePitchWith, transitionPitchStatusWith } from "@/lib/pitches/pitch-stage";
import { prospectSendBlock } from "@/lib/pitches/status-transitions";
import { isEmailOnDncList } from "@/lib/discover/dnc-check";
import { WRITER_FIXABLE } from "@/lib/pitches/review";
import { sendNotification, type NotificationResult } from "@/lib/notify/send";
import { storedVerdictUsable, verifyRecipient } from "@/lib/research/verify-recipient";
import { checkDeliverabilityHealth } from "@/lib/warmup/deliverability";
import { analyzeSpamRate } from "@/lib/warmup/intelligence";
import type { WarmupLogEntry } from "@/lib/warmup/types";
import {
  countVetoes,
  evaluateBreakers,
  HELD_BY_PERSON,
  heldAction,
  laneFor,
  nextStage,
  isQualityBreaker,
  REDRAFT_AFTER_DAYS,
  REDRAFT_FAILED,
  REDRAFT_OF,
  redraftOf,
  rejectedForWriting,
  REDRAFTS_PER_DAY,
  REDRAFTS_PER_TICK,
  REWRITE_FAILED,
  safetyOnly,
  STAGE_RULES,
  stageClockStart,
  VERIFIER_DROP_REASON,
  VERIFIER_UNSURE_REASON,
  VETO_RESTART_HOLD_REASON,
  type BreakerMetrics,
  type BreakerTrip,
  type Lane,
  type RedraftPitch,
  type Stage,
  type StageMetrics,
} from "./governor";

// The new tables (0040) aren't in the generated types; queries go through any.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Db = any;

/** Veto stage: how long a person has to hold an AUTO pitch before it sends (lib/autopilot/hold.ts). */
export { VETO_WINDOW_HOURS };
/** A running job whose heartbeat is older than this has a dead chain. */
const STALE_JOB_MS = 100_000;
const LABEL_BATCH = 40;
const SCHEDULE_BATCH = 25;
/** Stop starting slow work (verification, approvals) past this, under the route's cap. */
const TICK_BUDGET_MS = 90_000;
/** Rewrites per tick: each is a full write + review (up to ~60s). */
const REWRITES_PER_TICK = 2;
/** Don't start a rewrite the AI budget can't finish (it would fall back to a template). */
const REWRITE_MIN_BUDGET_USD = 0.25;
const DAY = 86_400_000;

export type AutonomyState = {
  tenant_id: string;
  stage: Stage;
  stage_since: string;
  enabled: boolean;
};

export type TickReport = {
  tenantId: string;
  stage: Stage | null;
  skipped: string | null;
  breakers: BreakerTrip[];
  resumedJobs: number;
  discovery: { started: boolean; reason: string; cell?: string; budget?: number };
  labelled: Record<Lane, number>;
  resolved: { rewritten: number; dropped: number; waiting: string | null };
  /** 4c: fresh drafts for prospects whose only draft was thrown away for its writing. */
  redrafted?: { drafted: number; failed: number; waiting: string | null };
  scheduled: number;
  /** Emails listed in the twice-daily veto digest this tick (0 when no slot was due). */
  digest?: number;
  /** from === to: the veto clock restarted (governor.nextStage restart). */
  stageChange: { from: Stage; to: Stage; reason: string } | null;
  /** Automatic approvals held because the stage is (or dropped to) shadow/off. */
  pulledBack?: number;
  review?: { ran: boolean; reason: string; guidance: string[] } | null;
  errors: string[];
};

/** audit_log action of the row a tick with errors leaves (read by the health check, lib/reports). */
export const TICK_ERRORS_ACTION = "autopilot.tick_errors";
const TICK_ERRORS_MAX = 20;
const TICK_ERROR_CHARS = 300;

export async function runTick(actor: Actor, now: Date = new Date()): Promise<TickReport> {
  const report = emptyReport(actor.user.tenantId);
  try {
    return await runTickSteps(actor, now, report);
  } catch (err) {
    // Outside any step(): still leave the row, then fail as before.
    report.errors.push(`tick: ${(err as Error)?.message ?? String(err)}`);
    throw err;
  } finally {
    await recordTickErrors(actor.supabase as Db, actor.user.tenantId, report.errors);
  }
}

function emptyReport(tenantId: string): TickReport {
  return {
    tenantId,
    stage: null,
    skipped: null,
    breakers: [],
    resumedJobs: 0,
    discovery: { started: false, reason: "not run" },
    labelled: { auto: 0, review: 0, drop: 0 },
    resolved: { rewritten: 0, dropped: 0, waiting: null },
    scheduled: 0,
    stageChange: null,
    errors: [],
  };
}

/**
 * A tick that hit errors leaves one audit_log row, so they are not only in the
 * route's JSON nobody reads. Frozen contract with the health check: action
 * TICK_ERRORS_ACTION, entity tenant, metadata { errors } (≤ 20, ≤ 300 chars
 * each). No row for a clean tick. Never throws.
 */
export async function recordTickErrors(db: Db, tenantId: string, errors: readonly string[]): Promise<void> {
  if (errors.length === 0) return;
  try {
    const { error } = await db.from("audit_log").insert({
      tenant_id: tenantId,
      actor_id: null,
      action: TICK_ERRORS_ACTION,
      entity_type: "tenant",
      entity_id: tenantId,
      metadata: { errors: errors.slice(0, TICK_ERRORS_MAX).map((e) => String(e).slice(0, TICK_ERROR_CHARS)) },
    });
    if (error) console.warn("[autopilot] tick errors not recorded:", error.message || "no detail");
  } catch (err) {
    console.warn("[autopilot] tick errors record threw:", (err as Error)?.message ?? err);
  }
}

async function runTickSteps(actor: Actor, now: Date, report: TickReport): Promise<TickReport> {
  const db = actor.supabase as Db;
  const tenantId = actor.user.tenantId;
  const deadline = now.getTime() + TICK_BUDGET_MS;

  const { data: state } = await db
    .from("autonomy_state")
    .select("tenant_id, stage, stage_since, enabled")
    .eq("tenant_id", tenantId)
    .maybeSingle();
  const s = state as AutonomyState | null;
  const step = async <T>(name: string, fn: () => Promise<T>, fallback: T): Promise<T> => {
    try {
      return await fn();
    } catch (err) {
      report.errors.push(`${name}: ${(err as Error).message}`);
      return fallback;
    }
  };

  // Kill switch or stage off: no automatic approval stays waiting to send (the
  // send-queue sends approved pitches whatever the stage). Before the digest,
  // so the digest never lists an approval this same tick holds.
  if (safetyOnly(s)) {
    const reason = s && s.enabled ? demotionHoldReason("off") : KILL_SWITCH_HOLD_REASON;
    const sweep = await step("pullback", () => holdAutoApprovals(db, tenantId, "off", reason), { held: 0, error: null });
    if (sweep.error) report.errors.push(`pullback: ${sweep.error}`);
    if (sweep.held > 0) {
      report.pulledBack = sweep.held;
      await insight(db, tenantId, {
        learner: "governor",
        kind: "stage",
        title: `Held ${sweep.held} automatic approval${sweep.held === 1 ? "" : "s"} still waiting with the autopilot off`,
        evidence: sweep,
      });
    }
  }
  // The digest lists approved emails, and the send-queue sends them whatever the
  // stage, so it runs even when the autopilot is switched off or was demoted.
  // Only the auto stage (scheduled to send now, no veto window) skips it. Early,
  // so it runs well inside the time budget.
  if (s && s.stage !== "auto") {
    try {
      report.digest = await sendVetoDigest(db, tenantId, now);
    } catch (err) {
      report.errors.push(`digest: ${(err as Error).message}`);
    }
  }

  // Breakers whatever the stage: the send-queue sends approved pitches (and
  // blocks an inbox on fresh bounces for one run only) even with the autopilot
  // off, so only this step turns trouble into a pause + email.
  report.breakers = await step("breakers", () => runBreakers(db, tenantId, now, report.errors), []);
  if (!s || safetyOnly(s)) {
    report.skipped = "autopilot off for this tenant";
    return report;
  }
  report.stage = s.stage;

  const sendingHalted = report.breakers.some((t) => t.scope === "all");
  report.resumedJobs = await step("watchdog", () => resumeStaleJobs(actor, db, now), 0);
  report.discovery = await step("supply", () => maybeStartDiscovery(actor, db, now), { started: false, reason: "error" });
  report.labelled = await step("label", () => labelDrafts(actor, db, now, deadline), report.labelled);
  report.resolved = await step("resolve", () => resolveHeld(actor, db, now, deadline), report.resolved);
  report.redrafted = await step("redraft", () => redraftPool(actor, db, now, deadline), { drafted: 0, failed: 0, waiting: "error" });
  if ((s.stage === "veto" || s.stage === "auto") && !sendingHalted) {
    report.scheduled = await step("schedule", () => scheduleAuto(actor, db, s.stage, now, deadline), 0);
  }
  const stage = await step("stage", () => evaluateStage(db, s, now), { change: null, pullback: null });
  report.stageChange = stage.change;
  if (stage.pullback) {
    report.pulledBack = stage.pullback.held;
    if (stage.pullback.error) report.errors.push(`pullback: ${stage.pullback.error}`);
  }
  // Learning: re-score every arm from settled outcomes (cheap), and once a
  // week let the AI review propose new writing guidance to test.
  await step("learn", () => learnFromOutcomes(db, tenantId, now), undefined);
  await step("icp", () => evolveSearchSpace(db, tenantId, now), null);
  if (Date.now() < deadline) {
    report.review = await step("review", () => weeklyReview(db, tenantId, now), null);
  }
  return report;
}

// ── Insights and alerts ───────────────────────────────────────────────────────

async function insight(
  db: Db,
  tenantId: string,
  row: { learner: string; kind: string; title: string; detail?: string; evidence?: unknown; applied?: boolean },
): Promise<void> {
  const { error } = await db.from("learning_insights").insert({
    tenant_id: tenantId,
    learner: row.learner,
    kind: row.kind,
    title: row.title,
    detail: row.detail ?? null,
    evidence: row.evidence ?? {},
    applied: row.applied ?? true,
  });
  if (error) console.warn("[autopilot] insight not recorded:", error.message);
}

/** Email the ops notify list (lib/notify/recipients.ts) from the oldest connected inbox. */
export async function notify(db: Db, tenantId: string, subject: string, body: string): Promise<NotificationResult> {
  return sendNotification(db, tenantId, { kind: "ops", subject, body, fromName: "S.P.A.M. Autopilot" });
}

const appUrl = () => process.env.NEXT_PUBLIC_APP_URL || "https://spam-runnareach.vercel.app";

// ── 1. Circuit breakers ───────────────────────────────────────────────────────

async function runBreakers(db: Db, tenantId: string, now: Date, errors: string[]): Promise<BreakerTrip[]> {
  const { data: inboxRows } = await db
    .from("sender_inboxes")
    .select("id, email, paused")
    .eq("tenant_id", tenantId);
  const inboxes = (inboxRows ?? []) as Array<{ id: string; email: string; paused: boolean }>;

  // Bounces count only after the inbox's latest resume (lib/autopilot/bounce-breaker.ts),
  // so a person's resume sticks; an inbox never resumed counts as before.
  const inboxStats: BreakerMetrics["inboxes"] = [];
  // Gmail send failures (lib/autopilot/send-failures.ts) in the same window: today, after the resume.
  for (const inbox of inboxes) {
    const stats = await inboxBounceStats(db, tenantId, inbox.id);
    const gmail = await gmailFailuresToday(db, tenantId, inbox.id, now, stats.resumedAt);
    if (gmail.error) errors.push(gmail.error);
    inboxStats.push({ id: inbox.id, recentSends: stats.recentSends, recentHardBounces: stats.recentHardBounces, apiErrorsToday: gmail.count });
  }

  const weekAgo = new Date(now.getTime() - 7 * DAY).toISOString();
  // Opt-outs count people, not events (lib/autopilot/opt-out-count.ts).
  const [bouncesToday, optOuts] = await Promise.all([
    bouncesTodayAfterResume(db, tenantId, now),
    optOutMetrics(db, tenantId, now),
  ]);
  errors.push(...optOuts.errors);

  // DMARC from the latest Postmaster snapshot (last 3 days), if any.
  const domain = inboxes[0]?.email.split("@")[1] ?? null;
  let dmarcPassRate: number | null = null;
  if (domain) {
    const { data: health } = await db
      .from("domain_health")
      .select("dmarc_success_ratio, recorded_date")
      .eq("tenant_id", tenantId)
      .eq("domain", domain)
      .gte("recorded_date", new Date(now.getTime() - 3 * DAY).toISOString().slice(0, 10))
      .order("recorded_date", { ascending: false })
      .limit(1);
    const ratio = (health ?? [])[0]?.dmarc_success_ratio;
    if (typeof ratio === "number") dmarcPassRate = ratio;
  }

  let blocklisted = false;
  if (domain) {
    try {
      const dh = await checkDeliverabilityHealth(domain);
      blocklisted = dh.blocklist.listed_on.length > 0;
    } catch {
      // DNS hiccup: unknown is not "listed".
    }
  }

  const { data: warm } = await db
    .from("warmup_log")
    .select("direction, landed_in_inbox")
    .eq("tenant_id", tenantId)
    .gte("created_at", weekAgo);
  const placement = analyzeSpamRate((warm ?? []) as WarmupLogEntry[]);

  const trips = evaluateBreakers({
    inboxes: inboxStats,
    hardBouncesToday: bouncesToday,
    optOutsThisWeek: optOuts.optOutsThisWeek,
    optOutWeeklyBaseline: optOuts.optOutWeeklyBaseline,
    dmarcPassRate,
    blocklisted,
    warmupInboxRate: placement.inboxRate,
  });

  // Apply: pause what isn't paused yet. Resuming stays a person's decision.
  const applied: BreakerTrip[] = [];
  for (const trip of trips) {
    const targets = trip.scope === "inbox" ? inboxes.filter((i) => i.id === trip.inboxId) : inboxes;
    const toPause = targets.filter((i) => !i.paused).map((i) => i.id);
    if (toPause.length === 0) continue;
    const { error } = await db
      .from("sender_inboxes")
      .update({ paused: true, paused_reason: `Autopilot breaker (${trip.code}): ${trip.reason}` })
      .in("id", toPause)
      .eq("tenant_id", tenantId);
    if (error) continue;
    for (const i of inboxes) if (toPause.includes(i.id)) i.paused = true;
    applied.push(trip);
    await insight(db, tenantId, { learner: "governor", kind: "breaker", title: `Paused sending: ${trip.reason}`, evidence: trip });
    await notify(
      db,
      tenantId,
      `Autopilot paused sending: ${trip.reason}`,
      `The autopilot paused ${trip.scope === "all" ? "all cold sending" : "one sending inbox"} because ${trip.reason}.\n\n` +
        `Nothing will send from ${trip.scope === "all" ? "any inbox" : "that inbox"} until a person resumes it in Settings → Sending.\n\n${appUrl()}/settings/sending`,
    );
  }
  return applied;
}

// ── 2. Watchdog ───────────────────────────────────────────────────────────────

async function resumeStaleJobs(actor: Actor, db: Db, now: Date): Promise<number> {
  const { data } = await db
    .from("discovery_jobs")
    .select("id")
    .eq("tenant_id", actor.user.tenantId)
    .eq("status", "running")
    .lt("heartbeat_at", new Date(now.getTime() - STALE_JOB_MS).toISOString());
  let resumed = 0;
  for (const job of (data ?? []) as Array<{ id: string }>) {
    const r = await resumeDiscoveryJobWith(actor, job.id);
    if (r.ok && r.resumed) resumed++;
  }
  return resumed;
}

// ── 3. Supply: the scout ──────────────────────────────────────────────────────

async function maybeStartDiscovery(actor: Actor, db: Db, now: Date): Promise<TickReport["discovery"]> {
  const tenantId = actor.user.tenantId;
  const { count: running } = await db
    .from("discovery_jobs")
    .select("id", { count: "exact", head: true })
    .eq("tenant_id", tenantId)
    .eq("status", "running");
  if ((running ?? 0) > 0) return { started: false, reason: "a discovery job is already running" };

  const { data: inboxRows } = await db
    .from("sender_inboxes")
    .select("daily_cap, paused, gmail_refresh_token_encrypted")
    .eq("tenant_id", tenantId);
  const capacity = ((inboxRows ?? []) as Array<{ daily_cap: number | null; paused: boolean; gmail_refresh_token_encrypted: string | null }>)
    .filter((i) => !i.paused && i.gmail_refresh_token_encrypted)
    .reduce((sum, i) => sum + (i.daily_cap ?? 0), 0);
  if (capacity === 0) return { started: false, reason: "no active sending capacity" };

  const { count: waiting } = await db
    .from("pitches")
    .select("id", { count: "exact", head: true })
    .eq("tenant_id", tenantId)
    .in("status", ["draft", "approved"])
    .is("sent_at", null)
    .is("parent_pitch_id", null)
    .gte("created_at", new Date(now.getTime() - 14 * DAY).toISOString());

  // Recent yield: pitches produced per prospect researched by finished jobs.
  // Counters only: stats also carries id lists, and this runs every tick.
  const { data: jobs } = await db
    .from("discovery_jobs")
    .select("pitched:stats->pitched, processed:stats->processed")
    .eq("tenant_id", tenantId)
    .eq("status", "done")
    .gte("created_at", new Date(now.getTime() - 30 * DAY).toISOString());
  let pitched = 0;
  let processed = 0;
  for (const j of (jobs ?? []) as Array<{ pitched: number | null; processed: number | null }>) {
    pitched += j.pitched ?? 0;
    processed += j.processed ?? 0;
  }
  const pitchYield = processed >= 20 ? pitched / processed : 0.2;

  const budget = discoveryBudget({ dailySendCapacity: capacity, pitchesWaiting: waiting ?? 0, pitchYield });
  if (budget === 0) return { started: false, reason: `${waiting ?? 0} pitches already waiting for ${capacity}/day`, budget };

  const { data: todays } = await db
    .from("discovery_jobs")
    .select("processed:stats->processed")
    .eq("tenant_id", tenantId)
    .eq("stats->>started_by", "autopilot")
    .gte("created_at", new Date(now.getTime() - DAY).toISOString());
  const todayRows = (todays ?? []) as Array<{ processed: number | null }>;
  const daily = dailyAllowance({
    budget,
    jobsToday: todayRows.length,
    researchedToday: todayRows.reduce((sum, j) => sum + (j.processed ?? 0), 0),
  });
  if (daily.prospects === 0) return { started: false, reason: daily.reason, budget };

  // A job past the AI cap researches on the fallbacks (rule scores, template
  // pitches), so start one only as big as the budget left still pays for.
  const cap = await isUnderDailyCap(tenantId);
  const allowance = aiBudgetAllowance(daily, { spentUsd: cap.spent_today_usd, capUsd: cap.cap_usd });
  if (allowance.prospects === 0) return { started: false, reason: allowance.reason, budget };

  const { data: icps } = await db
    .from("icps")
    .select("id, search_keywords, geo_regions")
    .eq("tenant_id", tenantId)
    .eq("is_active", true);
  const cells = candidateCells((icps ?? []) as Array<{ id: string; search_keywords: string[] | null; geo_regions: string[] | null }>);
  if (cells.length === 0) return { started: false, reason: "no active ICP has search keywords", budget };
  const byKey = new Map(cells.map((c) => [cellKey(c), c]));

  const { data: armRows } = await db
    .from("learning_arms")
    .select("key, status, reward, trials, negatives, config")
    .eq("tenant_id", tenantId)
    .eq("learner", "scout.cell");
  const stored = new Map(
    ((armRows ?? []) as Array<{ key: string; status: Arm["status"]; reward: number; trials: number; negatives: number; config: { empty_runs?: number } | null }>)
      .map((r) => [r.key, r]),
  );
  const choice = chooseCellFromArms(
    cells.map((c) => {
      const key = cellKey(c);
      const row = stored.get(key);
      return {
        arm: { key, status: row?.status ?? "challenger", reward: row?.reward ?? 0, trials: row?.trials ?? 0, negatives: row?.negatives ?? 0 },
        emptyRuns: row?.config?.empty_runs ?? 0,
      };
    }),
  );
  const cell: SearchCell | undefined = choice ? byKey.get(cellKey(choice)) : undefined;
  if (!cell) return { started: false, reason: "every search cell is exhausted or retired", budget };
  const key = cellKey(cell);

  if (!stored.has(key)) {
    await db.from("learning_arms").upsert(
      {
        tenant_id: tenantId,
        learner: "scout.cell",
        key,
        config: { icp_id: cell.icpId, keyword: cell.keyword, region: cell.region, empty_runs: 0 },
        status: "challenger",
        origin: "seed",
      },
      { onConflict: "tenant_id,learner,key", ignoreDuplicates: true },
    );
  }

  const started = await startDiscoveryJobWith(actor, cell.icpId, "full");
  if (!started.ok) return { started: false, reason: started.error, cell: key, budget };
  // The first slice is triggered after this request returns, so the focus is
  // in place before the worker reads the job.
  await db
    .from("discovery_jobs")
    .update({
      stats: {
        ...EMPTY_JOB_STATS,
        focus: { keyword: cell.keyword, region: cell.region, cell_key: key },
        started_by: "autopilot",
        max_processed: allowance.prospects,
      },
    })
    .eq("id", started.jobId)
    .eq("tenant_id", tenantId);
  return { started: true, reason: allowance.reason, cell: key, budget: allowance.prospects };
}

// ── 4. Label drafts ───────────────────────────────────────────────────────────

type DraftRow = {
  id: string;
  prospect_id: string;
  contact_id: string | null;
  gate_verdict: { pass: boolean; failures: Array<{ code: string; severity: "block" | "review" }> } | null;
  decision: { path?: string; critic?: { pass: boolean; score: number } | null } | null;
};

async function labelDrafts(actor: Actor, db: Db, now: Date, deadline: number): Promise<Record<Lane, number>> {
  const tenantId = actor.user.tenantId;
  const counts: Record<Lane, number> = { auto: 0, review: 0, drop: 0 };
  const { data } = await db
    .from("pitches")
    .select("id, prospect_id, contact_id, gate_verdict, decision")
    .eq("tenant_id", tenantId)
    .eq("status", "draft")
    .is("autopilot_lane", null)
    .is("parent_pitch_id", null)
    .gte("created_at", new Date(now.getTime() - 14 * DAY).toISOString())
    .order("created_at", { ascending: true })
    .limit(LABEL_BATCH);

  for (const p of (data ?? []) as DraftRow[]) {
    if (Date.now() > deadline) break;
    let verify: "send" | "review" | "drop" | null = null;
    let selectedBy: string | null = null;
    if (p.contact_id) {
      const { data: c } = await db
        .from("prospect_contacts")
        .select("email, selected_by, verify_verdict, verify_checked_at, prospects:prospect_id(domain)")
        .eq("id", p.contact_id)
        .eq("tenant_id", tenantId)
        .maybeSingle();
      const contact = c as {
        email: string | null;
        selected_by: string | null;
        verify_verdict: "send" | "review" | "drop" | null;
        verify_checked_at: string | null;
        prospects: { domain: string | null } | null;
      } | null;
      selectedBy = contact?.selected_by ?? null;
      // A stored verdict is reused for 7 days, but never a "send" stored for a
      // finder address before those needed a person (verify-recipient.ts).
      const reusable =
        contact !== null &&
        storedVerdictUsable({ verdict: contact.verify_verdict, checkedAt: contact.verify_checked_at, selectedBy }, now);
      if (contact?.email && !reusable) {
        const r = await verifyRecipient(db, {
          tenantId,
          email: contact.email,
          selectedBy,
          prospectDomain: contact.prospects?.domain ?? null,
        });
        verify = r.verdict;
      } else {
        verify = contact?.verify_verdict ?? null;
      }
    }

    const { lane, reasons } = laneFor({
      gate: p.gate_verdict ? { pass: p.gate_verdict.pass, failures: p.gate_verdict.failures ?? [] } : null,
      critic: p.decision?.critic ? { pass: p.decision.critic.pass, score: p.decision.critic.score } : null,
      verify,
      recipientSelectedBy: selectedBy,
      path: p.decision?.path ?? "template",
    });
    await db
      .from("pitches")
      .update({ autopilot_lane: lane, autopilot_reasons: reasons })
      .eq("id", p.id)
      .eq("tenant_id", tenantId);
    counts[lane]++;
  }
  return counts;
}

// ── 4b. Resolve held drafts ───────────────────────────────────────────────────

async function resolveHeld(actor: Actor, db: Db, now: Date, deadline: number): Promise<TickReport["resolved"]> {
  const tenantId = actor.user.tenantId;
  const out: TickReport["resolved"] = { rewritten: 0, dropped: 0, waiting: null };
  const { data } = await db
    .from("pitches")
    .select("id, prospect_id, contact_id, autopilot_lane, autopilot_reasons, body_edited, decision")
    .eq("tenant_id", tenantId)
    .eq("status", "draft")
    .in("autopilot_lane", ["review", "drop"])
    .is("parent_pitch_id", null)
    .order("created_at", { ascending: true })
    .limit(LABEL_BATCH);

  let budget: { ok: boolean } | null = null;
  for (const p of (data ?? []) as Array<{
    id: string;
    prospect_id: string;
    contact_id: string | null;
    autopilot_lane: Lane;
    autopilot_reasons: string[] | null;
    body_edited: string | null;
    decision: { retry_of?: string; redraft_of?: string } | null;
  }>) {
    if (Date.now() > deadline) break;
    const held = {
      lane: p.autopilot_lane,
      reasons: p.autopilot_reasons ?? [],
      isRewrite: Boolean(p.decision?.retry_of),
      editedByPerson: p.body_edited !== null,
    };
    let next = heldAction(held, WRITER_FIXABLE);
    // A drop over the verifier's doubt about the address: would another contact take it?
    // Read only then (a person's draft is left alone without asking).
    if (next.action === "drop" && held.reasons.some((r) => r === VERIFIER_UNSURE_REASON || r === VERIFIER_DROP_REASON)) {
      const hasAlternativeContact = await alternativeContact(db, tenantId, p.prospect_id, p.contact_id, now);
      if (hasAlternativeContact) next = heldAction({ ...held, hasAlternativeContact }, WRITER_FIXABLE);
    }
    if (next.action === "leave") continue;
    if (next.action === "drop") {
      await dropDraft(db, tenantId, p.id, next.why);
      out.dropped++;
      continue;
    }

    // Rewrite: the writer revises this draft against the notes that held it
    // (a Claude draft; a template or unreadable one is written fresh), then
    // the same reviewer checks it. It replaces this one (generatePitch clears
    // the prospect's drafts) and is labelled on the next tick like any new draft.
    if (out.rewritten >= REWRITES_PER_TICK || deadline - Date.now() < 60_000) continue;
    if (!budget) {
      const cap = await isUnderDailyCap(tenantId);
      budget = { ok: cap.under && cap.cap_usd - cap.spent_today_usd >= REWRITE_MIN_BUDGET_USD };
      if (!budget.ok) out.waiting = `AI budget: $${cap.spent_today_usd.toFixed(2)} of $${cap.cap_usd.toFixed(2)} used in 24h`;
    }
    if (!budget.ok) continue;
    const rewritten = await generatePitchWith(actor, p.prospect_id, { retryOf: p.id });
    if (rewritten.ok) {
      out.rewritten++;
      // A re-draft's rewrite is still that re-draft (one per prospect, ever).
      if (p.decision?.redraft_of) await markDecision(db, tenantId, rewritten.pitch_id, { [REDRAFT_OF]: p.decision.redraft_of });
    } else {
      await dropDraft(db, tenantId, p.id, `${REWRITE_FAILED}${rewritten.error}`);
      out.dropped++;
    }
  }
  return out;
}

/**
 * Does the prospect have a usable contact, other than this draft's, that the
 * verifier has not flagged (lib/pitches/contacts.ts hasAlternativeRecipient,
 * the rule the rewrite's recipient comes from)? A read error is "no": the
 * draft drops as before, never rewritten on a guess.
 */
async function alternativeContact(db: Db, tenantId: string, prospectId: string, contactId: string | null, now: Date): Promise<boolean> {
  const { data, error } = await db
    .from("prospect_contacts")
    .select(RECIPIENT_COLUMNS)
    .eq("tenant_id", tenantId)
    .eq("prospect_id", prospectId)
    .order("priority_rank", { ascending: true })
    .limit(12);
  if (error || !Array.isArray(data)) return false;
  return hasAlternativeRecipient(data as Array<VerdictContact & { id: string }>, contactId, now);
}

/** Merge keys into a pitch's decision (read, then write; only this tick writes these keys). */
async function markDecision(db: Db, tenantId: string, pitchId: string, keys: Record<string, unknown>): Promise<void> {
  const { data, error } = await db.from("pitches").select("decision").eq("id", pitchId).eq("tenant_id", tenantId).maybeSingle();
  if (error || !data) {
    console.warn("[autopilot] decision not marked:", error?.message || "no row");
    return;
  }
  const decision = ((data as { decision: Record<string, unknown> | null }).decision ?? {}) as Record<string, unknown>;
  const { error: writeErr } = await db
    .from("pitches")
    .update({ decision: { ...decision, ...keys } })
    .eq("id", pitchId)
    .eq("tenant_id", tenantId);
  if (writeErr) console.warn("[autopilot] decision not marked:", writeErr.message || "no detail");
}

// ── 4c. Re-draft pool ─────────────────────────────────────────────────────────

/** Auto_rejected pitches read per tick to find re-draft candidates. */
const REDRAFT_SCAN = 100;

/**
 * A researched prospect is not thrown away for good because one draft failed
 * for its writing: 14 days later it gets one fresh draft (governor.redraftOf),
 * labelled next tick like any draft. At most REDRAFTS_PER_TICK a tick and
 * REDRAFTS_PER_DAY a UTC day, and only while the AI budget has at least the
 * rewrite minimum left. The prospect must still be "pitched" (nothing sent,
 * nothing parked), out of cooldown, and its recipient off the do-not-contact
 * list; a read error skips it.
 */
async function redraftPool(actor: Actor, db: Db, now: Date, deadline: number): Promise<NonNullable<TickReport["redrafted"]>> {
  const tenantId = actor.user.tenantId;
  const out: NonNullable<TickReport["redrafted"]> = { drafted: 0, failed: 0, waiting: null };
  if (deadline - Date.now() < 60_000) return { ...out, waiting: "tick time budget" };

  const midnight = new Date(now);
  midnight.setUTCHours(0, 0, 0, 0);
  const { data: today, error: todayErr } = await db
    .from("pitches")
    .select("decision")
    .eq("tenant_id", tenantId)
    .not(`decision->>${REDRAFT_OF}`, "is", null)
    .gte("created_at", midnight.toISOString())
    .limit(100);
  if (todayErr) throw new Error(`today's re-drafts not read: ${todayErr.message || "no detail"}`);
  // A re-draft's rewrite carries the same mark: count re-drafts, not rows.
  const doneToday = new Set(((today ?? []) as Array<{ decision: Record<string, unknown> | null }>).map((r) => String(r.decision?.[REDRAFT_OF]))).size;
  const room = Math.min(REDRAFTS_PER_TICK, REDRAFTS_PER_DAY - doneToday);
  if (room <= 0) return { ...out, waiting: `${REDRAFTS_PER_DAY} re-drafts today` };

  // Rows already re-drafted (or tried) are left out, so the scan moves on to new ones.
  const { data: rejected, error: rejErr } = await db
    .from("pitches")
    .select("prospect_id, auto_rejected_reason")
    .eq("tenant_id", tenantId)
    .eq("status", "auto_rejected")
    .is("parent_pitch_id", null)
    .is(`decision->>${REDRAFT_OF}`, null)
    .is(`decision->>${REDRAFT_FAILED}`, null)
    .lte("created_at", new Date(now.getTime() - REDRAFT_AFTER_DAYS * DAY).toISOString())
    .order("created_at", { ascending: false })
    .limit(REDRAFT_SCAN);
  if (rejErr) throw new Error(`auto_rejected pitches not read: ${rejErr.message || "no detail"}`);
  // Only a writing rejection is worth reading the rest of the prospect for (redraftOf decides).
  const prospectIds = [
    ...new Set(
      ((rejected ?? []) as Array<{ prospect_id: string; auto_rejected_reason: string | null }>)
        .filter((r) => rejectedForWriting(r.auto_rejected_reason, WRITER_FIXABLE))
        .map((r) => r.prospect_id),
    ),
  ];

  for (const prospectId of prospectIds) {
    if (out.drafted + out.failed >= room) break;
    if (deadline - Date.now() < 60_000) {
      out.waiting = "tick time budget";
      break;
    }
    // Every pitch the prospect has, follow-ups included: one that is not an
    // auto_rejected draft (sent, approved, sending, a live draft) rules it out.
    const { data: pitches, error: pErr } = await db
      .from("pitches")
      .select("id, status, created_at, auto_rejected_reason, decision")
      .eq("tenant_id", tenantId)
      .eq("prospect_id", prospectId)
      .limit(10);
    if (pErr || !Array.isArray(pitches)) continue;
    const replaces = redraftOf(pitches as RedraftPitch[], now, WRITER_FIXABLE);
    if (!replaces) continue;

    const { data: prospect, error: prospectErr } = await db
      .from("prospects")
      .select("status, cooldown_until")
      .eq("id", prospectId)
      .eq("tenant_id", tenantId)
      .maybeSingle();
    const row = prospect as { status: string | null; cooldown_until: string | null } | null;
    if (prospectSendBlock(row, prospectErr, now.toISOString()) || row?.status !== "pitched") continue;
    const recipient = await fetchTopUsableContact(db, tenantId, prospectId, now);
    if (!recipient) continue;
    const dnc = await isEmailOnDncList(db, tenantId, recipient.email);
    if (dnc.blocked || dnc.error) continue;

    const cap = await isUnderDailyCap(tenantId);
    if (!cap.under || cap.cap_usd - cap.spent_today_usd < REWRITE_MIN_BUDGET_USD) {
      out.waiting = `AI budget: $${cap.spent_today_usd.toFixed(2)} of $${cap.cap_usd.toFixed(2)} used in 24h`;
      break;
    }
    const drafted = await generatePitchWith(actor, prospectId);
    if (drafted.ok) {
      await markDecision(db, tenantId, drafted.pitch_id, { [REDRAFT_OF]: replaces });
      out.drafted++;
    } else {
      // One try per prospect: a failure that repeats would otherwise be retried every tick.
      await markDecision(db, tenantId, replaces, { [REDRAFT_FAILED]: { at: now.toISOString(), error: drafted.error.slice(0, 300) } });
      out.failed++;
    }
  }
  return out;
}

/** Close a draft the autopilot won't send: off the drafts list, reason kept for the weekly review. */
async function dropDraft(db: Db, tenantId: string, pitchId: string, why: string): Promise<void> {
  await db
    .from("pitches")
    .update({ status: "auto_rejected", auto_rejected: true, auto_rejected_reason: why.slice(0, 500), autopilot_lane: "drop" })
    .eq("id", pitchId)
    .eq("tenant_id", tenantId)
    .eq("status", "draft");
}

// ── 5. Schedule AUTO pitches ──────────────────────────────────────────────────

async function scheduleAuto(actor: Actor, db: Db, stage: Stage, now: Date, deadline: number): Promise<number> {
  const tenantId = actor.user.tenantId;
  const { data: inboxRows } = await db
    .from("sender_inboxes")
    .select("id, daily_cap, paused, gmail_refresh_token_encrypted")
    .eq("tenant_id", tenantId);
  const inboxes = ((inboxRows ?? []) as Array<{ id: string; daily_cap: number | null; paused: boolean; gmail_refresh_token_encrypted: string | null }>)
    .filter((i) => !i.paused && i.gmail_refresh_token_encrypted);
  if (inboxes.length === 0) return 0;
  const capacity = inboxes.reduce((sum, i) => sum + (i.daily_cap ?? 0), 0);

  // Don't queue more than a day of capacity at once.
  const { count: queued } = await db
    .from("pitches")
    .select("id", { count: "exact", head: true })
    .eq("tenant_id", tenantId)
    .eq("status", "approved")
    .not("scheduled_send_at", "is", null)
    .is("sent_at", null);
  const room = Math.max(0, Math.min(SCHEDULE_BATCH, capacity - (queued ?? 0)));
  if (room === 0) return 0;

  const { data } = await db
    .from("pitches")
    .select("id, subject, contact_id, prospects:prospect_id(company_name)")
    .eq("tenant_id", tenantId)
    .eq("status", "draft")
    .eq("autopilot_lane", "auto")
    .not("contact_id", "is", null)
    .order("created_at", { ascending: true })
    .limit(room);

  const candidates = (data ?? []) as Array<{ id: string; subject: string; contact_id: string | null; prospects: { company_name: string } | null }>;

  // A pitch the autopilot already approved that is back in draft was held by a
  // person (the veto). Never re-queue it: it goes to the review lane for good.
  const held = new Set<string>();
  if (candidates.length) {
    const { data: prior } = await db
      .from("pitch_events")
      .select("pitch_id")
      .eq("tenant_id", tenantId)
      .eq("event_type", "approved")
      .eq("payload->>autopilot", "true")
      .in("pitch_id", candidates.map((c) => c.id));
    for (const r of (prior ?? []) as Array<{ pitch_id: string }>) held.add(r.pitch_id);
  }
  if (held.size) {
    await db
      .from("pitches")
      .update({ autopilot_lane: "review", autopilot_reasons: [`${HELD_BY_PERSON} after the autopilot scheduled it`] })
      .in("id", [...held])
      .eq("tenant_id", tenantId);
  }

  // A draft labelled AUTO before finder addresses needed a person (2026-10-19)
  // is relabelled, never approved (hold.ts relabelFinderDrafts). Unreadable
  // sources throw: approve nothing this tick.
  const relabel = await relabelFinderDrafts(db, tenantId, candidates.filter((c) => !held.has(c.id)));

  const sendAt = new Date(now.getTime() + (stage === "veto" ? VETO_WINDOW_HOURS * 3_600_000 : 0)).toISOString();
  let scheduled = 0;
  let i = 0;
  for (const p of candidates) {
    if (held.has(p.id) || relabel.has(p.id)) continue;
    if (Date.now() > deadline) break;
    // Same gate-checked approval a person uses.
    const approved = await transitionPitchStatusWith(actor, { pitch_id: p.id, next_status: "approved" });
    if (!approved.ok) {
      await db
        .from("pitches")
        .update({ autopilot_lane: "review", autopilot_reasons: [`approval refused: ${approved.error}`.slice(0, 300)] })
        .eq("id", p.id)
        .eq("tenant_id", tenantId);
      continue;
    }
    const inbox = inboxes[i++ % inboxes.length]!;
    await db
      .from("pitches")
      .update({ scheduled_send_at: sendAt, sender_inbox_id: inbox.id, queued_at: now.toISOString() })
      .eq("id", p.id)
      .eq("tenant_id", tenantId)
      .eq("status", "approved");
    scheduled++;
  }

  // The veto digest is sent twice a day by sendVetoDigest, not per tick.
  return scheduled;
}

/**
 * Twice a day (lib/autopilot/hold.ts DIGEST_SLOTS_UTC), one email listing every
 * approved autopilot email that will send in the next 24h, each with its hold
 * link. The slot is recorded (audit_log autopilot.digest) only once the digest
 * reached at least one inbox, so a failed send is retried on the next tick
 * (sendNotification also reports it to Sentry); an empty slot is recorded as is.
 */
async function sendVetoDigest(db: Db, tenantId: string, now: Date): Promise<number> {
  const { data: last, error: lastErr } = await db
    .from("audit_log")
    .select("created_at")
    .eq("tenant_id", tenantId)
    .eq("action", "autopilot.digest")
    .order("created_at", { ascending: false })
    .limit(1);
  if (lastErr) throw new Error(`digest slot lookup: ${lastErr.message}`);
  const lastAt = ((last ?? []) as Array<{ created_at: string }>)[0]?.created_at ?? null;
  if (!digestDue(now, lastAt)) return 0;

  const horizon = new Date(now.getTime() + DIGEST_HORIZON_HOURS * 3_600_000).toISOString();
  const { data, error } = await db
    .from("pitches")
    .select("id, subject, scheduled_send_at, prospects(company_name)")
    .eq("tenant_id", tenantId)
    .eq("status", "approved")
    .eq("autopilot_lane", "auto")
    .not("scheduled_send_at", "is", null)
    .lte("scheduled_send_at", horizon)
    .order("scheduled_send_at", { ascending: true })
    .limit(200);
  if (error) throw new Error(`digest pitches: ${error.message}`);
  const items: DigestItem[] = ((data ?? []) as Array<{ id: string; subject: string; scheduled_send_at: string; prospects: { company_name: string } | null }>).map(
    (p) => ({ pitchId: p.id, company: p.prospects?.company_name ?? "?", subject: p.subject, sendAt: p.scheduled_send_at }),
  );

  if (items.length > 0) {
    const digest = buildVetoDigest({ items, tenantId, appUrl: appUrl(), secret: holdSecret(), now });
    const result = await notify(db, tenantId, digest.subject, digest.body);
    if (result.sent === 0) throw new Error(`digest not delivered, retrying next tick: ${result.failed.join(" | ").slice(0, 300)}`);
  }
  const { error: insErr } = await db.from("audit_log").insert({
    tenant_id: tenantId,
    actor_id: null,
    action: "autopilot.digest",
    entity_type: "tenant",
    entity_id: tenantId,
    metadata: { count: items.length, slot: lastDigestSlot(now).toISOString() },
  });
  if (insErr) throw new Error(`digest slot not recorded: ${insErr.message}`);
  return items.length;
}

// ── 6. Autonomy stage ─────────────────────────────────────────────────────────

/**
 * created_at of the newest breaker insight since `sinceIso` that counts
 * against the stage (the same rows hold.ts stageQualityTrips counts, same
 * predicate), or null. Only read on a stage change, to start the new clock
 * after it (governor.stageClockStart). Throws when unreadable: a clock that
 * might recount a trip is not written.
 */
async function newestQualityTripAt(db: Db, tenantId: string, sinceIso: string): Promise<string | null> {
  const { data, error } = await db
    .from("learning_insights")
    .select("evidence, created_at")
    .eq("tenant_id", tenantId)
    .eq("kind", "breaker")
    .gte("created_at", sinceIso)
    .order("created_at", { ascending: false })
    .limit(1000);
  if (error) throw new Error(`breaker insights (clock): ${error.message || "no detail"}`);
  const row = ((data ?? []) as Array<{ evidence: { code?: unknown } | null; created_at: string | null }>).find((r) =>
    isQualityBreaker(r.evidence?.code),
  );
  return row?.created_at ?? null;
}

async function evaluateStage(
  db: Db,
  s: AutonomyState,
  now: Date,
): Promise<{ change: TickReport["stageChange"]; pullback: PullbackResult | null }> {
  const tenantId = s.tenant_id;
  const since = s.stage_since;
  const { data: autos } = await db
    .from("pitches")
    .select("id, status, body_original, body_edited, sent_at, created_at")
    .eq("tenant_id", tenantId)
    .eq("autopilot_lane", "auto")
    .gte("created_at", since);
  const rows = (autos ?? []) as Array<{
    id: string;
    status: string;
    body_original: string | null;
    body_edited: string | null;
    sent_at: string | null;
    created_at: string | null;
  }>;

  const { data: autoApprovals } = await db
    .from("pitch_events")
    .select("pitch_id")
    .eq("tenant_id", tenantId)
    .eq("event_type", "approved")
    .eq("payload->>autopilot", "true")
    .gte("event_at", since);
  const autopilotApproved = new Set(((autoApprovals ?? []) as Array<{ pitch_id: string }>).map((r) => r.pitch_id));

  const humanDecided = rows.filter((r) => !autopilotApproved.has(r.id) && ["approved", "sent", "reviewer_rejected"].includes(r.status));
  const unedited = humanDecided.filter(
    (r) => r.status !== "reviewer_rejected" && editRatio(r.body_original ?? "", r.body_edited ?? r.body_original ?? "") < 0.05,
  );
  const rejected = rows.filter((r) => r.status === "reviewer_rejected").length;
  // Vetoes by approval event, whatever the lane: a held pitch is moved to the
  // review lane (§5, the digest hold), so `rows` (lane auto) never holds it.
  const approvedIds = [...autopilotApproved];
  // With their reasons: an autopilot pull-back is not a person's veto (governor vetoedByPerson).
  const current: Array<{ id: string; status: string; autopilot_reasons: string[] | null }> = [];
  for (let k = 0; k < approvedIds.length; k += 200) {
    const { data: chunk } = await db
      .from("pitches")
      .select("id, status, autopilot_reasons")
      .eq("tenant_id", tenantId)
      .in("id", approvedIds.slice(k, k + 200));
    current.push(...((chunk ?? []) as Array<{ id: string; status: string; autopilot_reasons: string[] | null }>));
  }
  const vetoed = countVetoes(autopilotApproved, current);
  const sentAuto = rows.filter((r) => autopilotApproved.has(r.id) && r.sent_at).map((r) => r.id);
  let bounces = 0;
  if (sentAuto.length) {
    const { count } = await db
      .from("pitch_events")
      .select("id", { count: "exact", head: true })
      .eq("tenant_id", tenantId)
      .eq("event_type", "bounce")
      .in("pitch_id", sentAuto);
    bounces = count ?? 0;
  }
  // Only quality breakers count against the stage (governor BREAKER_KIND).
  const qualityTrips = s.stage === "shadow" ? [] : await stageQualityTrips(db, tenantId, since);

  const metrics: StageMetrics = {
    daysInStage: (now.getTime() - new Date(since).getTime()) / DAY,
    autoDecided: humanDecided.length,
    autoApprovedUnedited: unedited.length,
    autoFactualErrors: rejected,
    autoScheduled: autopilotApproved.size,
    autoVetoed: vetoed,
    autoBounceRate: sentAuto.length ? bounces / sentAuto.length : 0,
    autoQualityTrips: qualityTrips.length,
    autoQualityTripCodes: qualityTrips,
  };
  const next = nextStage(s.stage, metrics);
  await db
    .from("autonomy_state")
    .update({ metrics, reason: next.reason, updated_at: now.toISOString() })
    .eq("tenant_id", tenantId);

  // A stage that never sends automatically keeps no automatic approval waiting
  // to send (the send-queue sends approved pitches whatever the stage). On the
  // demotion itself, and on every later tick in that stage, which retries a
  // pull-back that failed and catches a stage set by hand. Nothing to hold: silent.
  if (next.stage === s.stage && !next.restart) {
    if (!pullsBackApprovals(s.stage)) return { change: null, pullback: null };
    const sweep = await holdAutoApprovals(db, tenantId, s.stage);
    if (sweep.held > 0) {
      await insight(db, tenantId, {
        learner: "governor",
        kind: "stage",
        title: `Held ${sweep.held} automatic approval${sweep.held === 1 ? "" : "s"} still waiting in ${s.stage}`,
        evidence: sweep,
      });
    }
    return { change: null, pullback: sweep };
  }

  // The new clock starts after everything this step counted, trips this same tick wrote included.
  const clock = stageClockStart(new Date(), [
    ...rows.filter((r) => r.status === "reviewer_rejected").map((r) => r.created_at),
    await newestQualityTripAt(db, tenantId, since),
  ]);
  if (next.restart) return restartStageClock(db, s, next.reason, metrics, clock);

  // Guarded on the stage this tick read: a person's change meanwhile wins.
  const { data: moved, error: moveError } = await db
    .from("autonomy_state")
    .update({ stage: next.stage, stage_since: clock })
    .eq("tenant_id", tenantId)
    .eq("stage", s.stage)
    .select("tenant_id");
  if (!moveError && ((moved ?? []) as unknown[]).length === 0) return { change: null, pullback: null };
  // After the stage write, so no tick schedules new approvals behind the hold.
  const pullback = pullsBackApprovals(next.stage) ? await holdAutoApprovals(db, tenantId, next.stage) : null;
  await insight(db, tenantId, {
    learner: "governor",
    kind: "stage",
    title: `Autopilot ${s.stage} → ${next.stage}`,
    detail: next.reason,
    evidence: pullback ? { ...metrics, pulledBack: pullback.held, pullbackError: pullback.error } : metrics,
  });
  await notify(
    db,
    tenantId,
    `Autopilot moved from ${s.stage} to ${next.stage}`,
    `Reason: ${next.reason}.\n\n${pullback ? `${pullbackSentence(pullback)}\n\n` : ""}${appUrl()}/pitches`,
  );
  return { change: { from: s.stage, to: next.stage, reason: next.reason }, pullback };
}

/**
 * Veto + a quality trip or factual error (governor.nextStage restart): the
 * stage stays veto, its clock (stage_since) starts again, and the automatic
 * approvals still waiting are pulled back as on a demotion. Logged like a
 * stage change. The trips that caused it predate the new stage_since, so the
 * next tick does not count them again; if the clock write fails, the pull-back
 * still runs and the step reports the error (no insight, no email: the next
 * tick retries the whole restart).
 */
async function restartStageClock(
  db: Db,
  s: AutonomyState,
  reason: string,
  metrics: StageMetrics,
  clock: string,
): Promise<{ change: TickReport["stageChange"]; pullback: PullbackResult | null }> {
  const tenantId = s.tenant_id;
  // Only the clock, and only while still in this stage: a person's change meanwhile wins.
  const { data: restarted, error } = await db
    .from("autonomy_state")
    .update({ stage_since: clock })
    .eq("tenant_id", tenantId)
    .eq("stage", s.stage)
    .select("tenant_id");
  if (!error && ((restarted ?? []) as unknown[]).length === 0) return { change: null, pullback: null };
  const pullback = await holdAutoApprovals(db, tenantId, s.stage, VETO_RESTART_HOLD_REASON);
  if (error) {
    throw new Error(
      `${s.stage} clock restart not recorded (${error.message || "no detail"}); pulled back ${pullback.held}${pullback.error ? `, pullback: ${pullback.error}` : ""}`,
    );
  }
  await insight(db, tenantId, {
    learner: "governor",
    kind: "stage",
    title: `Autopilot ${s.stage} clock restarted`,
    detail: reason,
    evidence: { ...metrics, restart: true, pulledBack: pullback.held, pullbackError: pullback.error },
  });
  await notify(
    db,
    tenantId,
    `Autopilot restarted the ${s.stage} clock`,
    `Reason: ${reason}.\n\nThe autopilot stays in ${s.stage}; the ${STAGE_RULES.veto.minDays}-day / ${STAGE_RULES.veto.minScheduled}-scheduled count toward auto starts again today.\n\n${pullbackSentence(pullback)}\n\n${appUrl()}/pitches`,
  );
  return { change: { from: s.stage, to: s.stage, reason }, pullback };
}
