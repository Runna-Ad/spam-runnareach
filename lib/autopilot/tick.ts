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
 *                 (governor.heldAction)
 *   5. schedule   veto stage: AUTO pitches approved and scheduled 18h out, with
 *                 a digest so a person can hold any; auto stage: scheduled now
 *   6. stage      promote / demote the autonomy stage on measured results
 *   7. learn      re-score writer variants and search cells from outcomes;
 *                 weekly AI review proposes new guidance to test (learn.ts)
 *
 * Every autonomous change writes a learning_insights row; breaker trips and
 * stage changes also email the notify address.
 */

import type { Actor } from "@/lib/actor";
import { isUnderDailyCap } from "@/lib/anthropic/cost-tracking";
import { evolveSearchSpace, learnFromOutcomes, weeklyReview } from "./learn";
import { buildVetoDigest, DIGEST_HORIZON_HOURS, digestDue, lastDigestSlot, VETO_WINDOW_HOURS, type DigestItem } from "./hold";
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
import { generatePitchWith, transitionPitchStatusWith } from "@/lib/pitches/pitch-stage";
import { WRITER_FIXABLE } from "@/lib/pitches/review";
import { sendNotification, type NotificationResult } from "@/lib/notify/send";
import { verifyRecipient } from "@/lib/research/verify-recipient";
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
  type BreakerMetrics,
  type BreakerTrip,
  type Lane,
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
  scheduled: number;
  /** Emails listed in the twice-daily veto digest this tick (0 when no slot was due). */
  digest?: number;
  stageChange: { from: Stage; to: Stage; reason: string } | null;
  review?: { ran: boolean; reason: string; guidance: string[] } | null;
  errors: string[];
};

export async function runTick(actor: Actor, now: Date = new Date()): Promise<TickReport> {
  const db = actor.supabase as Db;
  const tenantId = actor.user.tenantId;
  const deadline = now.getTime() + TICK_BUDGET_MS;
  const report: TickReport = {
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

  const { data: state } = await db
    .from("autonomy_state")
    .select("tenant_id, stage, stage_since, enabled")
    .eq("tenant_id", tenantId)
    .maybeSingle();
  const s = state as AutonomyState | null;
  // The digest lists approved emails, and the send-queue sends them whatever the
  // stage, so it runs even when the autopilot is switched off or was demoted.
  // Only the auto stage (scheduled to send now, no veto window) skips it. First,
  // so it runs well inside the time budget.
  if (s && s.stage !== "auto") {
    try {
      report.digest = await sendVetoDigest(db, tenantId, now);
    } catch (err) {
      report.errors.push(`digest: ${(err as Error).message}`);
    }
  }
  if (!s || !s.enabled || s.stage === "off") {
    report.skipped = "autopilot off for this tenant";
    return report;
  }
  report.stage = s.stage;

  const step = async <T>(name: string, fn: () => Promise<T>, fallback: T): Promise<T> => {
    try {
      return await fn();
    } catch (err) {
      report.errors.push(`${name}: ${(err as Error).message}`);
      return fallback;
    }
  };

  report.breakers = await step("breakers", () => runBreakers(db, tenantId, now), []);
  const sendingHalted = report.breakers.some((t) => t.scope === "all");
  report.resumedJobs = await step("watchdog", () => resumeStaleJobs(actor, db, now), 0);
  report.discovery = await step("supply", () => maybeStartDiscovery(actor, db, now), { started: false, reason: "error" });
  report.labelled = await step("label", () => labelDrafts(actor, db, now, deadline), report.labelled);
  report.resolved = await step("resolve", () => resolveHeld(actor, db, deadline), report.resolved);
  if ((s.stage === "veto" || s.stage === "auto") && !sendingHalted) {
    report.scheduled = await step("schedule", () => scheduleAuto(actor, db, s.stage, now, deadline), 0);
  }
  report.stageChange = await step("stage", () => evaluateStage(db, s, now), null);
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

async function countEvents(db: Db, tenantId: string, type: string, sinceIso: string, intent?: string): Promise<number> {
  let q = db
    .from("pitch_events")
    .select("id", { count: "exact", head: true })
    .eq("tenant_id", tenantId)
    .eq("event_type", type)
    .gte("event_at", sinceIso);
  if (intent) q = q.eq("payload->>intent", intent);
  const { count } = await q;
  return count ?? 0;
}

async function runBreakers(db: Db, tenantId: string, now: Date): Promise<BreakerTrip[]> {
  const { data: inboxRows } = await db
    .from("sender_inboxes")
    .select("id, email, paused")
    .eq("tenant_id", tenantId);
  const inboxes = (inboxRows ?? []) as Array<{ id: string; email: string; paused: boolean }>;

  const inboxStats: BreakerMetrics["inboxes"] = [];
  for (const inbox of inboxes) {
    const { data: sent } = await db
      .from("pitches")
      .select("id")
      .eq("tenant_id", tenantId)
      .eq("sender_inbox_id", inbox.id)
      .not("sent_at", "is", null)
      .order("sent_at", { ascending: false })
      .limit(50);
    const ids = ((sent ?? []) as Array<{ id: string }>).map((r) => r.id);
    let bounces = 0;
    if (ids.length) {
      const { count } = await db
        .from("pitch_events")
        .select("id", { count: "exact", head: true })
        .eq("tenant_id", tenantId)
        .eq("event_type", "bounce")
        .in("pitch_id", ids);
      bounces = count ?? 0;
    }
    inboxStats.push({ id: inbox.id, recentSends: ids.length, recentHardBounces: bounces, apiErrorsToday: 0 });
  }

  const dayStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())).toISOString();
  const weekAgo = new Date(now.getTime() - 7 * DAY).toISOString();
  const monthAgo = new Date(now.getTime() - 30 * DAY).toISOString();
  const [bouncesToday, unsubWeek, hardNoWeek, unsubMonth, hardNoMonth] = await Promise.all([
    countEvents(db, tenantId, "bounce", dayStart),
    countEvents(db, tenantId, "unsubscribe", weekAgo),
    countEvents(db, tenantId, "reply", weekAgo, "hard_no"),
    countEvents(db, tenantId, "unsubscribe", monthAgo),
    countEvents(db, tenantId, "reply", monthAgo, "hard_no"),
  ]);

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
    optOutsThisWeek: unsubWeek + hardNoWeek,
    optOutWeeklyBaseline: ((unsubMonth + hardNoMonth) / 30) * 7,
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
      const fresh = contact?.verify_checked_at && now.getTime() - new Date(contact.verify_checked_at).getTime() < 7 * DAY;
      if (contact?.email && !fresh) {
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

async function resolveHeld(actor: Actor, db: Db, deadline: number): Promise<TickReport["resolved"]> {
  const tenantId = actor.user.tenantId;
  const out: TickReport["resolved"] = { rewritten: 0, dropped: 0, waiting: null };
  const { data } = await db
    .from("pitches")
    .select("id, prospect_id, autopilot_lane, autopilot_reasons, body_edited, decision")
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
    autopilot_lane: Lane;
    autopilot_reasons: string[] | null;
    body_edited: string | null;
    decision: { retry_of?: string } | null;
  }>) {
    if (Date.now() > deadline) break;
    const next = heldAction(
      {
        lane: p.autopilot_lane,
        reasons: p.autopilot_reasons ?? [],
        isRewrite: Boolean(p.decision?.retry_of),
        editedByPerson: p.body_edited !== null,
      },
      WRITER_FIXABLE,
    );
    if (next.action === "leave") continue;
    if (next.action === "drop") {
      await dropDraft(db, tenantId, p.id, next.why);
      out.dropped++;
      continue;
    }

    // Rewrite: a fresh draft through the same writer and reviewer. It replaces
    // this one (generatePitch clears the prospect's drafts) and is labelled on
    // the next tick like any new draft.
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
    } else {
      await dropDraft(db, tenantId, p.id, `rewrite failed: ${rewritten.error}`);
      out.dropped++;
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
    .select("id, subject, prospects:prospect_id(company_name)")
    .eq("tenant_id", tenantId)
    .eq("status", "draft")
    .eq("autopilot_lane", "auto")
    .not("contact_id", "is", null)
    .order("created_at", { ascending: true })
    .limit(room);

  const candidates = (data ?? []) as Array<{ id: string; subject: string; prospects: { company_name: string } | null }>;

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

  const sendAt = new Date(now.getTime() + (stage === "veto" ? VETO_WINDOW_HOURS * 3_600_000 : 0)).toISOString();
  let scheduled = 0;
  let i = 0;
  for (const p of candidates) {
    if (held.has(p.id)) continue;
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

async function evaluateStage(db: Db, s: AutonomyState, now: Date): Promise<TickReport["stageChange"]> {
  const tenantId = s.tenant_id;
  const since = s.stage_since;
  const { data: autos } = await db
    .from("pitches")
    .select("id, status, body_original, body_edited, sent_at")
    .eq("tenant_id", tenantId)
    .eq("autopilot_lane", "auto")
    .gte("created_at", since);
  const rows = (autos ?? []) as Array<{ id: string; status: string; body_original: string | null; body_edited: string | null; sent_at: string | null }>;

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
  const current: Array<{ id: string; status: string }> = [];
  for (let k = 0; k < approvedIds.length; k += 200) {
    const { data: chunk } = await db
      .from("pitches")
      .select("id, status")
      .eq("tenant_id", tenantId)
      .in("id", approvedIds.slice(k, k + 200));
    current.push(...((chunk ?? []) as Array<{ id: string; status: string }>));
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
  const { count: trips } = await db
    .from("learning_insights")
    .select("id", { count: "exact", head: true })
    .eq("tenant_id", tenantId)
    .eq("kind", "breaker")
    .gte("created_at", since);

  const metrics: StageMetrics = {
    daysInStage: (now.getTime() - new Date(since).getTime()) / DAY,
    autoDecided: humanDecided.length,
    autoApprovedUnedited: unedited.length,
    autoFactualErrors: rejected,
    autoScheduled: autopilotApproved.size,
    autoVetoed: vetoed,
    autoBounceRate: sentAuto.length ? bounces / sentAuto.length : 0,
    autoBreakerTrips: s.stage === "shadow" ? 0 : trips ?? 0,
  };
  const next = nextStage(s.stage, metrics);
  await db
    .from("autonomy_state")
    .update({ metrics, reason: next.reason, updated_at: now.toISOString() })
    .eq("tenant_id", tenantId);
  if (next.stage === s.stage) return null;

  await db
    .from("autonomy_state")
    .update({ stage: next.stage, stage_since: now.toISOString() })
    .eq("tenant_id", tenantId);
  await insight(db, tenantId, {
    learner: "governor",
    kind: "stage",
    title: `Autopilot ${s.stage} → ${next.stage}`,
    detail: next.reason,
    evidence: metrics,
  });
  await notify(
    db,
    tenantId,
    `Autopilot moved from ${s.stage} to ${next.stage}`,
    `Reason: ${next.reason}.\n\n${appUrl()}/pitches`,
  );
  return { from: s.stage, to: next.stage, reason: next.reason };
}
