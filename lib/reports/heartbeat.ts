/**
 * Cron heartbeats (migration 0051): each scheduled job writes one row at the
 * end of every authorized run, and the health check (rule job_silent in
 * health.ts) alerts when a job stopped completing runs inside its window.
 *
 * Sentry cron monitors would do this too, but beyond one monitor they are a
 * paid add-on (cost rule), so the proof of life lives in our own Postgres.
 *
 * A run "succeeded" when it answered below 500, whatever it did: a send-queue
 * run outside the window or with the kill switch on still ran. A 5xx or a
 * throw records last_error instead and leaves last_ok_at where it was.
 * Writing the heartbeat never throws and never changes the route's response.
 * Tested in tests/health-alarms.test.ts.
 */

import { createServiceRoleClient } from "../supabase/service-role.ts";

/**
 * Each job's pg_cron schedules, quoted from their migrations (a test reads them
 * back). The tick and the reply poll keep their pace inside the send window;
 * outside it they run right after it closes and once a day, plus the ticks the
 * digests and the kill switch need (0053 explains each). Every run is a cold
 * start Vercel bills, and outside the window nothing sends.
 */
export const CRON_JOBS = {
  "autopilot-tick": {
    route: "/api/autopilot/tick",
    schedules: [
      { pgJob: "spam-autopilot-tick", cron: "*/15 15-22 * * 1-5", migration: "0053" },
      { pgJob: "spam-autopilot-tick-close", cron: "15 23 * * 1-5", migration: "0053" },
      { pgJob: "spam-autopilot-tick-evening", cron: "15 1 * * 1-6", migration: "0053" },
      { pgJob: "spam-autopilot-tick-morning", cron: "15 13 * * *", migration: "0053" },
      { pgJob: "spam-autopilot-tick-prewindow", cron: "45 14 * * 1-5", migration: "0053" },
    ],
  },
  "replies-poll": {
    route: "/api/replies/poll",
    schedules: [
      { pgJob: "spam-replies-poll", cron: "5-59/10 15-22 * * 1-5", migration: "0053" },
      { pgJob: "spam-replies-poll-close", cron: "5 23 * * 1-5", migration: "0053" },
      { pgJob: "spam-replies-poll-morning", cron: "5 13 * * *", migration: "0053" },
    ],
  },
  "send-queue": {
    route: "/api/pitches/send-queue",
    schedules: [{ pgJob: "spam-send-queue", cron: "*/10 15-22 * * 1-5", migration: "0041" }],
  },
  "follow-up": {
    route: "/api/pitches/follow-up",
    schedules: [{ pgJob: "spam-follow-up", cron: "7-59/10 15-22 * * 1-5", migration: "0052" }],
  },
  "site-observe": {
    route: "/api/research/observe",
    schedules: [{ pgJob: "spam-site-observe", cron: "12,42 15-22 * * 1-5", migration: "0054" }],
  },
} as const;

export type CronJob = keyof typeof CRON_JOBS;

/** Every cron expression a job runs on (UTC). */
export const cronsOf = (job: CronJob): string[] => CRON_JOBS[job].schedules.map((s) => s.cron);

export type HeartbeatOutcome = { ok: true } | { ok: false; error: string };
export type RecordHeartbeat = (job: CronJob, outcome: HeartbeatOutcome) => Promise<void>;

const ERROR_MAX = 300;
const WRITE_TIMEOUT_MS = 3_000;

const clip = (s: string) => (s.length > ERROR_MAX ? `${s.slice(0, ERROR_MAX - 1)}…` : s);

/** A 5xx body's error text ({ error, details }), or the status alone. */
async function errorOf(res: Response): Promise<string> {
  try {
    const body = (await res.clone().json()) as { error?: unknown; details?: unknown };
    const text = [body.error, body.details].filter((x) => typeof x === "string" && x).join(": ");
    return clip(`HTTP ${res.status}${text ? ` ${text}` : ""}`);
  } catch {
    return `HTTP ${res.status}`;
  }
}

/** Upserts the job's row: only the columns of this outcome, so the other side's last value stays. */
export async function recordHeartbeat(job: CronJob, outcome: HeartbeatOutcome): Promise<void> {
  try {
    const at = new Date().toISOString();
    const row = outcome.ok
      ? { job, last_ok_at: at, updated_at: at }
      : { job, last_error_at: at, last_error: clip(outcome.error), updated_at: at };
    // cron_heartbeats (0051) isn't in the generated types yet.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { error } = await (createServiceRoleClient() as any)
      .from("cron_heartbeats")
      .upsert(row, { onConflict: "job" })
      .abortSignal(AbortSignal.timeout(WRITE_TIMEOUT_MS));
    if (error) console.warn(`[heartbeat] ${job} not recorded:`, error.message);
  } catch (err) {
    console.warn(`[heartbeat] ${job} not recorded:`, (err as Error).message);
  }
}

/**
 * Runs an authorized cron run and records its heartbeat. Call it once, after
 * the route's own auth check. The response (or the throw) is passed through
 * untouched.
 */
export async function withHeartbeat<R extends Response>(
  job: CronJob,
  run: () => Promise<R>,
  record: RecordHeartbeat = recordHeartbeat,
): Promise<R> {
  const write = async (outcome: HeartbeatOutcome) => {
    try {
      await record(job, outcome);
    } catch {
      // A heartbeat must never change the run's result.
    }
  };
  let res: R;
  try {
    res = await run();
  } catch (err) {
    await write({ ok: false, error: clip(`threw: ${err instanceof Error ? err.message : String(err)}`) });
    throw err;
  }
  await write(res.status >= 500 ? { ok: false, error: await errorOf(res) } : { ok: true });
  return res;
}
