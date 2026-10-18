/**
 * The hourly health check: emails ONLY when something is wrong, at most once
 * per problem per 24h, and is silent otherwise.
 *
 * Each emergency is a pure rule over a snapshot that snapshot.ts gathers:
 *   google_disconnected  a connected inbox's refresh token no longer works
 *   autopilot_stopped    the kill switch is on but no tick has run for 2h
 *   emails_stuck         approved pitches long past their send time, or a
 *                        pitch left in "sending"
 * Not emergencies, by design: the AI budget cap, breaker trips (the tick
 * already emails them), a quiet day.
 *
 * Dedupe: an audit_log row (action health.alert, metadata.kind = the rule) is
 * written after an email goes out; a rule with such a row in the last 24h is
 * not emailed again. Tested in tests/reports-health.test.ts.
 */

const HOUR = 3_600_000;

export const ALERT_DEDUPE_HOURS = 24;
/** The tick runs every 15 min (0041); eight missed ticks is not a blip. */
export const TICK_SILENCE_HOURS = 2;
export const STUCK_APPROVED_HOURS = 24;
export const STUCK_SENDING_HOURS = 1;

/**
 * The send-queue only runs on weekdays 15:00–22:50 UTC (0041:
 * `*\/10 15-22 * * 1-5`), so a pitch due Friday night legitimately waits for
 * Monday. "Stuck" therefore also needs one whole send window to have passed
 * since the pitch was due, or every weekend would raise an alert.
 */
const SEND_WINDOW = { days: [1, 2, 3, 4, 5], startHour: 15, endHour: 23 };

export type HealthRule = "google_disconnected" | "autopilot_stopped" | "emails_stuck";

export type HealthSnapshot = {
  now: string;
  appUrl: string;
  autopilot: { enabled: boolean; stage: string; updatedAt: string | null } | null;
  /** Every sender_inboxes row with a refresh token, and what getAccessToken said. */
  inboxes: Array<{ email: string; tokenOk: boolean; error: string | null }>;
  /** Pitches in approved or sending. updatedAt is the row's updated_at (trigger-maintained). */
  pending: Array<{ id: string; status: string; scheduledSendAt: string | null; updatedAt: string | null }>;
};

export type HealthProblem = {
  kind: HealthRule;
  title: string;
  detail: string;
  stops: string;
  action: string;
};

/**
 * A token failure that says nothing about the connection (Google down, a
 * timeout) is retried next hour instead of raising "disconnected". Anything
 * else, including errors we haven't seen, counts as disconnected.
 */
export function isTransientTokenError(error: string | null): boolean {
  return !!error && /timed out|\(5\d\d\)|fetch failed|ECONNRESET|ENOTFOUND|EAI_AGAIN|network/i.test(error);
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
  const since = Number.isFinite(last) ? `${Math.floor((now - last) / HOUR)}h (last tick ${new Date(last).toISOString()})` : "ever (no tick recorded)";
  return {
    kind: "autopilot_stopped",
    title: "Autopilot stopped running",
    detail: `The autopilot is switched on (stage ${a.stage}) but no tick has run for ${since}.`,
    stops: "New drafts, AUTO scheduling, breakers and learning. Already-approved emails still send.",
    action: "Check the spam-autopilot-tick job in Supabase (cron.job_run_details, net._http_response) and the latest /api/autopilot/tick logs in Vercel.",
  };
}

/** Start of the first whole send window that opens after `t`. */
export function firstFullWindowAfter(t: number): number {
  const d = new Date(t);
  for (let i = 0; i < 8; i++) {
    const start = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + i, SEND_WINDOW.startHour);
    if (start > t && SEND_WINDOW.days.includes(new Date(start).getUTCDay())) return start;
  }
  return t;
}

/** Due more than 24h ago AND a whole send window has closed since it was due. */
export function isStuckApproved(scheduledSendAt: string, now: number): boolean {
  const due = new Date(scheduledSendAt).getTime();
  if (!Number.isFinite(due) || now - due <= STUCK_APPROVED_HOURS * HOUR) return false;
  return now >= firstFullWindowAfter(due) + (SEND_WINDOW.endHour - SEND_WINDOW.startHour) * HOUR;
}

export function emailsStuck(s: HealthSnapshot): HealthProblem | null {
  const now = new Date(s.now).getTime();
  const approved = s.pending.filter((p) => p.status === "approved" && p.scheduledSendAt && isStuckApproved(p.scheduledSendAt, now));
  const sending = s.pending.filter(
    (p) => p.status === "sending" && p.updatedAt && now - new Date(p.updatedAt).getTime() > STUCK_SENDING_HOURS * HOUR,
  );
  if (approved.length === 0 && sending.length === 0) return null;
  const parts: string[] = [];
  if (approved.length) {
    const oldest = approved.map((p) => p.scheduledSendAt as string).sort()[0];
    parts.push(`${approved.length} approved pitch(es) more than ${STUCK_APPROVED_HOURS}h past their send time, through a whole send window (oldest due ${oldest}).`);
  }
  if (sending.length) {
    parts.push(`${sending.length} pitch(es) in "sending" for over ${STUCK_SENDING_HOURS}h: ${sending.slice(0, 5).map((p) => p.id).join(", ")}.`);
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
  /** fromEmail: a connected inbox whose token works, so a disconnect alert can still go out. */
  send: (tenantId: string, message: { subject: string; body: string; fromEmail?: string }) => Promise<{ sent: number; failed: string[] }>;
  recordAlert: (tenantId: string, problem: HealthProblem) => Promise<void>;
  /** Last resort when no email went out (e.g. the only inbox is the disconnected one). */
  undelivered: (tenantId: string, problems: HealthProblem[], failed: string[]) => Promise<void>;
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
      const fromEmail = snap.inboxes.find((i) => i.tokenOk)?.email;
      const res = await deps.send(tenantId, { ...message, fromEmail });
      sent += res.sent;
      failed.push(...res.failed.map((f) => `${tenantId}: ${f}`));
      if (res.sent > 0) {
        // Dedupe only what was delivered; an undelivered alert is retried next hour.
        for (const p of fresh) await deps.recordAlert(tenantId, p);
        row.emailed = fresh.map((p) => p.kind);
      } else {
        await deps.undelivered(tenantId, fresh, res.failed);
      }
    } catch (err) {
      failed.push(`${tenantId}: ${(err as Error).message}`);
    }
  }
  return Response.json({ ok: true, dry, sent, failed, results });
}
