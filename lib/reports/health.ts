/**
 * The hourly health check: emails ONLY when something is wrong, at most once
 * per problem per 24h, and is silent otherwise.
 *
 * An emergency is activity that was due in a period and did not happen, never
 * "something is waiting": every state the system enters by design is silent,
 * because the 24h dedupe would turn a false positive into a daily email.
 * Each is a pure rule over a snapshot that snapshot.ts gathers:
 *   google_disconnected  a connected inbox's refresh token no longer works
 *   autopilot_stopped    the kill switch is on but no tick has run for 2h
 *   emails_stuck         the last closed send window had sendable pitches due
 *                        and their inbox sent nothing, or a pitch stayed in
 *                        "sending" through a whole window
 * Not emergencies, by design: the AI budget cap, breaker trips (the tick
 * already emails them), the daily-cap drip, cooldowns, weekends, a quiet day.
 *
 * Dedupe: an audit_log row (action health.alert, metadata.kind = the rule) is
 * written after an email goes out; a rule with such a row in the last 24h is
 * not emailed again. Tested in tests/reports-health.test.ts.
 */

const HOUR = 3_600_000;

export const ALERT_DEDUPE_HOURS = 24;
/** The tick runs every 15 min (0041); eight missed ticks is not a blip. */
export const TICK_SILENCE_HOURS = 2;

/**
 * The send-queue runs weekdays every 10 min from 15:00 to 22:50 UTC (0041:
 * `*\/10 15-22 * * 1-5`). Outside a window nothing is supposed to send, so
 * "emails stuck" is judged on the last CLOSED window only, and only within
 * 24h of its close: a weekend never re-judges Friday's window.
 */
const SEND_WINDOW = { days: [1, 2, 3, 4, 5], startHour: 15, endHour: 23, lastRunMinute: 22 * 60 + 50 };

export type HealthRule = "google_disconnected" | "autopilot_stopped" | "emails_stuck";

export type HealthSnapshot = {
  now: string;
  appUrl: string;
  autopilot: { enabled: boolean; stage: string; updatedAt: string | null } | null;
  /** Every sender_inboxes row with a refresh token, its send state, and what getAccessToken said. */
  inboxes: Array<{ id: string; email: string; paused: boolean; dailyCap: number; tokenOk: boolean; error: string | null }>;
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
  if (Number.isFinite(last) && now - last <= TICK_SILENCE_HOURS * HOUR) return null;
  const observed = Number.isFinite(last)
    ? `the last tick recorded is ${new Date(last).toISOString()}, ${Math.floor((now - last) / HOUR)}h ago`
    : "no tick has been recorded";
  return {
    kind: "autopilot_stopped",
    title: "Autopilot stopped running",
    detail: `The autopilot is switched on (stage ${a.stage}); it runs every 15 minutes, but ${observed} (autonomy_state.updated_at).`,
    stops: "New drafts, AUTO scheduling, breakers and learning. Already-approved emails still send.",
    action: "Check the spam-autopilot-tick job in Supabase (cron.job_run_details, net._http_response) and the latest /api/autopilot/tick logs in Vercel.",
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
 *   - a paused inbox (a breaker, which the tick already emails), a
 *     disconnected one (E1's job), or one with no daily cap
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

export const HEALTH_RULES: ReadonlyArray<(s: HealthSnapshot) => HealthProblem | null> = [googleDisconnected, autopilotStopped, emailsStuck];

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
    "The hourly health check found a problem the platform cannot fix by itself.",
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
