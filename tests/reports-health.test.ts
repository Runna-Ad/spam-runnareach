/**
 * Health check: each emergency rule fires on its bad snapshot and not on
 * a healthy one, a healthy run sends nothing, the 24h dedupe, undelivered
 * alerts retry, dry runs, route auth, and migration 0045.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  autopilotStopped,
  emailsStuck,
  findProblems,
  formatHealthAlert,
  googleDisconnected,
  handleHealthCheck,
  lastClosedSendWindow,
  newProblems,
  type HealthRouteDeps,
  type HealthSnapshot,
} from "../lib/reports/health.ts";

const HOUR = 3_600_000;
// Monday 2026-10-19 14:25 UTC.
const NOW = new Date("2026-10-19T14:25:00Z");
// Monday 2026-10-19 17:25 UTC, inside the send window (the tick runs every 15 min).
const IN_WINDOW = new Date("2026-10-19T17:25:00Z");
const ago = (h: number, from: Date = NOW) => new Date(from.getTime() - h * HOUR).toISOString();

type Inbox = HealthSnapshot["inboxes"][number];
type Pending = HealthSnapshot["pending"][number];
const inbox = (email: string, over: Partial<Inbox> = {}): Inbox => ({ id: `ib-${email}`, email, paused: false, dailyCap: 20, tokenOk: true, error: null, ...over });
const pitch = (over: Partial<Pending> = {}): Pending => ({
  id: "p",
  status: "approved",
  scheduledSendAt: null,
  updatedAt: null,
  senderInboxId: "ib-henry@runna.ca",
  cooldownUntil: null,
  ...over,
});

function healthy(now: Date = NOW): HealthSnapshot {
  return {
    now: now.toISOString(),
    appUrl: "https://app.test",
    autopilot: { enabled: true, stage: "veto", updatedAt: ago(0.2, now) },
    inboxes: [inbox("henry@runna.ca")],
    pending: [
      pitch({ id: "p-fresh", scheduledSendAt: ago(2, now) }),
      pitch({ id: "p-future", scheduledSendAt: ago(-10, now) }),
      pitch({ id: "p-sending", status: "sending", scheduledSendAt: null, updatedAt: ago(0.1, now) }),
    ],
    // The queue ran in the last closed window.
    recentSends: [{ senderInboxId: "ib-henry@runna.ca", sentAt: new Date((lastClosedSendWindow(now.getTime())?.start ?? 0) + 600_000).toISOString() }],
    // Today's designed state: no tick errors, no 15-day-old sends, arms at 0 trials, no heartbeat rows yet.
    tickErrors: [],
    learning: { dueRootSends: [], writerArms: [{ trials: 0, updatedAt: ago(0.2, now) }] },
    heartbeats: [],
  };
}

test("a healthy snapshot has no problems", () => {
  assert.deepEqual(findProblems(healthy()), []);
});

// ── E1 Google disconnected ────────────────────────────────────────────────────

test("E1 fires when a connected inbox's token fails, naming the inbox and the fix", () => {
  const s = healthy();
  s.inboxes.push(inbox("maria@runna.ca", { tokenOk: false, error: 'Token refresh failed (400): {"error":"invalid_grant"}' }));
  const p = googleDisconnected(s);
  assert.ok(p);
  assert.equal(p.kind, "google_disconnected");
  assert.match(p.title, /maria@runna\.ca/);
  assert.doesNotMatch(p.title, /henry/);
  assert.match(p.stops, /Sending, reply reading and calendar/);
  assert.match(p.action, /Settings → Sending/);
});

test("E1 ignores a transient token failure (timeout, Google 5xx) and retries next hour", () => {
  for (const error of ["Token refresh failed: timed out after 10s", "Token refresh failed (503): backend", "Token refresh failed (429): rate limited", "Token refresh failed: fetch failed"]) {
    const s = healthy();
    s.inboxes[0] = inbox("henry@runna.ca", { tokenOk: false, error });
    assert.equal(googleDisconnected(s), null, error);
  }
  const s = healthy();
  s.inboxes[0] = inbox("henry@runna.ca", { tokenOk: false, error: "Could not decrypt refresh token." });
  assert.ok(googleDisconnected(s), "an unknown or permanent error counts as disconnected");
});

// ── E2 Autopilot stopped ─────────────────────────────────────────────────────

test("E2 fires when the autopilot is on and no tick wrote autonomy_state for 8 scheduled ticks (2h in the window)", () => {
  const s = healthy(IN_WINDOW);
  s.autopilot = { enabled: true, stage: "veto", updatedAt: ago(3, IN_WINDOW) };
  const p = autopilotStopped(s);
  assert.ok(p);
  assert.equal(p.kind, "autopilot_stopped");
  assert.match(p.detail, /last tick recorded is .*, 3h ago/);
  assert.doesNotMatch(p.detail, /no tick has run/);
  s.autopilot.updatedAt = null;
  assert.ok(autopilotStopped(s));
});

test("E2 is quiet when the tick ran within 8 scheduled ticks, or the autopilot is switched off", () => {
  const s = healthy(IN_WINDOW);
  s.autopilot = { enabled: true, stage: "veto", updatedAt: ago(1.9, IN_WINDOW) };
  assert.equal(autopilotStopped(s), null, "7 ticks due since 15:31");
  // Outside the window the tick runs after it and once a day (0053): hours without one are by design.
  for (const [now, last] of [
    ["2026-10-19T14:25:00Z", "2026-10-19T01:15:20Z"], // Monday before the window: only 13:15 was due
    ["2026-10-24T12:25:00Z", "2026-10-23T22:45:20Z"], // Saturday: only Fri 23:15 and Sat 01:15 were due
    ["2026-10-26T12:25:00Z", "2026-10-25T13:15:20Z"], // Monday morning after Sunday's run: only Mon 01:15 due
  ] as const) {
    const q = healthy(new Date(now));
    q.autopilot = { enabled: true, stage: "veto", updatedAt: last };
    assert.equal(autopilotStopped(q), null, now);
  }
  s.autopilot = { enabled: false, stage: "veto", updatedAt: ago(48) };
  assert.equal(autopilotStopped(s), null);
  s.autopilot = { enabled: true, stage: "off", updatedAt: ago(48) };
  assert.equal(autopilotStopped(s), null, "the tick skips stage off, so it never writes");
  s.autopilot = null;
  assert.equal(autopilotStopped(s), null);
});

// ── E3 Emails stuck ─────────────────────────────────────────────────────────
// Judged on the last CLOSED send window (weekdays 15:00–23:00 UTC), within 24h of its close.

const TUE_NIGHT = new Date("2026-10-20T23:25:00Z"); // Tuesday's window closed at 23:00
const at = (iso: string) => new Date(iso);
function snapAt(now: Date, over: Partial<HealthSnapshot> = {}): HealthSnapshot {
  return { ...healthy(now), pending: [], recentSends: [], ...over };
}
const dueTue = pitch({ id: "p-due", scheduledSendAt: "2026-10-20T10:00:00Z" });

test("lastClosedSendWindow: weekdays only, closed only", () => {
  const w = (iso: string) => {
    const r = lastClosedSendWindow(new Date(iso).getTime());
    return r ? new Date(r.start).toISOString() : null;
  };
  assert.equal(w("2026-10-20T23:25:00Z"), "2026-10-20T15:00:00.000Z");
  assert.equal(w("2026-10-20T20:00:00Z"), "2026-10-19T15:00:00.000Z", "today's window is still open");
  assert.equal(w("2026-10-18T12:00:00Z"), "2026-10-16T15:00:00.000Z", "Sunday → Friday");
});

test("E3 true positive: a sendable pitch was due in the last closed window and its inbox sent nothing", () => {
  const p = emailsStuck(snapAt(TUE_NIGHT, { pending: [dueTue] }));
  assert.ok(p);
  assert.equal(p.kind, "emails_stuck");
  assert.match(p.detail, /1 approved pitch\(es\) were due in the 2026-10-20 send window/);
  assert.match(p.detail, /henry@runna\.ca sent nothing/);
});

test("E3 true positive: a pitch already in sending before the window opened is still sending after it closed", () => {
  const hung = pitch({ id: "p-hung", status: "sending", updatedAt: "2026-10-20T09:00:00Z" });
  const p = emailsStuck(snapAt(TUE_NIGHT, { pending: [hung] }));
  assert.ok(p);
  assert.match(p.detail, /p-hung/);
});

test("E3 is silent for every state the send-queue holds a pitch in by design", () => {
  const cases: Array<[string, HealthSnapshot]> = [
    ["paused inbox (a breaker; the tick emails it)", snapAt(TUE_NIGHT, { pending: [dueTue], inboxes: [inbox("henry@runna.ca", { paused: true })] })],
    ["disconnected inbox (E1's job)", { ...snapAt(TUE_NIGHT, { pending: [dueTue], inboxes: [inbox("henry@runna.ca", { tokenOk: false, error: "Token refresh failed (400): invalid_grant" })] }) }],
    ["inbox with no daily cap", snapAt(TUE_NIGHT, { pending: [dueTue], inboxes: [inbox("henry@runna.ca", { dailyCap: 0 })] })],
    [
      "daily-cap drip backlog: the inbox sent in the window",
      snapAt(TUE_NIGHT, {
        pending: Array.from({ length: 30 }, (_, i) => pitch({ id: `p${i}`, scheduledSendAt: "2026-10-19T16:00:00Z" })),
        recentSends: [{ senderInboxId: "ib-henry@runna.ca", sentAt: "2026-10-20T15:10:00Z" }],
      }),
    ],
    ["prospect in cooldown", snapAt(TUE_NIGHT, { pending: [{ ...dueTue, cooldownUntil: "2026-10-27T00:00:00Z" }] })],
    ["due after the window's last run (22:50)", snapAt(TUE_NIGHT, { pending: [pitch({ scheduledSendAt: "2026-10-20T22:55:00Z" })] })],
    ["weekend: due Friday after the last run, checked Saturday", snapAt(at("2026-10-24T12:00:00Z"), { pending: [pitch({ scheduledSendAt: "2026-10-23T23:30:00Z" })] })],
    ["weekend: Sunday, more than 24h after Friday's window", snapAt(at("2026-10-25T12:00:00Z"), { pending: [pitch({ scheduledSendAt: "2026-10-22T10:00:00Z" })] })],
    ["outside the window: Tuesday 20:00, window still open", snapAt(at("2026-10-20T20:00:00Z"), { pending: [pitch({ scheduledSendAt: "2026-10-20T19:00:00Z" })] })],
    ["Friday 22:51 sending row, checked Saturday", snapAt(at("2026-10-24T09:25:00Z"), { pending: [pitch({ status: "sending", updatedAt: "2026-10-23T22:51:00Z" })] })],
    ["veto stage with nothing sent yet: AUTO pitches scheduled 18h out", snapAt(TUE_NIGHT, { pending: [pitch({ scheduledSendAt: "2026-10-21T17:00:00Z" })] })],
    ["pitch with no sender inbox", snapAt(TUE_NIGHT, { pending: [{ ...dueTue, senderInboxId: null }] })],
  ];
  for (const [name, snap] of cases) assert.equal(emailsStuck(snap), null, name);
});

test("conductor repro: a pitch due Mon 10:00 behind a cap drip stays silent all week", () => {
  const backlog = pitch({ id: "p-backlog", scheduledSendAt: "2026-10-19T10:00:00Z" });
  for (const day of ["2026-10-20", "2026-10-21", "2026-10-22", "2026-10-23"]) {
    const snap = snapAt(at(`${day}T23:25:00Z`), {
      pending: [backlog],
      recentSends: [{ senderInboxId: "ib-henry@runna.ca", sentAt: `${day}T15:00:00Z` }],
    });
    assert.deepEqual(findProblems(snap), [], day);
  }
});

test("AI cap reached, no discovery for hours, nothing waiting: silent (the tick still writes autonomy_state)", () => {
  const s = snapAt(TUE_NIGHT, { autopilot: { enabled: true, stage: "veto", updatedAt: ago(0.2, TUE_NIGHT) } });
  assert.deepEqual(findProblems(s), []);
});

test("budget cap, breaker trips and a quiet day are not emergencies", () => {
  const s = healthy();
  s.pending = [];
  // Nothing in the snapshot even carries spend or breaker trips: the rules cannot see them.
  assert.deepEqual(Object.keys(s).sort(), ["appUrl", "autopilot", "heartbeats", "inboxes", "learning", "now", "pending", "recentSends", "tickErrors"]);
  assert.deepEqual(findProblems(s), []);
});

// ── Format ─────────────────────────────────────────────────────────────────────

test("the alert names each problem, what it stops, and the one thing to do", () => {
  const s = healthy(IN_WINDOW);
  s.autopilot = { enabled: true, stage: "veto", updatedAt: ago(5, IN_WINDOW) };
  s.inboxes[0] = inbox("henry@runna.ca", { tokenOk: false, error: "Token refresh failed (400): invalid_grant" });
  const { subject, body } = formatHealthAlert(findProblems(s));
  assert.match(subject, /EMERGENCY: 2 problems/);
  assert.match(body, /1\. Google disconnected for henry@runna\.ca/);
  assert.match(body, /2\. Autopilot stopped running/);
  assert.equal((body.match(/^Stops: /gm) ?? []).length, 2);
  assert.equal((body.match(/^Do: /gm) ?? []).length, 2);
});

// ── Route: healthy = no email, dedupe, undelivered, dry, auth ──────────────────

type Sent = { subject: string; body: string };

function harness(opts: { snapshot: (now: Date) => HealthSnapshot; deliver?: boolean }) {
  const audit: Array<{ kind: string; at: string }> = [];
  const sent: Sent[] = [];
  let now = NOW;
  const deps: HealthRouteDeps = {
    authorize: async (req) => req.headers.get("authorization") === "Bearer ok",
    tenantIds: async () => ["t1"],
    snapshot: async (_t, at) => opts.snapshot(at),
    recentAlerts: async (_t, since) => audit.filter((a) => new Date(a.at) >= since),
    send: async (_t, m) => {
      sent.push(m);
      return opts.deliver === false ? { sent: 0, failed: ["token: invalid_grant"] } : { sent: 2, failed: [] };
    },
    recordAlert: async (_t, p) => {
      audit.push({ kind: p.kind, at: now.toISOString() });
    },
    capture: () => {},
    now: () => now,
  };
  const call = async (at: Date, query = "") => {
    now = at;
    const res = await handleHealthCheck(new Request(`https://app.test/api/reports/health${query}`, { headers: { authorization: "Bearer ok" } }), deps);
    return (await res.json()) as { sent: number; results: Array<{ problems: string[]; emailed: string[]; suppressed: string[]; body?: string }> };
  };
  return { audit, sent, deps, call };
}

const disconnectedAt = (at: Date): HealthSnapshot => {
  const s = healthy(at);
  s.inboxes = [inbox("henry@runna.ca"), inbox("maria@runna.ca", { tokenOk: false, error: "Token refresh failed (400): invalid_grant" })];
  return s;
};

test("a healthy run sends NO email and records nothing", async () => {
  const h = harness({ snapshot: (at) => healthy(at) });
  const out = await h.call(NOW);
  assert.equal(out.sent, 0);
  assert.equal(h.sent.length, 0);
  assert.equal(h.audit.length, 0);
});

test("the same problem two hours running produces ONE email", async () => {
  const h = harness({ snapshot: disconnectedAt });
  const first = await h.call(NOW);
  const second = await h.call(new Date(NOW.getTime() + HOUR));
  const third = await h.call(new Date(NOW.getTime() + 2 * HOUR));
  assert.equal(h.sent.length, 1);
  assert.deepEqual(first.results[0]?.emailed, ["google_disconnected"]);
  assert.deepEqual(second.results[0]?.suppressed, ["google_disconnected"]);
  assert.deepEqual(third.results[0]?.emailed, []);
});

test("a problem that clears and returns after 24h emails again; within 24h it does not", async () => {
  let broken = true;
  const h = harness({ snapshot: (at) => (broken ? disconnectedAt(at) : healthy(at)) });
  await h.call(NOW);
  broken = false;
  await h.call(new Date(NOW.getTime() + 3 * HOUR));
  broken = true;
  await h.call(new Date(NOW.getTime() + 10 * HOUR));
  assert.equal(h.sent.length, 1, "returned within 24h of the last email");
  broken = false;
  await h.call(new Date(NOW.getTime() + 12 * HOUR));
  broken = true;
  await h.call(new Date(NOW.getTime() + 25 * HOUR));
  assert.equal(h.sent.length, 2);
});

test("one email lists every new problem of the run; an older one stays deduped", async () => {
  let both = false;
  const h = harness({
    snapshot: (at) => {
      const s = disconnectedAt(at);
      if (both) s.autopilot = { enabled: true, stage: "veto", updatedAt: ago(4, at) };
      return s;
    },
  });
  await h.call(IN_WINDOW);
  both = true;
  const out = await h.call(new Date(IN_WINDOW.getTime() + HOUR));
  assert.equal(h.sent.length, 2);
  assert.deepEqual(out.results[0]?.emailed, ["autopilot_stopped"]);
  assert.match(h.sent[1]?.subject ?? "", /Autopilot stopped/);
  assert.doesNotMatch(h.sent[1]?.body ?? "", /Google disconnected/);
});

test("an alert no inbox could deliver is not recorded and retries next hour (sendNotification reports it to Sentry)", async () => {
  const h = harness({ snapshot: disconnectedAt, deliver: false });
  await h.call(NOW);
  await h.call(new Date(NOW.getTime() + HOUR));
  assert.equal(h.audit.length, 0);
  assert.equal(h.sent.length, 2);
});

test("?dry=1 returns the text without sending or recording", async () => {
  const h = harness({ snapshot: disconnectedAt });
  const out = await h.call(NOW, "?dry=1");
  assert.equal(h.sent.length, 0);
  assert.equal(h.audit.length, 0);
  assert.match(out.results[0]?.body ?? "", /Google disconnected for maria@runna\.ca/);
});

test("401 without the scheduler token, dry or not", async () => {
  const h = harness({ snapshot: disconnectedAt });
  for (const q of ["", "?dry=1"]) {
    const res = await handleHealthCheck(new Request(`https://app.test/api/reports/health${q}`), h.deps);
    assert.equal(res.status, 401);
  }
  assert.equal(h.sent.length, 0);
});

test("newProblems ignores alerts older than 24h", () => {
  const p = googleDisconnected(disconnectedAt(NOW));
  assert.ok(p);
  assert.equal(newProblems([p], [{ kind: "google_disconnected", at: ago(23) }], NOW).length, 0);
  assert.equal(newProblems([p], [{ kind: "google_disconnected", at: ago(25) }], NOW).length, 1);
  assert.equal(newProblems([p], [{ kind: "emails_stuck", at: ago(1) }], NOW).length, 1);
});

test("newProblems: a run 24h after an alert is not suppressed by the seconds the alert took to record", () => {
  // Sat 13:25:05 alert (recorded after its run read `now`), next run Sun 13:25:00: on weekends that is the only one.
  const sun = at("2026-10-25T13:25:00Z");
  const p = googleDisconnected(disconnectedAt(sun));
  assert.ok(p);
  assert.equal(newProblems([p], [{ kind: "google_disconnected", at: "2026-10-24T13:25:05Z" }], sun).length, 1);
  assert.equal(newProblems([p], [{ kind: "google_disconnected", at: "2026-10-24T14:25:00Z" }], sun).length, 0, "23h ago still suppresses");
});

test("emails_stuck: each closed window gets its own alert, even when the previous one alerted less than 24h ago", () => {
  // Friday's window is judged only Fri 23:25, Sat 12:40 (Vercel) and Sat 13:25; by Sunday it is over 24h old.
  const FRI_NIGHT = at("2026-10-23T23:25:00Z");
  const SAT_MORNING = at("2026-10-24T13:25:00Z");
  const dueFri = pitch({ id: "p-due", scheduledSendAt: "2026-10-23T10:00:00Z" });
  for (const now of [FRI_NIGHT, SAT_MORNING]) {
    const p = emailsStuck(snapAt(now, { pending: [dueFri] }));
    assert.ok(p);
    // An alert about Thursday's window (Fri 16:25) must not hide Friday's.
    assert.equal(newProblems([p], [{ kind: "emails_stuck", at: "2026-10-23T16:25:05Z" }], now).length, 1, now.toISOString());
  }
  // Once Friday's window has alerted (Fri 23:25:05), Saturday's runs stay quiet about it.
  const p = emailsStuck(snapAt(SAT_MORNING, { pending: [dueFri] }));
  assert.ok(p);
  assert.equal(newProblems([p], [{ kind: "emails_stuck", at: "2026-10-23T23:25:05Z" }], SAT_MORNING).length, 0);
});

// ── Migration 0045 ───────────────────────────────────────────────────────────

test("migration 0045 schedules exactly the health check and the weekly report", () => {
  const sql = readFileSync(new URL("../supabase/migrations/0045_reports_cron.sql", import.meta.url), "utf8");
  const code = sql.split("\n").filter((l) => !l.trim().startsWith("--")).join("\n");
  assert.equal((code.match(/cron\.schedule\(/g) ?? []).length, 2);
  assert.match(code, /cron\.schedule\('spam-health-check', '25 \* \* \* \*', \$job\$select public\.spam_cron_call\('\/api\/reports\/health'\)\$job\$\)/);
  assert.match(code, /cron\.schedule\('spam-weekly-report', '10 13 \* \* 1', \$job\$select public\.spam_cron_call\('\/api\/reports\/weekly'\)\$job\$\)/);
  assert.doesNotMatch(code, /create|alter|drop|insert|update|delete/i);
});
