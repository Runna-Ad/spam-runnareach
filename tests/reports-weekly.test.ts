/**
 * Weekly report: counts this week vs last over a fixture, test addresses
 * excluded everywhere, a failed source reads "n/a" (never 0), arm rates gated
 * at 20 trials, the 60-line budget, dry runs and route auth.
 */

import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import test from "node:test";
import { buildWeeklyStats, formatWeeklyReport, formatWeeklyReportHtml, handleWeeklyReport, type WeeklyRaw } from "../lib/reports/weekly.ts";

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
    exemplarsEnabled: false,
    exemplarPool: {
      pitches: [
        {
          id: "pitch-exemplar",
          prospect_id: "prospect-exemplar",
          parent_pitch_id: null,
          status: "sent",
          sent_at: d(30),
          critic_pass: true,
          gate_override: null,
          prospects: { industry: "Law firm", market: "CA", language: "en", status: "sent" },
          prospect_contacts: { email: REAL(15) },
          events: [
            { type: "sent", at: d(30), payload: null },
            { type: "reply", at: d(28), payload: { intent: "wants_meeting" } },
          ],
        },
      ],
      dnc: { emails: new Set(), domains: new Set() },
    },
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

// ── The designed HTML part ────────────────────────────────────────────────────

const GREEN = "#15803d";
const RED = "#b91c1c";
const html = (raw: WeeklyRaw) => formatWeeklyReportHtml(buildWeeklyStats(raw), raw.appUrl);

/** What a reader sees: tags dropped, entities decoded. */
function visibleText(h: string): string {
  return h
    .replace(/<head>[\s\S]*?<\/head>/, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, "&");
}

/** Number tokens with their multiplicity: "2026-10-12", "4,500", "12.5%" → 2026, 10, 12, 4,500, 12.5. */
function numberCounts(text: string): Map<string, number> {
  const m = new Map<string, number>();
  for (const t of text.match(/\d+(?:[.,]\d+)*/g) ?? []) m.set(t, (m.get(t) ?? 0) + 1);
  return m;
}

/** The <tr> holding a row label (pairRow / valueRow put the label in the first cell). */
function rowOf(h: string, label: string): string {
  const row = h.split("<tr>").find((r) => r.includes(`>${label}</td>`));
  assert.ok(row, `row ${label}`);
  return row;
}

test("html: every number of the text version appears in the HTML, as often", () => {
  const raw = fixture();
  const text = formatWeeklyReport(buildWeeklyStats(raw), raw.appUrl).body;
  const h = html(raw);
  if (process.env.WEEKLY_PREVIEW_HTML) writeFileSync(process.env.WEEKLY_PREVIEW_HTML, h);
  const seen = numberCounts(visibleText(h));
  for (const [n, count] of numberCounts(text)) assert.ok((seen.get(n) ?? 0) >= count, `${n}: text ${count}, html ${seen.get(n) ?? 0}`);
  for (const s of ["Promoted own-only evidence", "unverified claim", "wants_meeting 1", "writer.evidence / own-only", "Open analytics", "S.P.A.M. weekly", "2 sent, 2 replies, 1 meetings", "EN 1; top: legal/ca 1"]) {
    assert.ok(visibleText(h).includes(s), s);
  }
  assert.doesNotMatch(h, /pedrojr22|pedro\.jr22|test only/);
});

test("html: DB strings are escaped (insight titles, reasons, intents, kinds, stage)", () => {
  const raw = fixture();
  raw.insights = [{ at: d(1), kind: "<i>kind</i>", title: "<script>alert(1)</script>" }];
  raw.drafts = [{ at: d(1), email: REAL(1), autoRejected: true, reason: `x" onmouseover="alert(2)` }];
  raw.replies = [{ at: d(1), intent: "<b>bold</b>", email: REAL(1) }];
  raw.alerts = [{ at: d(1), kind: "a&b<c>" }];
  raw.autopilot = { enabled: false, stage: "<img src=x>", reason: "it's <u>fine</u>" };
  const h = html(raw);
  assert.doesNotMatch(h, /<script|<i>|<b>|<u>|<img|onmouseover="/);
  for (const escaped of ["&lt;script&gt;alert(1)&lt;/script&gt;", "&lt;i&gt;kind&lt;/i&gt;", "x&quot; onmouseover=&quot;alert(2)", "&lt;b&gt;bold&lt;/b&gt;", "a&amp;b&lt;c&gt;", "&lt;img src=x&gt;", "it&#39;s &lt;u&gt;fine&lt;/u&gt;"]) {
    assert.ok(h.includes(escaped), escaped);
  }
});

test("html: a failed source is a muted n/a, and zeros render as 0", () => {
  const failed = fixture();
  for (const k of ["sent", "replies", "opportunities", "optOuts", "bounces", "discoveryJobs", "researched", "drafts", "autoScheduled", "breakerTrips", "arms", "insights", "aiSpend", "warmup", "alerts"] as const) {
    failed[k] = null;
  }
  failed.autopilot = null;
  failed.exemplarPool = null;
  const h = html(failed);
  assert.doesNotMatch(h, /undefined|null|NaN/);
  const text = visibleText(h).replace("n/a = no data.", "");
  assert.equal((text.match(/n\/a/g) ?? []).length, (h.match(/color:#94a3b8;">n\/a</g) ?? []).length, "every n/a value is muted");
  for (const label of ["First emails sent", "Replies", "Bounces", "Won", "Auto-rejected", "Stage", "Breaker trips this week", "Insights this week", "Past pitches that qualify", "Emergencies raised"]) {
    assert.match(rowOf(h, label), /color:#94a3b8;">n\/a</, label);
  }
  assert.doesNotMatch(text, /\b0\b/, "no source reads 0 when it failed");

  const empty = fixture();
  for (const k of ["sent", "replies", "opportunities", "optOuts", "bounces", "discoveryJobs", "researched", "drafts", "autoScheduled", "breakerTrips", "arms", "insights", "aiSpend", "warmup", "alerts"] as const) {
    empty[k] = [];
  }
  empty.exemplarPool = { pitches: [], dnc: { emails: new Set(), domains: new Set() } };
  const z = html(empty);
  for (const label of ["First emails sent", "Bounces", "Auto-rejected", "Breaker trips this week", "Emergencies raised", "Past pitches that qualify"]) {
    assert.match(visibleText(rowOf(z, label)), /(^|\s)0(\s|$)/, label);
  }
  assert.match(rowOf(z, "First emails sent"), />—</, "no change is a dash");
  assert.match(rowOf(z, "Top arms"), /none yet/);
});

test("html: delta colours follow what is good for each metric", () => {
  const raw = fixture();
  const at = (thisWeek: number, lastWeek: number) => [...Array.from({ length: thisWeek }, () => d(1)), ...Array.from({ length: lastWeek }, () => d(9))];
  const up = (thisWeek: number, lastWeek: number) => {
    const ts = at(thisWeek, lastWeek);
    raw.sent = [...ts.map((t) => ({ at: t, followUp: false, email: REAL(1) })), ...ts.map((t) => ({ at: t, followUp: true, email: REAL(1) }))];
    raw.replies = ts.map((t) => ({ at: t, intent: "wants_meeting", email: REAL(1) }));
    raw.opportunities = ts.map((t) => ({ createdAt: t, stage: "meeting_booked", closedAt: null, valueCad: null, email: REAL(1) }));
    raw.optOuts = ts.map((t) => ({ at: t, email: REAL(1) }));
    raw.bounces = ts.map((t) => ({ at: t, email: REAL(1), test: false }));
    raw.discoveryJobs = ts.map((t) => ({ at: t }));
    raw.researched = ts.map((t) => ({ at: t }));
    raw.drafts = ts.map((t) => ({ at: t, email: REAL(1), autoRejected: false, reason: null }));
    raw.autoScheduled = ts.map((t) => ({ at: t, status: "sent", email: REAL(1) }));
    return html(raw);
  };
  const GOOD_UP = ["First emails sent", "Replies", "Meetings booked", "Prospects researched", "Drafts written", "AUTO scheduled"];
  const BAD_UP = ["Opt-outs", "Bounces"];
  const NEUTRAL = ["Follow-ups sent", "Discovery jobs"];
  const delta = (row: string) => row.match(/<span style="color:(#[0-9a-f]{6});font-size:12px;font-weight:600;">([▲▼—]\d*)<\/span>/);

  const rising = up(3, 1);
  for (const label of GOOD_UP) assert.deepEqual(delta(rowOf(rising, label))?.slice(1), [GREEN, "▲2"], label);
  for (const label of BAD_UP) assert.deepEqual(delta(rowOf(rising, label))?.slice(1), [RED, "▲2"], label);
  for (const label of NEUTRAL) {
    const [color, text] = delta(rowOf(rising, label))?.slice(1) ?? [];
    assert.equal(text, "▲2", label);
    assert.ok(color !== GREEN && color !== RED, `${label} is neutral grey`);
  }
  const falling = up(1, 2);
  for (const label of GOOD_UP) assert.deepEqual(delta(rowOf(falling, label))?.slice(1), [RED, "▼1"], label);
  for (const label of BAD_UP) assert.deepEqual(delta(rowOf(falling, label))?.slice(1), [GREEN, "▼1"], label);
  const tiles = rising.split('<td width="33%"').slice(1);
  assert.equal(tiles.length, 3, "three KPI tiles");
  for (const [i, label] of ["First emails", "Replies", "Meetings"].entries()) {
    assert.ok(tiles[i]?.includes(`>${label}</div>`), label);
    assert.match(tiles[i] ?? "", new RegExp(`color:${GREEN};font-size:12px;font-weight:600;">▲2<`), `${label} tile delta`);
    assert.match(tiles[i] ?? "", />3<\/span>/, `${label} tile number`);
    assert.match(tiles[i] ?? "", /last week 1/, `${label} tile last week`);
  }

  // No last-week number: the count itself is coloured once it is not 0.
  const singles = fixture();
  singles.breakerTrips = [{ at: d(1), title: "x" }];
  singles.alerts = [{ at: d(1), kind: "emails_stuck" }];
  const s = html(singles);
  assert.match(rowOf(s, "Won"), new RegExp(`color:${GREEN};font-weight:600;">1<`));
  for (const label of ["Auto-rejected", "Breaker trips this week", "Emergencies raised"]) {
    assert.match(rowOf(s, label), new RegExp(`color:${RED};font-weight:600;">\\d+<`), label);
  }
  singles.breakerTrips = [];
  assert.doesNotMatch(rowOf(html(singles), "Breaker trips this week"), new RegExp(RED), "0 is not red");
});

test("html: email-safe, appUrl is the only URL, under 100 KB even for a long week", () => {
  const raw = fixture();
  raw.replies = ["wants_meeting", "wants_info", "hard_no", "not_now", "wrong_person", "auto_reply", "unclassified"].map((intent, i) => ({ at: d(1), intent, email: REAL(i) }));
  raw.arms = Array.from({ length: 30 }, (_, i) => ({ learner: "icp", key: `k${i}`.repeat(20), status: "challenger" as const, origin: "learner", reward: i, trials: 100 + i, negatives: 0, updated_at: d(1) }));
  raw.insights = Array.from({ length: 30 }, (_, i) => ({ at: d(1), kind: `kind${i % 5}`, title: `insight ${i} `.repeat(40) }));
  raw.drafts = Array.from({ length: 30 }, (_, i) => ({ at: d(1), email: REAL(i), autoRejected: true, reason: `reason ${i % 7} `.repeat(20) }));
  const h = html(raw);
  assert.ok(Buffer.byteLength(h, "utf8") < 100_000, `${Buffer.byteLength(h, "utf8")} bytes`);
  const urls = h.match(/https?:\/\/[^\s"'<>]*/g) ?? [];
  assert.ok(urls.length > 0);
  for (const u of urls) assert.ok(u.startsWith("https://app.test"), u);
  assert.ok(h.includes('href="https://app.test/analytics"'));
  assert.doesNotMatch(h, /<img|<link|<script|<style|@import|url\(|class="/i);
  assert.match(h, /max-width:600px/);
  for (const table of h.match(/<table[^>]*>/g) ?? []) assert.match(table, /role="presentation"/, table);
  assert.doesNotMatch(h, /#000000|#000\b|background-color:black/i, "no black fills");
});

test("the route sends the designed HTML alongside the unchanged text part", async () => {
  const sent: Array<{ subject: string; body: string; html?: string }> = [];
  const res = await handleWeeklyReport(new Request("https://app.test/api/reports/weekly", { headers: { authorization: "Bearer ok" } }), {
    authorize: async () => true,
    tenantIds: async () => ["t1"],
    gather: async () => fixture(),
    send: async (_t, m) => {
      sent.push(m);
      return { sent: 1, failed: [] };
    },
    now: () => NOW,
  });
  assert.equal(res.status, 200);
  const expected = formatWeeklyReport(buildWeeklyStats(fixture()), "https://app.test");
  assert.equal(sent[0]?.subject, expected.subject);
  assert.equal(sent[0]?.body, expected.body, "the text part is formatWeeklyReport, unchanged");
  assert.equal(sent[0]?.html, formatWeeklyReportHtml(buildWeeklyStats(fixture()), "https://app.test"));
});
