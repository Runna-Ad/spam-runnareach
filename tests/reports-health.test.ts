/**
 * Hourly health check: each emergency rule fires on its bad snapshot and not on
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
  isStuckApproved,
  newProblems,
  type HealthProblem,
  type HealthRouteDeps,
  type HealthSnapshot,
} from "../lib/reports/health.ts";

const HOUR = 3_600_000;
// Monday 2026-10-19 14:25 UTC.
const NOW = new Date("2026-10-19T14:25:00Z");
const ago = (h: number, from: Date = NOW) => new Date(from.getTime() - h * HOUR).toISOString();

function healthy(now: Date = NOW): HealthSnapshot {
  return {
    now: now.toISOString(),
    appUrl: "https://app.test",
    autopilot: { enabled: true, stage: "veto", updatedAt: ago(0.2, now) },
    inboxes: [{ email: "henry@runna.ca", tokenOk: true, error: null }],
    pending: [
      { id: "p-fresh", status: "approved", scheduledSendAt: ago(2, now), updatedAt: ago(20, now) },
      { id: "p-future", status: "approved", scheduledSendAt: ago(-10, now), updatedAt: ago(1, now) },
      { id: "p-sending", status: "sending", scheduledSendAt: null, updatedAt: ago(0.1, now) },
    ],
  };
}

test("a healthy snapshot has no problems", () => {
  assert.deepEqual(findProblems(healthy()), []);
});

// ── E1 Google disconnected ────────────────────────────────────────────────────

test("E1 fires when a connected inbox's token fails, naming the inbox and the fix", () => {
  const s = healthy();
  s.inboxes.push({ email: "maria@runna.ca", tokenOk: false, error: 'Token refresh failed (400): {"error":"invalid_grant"}' });
  const p = googleDisconnected(s);
  assert.ok(p);
  assert.equal(p.kind, "google_disconnected");
  assert.match(p.title, /maria@runna\.ca/);
  assert.doesNotMatch(p.title, /henry/);
  assert.match(p.stops, /Sending, reply reading and calendar/);
  assert.match(p.action, /Settings → Sending/);
});

test("E1 ignores a transient token failure (timeout, Google 5xx) and retries next hour", () => {
  for (const error of ["Token refresh failed: timed out after 10s", "Token refresh failed (503): backend", "Token refresh failed: fetch failed"]) {
    const s = healthy();
    s.inboxes[0] = { email: "henry@runna.ca", tokenOk: false, error };
    assert.equal(googleDisconnected(s), null, error);
  }
  const s = healthy();
  s.inboxes[0] = { email: "henry@runna.ca", tokenOk: false, error: "Could not decrypt refresh token." };
  assert.ok(googleDisconnected(s), "an unknown or permanent error counts as disconnected");
});

// ── E2 Autopilot stopped ─────────────────────────────────────────────────────

test("E2 fires when the autopilot is on and no tick wrote autonomy_state for over 2h", () => {
  const s = healthy();
  s.autopilot = { enabled: true, stage: "veto", updatedAt: ago(3) };
  const p = autopilotStopped(s);
  assert.ok(p);
  assert.equal(p.kind, "autopilot_stopped");
  assert.match(p.detail, /3h/);
  s.autopilot.updatedAt = null;
  assert.ok(autopilotStopped(s));
});

test("E2 is quiet when the tick ran within 2h, or the autopilot is switched off", () => {
  const s = healthy();
  s.autopilot = { enabled: true, stage: "veto", updatedAt: ago(1.9) };
  assert.equal(autopilotStopped(s), null);
  s.autopilot = { enabled: false, stage: "veto", updatedAt: ago(48) };
  assert.equal(autopilotStopped(s), null);
  s.autopilot = { enabled: true, stage: "off", updatedAt: ago(48) };
  assert.equal(autopilotStopped(s), null, "the tick skips stage off, so it never writes");
  s.autopilot = null;
  assert.equal(autopilotStopped(s), null);
});

// ── E3 Emails stuck ─────────────────────────────────────────────────────────

test("E3 fires on an approved pitch more than 24h overdue through a whole send window", () => {
  const s = healthy();
  s.pending.push({ id: "p-old", status: "approved", scheduledSendAt: "2026-10-15T16:00:00Z", updatedAt: null }); // Thu: Friday's window passed
  const p = emailsStuck(s);
  assert.ok(p);
  assert.equal(p.kind, "emails_stuck");
  assert.match(p.detail, /1 approved/);
});

test("E3 fires on a pitch left in sending for over 1h", () => {
  const s = healthy();
  s.pending.push({ id: "p-hung", status: "sending", scheduledSendAt: null, updatedAt: ago(1.5) });
  const p = emailsStuck(s);
  assert.ok(p);
  assert.match(p.detail, /p-hung/);
});

test("E3 does not fire over a weekend: the send-queue only runs weekdays 15:00–23:00 UTC", () => {
  const due = "2026-10-16T23:30:00Z"; // Friday, after the last run
  assert.equal(isStuckApproved(due, new Date("2026-10-18T12:00:00Z").getTime()), false, "Sunday");
  assert.equal(isStuckApproved(due, new Date("2026-10-19T20:00:00Z").getTime()), false, "Monday, window still open");
  assert.equal(isStuckApproved(due, new Date("2026-10-19T23:00:00Z").getTime()), true, "Monday's window closed without sending it");
  // A weekday pitch due mid-window: 24h alone is not enough until the next whole window closes.
  const tue = "2026-10-20T16:00:00Z";
  assert.equal(isStuckApproved(tue, new Date("2026-10-21T16:30:00Z").getTime()), false);
  assert.equal(isStuckApproved(tue, new Date("2026-10-21T23:00:00Z").getTime()), true);
});

test("budget cap, breaker trips and a quiet day are not emergencies", () => {
  const s = healthy();
  s.pending = [];
  // Nothing in the snapshot even carries spend or breakers: the rules cannot see them.
  assert.deepEqual(Object.keys(s).sort(), ["appUrl", "autopilot", "inboxes", "now", "pending"]);
  assert.deepEqual(findProblems(s), []);
});

// ── Format ─────────────────────────────────────────────────────────────────────

test("the alert names each problem, what it stops, and the one thing to do", () => {
  const s = healthy();
  s.autopilot = { enabled: true, stage: "veto", updatedAt: ago(5) };
  s.inboxes[0] = { email: "henry@runna.ca", tokenOk: false, error: "Token refresh failed (400): invalid_grant" };
  const { subject, body } = formatHealthAlert(findProblems(s));
  assert.match(subject, /EMERGENCY: 2 problems/);
  assert.match(body, /1\. Google disconnected for henry@runna\.ca/);
  assert.match(body, /2\. Autopilot stopped running/);
  assert.equal((body.match(/^Stops: /gm) ?? []).length, 2);
  assert.equal((body.match(/^Do: /gm) ?? []).length, 2);
});

// ── Route: healthy = no email, dedupe, undelivered, dry, auth ──────────────────

type Sent = { subject: string; body: string; fromEmail?: string };

function harness(opts: { snapshot: (now: Date) => HealthSnapshot; deliver?: boolean }) {
  const audit: Array<{ kind: string; at: string }> = [];
  const sent: Sent[] = [];
  const undelivered: HealthProblem[][] = [];
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
    undelivered: async (_t, problems) => {
      undelivered.push(problems);
    },
    now: () => now,
  };
  const call = async (at: Date, query = "") => {
    now = at;
    const res = await handleHealthCheck(new Request(`https://app.test/api/reports/health${query}`, { headers: { authorization: "Bearer ok" } }), deps);
    return (await res.json()) as { sent: number; results: Array<{ problems: string[]; emailed: string[]; suppressed: string[]; body?: string }> };
  };
  return { audit, sent, undelivered, deps, call };
}

const disconnectedAt = (at: Date): HealthSnapshot => {
  const s = healthy(at);
  s.inboxes = [
    { email: "henry@runna.ca", tokenOk: true, error: null },
    { email: "maria@runna.ca", tokenOk: false, error: "Token refresh failed (400): invalid_grant" },
  ];
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
  assert.equal(h.sent[0]?.fromEmail, "henry@runna.ca", "sent from an inbox whose token works");
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
  await h.call(NOW);
  both = true;
  const out = await h.call(new Date(NOW.getTime() + HOUR));
  assert.equal(h.sent.length, 2);
  assert.deepEqual(out.results[0]?.emailed, ["autopilot_stopped"]);
  assert.match(h.sent[1]?.subject ?? "", /Autopilot stopped/);
  assert.doesNotMatch(h.sent[1]?.body ?? "", /Google disconnected/);
});

test("an alert no inbox could deliver is not recorded, goes to the fallback, and retries next hour", async () => {
  const h = harness({ snapshot: disconnectedAt, deliver: false });
  await h.call(NOW);
  await h.call(new Date(NOW.getTime() + HOUR));
  assert.equal(h.audit.length, 0);
  assert.equal(h.sent.length, 2);
  assert.equal(h.undelivered.length, 2);
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

// ── Migration 0045 ───────────────────────────────────────────────────────────

test("migration 0045 schedules exactly the health check and the weekly report", () => {
  const sql = readFileSync(new URL("../supabase/migrations/0045_reports_cron.sql", import.meta.url), "utf8");
  const code = sql.split("\n").filter((l) => !l.trim().startsWith("--")).join("\n");
  assert.equal((code.match(/cron\.schedule\(/g) ?? []).length, 2);
  assert.match(code, /cron\.schedule\('spam-health-check', '25 \* \* \* \*', \$job\$select public\.spam_cron_call\('\/api\/reports\/health'\)\$job\$\)/);
  assert.match(code, /cron\.schedule\('spam-weekly-report', '10 13 \* \* 1', \$job\$select public\.spam_cron_call\('\/api\/reports\/weekly'\)\$job\$\)/);
  assert.doesNotMatch(code, /create|alter|drop|insert|update|delete/i);
});
