/**
 * Weekly report: counts this week vs last over a fixture, test addresses
 * excluded everywhere, a failed source reads "n/a" (never 0), arm rates gated
 * at 20 trials, the 60-line budget, dry runs and route auth.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { buildWeeklyStats, formatWeeklyReport, handleWeeklyReport, type WeeklyRaw } from "../lib/reports/weekly.ts";

const DAY = 86_400_000;
const NOW = new Date("2026-10-19T13:10:00Z"); // Monday
const d = (days: number) => new Date(NOW.getTime() - days * DAY).toISOString();
const TEST = "pedrojr22+demo@gmail.com"; // a test address (+tag of the default)
const REAL = (i: number) => `owner${i}@acme${i}.ca`;

function fixture(): WeeklyRaw {
  return {
    now: NOW.toISOString(),
    appUrl: "https://app.test",
    sent: [
      { at: d(1), followUp: false, email: REAL(1) },
      { at: d(2), followUp: false, email: REAL(2) },
      { at: d(3), followUp: false, email: TEST },
      { at: d(3), followUp: true, email: REAL(3) },
      { at: d(9), followUp: false, email: REAL(4) },
      { at: d(20), followUp: false, email: REAL(5) }, // outside both windows
    ],
    replies: [
      { at: d(1), intent: "wants_meeting", email: REAL(1) },
      { at: d(2), intent: "not_now", email: REAL(2) },
      { at: d(2), intent: "wants_meeting", email: "pedro.jr22@gmail.com" }, // test (dots)
      { at: d(2), intent: "bounced", email: "mailer-daemon@googlemail.com" },
      { at: d(8), intent: "hard_no", email: REAL(4) },
    ],
    opportunities: [
      { createdAt: d(1), stage: "meeting_booked", closedAt: null, valueCad: null, email: REAL(1) },
      { createdAt: d(10), stage: "won", closedAt: d(2), valueCad: 4500, email: REAL(6) },
      { createdAt: d(3), stage: "won", closedAt: d(1), valueCad: 9000, email: TEST },
      { createdAt: d(12), stage: "lost", closedAt: d(4), valueCad: null, email: REAL(7) },
    ],
    optOuts: [
      { at: d(1), email: REAL(8) },
      { at: d(1), email: TEST },
    ],
    bounces: [
      { at: d(2), email: REAL(9), test: false },
      { at: d(2), email: REAL(10), test: true },
      { at: d(9), email: REAL(11), test: false },
    ],
    discoveryJobs: [{ at: d(1) }, { at: d(2) }, { at: d(8) }],
    researched: Array.from({ length: 30 }, (_, i) => ({ at: d(i % 14) })),
    drafts: [
      { at: d(1), email: REAL(1), autoRejected: false, reason: null },
      { at: d(1), email: REAL(12), autoRejected: true, reason: "unverified claim: revenue figure" },
      { at: d(2), email: REAL(13), autoRejected: true, reason: "unverified claim: staff count" },
      { at: d(2), email: REAL(14), autoRejected: true, reason: "generic opener" },
      { at: d(2), email: TEST, autoRejected: true, reason: "test only" },
    ],
    autoScheduled: [
      { at: d(1), status: "sent", email: REAL(1) },
      { at: d(2), status: "draft", email: REAL(2) }, // vetoed
      { at: d(2), status: "draft", email: TEST },
      { at: d(9), status: "sent", email: REAL(4) },
    ],
    autopilot: { enabled: true, stage: "veto", reason: "4 of 10 decisions needed before auto" },
    breakerTrips: [{ at: d(3), title: "Paused sending: bounce rate" }],
    arms: [
      { learner: "writer.evidence", key: "own-only", status: "champion", origin: "seed", reward: 5, trials: 40, negatives: 1, updated_at: d(1) },
      { learner: "scout.cell", key: "dentist|calgary", status: "challenger", origin: "learner", reward: 1, trials: 7, negatives: 0, updated_at: d(1) },
    ],
    insights: [
      { at: d(1), kind: "promote", title: "Promoted own-only evidence" },
      { at: d(2), kind: "observation", title: "Dentists reply faster" },
      { at: d(9), kind: "observation", title: "old" },
    ],
    aiSpend: [{ at: d(1), usd: 1.25 }, { at: d(2), usd: 2.5 }, { at: d(9), usd: 99 }],
    dailyCapUsd: 3,
    warmup: [
      { at: d(1), landed: true },
      { at: d(1), landed: true },
      { at: d(2), landed: false },
      { at: d(2), landed: null },
    ],
    alerts: [{ at: d(2), kind: "emails_stuck" }],
  };
}

test("counts this week vs last week, test addresses excluded", () => {
  const s = buildWeeklyStats(fixture());
  assert.deepEqual(s.firstEmails, { thisWeek: 2, lastWeek: 1 });
  assert.deepEqual(s.followUps, { thisWeek: 1, lastWeek: 0 });
  assert.deepEqual(s.replies, { thisWeek: 2, lastWeek: 1 }, "test reply and bounce reply excluded");
  assert.deepEqual(s.repliesByIntent, [["not_now", 1], ["wants_meeting", 1]]);
  assert.deepEqual(s.meetings, { thisWeek: 1, lastWeek: 2 }, "booked = opportunity created; the test-address one is excluded");
  assert.deepEqual(s.won, { count: 1, valueCad: 4500 });
  assert.deepEqual(s.lost, { count: 1, valueCad: null });
  assert.deepEqual(s.optOuts, { thisWeek: 1, lastWeek: 0 });
  assert.deepEqual(s.bounces, { thisWeek: 1, lastWeek: 1 }, "payload.test bounce excluded");
  assert.deepEqual(s.discoveryJobs, { thisWeek: 2, lastWeek: 1 });
  assert.deepEqual(s.drafts, { thisWeek: 4, lastWeek: 0 });
  assert.deepEqual(s.autoScheduled, { thisWeek: 2, lastWeek: 1 });
  assert.equal(s.vetoed, 1);
  assert.deepEqual(s.autoRejected, { count: 3, topReasons: [["unverified claim", 2], ["generic opener", 1]] });
  assert.equal(s.breakerTrips, 1);
  assert.equal(s.aiSpendUsd, 3.75);
  assert.equal(s.aiCapUsd, 21);
  assert.deepEqual(s.placement, { inbox: 2, checked: 3 });
  assert.deepEqual(s.alerts, { count: 1, kinds: ["emails_stuck"] });
});

test("the rendered report: numbers, too early, value n/a, under 60 lines", () => {
  const { subject, body } = formatWeeklyReport(buildWeeklyStats(fixture()), "https://app.test");
  assert.equal(subject, "S.P.A.M. weekly: 2 sent, 2 replies, 1 meetings");
  assert.match(body, /^First emails sent: 2 \(last week 1\)$/m);
  assert.match(body, /^Won: 1 \(CAD 4,500\)$/m);
  assert.match(body, /^Lost: 1 \(value n\/a\)$/m);
  assert.match(body, /writer\.evidence \/ own-only: 40 trials, 12\.5% reward rate \(early\)/);
  assert.match(body, /scout\.cell \/ dentist\|calgary: 7 trials, too early/);
  assert.match(body, /^AI spend: \$3\.75 of \$21\.00 weekly cap/m);
  assert.match(body, /^Warmup inbox placement: 67% inbox \(2\/3 checked\)$/m);
  assert.match(body, /^Emergencies raised: 1 \(emails_stuck\)$/m);
  assert.doesNotMatch(body, /pedrojr22|pedro\.jr22|test only/);
  assert.ok(body.split("\n").length <= 60, `${body.split("\n").length} lines`);
});

test("a failed source prints n/a, never 0", () => {
  const raw = fixture();
  for (const k of ["sent", "replies", "opportunities", "optOuts", "bounces", "discoveryJobs", "researched", "drafts", "autoScheduled", "breakerTrips", "arms", "insights", "aiSpend", "warmup", "alerts"] as const) {
    raw[k] = null;
  }
  raw.autopilot = null;
  const { subject, body } = formatWeeklyReport(buildWeeklyStats(raw), "https://app.test");
  assert.equal(subject, "S.P.A.M. weekly: report");
  for (const label of ["First emails sent", "Replies", "Meetings booked", "Opt-outs", "Bounces", "Drafts written", "AUTO scheduled"]) {
    assert.match(body, new RegExp(`^${label}: n/a \\(last week n/a\\)$`, "m"), label);
  }
  for (const line of ["Won: n/a", "Held by a person (vetoes): n/a", "Auto-rejected: n/a", "Stage: n/a", "Breaker trips this week: n/a", "Top arms: n/a", "Insights this week: n/a", "Emergencies raised: n/a"]) {
    assert.ok(body.includes(line), line);
  }
  assert.match(body, /^AI spend: n\/a of/m);
  assert.match(body, /^Warmup inbox placement: n\/a/m);
  assert.doesNotMatch(body, /: 0\b/);
});

test("placement with no checks this week is n/a, not 0%", () => {
  const raw = fixture();
  raw.warmup = [{ at: d(1), landed: null }];
  assert.match(formatWeeklyReport(buildWeeklyStats(raw), "x").body, /Warmup inbox placement: n\/a \(not measured this week\)/);
});

test("a long week still fits in 60 lines", () => {
  const raw = fixture();
  raw.replies = ["wants_meeting", "wants_info", "hard_no", "not_now", "wrong_person", "auto_reply", "unclassified"].map((intent, i) => ({ at: d(1), intent, email: REAL(i) }));
  raw.arms = Array.from({ length: 30 }, (_, i) => ({ learner: "icp", key: `k${i}`, status: "challenger" as const, origin: "learner", reward: i, trials: 100 + i, negatives: 0, updated_at: d(1) }));
  raw.insights = Array.from({ length: 30 }, (_, i) => ({ at: d(1), kind: "observation", title: `insight ${i}` }));
  raw.drafts = Array.from({ length: 30 }, (_, i) => ({ at: d(1), email: REAL(i), autoRejected: true, reason: `reason ${i % 7}` }));
  const lines = formatWeeklyReport(buildWeeklyStats(raw), "x").body.split("\n").length;
  assert.ok(lines <= 60, `${lines} lines`);
});

// ── Route ─────────────────────────────────────────────────────────────────────

function deps() {
  const sent: Array<{ subject: string; body: string }> = [];
  return {
    sent,
    deps: {
      authorize: async (req: Request) => req.headers.get("authorization") === "Bearer ok",
      tenantIds: async () => ["t1"],
      gather: async () => fixture(),
      send: async (_t: string, m: { subject: string; body: string }) => {
        sent.push(m);
        return { sent: 2, failed: [] };
      },
      now: () => NOW,
    },
  };
}

test("the route sends one report per tenant to the ops list", async () => {
  const h = deps();
  const res = await handleWeeklyReport(new Request("https://app.test/api/reports/weekly", { headers: { authorization: "Bearer ok" } }), h.deps);
  const json = (await res.json()) as { sent: number; failed: string[] };
  assert.equal(json.sent, 2);
  assert.equal(h.sent.length, 1);
  assert.match(h.sent[0]?.body ?? "", /OUTREACH/);
});

test("?dry=1 returns the text and sends nothing", async () => {
  const h = deps();
  const res = await handleWeeklyReport(new Request("https://app.test/api/reports/weekly?dry=1", { headers: { authorization: "Bearer ok" } }), h.deps);
  const json = (await res.json()) as { sent: number; reports: Array<{ body?: string }> };
  assert.equal(h.sent.length, 0);
  assert.equal(json.sent, 0);
  assert.match(json.reports[0]?.body ?? "", /^First emails sent: 2/m);
});

test("401 without the scheduler token", async () => {
  const h = deps();
  for (const q of ["", "?dry=1"]) {
    const res = await handleWeeklyReport(new Request(`https://app.test/api/reports/weekly${q}`), h.deps);
    assert.equal(res.status, 401);
  }
  assert.equal(h.sent.length, 0);
});
