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
import { evolveSearchSpace, learnFromOutcomes, weeklyReview } from "./learn";
import { resumeDiscoveryJobWith, startDiscoveryJobWith } from "@/lib/discover/job-stage";
import { EMPTY_JOB_STATS } from "@/lib/discover/job-types";
import { getAccessToken, sendGmailMessage } from "@/lib/gmail/client";
import type { Arm } from "@/lib/learning/bandit";
import { candidateCells, cellKey, chooseCellFromArms, discoveryBudget, type SearchCell } from "@/lib/learning/scout";
import { editRatio } from "@/lib/pitches/decision";
import { transitionPitchStatusWith } from "@/lib/pitches/pitch-stage";
import { verifyRecipient } from "@/lib/research/verify-recipient";
import { checkDeliverabilityHealth } from "@/lib/warmup/deliverability";
import { analyzeSpamRate } from "@/lib/warmup/intelligence";
import type { WarmupLogEntry } from "@/lib/warmup/types";
import {
  evaluateBreakers,
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

/** Veto stage: how long a person has to hold an AUTO pitch before it sends. */
export const VETO_WINDOW_HOURS = 18;
/** A running job whose heartbeat is older than this has a dead chain. */
const STALE_JOB_MS = 100_000;
const LABEL_BATCH = 40;
const SCHEDULE_BATCH = 25;
/** Stop starting slow work (verification, approvals) past this, under the route's cap. */
const TICK_BUDGET_MS = 90_000;
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
  scheduled: number;
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

/** Email the notify address from any connected inbox (same path as the reply digest). */
export async function notify(db: Db, tenantId: string, subject: string, body: string): Promise<void> {
  try {
    // Same recipient as the reply digest (app/api/replies/poll).
    const to = process.env.AUTOPILOT_NOTIFY_EMAIL || process.env.REPLY_FUNNEL_NOTIFY_EMAIL || "petedv31@gmail.com";
    const { data: inboxes } = await db
      .from("sender_inboxes")
      .select("email, gmail_refresh_token_encrypted")
      .eq("tenant_id", tenantId)
      .not("gmail_refresh_token_encrypted", "is", null)
      .limit(1);
    const inbox = (inboxes ?? [])[0] as { email: string; gmail_refresh_token_encrypted: string } | undefined;
    if (!inbox) return;
    const token = await getAccessToken(inbox.gmail_refresh_token_encrypted);
    if (!token.ok) return;
    await sendGmailMessage({
      accessToken: token.accessToken,
      fromEmail: inbox.email,
      fromName: "S.P.A.M. Autopilot",
      to,
      subject,
      body,
    });
  } catch (err) {
    console.warn("[autopilot] notify failed:", (err as Error).message);
  }
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
  const { data: jobs } = await db
    .from("discovery_jobs")
    .select("stats")
    .eq("tenant_id", tenantId)
    .eq("status", "done")
    .gte("created_at", new Date(now.getTime() - 30 * DAY).toISOString());
  let pitched = 0;
  let processed = 0;
  for (const j of (jobs ?? []) as Array<{ stats: { pitched?: number; processed?: number } | null }>) {
    pitched += j.stats?.pitched ?? 0;
    processed += j.stats?.processed ?? 0;
  }
  const pitchYield = processed >= 20 ? pitched / processed : 0.2;

  const budget = discoveryBudget({ dailySendCapacity: capacity, pitchesWaiting: waiting ?? 0, pitchYield });
  if (budget === 0) return { started: false, reason: `${waiting ?? 0} pitches already waiting for ${capacity}/day`, budget };

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
      stats: { ...EMPTY_JOB_STATS, focus: { keyword: cell.keyword, region: cell.region, cell_key: key }, started_by: "autopilot" },
    })
    .eq("id", started.jobId)
    .eq("tenant_id", tenantId);
  return { started: true, reason: `budget ${budget} prospects`, cell: key, budget };
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
      .update({ autopilot_lane: "review", autopilot_reasons: ["held by a person after the autopilot scheduled it"] })
      .in("id", [...held])
      .eq("tenant_id", tenantId);
  }

  const sendAt = new Date(now.getTime() + (stage === "veto" ? VETO_WINDOW_HOURS * 3_600_000 : 0)).toISOString();
  const scheduled: Array<{ company: string; subject: string }> = [];
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
    scheduled.push({ company: p.prospects?.company_name ?? "?", subject: p.subject });
  }

  if (scheduled.length > 0 && stage === "veto") {
    await notify(
      db,
      tenantId,
      `Autopilot scheduled ${scheduled.length} email${scheduled.length === 1 ? "" : "s"} (sends in ${VETO_WINDOW_HOURS}h unless held)`,
      `These passed every check and will send in about ${VETO_WINDOW_HOURS} hours:\n\n` +
        scheduled.map((s) => `• ${s.company}: "${s.subject}"`).join("\n") +
        `\n\nTo hold one, move it back to draft on /pitches before then. Holding one counts as a veto; few vetoes over two weeks lets the autopilot send without the wait.\n\n${appUrl()}/pitches`,
    );
  }
  return scheduled.length;
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
  const vetoed = rows.filter((r) => autopilotApproved.has(r.id) && ["draft", "reviewer_rejected"].includes(r.status)).length;
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
