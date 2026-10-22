/**
 * Health alarms (batch 8): inbox_paused, tick_errors, learning_stalled,
 * job_silent, the Sentry copy of every alert, the cron heartbeat wrapper, its
 * one call in each of the 4 cron routes, and migration 0051. Each rule has a
 * firing test and one test per state the system enters by design (silent).
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  BREAKER_PAUSE_PREFIX,
  findProblems,
  handleHealthCheck,
  inboxPaused,
  jobSilent,
  learningStalled,
  scheduledRuns,
  tickErrors,
  type HealthRouteDeps,
  type HealthSnapshot,
} from "../lib/reports/health.ts";
import { CRON_JOBS, withHeartbeat, type HeartbeatOutcome } from "../lib/reports/heartbeat.ts";

const HOUR = 3_600_000;
// Wednesday 2026-10-21 18:25 UTC: inside the send window.
const NOW = new Date("2026-10-21T18:25:00Z");
const ago = (h: number, from: Date = NOW) => new Date(from.getTime() - h * HOUR).toISOString();

type Inbox = HealthSnapshot["inboxes"][number];
const inbox = (email: string, over: Partial<Inbox> = {}): Inbox => ({
  id: `ib-${email}`,
  email,
  paused: false,
  dailyCap: 20,
  tokenOk: true,
  error: null,
  pausedReason: null,
  pausedSince: null,
  ...over,
});

/** Healthy, and today's designed state: no tick errors, no 15-day-old sends, arms at 0 trials. */
function snap(now: Date = NOW, over: Partial<HealthSnapshot> = {}): HealthSnapshot {
  return {
    now: now.toISOString(),
    appUrl: "https://app.test",
    autopilot: { enabled: true, stage: "veto", updatedAt: ago(0.2, now) },
    inboxes: [inbox("henry@runna.ca")],
    pending: [],
    recentSends: [],
    tickErrors: [],
    learning: { dueRootSends: [], writerArms: [{ trials: 0, updatedAt: ago(0.2, now) }, { trials: 0, updatedAt: ago(0.2, now) }] },
    heartbeats: [],
    ...over,
  };
}

test("today's designed state raises nothing", () => {
  assert.deepEqual(findProblems(snap()), []);
});

// ── inbox_paused ─────────────────────────────────────────────────────────────

const BREAKER = "Autopilot breaker (hard_bounces): 2 hard bounces today";

test("inbox_paused fires for a connected, capped, paused inbox: which inbox, since when, why, how to resume", () => {
  const p = inboxPaused(
    snap(NOW, {
      inboxes: [
        inbox("henry@runna.ca", { paused: true, pausedReason: "Autopilot breaker (hard_bounces): 2 hard bounces today", pausedSince: "2026-10-19T15:45:00Z" }),
      ],
    }),
  );
  assert.ok(p);
  assert.equal(p.kind, "inbox_paused");
  assert.equal(p.title, "Sending paused on henry@runna.ca");
  assert.match(p.detail, /since 2026-10-19T15:45:00Z, reason: Autopilot breaker \(hard_bounces\)/);
  assert.match(p.stops, /All cold sending/);
  assert.match(p.action, /Settings → Sending: https:\/\/app\.test\/settings\/sending/);
  assert.match(p.action, /repeats every 24h/);
});

test("inbox_paused: one of two paused says the other keeps sending; a breaker pause with no trip on record says so", () => {
  const p = inboxPaused(snap(NOW, { inboxes: [inbox("henry@runna.ca", { paused: true, pausedReason: BREAKER }), inbox("maria@runna.ca")] }));
  assert.ok(p);
  assert.match(p.stops, /other inboxes keep sending/);
  assert.match(p.detail, /henry@runna\.ca is paused since an unrecorded time/);
  assert.doesNotMatch(p.detail, /maria/);
});

test("inbox_paused fires on a breaker trip since the last resume even if a person edited the reason", () => {
  const p = inboxPaused(snap(NOW, { inboxes: [inbox("henry@runna.ca", { paused: true, pausedReason: "checking bounces", pausedSince: "2026-10-21T15:45:00Z" })] }));
  assert.ok(p);
  assert.match(p.detail, /since 2026-10-21T15:45:00Z, reason: checking bounces/);
});

test("inbox_paused: a person's pause next to a breaker pause still counts toward 'all sending stopped'", () => {
  const p = inboxPaused(
    snap(NOW, { inboxes: [inbox("henry@runna.ca", { paused: true, pausedReason: BREAKER }), inbox("maria@runna.ca", { paused: true, pausedReason: "holiday" })] }),
  );
  assert.ok(p);
  assert.equal(p.title, "Sending paused on henry@runna.ca");
  assert.match(p.stops, /All cold sending/);
});

test("the breaker prefix is the one lib/autopilot/tick.ts writes into paused_reason", () => {
  const src = readFileSync(new URL("../lib/autopilot/tick.ts", import.meta.url), "utf8");
  const written = src.match(/paused_reason: `([^$`]*)\$\{trip\.code\}/)?.[1];
  assert.equal(written, BREAKER_PAUSE_PREFIX);
});

test("inbox_paused is silent for every designed state", () => {
  const cases: Array<[string, Inbox[]]> = [
    ["nothing paused", [inbox("henry@runna.ca")]],
    ["a person paused it on purpose (Settings → Sending)", [inbox("henry@runna.ca", { paused: true, pausedReason: "holiday" })]],
    ["a person paused it with no reason", [inbox("henry@runna.ca", { paused: true })]],
    ["a breaker pause a person already resumed, then re-paused by hand", [inbox("henry@runna.ca", { paused: true, pausedReason: "testing", pausedSince: null })]],
    ["paused AND disconnected: google_disconnected's job", [inbox("henry@runna.ca", { paused: true, pausedReason: BREAKER, tokenOk: false, error: "Token refresh failed (400): invalid_grant" })]],
    ["paused during a transient token failure", [inbox("henry@runna.ca", { paused: true, pausedReason: BREAKER, tokenOk: false, error: "Token refresh failed: timed out after 10s" })]],
    ["paused with a daily cap of 0 (not a sending inbox)", [inbox("henry@runna.ca", { paused: true, pausedReason: BREAKER, dailyCap: 0 })]],
    ["no inboxes", []],
  ];
  for (const [name, inboxes] of cases) assert.equal(inboxPaused(snap(NOW, { inboxes })), null, name);
});

test("emails_stuck still ignores a paused inbox: one alert (inbox_paused), not two", () => {
  const tueNight = new Date("2026-10-20T23:25:00Z");
  const s = snap(tueNight, {
    inboxes: [inbox("henry@runna.ca", { paused: true, pausedReason: BREAKER })],
    pending: [{ id: "p-due", status: "approved", scheduledSendAt: "2026-10-20T10:00:00Z", updatedAt: null, senderInboxId: "ib-henry@runna.ca", cooldownUntil: null }],
  });
  assert.deepEqual(findProblems(s).map((p) => p.kind), ["inbox_paused"]);
});

// ── tick_errors ──────────────────────────────────────────────────────────────

const tickRow = (h: number, ...errors: string[]) => ({ at: ago(h), errors });

test("tick_errors fires on 3 erroring ticks in 2h and lists distinct step prefixes, at most 5", () => {
  const p = tickErrors(
    snap(NOW, {
      tickErrors: [
        tickRow(0.1, "supply: Places quota: 429", "label: timeout", "a: x", "b: y", "c: z", "d: w"),
        tickRow(0.35, "supply: Places quota: 429"),
        tickRow(1.9, "supply: boom", "label: timeout"),
      ],
    }),
  );
  assert.ok(p);
  assert.equal(p.kind, "tick_errors");
  assert.match(p.detail, /3 autopilot ticks in the last 2h/);
  assert.match(p.detail, /Failing steps: supply \(3 ticks\), label \(2 ticks\)/);
  const listed = (p.detail.match(/Failing steps: (.*)\./)?.[1] ?? "").split(", ");
  assert.equal(listed.length, 5, "at most 5 prefixes");
  assert.match(p.detail, /Latest \(.*\): supply: Places quota: 429/);
});

test("tick_errors is silent for a single failing tick, two, or three spread past 2h", () => {
  const cases: Array<[string, HealthSnapshot["tickErrors"]]> = [
    ["no errors", []],
    ["a single failing tick", [tickRow(0.1, "supply: boom")]],
    ["two failing ticks", [tickRow(0.1, "supply: boom"), tickRow(0.4, "supply: boom")]],
    ["three, but one is 2h+ old", [tickRow(0.1, "supply: boom"), tickRow(0.4, "supply: boom"), tickRow(2.1, "supply: boom")]],
    ["rows with an empty error list", [tickRow(0.1), tickRow(0.4), tickRow(0.6)]],
    ["not read (null)", null],
  ];
  for (const [name, rows] of cases) assert.equal(tickErrors(snap(NOW, { tickErrors: rows })), null, name);
});

// ── learning_stalled ─────────────────────────────────────────────────────────

// Prod shape: root pitches keep status "sent" (or replied …) after a bounce; the bounce is a pitch_events row.
const due = (n: number, over: Partial<{ email: string | null; bounced: boolean }> = {}) =>
  Array.from({ length: n }, (_, i) => ({ email: `owner${i}@shop${i}.ca`, bounced: false, ...over }));
const arms = (trials: number, updatedHoursAgo: number) => [
  { trials, updatedAt: ago(updatedHoursAgo) },
  { trials: 0, updatedAt: ago(updatedHoursAgo) },
];

test("learning_stalled fires when 5+ settled first emails exist and the writer arms show 0 trials", () => {
  const p = learningStalled(snap(NOW, { learning: { dueRootSends: due(5), writerArms: arms(0, 0.2) } }));
  assert.ok(p);
  assert.equal(p.kind, "learning_stalled");
  assert.match(p.detail, /5 first emails were sent 15-30 days ago.*0 trials/);
});

test("learning_stalled fires when the writer arms have not been written for 7+ days", () => {
  const p = learningStalled(snap(NOW, { learning: { dueRootSends: due(6), writerArms: arms(4, 8 * 24) } }));
  assert.ok(p);
  assert.match(p.detail, /last written/);
});

test("learning_stalled fires when the learning step failed in 2 ticks in the last 24h", () => {
  const p = learningStalled(snap(NOW, { tickErrors: [tickRow(1, "learn: relation does not exist"), tickRow(20, "learn: timeout")] }));
  assert.ok(p);
  assert.match(p.detail, /learning step failed in 2 ticks/);
});

test("learning_stalled is silent for every designed state", () => {
  const cases: Array<[string, HealthSnapshot]> = [
    ["today: no 15-day-old sends, arms at 0 trials", snap()],
    ["4 settled sends only", snap(NOW, { learning: { dueRootSends: due(4), writerArms: arms(0, 0.2) } })],
    ["5 due but all to test addresses", snap(NOW, { learning: { dueRootSends: due(5, { email: "pedrojr22+t@gmail.com" }), writerArms: arms(0, 0.2) } })],
    ["5 due but bounced (a bounce event; never a trial)", snap(NOW, { learning: { dueRootSends: due(5, { bounced: true }), writerArms: arms(0, 0.2) } })],
    [
      "kill switch flipped back on after 10 days off, before the first tick learns",
      // An off tick never writes autonomy_state.updated_at and the flip doesn't either (no trigger on 0040 tables).
      snap(NOW, { autopilot: { enabled: true, stage: "veto", updatedAt: ago(240) }, learning: { dueRootSends: due(9), writerArms: arms(3, 240) } }),
    ],
    ["5 due, learner counted them, wrote arms this tick", snap(NOW, { learning: { dueRootSends: due(5), writerArms: arms(5, 0.2) } })],
    ["autopilot switched off (the tick does not learn)", snap(NOW, { autopilot: { enabled: false, stage: "veto", updatedAt: ago(0.2) }, learning: { dueRootSends: due(9), writerArms: arms(0, 300) } })],
    ["stage off", snap(NOW, { autopilot: { enabled: true, stage: "off", updatedAt: ago(0.2) }, learning: { dueRootSends: due(9), writerArms: arms(0, 300) } })],
    ["tick not running: autopilot_stopped's job", snap(NOW, { autopilot: { enabled: true, stage: "veto", updatedAt: ago(5) }, learning: { dueRootSends: due(9), writerArms: arms(0, 300) } })],
    ["a single failed learning step", snap(NOW, { tickErrors: [tickRow(1, "learn: timeout")] })],
    ["errors from other steps", snap(NOW, { tickErrors: [tickRow(1, "supply: x"), tickRow(2, "review: y"), tickRow(3, "icp: z")] })],
    ["learning errors older than 24h", snap(NOW, { tickErrors: [tickRow(25, "learn: x"), tickRow(30, "learn: y")] })],
    ["not read (null)", snap(NOW, { learning: null, tickErrors: null })],
  ];
  for (const [name, s] of cases) assert.equal(learningStalled(s), null, name);
});

// ── job_silent ───────────────────────────────────────────────────────────────

type Beat = NonNullable<HealthSnapshot["heartbeats"]>[number];
const beat = (job: string, lastOkAt: string | null, over: Partial<Beat> = {}): Beat => ({
  job,
  lastOkAt,
  lastErrorAt: null,
  lastError: null,
  createdAt: "2026-10-20T00:00:00Z",
  ...over,
});
const at = (iso: string) => new Date(iso);
const silentAt = (now: Date, ...beats: Beat[]) => jobSilent(snap(now, { heartbeats: beats }));

test("each job's schedule is the one its migration sets", () => {
  for (const [job, spec] of Object.entries(CRON_JOBS)) {
    const file = spec.migration === "0041" ? "0041_autopilot_scheduler.sql" : "0048_replies_poll_every_10min.sql";
    const sql = readFileSync(new URL(`../supabase/migrations/${file}`, import.meta.url), "utf8");
    assert.ok(sql.includes(`'${spec.pgJob}', '${spec.cron}'`) || sql.includes(`schedule := '${spec.cron}'`), job);
    assert.ok(sql.includes(spec.route), job);
  }
});

test("scheduledRuns counts only runs inside the window", () => {
  const t = (iso: string) => new Date(iso).getTime();
  assert.equal(scheduledRuns(CRON_JOBS["autopilot-tick"].cron, t("2026-10-21T14:02:00Z"), t("2026-10-21T14:50:00Z"), 10), 3);
  assert.equal(scheduledRuns(CRON_JOBS["replies-poll"].cron, t("2026-10-21T14:06:00Z"), t("2026-10-21T14:44:00Z"), 10), 3); // :15 :25 :35
  // Friday 22:51 → Monday 15:05: only Monday 15:00 is a send-queue run.
  assert.equal(scheduledRuns(CRON_JOBS["send-queue"].cron, t("2026-10-23T22:51:00Z"), t("2026-10-26T15:05:00Z"), 10), 1);
  // Follow-ups: 15:20…22:20 weekdays only.
  assert.equal(scheduledRuns(CRON_JOBS["follow-up"].cron, t("2026-10-21T22:21:00Z"), t("2026-10-22T16:30:00Z"), 10), 2);
  // The run at exactly `from` is the one that succeeded: never counted.
  assert.equal(scheduledRuns(CRON_JOBS["autopilot-tick"].cron, t("2026-10-21T14:00:00Z"), t("2026-10-21T14:14:00Z"), 10), 0);
});

test("job_silent fires when the tick missed 3 runs, naming the job, schedule and where to look", () => {
  const p = silentAt(NOW, beat("autopilot-tick", ago(55 / 60)));
  assert.ok(p);
  assert.equal(p.kind, "job_silent");
  assert.equal(p.title, "Scheduled job autopilot-tick stopped completing");
  assert.match(p.detail, /spam-autopilot-tick, \*\/15 \* \* \* \* UTC/);
  assert.match(p.action, /cron\.job_run_details for spam-autopilot-tick/);
  assert.match(p.action, /\/api\/autopilot\/tick/);
});

test("job_silent fires for a send-queue that missed 3 runs inside the window, with its last error", () => {
  const p = silentAt(
    at("2026-10-26T15:40:00Z"), // Monday
    beat("send-queue", "2026-10-23T22:51:00Z", { lastErrorAt: "2026-10-26T15:31:00Z", lastError: "HTTP 500 Send-queue error: boom" }),
  );
  assert.ok(p);
  assert.match(p.detail, /last error 2026-10-26T15:31:00Z: HTTP 500 Send-queue error: boom/);
});

test("job_silent fires for a job that never succeeded since it was first seen", () => {
  const p = silentAt(NOW, beat("replies-poll", null, { createdAt: ago(1), lastErrorAt: ago(0.1), lastError: "HTTP 500 DB query failed" }));
  assert.ok(p);
  assert.match(p.detail, /no successful run since it was first seen/);
});

test("job_silent: several silent jobs are one problem listing each", () => {
  const p = silentAt(NOW, beat("autopilot-tick", ago(2)), beat("follow-up", ago(4)));
  assert.ok(p);
  assert.equal(p.title, "2 scheduled jobs stopped completing");
  assert.match(p.stops, /autopilot-tick: .* follow-up: Follow-up emails/);
});

test("job_silent is silent for every designed state", () => {
  const cases: Array<[string, Date, Beat[]]> = [
    ["no heartbeat rows yet (first hours after deploy)", NOW, []],
    ["the tick ran 20 minutes ago", NOW, [beat("autopilot-tick", ago(20 / 60))]],
    ["two missed ticks only", NOW, [beat("autopilot-tick", ago(35 / 60))]],
    ["third tick run still inside its grace", at("2026-10-21T14:48:00Z"), [beat("autopilot-tick", "2026-10-21T14:02:00Z")]],
    ["send-queue on Saturday after Friday's last run", at("2026-10-24T12:25:00Z"), [beat("send-queue", "2026-10-23T22:51:00Z")]],
    ["send-queue Monday before the window", at("2026-10-26T14:25:00Z"), [beat("send-queue", "2026-10-23T22:51:00Z")]],
    ["send-queue Monday 15:24, the 15:20 run still in its grace", at("2026-10-26T15:24:00Z"), [beat("send-queue", "2026-10-23T22:51:00Z")]],
    ["send-queue at night, last ran at 22:50", at("2026-10-21T23:59:00Z"), [beat("send-queue", "2026-10-21T22:51:00Z")]],
    ["follow-up two window hours in (17:20 run in its grace)", at("2026-10-21T17:24:00Z"), [beat("follow-up", "2026-10-20T22:21:00Z")]],
    ["follow-up overnight", at("2026-10-22T14:25:00Z"), [beat("follow-up", "2026-10-21T22:21:00Z")]],
    ["poll ran 15 minutes ago", NOW, [beat("replies-poll", ago(0.25))]],
    ["an unknown job row", NOW, [beat("warmup-engine", ago(100))]],
    ["no last_ok and no created_at", NOW, [beat("autopilot-tick", null, { createdAt: null })]],
  ];
  for (const [name, now, beats] of cases) assert.equal(jobSilent(snap(now, { heartbeats: beats })), null, name);
  assert.equal(jobSilent(snap(NOW, { heartbeats: null })), null, "not read (null)");
});

test("job_silent: follow-up fires on the third missed window hour", () => {
  assert.ok(silentAt(at("2026-10-21T17:30:00Z"), beat("follow-up", "2026-10-20T22:21:00Z")));
});

// ── Sentry copy of each alert ───────────────────────────────────────────────

function harness(opts: { snapshot: (now: Date) => HealthSnapshot; deliver?: boolean }) {
  const audit: Array<{ kind: string; at: string }> = [];
  const sent: Array<{ subject: string; body: string }> = [];
  const captured: string[] = [];
  let now = NOW;
  const deps: HealthRouteDeps = {
    authorize: async (req) => req.headers.get("authorization") === "Bearer ok",
    tenantIds: async () => ["t1"],
    snapshot: async (_t, when) => opts.snapshot(when),
    recentAlerts: async (_t, since) => audit.filter((a) => new Date(a.at) >= since),
    send: async (_t, m) => {
      sent.push(m);
      return opts.deliver === false ? { sent: 0, failed: ["token: invalid_grant"] } : { sent: 2, failed: [] };
    },
    recordAlert: async (_t, p) => {
      audit.push({ kind: p.kind, at: now.toISOString() });
    },
    capture: (m) => captured.push(m),
    now: () => now,
  };
  const call = async (when: Date, query = "", auth = true) => {
    now = when;
    const headers: Record<string, string> = auth ? { authorization: "Bearer ok" } : {};
    return handleHealthCheck(new Request(`https://app.test/api/reports/health${query}`, { headers }), deps);
  };
  return { audit, sent, captured, call };
}

const pausedAndSilent = (now: Date) =>
  snap(now, { inboxes: [inbox("henry@runna.ca", { paused: true, pausedReason: BREAKER })], heartbeats: [beat("autopilot-tick", ago(2, now))] });

test("each new problem goes to Sentry once, deduped like the email", async () => {
  const h = harness({ snapshot: pausedAndSilent });
  await h.call(NOW);
  assert.deepEqual(h.captured.sort(), ["S.P.A.M. health: Scheduled job autopilot-tick stopped completing", "S.P.A.M. health: Sending paused on henry@runna.ca"]);
  await h.call(new Date(NOW.getTime() + HOUR));
  await h.call(new Date(NOW.getTime() + 23 * HOUR));
  assert.equal(h.captured.length, 2, "deduped problems are not captured again");
  assert.equal(h.sent.length, 1);
  await h.call(new Date(NOW.getTime() + 25 * HOUR));
  assert.equal(h.captured.length, 4, "the daily reminder reaches Sentry too");
  assert.equal(h.sent.length, 2);
});

test("a run with one old and one new problem sends only the new one to Sentry", async () => {
  let both = false;
  const h = harness({
    snapshot: (n) => (both ? pausedAndSilent(n) : snap(n, { inboxes: [inbox("henry@runna.ca", { paused: true, pausedReason: BREAKER })] })),
  });
  await h.call(NOW);
  assert.deepEqual(h.captured, ["S.P.A.M. health: Sending paused on henry@runna.ca"]);
  both = true;
  await h.call(new Date(NOW.getTime() + HOUR));
  assert.deepEqual(h.captured, ["S.P.A.M. health: Sending paused on henry@runna.ca", "S.P.A.M. health: Scheduled job autopilot-tick stopped completing"]);
});

test("an undelivered alert still reaches Sentry (and retries hourly like the email)", async () => {
  const h = harness({ snapshot: pausedAndSilent, deliver: false });
  await h.call(NOW);
  assert.equal(h.captured.length, 2);
  await h.call(new Date(NOW.getTime() + HOUR));
  assert.equal(h.captured.length, 4);
  assert.equal(h.audit.length, 0);
});

test("healthy, dry and unauthorized runs capture nothing", async () => {
  const healthy = harness({ snapshot: (n) => snap(n) });
  await healthy.call(NOW);
  assert.equal(healthy.captured.length, 0);
  const h = harness({ snapshot: pausedAndSilent });
  await h.call(NOW, "?dry=1");
  const res = await h.call(NOW, "", false);
  assert.equal(res.status, 401);
  assert.equal(h.captured.length, 0);
  assert.equal(h.sent.length, 0);
});

test("a Sentry failure does not stop the email", async () => {
  const h = harness({ snapshot: pausedAndSilent });
  const deps = { capture: () => { throw new Error("sentry down"); } };
  // Re-run with a throwing capture.
  const res = await handleHealthCheck(new Request("https://app.test/api/reports/health", { headers: { authorization: "Bearer ok" } }), {
    authorize: async () => true,
    tenantIds: async () => ["t1"],
    snapshot: async (_t, n) => pausedAndSilent(n),
    recentAlerts: async () => [],
    send: async (_t, m) => {
      h.sent.push(m);
      return { sent: 1, failed: [] };
    },
    recordAlert: async () => {},
    ...deps,
  });
  assert.equal(res.status, 200);
  assert.equal(h.sent.length, 1);
});

// ── Heartbeat wrapper ───────────────────────────────────────────────────────

function recorder() {
  const rows: Array<{ job: string; outcome: HeartbeatOutcome }> = [];
  return { rows, record: async (job: keyof typeof CRON_JOBS, outcome: HeartbeatOutcome) => void rows.push({ job, outcome }) };
}

test("withHeartbeat records ok for a 2xx (or 4xx) answer and passes the response through", async () => {
  const r = recorder();
  const body = { ok: true, sent: 3 };
  const res = await withHeartbeat("send-queue", async () => Response.json(body), r.record);
  assert.deepEqual(await res.json(), body);
  assert.deepEqual(r.rows, [{ job: "send-queue", outcome: { ok: true } }]);
  await withHeartbeat("send-queue", async () => Response.json({ error: "bad" }, { status: 400 }), r.record);
  assert.deepEqual(r.rows[1]?.outcome, { ok: true });
});

test("withHeartbeat records the error of a 5xx answer, and the response is unchanged", async () => {
  const r = recorder();
  const res = await withHeartbeat("replies-poll", async () => Response.json({ error: "DB query failed", details: "timeout" }, { status: 500 }), r.record);
  assert.equal(res.status, 500);
  assert.deepEqual(await res.json(), { error: "DB query failed", details: "timeout" });
  assert.deepEqual(r.rows, [{ job: "replies-poll", outcome: { ok: false, error: "HTTP 500 DB query failed: timeout" } }]);
});

test("withHeartbeat records a throw and rethrows it", async () => {
  const r = recorder();
  await assert.rejects(withHeartbeat("autopilot-tick", async () => { throw new Error("boom"); }, r.record), /boom/);
  assert.deepEqual(r.rows, [{ job: "autopilot-tick", outcome: { ok: false, error: "threw: boom" } }]);
});

test("a failing heartbeat write never changes the response", async () => {
  const res = await withHeartbeat("follow-up", async () => Response.json({ ok: true }), async () => {
    throw new Error("db down");
  });
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { ok: true });
});

test("a long error is clipped to 300 characters", async () => {
  const r = recorder();
  await withHeartbeat("follow-up", async () => Response.json({ error: "x".repeat(1000) }, { status: 503 }), r.record);
  const o = r.rows[0]?.outcome;
  assert.ok(o && !o.ok && o.error.length === 300);
});

// ── One heartbeat per authorized run in each cron route ─────────────────────

const ROUTES: Array<[string, keyof typeof CRON_JOBS]> = [
  ["app/api/autopilot/tick/route.ts", "autopilot-tick"],
  ["app/api/pitches/send-queue/route.ts", "send-queue"],
  ["app/api/pitches/follow-up/route.ts", "follow-up"],
  ["app/api/replies/poll/route.ts", "replies-poll"],
];

test("each cron route calls withHeartbeat exactly once, after its 401 return, wrapping the whole run", () => {
  for (const [file, job] of ROUTES) {
    const src = readFileSync(new URL(`../${file}`, import.meta.url), "utf8");
    const calls = src.match(/withHeartbeat\(/g) ?? [];
    assert.equal(calls.length, 1, file);
    const unauthorized = src.indexOf('{ status: 401 }');
    const call = src.indexOf(`return withHeartbeat("${job}", () => `);
    assert.ok(unauthorized > 0 && call > unauthorized, `${file}: the heartbeat is on the authorized path only`);
    // Between the 401 and the heartbeat there is nothing but the closing brace.
    const between = src.slice(src.indexOf("\n", unauthorized), call);
    assert.match(between, /^\n\s*\}\n\s*$/, `${file}: nothing runs between the auth check and the heartbeat-wrapped run`);
    assert.equal(`app${CRON_JOBS[job].route}/route.ts`, file);
  }
});

// ── Migration 0051 ──────────────────────────────────────────────────────────

test("migration 0051 creates cron_heartbeats with RLS on, no policies, no schedule change", () => {
  const sql = readFileSync(new URL("../supabase/migrations/0051_cron_heartbeats.sql", import.meta.url), "utf8");
  const code = sql.split("\n").filter((l) => !l.trim().startsWith("--")).join("\n");
  assert.match(code, /create table if not exists public\.cron_heartbeats \(\s*job text primary key,/);
  for (const col of ["last_ok_at timestamptz", "last_error_at timestamptz", "last_error text", "updated_at timestamptz default now()"]) assert.ok(code.includes(col), col);
  assert.match(code, /alter table public\.cron_heartbeats enable row level security;/);
  assert.doesNotMatch(code, /create policy|tenant_id|cron\.schedule|drop /i);
});

test("the snapshot reads only columns 0051 creates", () => {
  const src = readFileSync(new URL("../lib/reports/snapshot.ts", import.meta.url), "utf8");
  const sel = src.match(/from\("cron_heartbeats"\)\.select\("([^"]+)"\)/)?.[1];
  assert.ok(sel);
  const sql = readFileSync(new URL("../supabase/migrations/0051_cron_heartbeats.sql", import.meta.url), "utf8");
  for (const col of sel.split(",").map((c) => c.trim())) assert.match(sql, new RegExp(`\\n\\s+${col} `), col);
  const hb = readFileSync(new URL("../lib/reports/heartbeat.ts", import.meta.url), "utf8");
  for (const col of ["last_ok_at", "last_error_at", "last_error", "updated_at"]) assert.ok(hb.includes(`${col}:`), col);
});
