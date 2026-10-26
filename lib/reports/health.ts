/**
 * The health check (hourly in the send window and right after it, then once a
 * day: 0053): emails ONLY when something is wrong, at most once
 * per problem per 24h, and is silent otherwise. Every alert email also goes to
 * Sentry (a warning, deduped like the email), so a dead Gmail token cannot
 * hide its own alarm.
 *
 * An emergency is activity that was due in a period and did not happen, never
 * "something is waiting": every state the system enters by design is silent,
 * because the 24h dedupe would turn a false positive into a daily email.
 * Each is a pure rule over a snapshot that snapshot.ts gathers:
 *   google_disconnected  a connected inbox's refresh token no longer works
 *   autopilot_stopped    the kill switch is on but no tick has run for 8
 *                        scheduled ticks (2h inside the send window)
 *   emails_stuck         the last closed send window had sendable pitches due
 *                        and their inbox sent nothing, or a pitch stayed in
 *                        "sending" through a whole window
 *   inbox_paused         a breaker paused a connected inbox with a daily cap:
 *                        nothing sends from it until a person resumes it. The
 *                        tick emails once at the trip; this rule re-alerts
 *                        every 24h while the pause lasts. A pause a person set
 *                        (Settings → Sending) is silent.
 *   tick_errors          3+ autopilot ticks in the last 2h recorded errors
 *                        (audit_log autopilot.tick_errors); one failing tick is not
 *   learning_stalled     5+ first emails sent 15-30 days ago (all settled) and
 *                        the writer learner shows no trial or has not written
 *                        its arms for 7 days, or the learning step failed in
 *                        2+ ticks in the last 24h
 *   job_silent           a cron job (heartbeat.ts) missed 3 scheduled runs in a
 *                        row inside its window; no heartbeat row yet = silent
 * Not emergencies, by design: the AI budget cap, the daily-cap drip, cooldowns,
 * weekends, hours outside a job's window, a quiet day, one failing tick, no
 * 15-day-old sends yet (nothing has settled), an inbox with a daily cap of 0,
 * an inbox a person paused on purpose.
 *
 * Dedupe: an audit_log row (action health.alert, metadata.kind = the rule) is
 * written after an email goes out; a rule with such a row in the last 24h is
 * not emailed again. Tested in tests/reports-health.test.ts and
 * tests/health-alarms.test.ts.
 */

import { CRON_JOBS, cronsOf, type CronJob } from "./heartbeat.ts";
import { isTestAddress } from "../compliance/test-addresses.ts";

const HOUR = 3_600_000;

export const ALERT_DEDUPE_HOURS = 24;
/**
 * The health check's own weekday runs (0053 spam-health-check 25 15-23 * * 1-5
 * and spam-health-check-morning 25 13 * * *), for its Sentry monitor, which
 * takes a single crontab. Weekend runs are extra check-ins it does not expect.
 */
export const HEALTH_CHECK_WEEKDAY_CRON = "25 13,15-23 * * 1-5";
/**
 * Eight missed ticks is not a blip: 2h inside the send window, where the tick
 * runs every 15 min. Counted in scheduled ticks, not hours, because outside the
 * window it runs only after the window and once a day (0053).
 */
export const TICK_SILENCE_RUNS = 8;

/**
 * The send-queue runs weekdays every 10 min from 15:00 to 22:50 UTC (0041:
 * `*\/10 15-22 * * 1-5`). Outside a window nothing is supposed to send, so
 * "emails stuck" is judged on the last CLOSED window only, and only within
 * 24h of its close: a weekend never re-judges Friday's window.
 */
const SEND_WINDOW = { days: [1, 2, 3, 4, 5], startHour: 15, endHour: 23, lastRunMinute: 22 * 60 + 50 };

export type HealthRule =
  | "google_disconnected"
  | "autopilot_stopped"
  | "emails_stuck"
  | "inbox_paused"
  | "tick_errors"
  | "learning_stalled"
  | "job_silent";

export type HealthSnapshot = {
  now: string;
  appUrl: string;
  autopilot: { enabled: boolean; stage: string; updatedAt: string | null } | null;
  /** Every sender_inboxes row with a refresh token, its send state, and what getAccessToken said. */
  inboxes: Array<{
    id: string;
    email: string;
    paused: boolean;
    dailyCap: number;
    tokenOk: boolean;
    error: string | null;
    /** sender_inboxes.paused_reason (the breaker writes its reason; a person may write one). */
    pausedReason?: string | null;
    /** The latest breaker trip covering this inbox after its last resume (learning_insights), if any. */
    pausedSince?: string | null;
  }>;
  /** Pitches in approved or sending. updatedAt is the row's updated_at (trigger-maintained). */
  pending: Array<{
    id: string;
    status: string;
    scheduledSendAt: string | null;
    updatedAt: string | null;
    senderInboxId: string | null;
    /** The prospect's cooldown_until: the send-queue skips the pitch until then. */
    cooldownUntil: string | null;
  }>;
  /** Pitches sent in the last 48h (sent_at, from which inbox): proof the queue ran. */
  recentSends: Array<{ senderInboxId: string | null; sentAt: string }>;
  /**
   * audit_log autopilot.tick_errors rows of the last 24h (one per tick that had
   * errors, each "step: message"). null = not read (the rule stays silent).
   */
  tickErrors: Array<{ at: string; errors: string[] }> | null;
  /**
   * What the writer learner should have seen. dueRootSends: first emails sent
   * 15-30 days ago that carry writer arms (all settled by then). writerArms:
   * every writer.* learning_arms row. null = not read.
   */
  learning: {
    /** bounced: the pitch has a pitch_events "bounce" row (pitches.status is never set to bounced). */
    dueRootSends: Array<{ email: string | null; bounced: boolean }>;
    writerArms: Array<{ trials: number; updatedAt: string | null }>;
  } | null;
  /** cron_heartbeats rows (0051). null = not read. */
  heartbeats: Array<{ job: string; lastOkAt: string | null; lastErrorAt: string | null; lastError: string | null; createdAt: string | null }> | null;
};

export type HealthProblem = {
  kind: HealthRule;
  title: string;
  detail: string;
  stops: string;
  action: string;
};

/**
 * A token failure that says nothing about the connection (Google down or rate
 * limiting, a timeout) is retried next hour instead of raising
 * "disconnected". Anything else, including errors we haven't seen, counts.
 */
export function isTransientTokenError(error: string | null): boolean {
  return !!error && /timed out|\((5\d\d|429)\)|fetch failed|ECONNRESET|ENOTFOUND|EAI_AGAIN|network/i.test(error);
}

export function googleDisconnected(s: HealthSnapshot): HealthProblem | null {
  const bad = s.inboxes.filter((i) => !i.tokenOk && !isTransientTokenError(i.error));
  if (bad.length === 0) return null;
  return {
    kind: "google_disconnected",
    title: `Google disconnected for ${bad.map((i) => i.email).join(", ")}`,
    detail: bad.map((i) => `${i.email}: ${(i.error ?? "token refresh failed").slice(0, 160)}`).join("\n"),
    stops: "Sending, reply reading and calendar booking sync from that inbox.",
    action: `Reconnect it in Settings → Sending: ${s.appUrl}/settings/sending`,
  };
}

export function autopilotStopped(s: HealthSnapshot): HealthProblem | null {
  const a = s.autopilot;
  if (!a || !a.enabled || a.stage === "off") return null;
  const now = new Date(s.now).getTime();
  const last = a.updatedAt ? new Date(a.updatedAt).getTime() : NaN;
  const due = now - JOB_GRACE_MINUTES * 60_000;
  if (Number.isFinite(last) && scheduledRuns(cronsOf("autopilot-tick"), last, due, TICK_SILENCE_RUNS) < TICK_SILENCE_RUNS) return null;
  const observed = Number.isFinite(last)
    ? `the last tick recorded is ${new Date(last).toISOString()}, ${Math.floor((now - last) / HOUR)}h ago`
    : "no tick has been recorded";
  return {
    kind: "autopilot_stopped",
    title: "Autopilot stopped running",
    detail: `The autopilot is switched on (stage ${a.stage}); it runs every 15 minutes in the send window, after it and once a day outside it, but ${observed} (autonomy_state.updated_at).`,
    stops: "New drafts, AUTO scheduling, breakers and learning. Already-approved emails still send.",
    action:
      "Check the spam-autopilot-tick jobs in Supabase (cron.job_run_details, net._http_response) and the latest /api/autopilot/tick logs in Vercel. " +
      "If it was just switched back on by hand, set autonomy_state.updated_at = now() as well; otherwise this clears at the next tick.",
  };
}

/** The most recent weekday send window that has closed at `now`, or null if none in the last week. */
export function lastClosedSendWindow(now: number): { start: number; end: number; lastRun: number } | null {
  const d = new Date(now);
  for (let i = 0; i < 8; i++) {
    const start = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - i, SEND_WINDOW.startHour);
    const end = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - i, SEND_WINDOW.endHour);
    if (end <= now && SEND_WINDOW.days.includes(new Date(start).getUTCDay())) {
      const lastRun = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - i, 0, SEND_WINDOW.lastRunMinute);
      return { start, end, lastRun };
    }
  }
  return null;
}

/**
 * Emails stuck = the last closed send window should have sent something and
 * did not. Every state the send-queue holds a pitch in BY DESIGN is silent:
 *   - a paused inbox (inbox_paused's job), a disconnected one (E1's job),
 *     or one with no daily cap
 *   - the daily-cap drip: if the inbox sent anything in the window, the queue
 *     ran and the backlog is the cap working
 *   - a prospect in cooldown through the window's last run
 *   - weekends and the hours outside the window (only a closed window counts)
 * A "sending" row counts only if it was already sending before that window
 * opened: recoverStuckSends runs inside the window and should have settled it.
 */
export function emailsStuck(s: HealthSnapshot): HealthProblem | null {
  const now = new Date(s.now).getTime();
  const w = lastClosedSendWindow(now);
  if (!w || now - w.end > 24 * HOUR) return null;

  const sendable = new Map(s.inboxes.filter((i) => i.tokenOk && !i.paused && i.dailyCap > 0).map((i) => [i.id, i]));
  const sentFrom = new Set(
    s.recentSends
      .filter((r) => {
        const t = new Date(r.sentAt).getTime();
        return t >= w.start && t < w.end;
      })
      .map((r) => r.senderInboxId),
  );
  const ts = (iso: string | null) => (iso ? new Date(iso).getTime() : NaN);

  const approved = s.pending.filter(
    (p) =>
      p.status === "approved" &&
      ts(p.scheduledSendAt) <= w.lastRun &&
      p.senderInboxId !== null &&
      sendable.has(p.senderInboxId) &&
      !sentFrom.has(p.senderInboxId) &&
      !(ts(p.cooldownUntil) > w.lastRun),
  );
  const sending = s.pending.filter((p) => p.status === "sending" && ts(p.updatedAt) < w.start);
  if (approved.length === 0 && sending.length === 0) return null;

  const day = new Date(w.start).toISOString().slice(0, 10);
  const parts: string[] = [];
  if (approved.length) {
    const inboxes = [...new Set(approved.map((p) => sendable.get(p.senderInboxId as string)?.email ?? "?"))];
    const oldest = approved.map((p) => p.scheduledSendAt as string).sort()[0];
    parts.push(
      `${approved.length} approved pitch(es) were due in the ${day} send window (15:00–23:00 UTC), but ${inboxes.join(", ")} sent nothing in that window although active and connected (oldest due ${oldest}).`,
    );
  }
  if (sending.length) {
    parts.push(
      `${sending.length} pitch(es) were already in "sending" before the ${day} window opened and are still there: ${sending.slice(0, 5).map((p) => p.id).join(", ")}.`,
    );
  }
  return {
    kind: "emails_stuck",
    title: "Emails are stuck",
    detail: parts.join("\n"),
    stops: "Those emails (and their follow-ups) are not going out.",
    action: `Look at the send-queue run (Vercel logs for /api/pitches/send-queue) and the pitches on ${s.appUrl}/pitches. A pitch stuck in "sending" needs checking in Gmail Sent before moving it back to approved.`,
  };
}

// ── Paused inbox ─────────────────────────────────────────────────────────────

/**
 * The paused_reason prefix the tick's breakers write (lib/autopilot/tick.ts
 * runBreakers: `Autopilot breaker (<code>): <reason>`). A test pins it to that
 * source.
 */
export const BREAKER_PAUSE_PREFIX = "Autopilot breaker (";

/** A breaker paused it: its reason is the breaker's, or a trip covers it since its last resume. */
export const pausedByBreaker = (i: HealthSnapshot["inboxes"][number]) =>
  i.paused && (!!i.pausedSince || (i.pausedReason ?? "").startsWith(BREAKER_PAUSE_PREFIX));

/**
 * A connected inbox with a daily cap that a breaker paused sends nothing,
 * first emails or follow-ups, until a person resumes it; with one inbox that
 * is a full stop. The breaker emails once when it trips; the 24h dedupe turns
 * this into the daily reminder. A pause a person set on purpose (Settings →
 * Sending: a daily cap can't go below 1, so pausing is the only off switch) is
 * silent, and a disconnected inbox is google_disconnected's job.
 */
export function inboxPaused(s: HealthSnapshot): HealthProblem | null {
  const usable = s.inboxes.filter((i) => i.tokenOk && i.dailyCap > 0);
  const paused = usable.filter(pausedByBreaker);
  if (paused.length === 0) return null;
  const all = usable.every((i) => i.paused);
  const first = paused[0] as (typeof paused)[number];
  return {
    kind: "inbox_paused",
    title: paused.length === 1 ? `Sending paused on ${first.email}` : `Sending paused on ${paused.length} inboxes`,
    detail: paused
      .map((i) => {
        const since = i.pausedSince ? `since ${i.pausedSince}` : "since an unrecorded time (no breaker trip on record since its last resume)";
        const why = i.pausedReason ? `, reason: ${i.pausedReason.slice(0, 200)}` : "";
        return `${i.email} is paused ${since}${why}.`;
      })
      .join("\n"),
    stops: all
      ? "All cold sending: no first email or follow-up goes out from any inbox."
      : "Cold sending from that inbox (first emails and follow-ups). The other inboxes keep sending.",
    action: `Once the cause is fixed, resume it in Settings → Sending: ${s.appUrl}/settings/sending. This reminder repeats every ${ALERT_DEDUPE_HOURS}h while the pause lasts.`,
  };
}

// ── Tick errors ──────────────────────────────────────────────────────────────

/**
 * Ticks run every 15 min in the send window (0053): 3 erroring ticks in 2h is a
 * pattern, one is a blip. Outside the window at most two ticks fall within 2h
 * (14:45 and 15:00, or 22:45 and 23:15), so this rule judges the window's ticks;
 * a step that fails every tick is reported within the window's first hour.
 */
export const TICK_ERROR_WINDOW_HOURS = 2;
export const TICK_ERROR_MIN_TICKS = 3;

/** The step name a tick error starts with ("learn: …" → "learn"). */
export const errorStep = (e: string) => (e.split(":")[0] ?? "").trim() || "unknown";

const within = <T extends { at: string }>(rows: T[], now: number, hours: number): T[] =>
  rows.filter((r) => {
    const t = new Date(r.at).getTime();
    return t <= now && now - t <= hours * HOUR;
  });

export function tickErrors(s: HealthSnapshot): HealthProblem | null {
  if (!s.tickErrors) return null;
  const now = new Date(s.now).getTime();
  const rows = within(s.tickErrors, now, TICK_ERROR_WINDOW_HOURS).filter((r) => r.errors.length > 0);
  if (rows.length < TICK_ERROR_MIN_TICKS) return null;
  const counts = new Map<string, number>();
  for (const r of rows) for (const step of new Set(r.errors.map(errorStep))) counts.set(step, (counts.get(step) ?? 0) + 1);
  const steps = [...counts].sort((a, b) => b[1] - a[1]).slice(0, 5);
  const latest = [...rows].sort((a, b) => b.at.localeCompare(a.at))[0];
  return {
    kind: "tick_errors",
    title: "Autopilot ticks are failing",
    detail:
      `${rows.length} autopilot ticks in the last ${TICK_ERROR_WINDOW_HOURS}h recorded errors (it ticks every 15 minutes in the send window). ` +
      `Failing steps: ${steps.map(([k, n]) => `${k} (${n} ticks)`).join(", ")}.` +
      (latest?.errors[0] ? `\nLatest (${latest.at}): ${latest.errors[0].slice(0, 200)}` : ""),
    stops: "The failing steps of every tick (see the step names); the other steps keep running.",
    action: "Read the errors in audit_log (action autopilot.tick_errors) and the /api/autopilot/tick logs in Vercel.",
  };
}

// ── Learning stalled ─────────────────────────────────────────────────────────

/** First emails sent 15-30 days ago are all settled (ATTRIBUTION_WINDOW_DAYS 14 + a day). */
export const LEARNING_DUE_MIN = 5;
/** The learner rewrites every writer arm (learning_arms.updated_at) on each tick it runs. */
export const LEARNING_STALE_DAYS = 7;
/** Tick step names of the learning step: lib/autopilot/tick.ts step("learn") (settling and the pre-send guardrail run inside it). */
export const LEARNING_STEPS: ReadonlySet<string> = new Set(["learn"]);
/** One failed learning step is a blip: the learner reruns on the next tick. */
export const LEARNING_ERROR_MIN_TICKS = 2;

export function learningStalled(s: HealthSnapshot): HealthProblem | null {
  const a = s.autopilot;
  // The tick only learns with the autopilot on; a silent tick is autopilot_stopped's job.
  // That guard also covers the kill switch flipped back on: autonomy_state has no
  // updated_at trigger (0040), and an off tick never writes it, so until the first
  // tick after the flip (which writes it, then learns) autopilot_stopped owns it.
  if (!a || !a.enabled || a.stage === "off" || autopilotStopped(s)) return null;
  const now = new Date(s.now).getTime();
  const parts: string[] = [];

  if (s.learning) {
    // The learner never counts a test send or a bounce (lib/learning/reward.ts).
    const due = s.learning.dueRootSends.filter((p) => !p.bounced && !isTestAddress(p.email)).length;
    if (due >= LEARNING_DUE_MIN) {
      const trials = s.learning.writerArms.reduce((n, r) => n + r.trials, 0);
      const newest = Math.max(...s.learning.writerArms.map((r) => (r.updatedAt ? new Date(r.updatedAt).getTime() : NaN)).filter(Number.isFinite));
      const stale = !Number.isFinite(newest) || now - newest > LEARNING_STALE_DAYS * 24 * HOUR;
      if (trials === 0 || stale) {
        const seen = trials === 0 ? "the writer arms show 0 trials" : `the writer arms were last written ${new Date(newest).toISOString()}`;
        parts.push(`${due} first emails were sent 15-30 days ago, so their outcomes have settled, but ${seen} (learning_arms, writer.*).`);
      }
    }
  }

  if (s.tickErrors) {
    const failed = within(s.tickErrors, now, 24).filter((r) => r.errors.some((e) => LEARNING_STEPS.has(errorStep(e))));
    if (failed.length >= LEARNING_ERROR_MIN_TICKS) {
      const sample = failed.flatMap((r) => r.errors).find((e) => LEARNING_STEPS.has(errorStep(e))) ?? "";
      parts.push(`The learning step failed in ${failed.length} ticks in the last 24h. Latest: ${sample.slice(0, 200)}`);
    }
  }

  if (parts.length === 0) return null;
  return {
    kind: "learning_stalled",
    title: "Learning has stalled",
    detail: parts.join("\n"),
    stops: "The writer stops learning from replies and scans: no arm is promoted or retired. Sending goes on.",
    action: "Check the learn step in the /api/autopilot/tick logs (Vercel) and audit_log autopilot.tick_errors; the arms are on " + `${s.appUrl}/learning.`,
  };
}

// ── Cron job silent ──────────────────────────────────────────────────────────

/** Scheduled runs a job may miss in a row before it is an emergency. */
export const JOB_MISSED_RUNS = 3;
/** A run is due only once it had time to finish (maxDuration 120s) and write its heartbeat. */
export const JOB_GRACE_MINUTES = 5;

const JOB_STOPS: Record<CronJob, string> = {
  "autopilot-tick": "Drafting, AUTO scheduling, breakers and learning.",
  "replies-poll": "Reading replies and bounces: lead alerts, opt-outs and the bounce breaker.",
  "send-queue": "Approved emails going out.",
  "follow-up": "Follow-up emails.",
};

/** The values one cron field allows: *, n, a-b, a-b/n, *\/n and lists of them. */
function cronField(spec: string, min: number, max: number): Set<number> {
  const out = new Set<number>();
  for (const part of spec.split(",")) {
    const [range = "*", stepText] = part.split("/");
    const step = stepText ? Number(stepText) : 1;
    let lo = min;
    let hi = max;
    if (range !== "*") {
      const [a, b] = range.split("-");
      lo = Number(a);
      hi = b !== undefined ? Number(b) : stepText ? max : lo;
    }
    for (let v = lo; v <= hi; v += step) out.add(v);
  }
  return out;
}

/** A UTC matcher for a 5-field cron expression (pg_cron runs in UTC). */
export function cronMatcher(expr: string): (t: number) => boolean {
  const [m = "*", h = "*", dom = "*", mon = "*", dow = "*"] = expr.trim().split(/\s+/);
  const minutes = cronField(m, 0, 59);
  const hours = cronField(h, 0, 23);
  const days = cronField(dom, 1, 31);
  const months = cronField(mon, 1, 12);
  const weekdays = cronField(dow, 0, 6);
  return (t) => {
    const d = new Date(t);
    return (
      minutes.has(d.getUTCMinutes()) &&
      hours.has(d.getUTCHours()) &&
      days.has(d.getUTCDate()) &&
      months.has(d.getUTCMonth() + 1) &&
      weekdays.has(d.getUTCDay())
    );
  };
}

/**
 * Scheduled runs after `from` and at or before `to`, counted up to `cap`. A job
 * with several schedules counts a minute once, however many of them match it.
 */
export function scheduledRuns(expr: string | readonly string[], from: number, to: number, cap: number = JOB_MISSED_RUNS): number {
  const matchers = (typeof expr === "string" ? [expr] : expr).map(cronMatcher);
  let n = 0;
  for (let t = Math.floor(from / 60_000) * 60_000 + 60_000; t <= to && n < cap; t += 60_000) if (matchers.some((m) => m(t))) n++;
  return n;
}

/**
 * A job is silent when it missed JOB_MISSED_RUNS scheduled runs in a row since
 * its last success: in the send window 45 min for the tick, 30 for the poll,
 * the send-queue and the follow-ups. Outside the window the send-queue and the
 * follow-ups are not scheduled, and the tick and the poll run only after it and
 * once a day (0053), so their 3 missed runs take a day or more. A job with no
 * heartbeat row yet is silent; one that never succeeded counts from when it
 * was first seen.
 */
export function jobSilent(s: HealthSnapshot): HealthProblem | null {
  if (!s.heartbeats) return null;
  const now = new Date(s.now).getTime();
  const due = now - JOB_GRACE_MINUTES * 60_000;
  const silent: Array<{ job: CronJob; line: string }> = [];
  for (const hb of s.heartbeats) {
    if (!(hb.job in CRON_JOBS)) continue;
    const job = hb.job as CronJob;
    const spec = CRON_JOBS[job];
    const base = hb.lastOkAt ?? hb.createdAt;
    if (!base) continue;
    const baseMs = new Date(base).getTime();
    if (!Number.isFinite(baseMs) || scheduledRuns(cronsOf(job), baseMs, due) < JOB_MISSED_RUNS) continue;
    const since = hb.lastOkAt ? `last successful run ${hb.lastOkAt}` : `no successful run since it was first seen ${hb.createdAt}`;
    const lastError =
      hb.lastErrorAt && new Date(hb.lastErrorAt).getTime() > baseMs ? `; last error ${hb.lastErrorAt}: ${(hb.lastError ?? "").slice(0, 200)}` : "";
    const crons = spec.schedules.map((x) => `${x.pgJob}, ${x.cron}`).join("; ");
    silent.push({ job, line: `${job} (pg_cron ${crons} UTC): ${since}, ${JOB_MISSED_RUNS}+ scheduled runs since without a success${lastError}.` });
  }
  if (silent.length === 0) return null;
  const first = silent[0] as (typeof silent)[number];
  return {
    kind: "job_silent",
    title: silent.length === 1 ? `Scheduled job ${first.job} stopped completing` : `${silent.length} scheduled jobs stopped completing`,
    detail: silent.map((x) => x.line).join("\n"),
    stops: silent.map((x) => `${x.job}: ${JOB_STOPS[x.job]}`).join(" "),
    action:
      `In Supabase, cron.job_run_details for ${silent.flatMap((x) => CRON_JOBS[x.job].schedules.map((y) => y.pgJob)).join(", ")} and net._http_response (what the app answered); ` +
      `in Vercel, the logs of ${silent.map((x) => CRON_JOBS[x.job].route).join(", ")}. A 5xx run records its error above; a run that never reached the app records nothing.`,
  };
}

export const HEALTH_RULES: ReadonlyArray<(s: HealthSnapshot) => HealthProblem | null> = [
  googleDisconnected,
  autopilotStopped,
  emailsStuck,
  inboxPaused,
  tickErrors,
  learningStalled,
  jobSilent,
];

export function findProblems(s: HealthSnapshot): HealthProblem[] {
  return HEALTH_RULES.map((rule) => rule(s)).filter((p): p is HealthProblem => p !== null);
}

/** Problems with no alert of the same kind in the last 24h. */
export function newProblems(problems: HealthProblem[], recentAlerts: Array<{ kind: string; at: string }>, now: Date): HealthProblem[] {
  const cutoff = now.getTime() - ALERT_DEDUPE_HOURS * HOUR;
  const recent = new Set(recentAlerts.filter((a) => new Date(a.at).getTime() > cutoff).map((a) => a.kind));
  return problems.filter((p) => !recent.has(p.kind));
}

export function formatHealthAlert(problems: HealthProblem[]): { subject: string; body: string } {
  const first = problems[0];
  const subject =
    problems.length === 1 && first ? `S.P.A.M. EMERGENCY: ${first.title}` : `S.P.A.M. EMERGENCY: ${problems.length} problems need you`;
  const blocks = problems.map((p, i) =>
    [`${i + 1}. ${p.title}`, p.detail, `Stops: ${p.stops}`, `Do: ${p.action}`].join("\n"),
  );
  const body = [
    "The health check found a problem the platform cannot fix by itself.",
    "",
    blocks.join("\n\n"),
    "",
    `You get this at most once per problem per ${ALERT_DEDUPE_HOURS}h. No email means healthy.`,
  ].join("\n");
  return { subject, body };
}

// ── Route orchestration (deps injected so tests run it in memory) ──────────────

export type HealthRouteDeps = {
  authorize: (req: Request) => Promise<boolean>;
  tenantIds: () => Promise<string[]>;
  snapshot: (tenantId: string, now: Date) => Promise<HealthSnapshot>;
  recentAlerts: (tenantId: string, since: Date) => Promise<Array<{ kind: string; at: string }>>;
  /** sendNotification: tries each connected inbox, and reports to Sentry when none can send. */
  send: (tenantId: string, message: { subject: string; body: string }) => Promise<{ sent: number; failed: string[] }>;
  recordAlert: (tenantId: string, problem: HealthProblem) => Promise<void>;
  /** Sentry.captureMessage at warning level: every alert also reaches Sentry, whether or not an inbox can send it. */
  capture: (message: string) => void;
  now?: () => Date;
};

export async function handleHealthCheck(req: Request, deps: HealthRouteDeps): Promise<Response> {
  if (!(await deps.authorize(req))) return Response.json({ ok: false, error: "Unauthorized" }, { status: 401 });
  const dry = new URL(req.url).searchParams.get("dry") === "1";
  const now = deps.now?.() ?? new Date();
  let tenants: string[];
  try {
    tenants = await deps.tenantIds();
  } catch (err) {
    return Response.json({ ok: false, error: (err as Error).message }, { status: 500 });
  }

  let sent = 0;
  const failed: string[] = [];
  const results: Array<{ tenantId: string; problems: HealthRule[]; emailed: HealthRule[]; suppressed: HealthRule[]; subject?: string; body?: string }> = [];
  for (const tenantId of tenants) {
    try {
      const snap = await deps.snapshot(tenantId, now);
      const problems = findProblems(snap);
      const recent = problems.length ? await deps.recentAlerts(tenantId, new Date(now.getTime() - ALERT_DEDUPE_HOURS * HOUR)) : [];
      const fresh = newProblems(problems, recent, now);
      const row = {
        tenantId,
        problems: problems.map((p) => p.kind),
        emailed: [] as HealthRule[],
        suppressed: problems.filter((p) => !fresh.includes(p)).map((p) => p.kind),
      };
      results.push(row);
      if (fresh.length === 0) continue;
      const message = formatHealthAlert(fresh);
      if (dry) {
        Object.assign(row, message);
        continue;
      }
      // Once per new problem, deduped like the email: an undelivered one retries next hour.
      for (const p of fresh) {
        try {
          deps.capture(`S.P.A.M. health: ${p.title}`);
        } catch {
          // Sentry down must not stop the email.
        }
      }
      const res = await deps.send(tenantId, message);
      sent += res.sent;
      failed.push(...res.failed.map((f) => `${tenantId}: ${f}`));
      // Dedupe only what was delivered; an undelivered alert is retried next hour.
      if (res.sent > 0) {
        for (const p of fresh) await deps.recordAlert(tenantId, p);
        row.emailed = fresh.map((p) => p.kind);
      }
    } catch (err) {
      failed.push(`${tenantId}: ${(err as Error).message}`);
    }
  }
  return Response.json({ ok: true, dry, sent, failed, results });
}
