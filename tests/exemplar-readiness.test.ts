/**
 * Exemplar readiness in the weekly report: how many past pitches would qualify
 * as style examples today. The count runs the same predicate the selector runs
 * (qualifiesAsExemplar) plus fetchExemplars's own rules (suppressed prospect,
 * do-not-contact address or domain), each rule here has a case, a failed read
 * prints "n/a" (never 0), and the "worth turning on" hint follows the switch.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { isTestAddress } from "../lib/compliance/test-addresses.ts";
import type { OutcomeEvent } from "../lib/learning/reward.ts";
import { segmentOf, type SegmentIndustry, type SegmentMarket } from "../lib/learning/segments.ts";
import { toDncEntries, type CandidateRow } from "../lib/pitches/exemplar-queries.ts";
import {
  qualifiesAsExemplar,
  selectExemplars,
  type ExemplarCandidateWithEvents,
  type ExemplarTarget,
} from "../lib/pitches/exemplars.ts";
import { buildWeeklyStats, exemplarReadiness, formatWeeklyReport, type ExemplarPool, type WeeklyRaw } from "../lib/reports/weekly.ts";

const DAY = 86_400_000;
const NOW = new Date("2026-10-19T13:10:00Z"); // Monday
const d = (days: number) => new Date(NOW.getTime() - days * DAY).toISOString();

const sent = (days: number, test = false): OutcomeEvent => ({ type: "sent", at: d(days), payload: test ? { test: true } : null });
const reply = (days: number, intent: string): OutcomeEvent => ({ type: "reply", at: d(days), payload: { intent } });
const scan = (days: number, stage = "scan"): OutcomeEvent => ({ type: "audit_scan", at: d(days), payload: { stage } });
const bounce = (days: number): OutcomeEvent => ({ type: "bounce", at: d(days), payload: null });
const booked = (days: number): OutcomeEvent => ({ type: "meeting_booked", at: d(days), payload: null });

type PoolRow = ExemplarPool["pitches"][number];

let seq = 0;
/** One settled root send to a Canadian law firm with a meeting request: qualifies unless overridden. */
function row(
  over: Partial<Omit<CandidateRow, "prospects" | "prospect_contacts">> & {
    prospect?: Partial<NonNullable<CandidateRow["prospects"]>>;
    email?: string | null;
    events?: OutcomeEvent[];
  } = {},
): PoolRow {
  seq++;
  const { prospect, email, events, ...rest } = over;
  return {
    id: `pitch-${seq}`,
    prospect_id: `prospect-${seq}`,
    parent_pitch_id: null,
    status: "sent",
    sent_at: d(30),
    critic_pass: true,
    gate_override: null,
    prospects: { industry: "Law firm", market: "CA", language: "en", status: "sent", ...prospect },
    prospect_contacts: { email: email === undefined ? `owner${seq}@firm${seq}.ca` : email },
    events: events ?? [sent(30), reply(28, "wants_meeting")],
    ...rest,
  };
}

/** Every rule fetchExemplars applies, one case each, and the three that pass. */
function world() {
  const legalCa = row({ id: "q-legal-ca" });
  const dentalMx = row({
    id: "q-dental-mx",
    prospect: { industry: "Clínica dental", market: "MX", language: "es" },
    events: [sent(40), reply(38, "wants_info")],
  });
  // Sent before pitch_events existed: no "sent" row, the pitch's own sent_at stands in.
  const preEventsScanned = row({ id: "q-pre-events-scan", events: [scan(25)] });
  const qualifying = [legalCa, dentalMx, preEventsScanned];

  const excluded = {
    followUp: row({ parent_pitch_id: legalCa.id }),
    unsettled: row({ sent_at: d(5), events: [sent(5), reply(4, "wants_meeting")] }),
    criticFailed: row({ critic_pass: false }),
    gateOverride: row({ gate_override: { codes: ["unverified_claim"] } }),
    testAddress: row({ email: "pedrojr22+demo@gmail.com" }),
    testEvent: row({ events: [sent(30, true), reply(28, "wants_meeting")] }),
    bounced: row({ events: [sent(30), bounce(30), booked(20)] }),
    lowScore: row({ events: [sent(30), reply(28, "not_now")] }),
    negativeReply: row({ events: [sent(30), scan(29, "contact_request"), reply(28, "hard_no")] }),
    otherSegment: row({ prospect: { industry: "Astrology readings" } }),
    suppressed: row({ prospect: { status: "suppressed" } }),
    dncAddress: row({ email: " Owner@Blocked.ca " }),
    dncDomain: row({ email: "sales@blocked-domain.ca" }),
    // Pre-events and silent: 0 on the outcome scale, the prod state today.
    preEventsSilent: row({ events: [] }),
  };
  const dnc = toDncEntries([{ email: "OWNER@blocked.ca" }], [{ domain: " Blocked-Domain.CA " }]);
  // The same pitch read twice (a paging overlap): still one pitch.
  const pitches = [...qualifying, ...Object.values(excluded), { ...legalCa }];
  return { pitches, dnc, qualifying, excluded };
}

// ── The count ────────────────────────────────────────────────────────────────

test("readiness: each rule excludes its case; two languages qualify; counted once", () => {
  const w = world();
  assert.equal(segmentOf({ industry: "Astrology readings" }).industry, "other", "fixture: the 'other' case really is unclassified");
  const r = exemplarReadiness({ pitches: w.pitches, dnc: w.dnc }, NOW);
  assert.deepEqual(r, {
    count: 3,
    byLang: [["EN", 2], ["ES", 1]],
    topSegments: [["legal/ca", 2], ["dental/mx", 1]],
  });
});

test("readiness: each excluded case qualifies once its one rule is lifted (the fixture is not vacuous)", () => {
  const w = world();
  const lifted: Record<keyof typeof w.excluded, (r: PoolRow) => PoolRow> = {
    followUp: (r) => ({ ...r, parent_pitch_id: null }),
    unsettled: (r) => ({ ...r, sent_at: d(30), events: [sent(30), reply(28, "wants_meeting")] }),
    criticFailed: (r) => ({ ...r, critic_pass: true }),
    gateOverride: (r) => ({ ...r, gate_override: null }),
    testAddress: (r) => ({ ...r, prospect_contacts: { email: "owner@real-firm.ca" } }),
    testEvent: (r) => ({ ...r, events: [sent(30), reply(28, "wants_meeting")] }),
    bounced: (r) => ({ ...r, events: [sent(30), booked(20)] }),
    lowScore: (r) => ({ ...r, events: [sent(30), reply(28, "wants_meeting")] }),
    negativeReply: (r) => ({ ...r, events: [sent(30), scan(29, "contact_request")] }),
    otherSegment: (r) => ({ ...r, prospects: { ...r.prospects!, industry: "Law firm" } }),
    suppressed: (r) => ({ ...r, prospects: { ...r.prospects!, status: "sent" } }),
    dncAddress: (r) => ({ ...r, prospect_contacts: { email: "owner@open.ca" } }),
    dncDomain: (r) => ({ ...r, prospect_contacts: { email: "sales@open-domain.ca" } }),
    preEventsSilent: (r) => ({ ...r, events: [reply(20, "wants_meeting")] }),
  };
  for (const [name, r] of Object.entries(w.excluded) as Array<[keyof typeof w.excluded, PoolRow]>) {
    assert.equal(exemplarReadiness({ pitches: [r], dnc: w.dnc }, NOW).count, 0, `${name} is excluded`);
    assert.equal(exemplarReadiness({ pitches: [lifted[name](r)], dnc: w.dnc }, NOW).count, 1, `${name} qualifies once lifted`);
  }
});

test("readiness: prod today (settled sends, all before pitch_events, no outcome event) counts 0", () => {
  const pitches = Array.from({ length: 178 }, () => row({ events: [] }));
  assert.deepEqual(exemplarReadiness({ pitches, dnc: toDncEntries([], []) }, NOW), { count: 0, byLang: [], topSegments: [] });
});

test("readiness: top segments are the three biggest", () => {
  const seg = (industry: string, n: number) => Array.from({ length: n }, () => row({ prospect: { industry } }));
  const pitches = [...seg("Law firm", 4), ...seg("Dentist", 3), ...seg("Accounting firm", 2), ...seg("Gym", 1)];
  const r = exemplarReadiness({ pitches, dnc: toDncEntries([], []) }, NOW);
  assert.equal(r.count, 10);
  assert.deepEqual(r.topSegments, [["legal/ca", 4], ["dental/ca", 3], ["accounting/ca", 2]]);
});

// ── The line in the report ───────────────────────────────────────────────────

function raw(over: Partial<WeeklyRaw> = {}): WeeklyRaw {
  return {
    now: NOW.toISOString(),
    appUrl: "https://app.test",
    sent: [],
    replies: [],
    opportunities: [],
    optOuts: [],
    bounces: [],
    discoveryJobs: [],
    researched: [],
    drafts: [],
    autoScheduled: [],
    autopilot: { enabled: true, stage: "veto", reason: null },
    breakerTrips: [],
    arms: [],
    insights: [],
    aiSpend: [],
    dailyCapUsd: 3,
    warmup: [],
    alerts: [],
    exemplarsEnabled: false,
    exemplarPool: { pitches: [], dnc: toDncEntries([], []) },
    ...over,
  };
}

const exemplarLine = (r: WeeklyRaw) => {
  const lines = formatWeeklyReport(buildWeeklyStats(r), r.appUrl).body.split("\n").filter((l) => l.startsWith("Exemplars:"));
  assert.equal(lines.length, 1, "exactly one Exemplars line");
  return lines[0] ?? "";
};
const pool = (n: number): ExemplarPool => ({
  pitches: Array.from({ length: n }, (_, i) => row(i % 2 ? { prospect: { industry: "Dentista", market: "MX", language: "es" } } : {})),
  dnc: toDncEntries([], []),
});

test("report line: a failed read is n/a, never 0", () => {
  assert.equal(exemplarLine(raw({ exemplarPool: null })), "Exemplars: off (EXEMPLARS_ENABLED unset). Past pitches that qualify: n/a");
  assert.equal(exemplarLine(raw({ exemplarPool: null, exemplarsEnabled: true })), "Exemplars: on. Past pitches that qualify: n/a");
});

test("report line: nothing qualifies is 0, with no breakdown", () => {
  assert.equal(exemplarLine(raw()), "Exemplars: off (EXEMPLARS_ENABLED unset). Past pitches that qualify: 0");
});

test("report line: the breakdown by language and top segments", () => {
  const w = world();
  assert.equal(
    exemplarLine(raw({ exemplarPool: { pitches: w.pitches, dnc: w.dnc } })),
    "Exemplars: off (EXEMPLARS_ENABLED unset). Past pitches that qualify: 3 (EN 2, ES 1; top: legal/ca 2, dental/mx 1)",
  );
});

test("report line: 'worth turning on' from 5 with the switch off, never when on", () => {
  assert.doesNotMatch(exemplarLine(raw({ exemplarPool: pool(4) })), /worth turning on/);
  assert.equal(
    exemplarLine(raw({ exemplarPool: pool(5) })),
    "Exemplars: off (EXEMPLARS_ENABLED unset). Past pitches that qualify: 5 (EN 3, ES 2; top: legal/ca 3, dental/mx 2): worth turning on",
  );
  assert.equal(
    exemplarLine(raw({ exemplarPool: pool(5), exemplarsEnabled: true })),
    "Exemplars: on. Past pitches that qualify: 5 (EN 3, ES 2; top: legal/ca 3, dental/mx 2)",
  );
});

test("report line: sits in LEARNING", () => {
  const body = formatWeeklyReport(buildWeeklyStats(raw()), "x").body;
  const at = (s: string) => body.indexOf(s);
  assert.ok(at("LEARNING") < at("Exemplars:") && at("Exemplars:") < at("HEALTH"), body);
});

// ── One predicate: the selector picks only what the count counts ─────────────

/** Seeded PRNG (mulberry32) so a failure reproduces. */
function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function randomCandidates(seed: number, n: number): ExemplarCandidateWithEvents[] {
  const r = rng(seed);
  const pickOne = <T>(xs: readonly T[]): T => xs[Math.floor(r() * xs.length)]!;
  const eventPool: Array<() => OutcomeEvent> = [
    () => sent(30),
    () => sent(30, true),
    () => reply(28, "wants_meeting"),
    () => reply(28, "wants_info"),
    () => reply(28, "not_now"),
    () => reply(28, "hard_no"),
    () => scan(27),
    () => scan(27, "contact_request"),
    () => bounce(29),
    () => ({ type: "unsubscribe", at: d(26), payload: null }),
    () => booked(20),
  ];
  return Array.from({ length: n }, (_, i) => {
    const sentAt = pickOne([d(30), d(30), d(15), d(13), null, "not a date"]);
    return {
      pitch_id: `rand-${seed}-${i}`,
      prospect_id: `prospect-${seed}-${i}`,
      parent_pitch_id: r() < 0.15 ? "parent" : null,
      status: r() < 0.1 ? "approved" : "sent",
      sent_at: sentAt,
      lang: pickOne(["en", "es", "en", "es", ""]),
      industry: pickOne(["Law firm", "Abogados", "Clínica dental", "Astrology readings", null]),
      market: pickOne(["CA", "MX", null]),
      recipient_email: pickOne([`o${i}@firm${i}.ca`, `o${i}@firm${i}.mx`, "pedrojr22@gmail.com", "pedro.jr22+x@gmail.com", null]),
      critic_pass: pickOne([true, false, null]),
      gate_overridden: r() < 0.15,
      events: eventPool.filter(() => r() < 0.3).map((e) => e()),
    };
  });
}

const INDUSTRIES: SegmentIndustry[] = ["legal", "dental", "other"];
const MARKETS: SegmentMarket[] = ["ca", "mx", "unknown"];
const TARGETS: ExemplarTarget[] = (["en", "es"] as const).flatMap((lang) =>
  INDUSTRIES.flatMap((industry) => MARKETS.map((market) => ({ lang, segment: { industry, market, size: "small" as const }, prospect_id: "p-target" }))),
);
const OPTS = { now: NOW, isTestAddress, max: 1_000_000 };

test("one predicate: every pitch selectExemplars picks, for any target, the readiness predicate counts (same score)", () => {
  for (const seed of [1, 2, 3, 4, 5]) {
    const cands = randomCandidates(seed, 400);
    const counted = new Map(cands.map((c) => [c.pitch_id, qualifiesAsExemplar(c, OPTS)]));
    for (const target of TARGETS) {
      for (const p of selectExemplars(cands, target, OPTS)) {
        const q = counted.get(p.pitch_id);
        assert.ok(q, `seed ${seed}: ${p.pitch_id} picked for ${JSON.stringify(target)} but not counted`);
        assert.equal(q.score, p.score);
      }
    }
  }
});

test("one predicate: every pitch the readiness predicate counts is picked for its own segment, and nothing else is picked anywhere", () => {
  let counted = 0;
  for (const seed of [11, 12, 13, 14, 15]) {
    for (const c of randomCandidates(seed, 400)) {
      const q = qualifiesAsExemplar(c, OPTS);
      const pickedSomewhere = TARGETS.some((t) => selectExemplars([c], t, OPTS).length === 1);
      assert.equal(pickedSomewhere, q !== null, `seed ${seed}: ${JSON.stringify(c)}`);
      if (q) {
        counted++;
        const own: ExemplarTarget = { lang: c.lang as "en" | "es", segment: q.segment, prospect_id: "p-target" };
        assert.equal(selectExemplars([c], own, OPTS)[0]?.tier, 1, "its own segment is a tier-1 match");
      }
    }
  }
  assert.ok(counted > 20, `the generator produces qualifying pitches (${counted})`);
});

test("one predicate: the weekly count over the fixture equals the qualifying set the selector can reach", () => {
  const w = world();
  const reach = new Set<string>();
  // What fetchExemplars applies before selection (suppressed) and after (do-not-contact), then the selector.
  for (const target of TARGETS) {
    const rows = w.pitches.filter((p) => p.prospects?.status !== "suppressed");
    const cands = rows.map((p) => ({
      pitch_id: p.id,
      prospect_id: p.prospect_id,
      parent_pitch_id: p.parent_pitch_id,
      status: p.status,
      sent_at: p.sent_at,
      lang: p.prospects?.language ?? "",
      industry: p.prospects?.industry ?? null,
      market: p.prospects?.market ?? null,
      recipient_email: p.prospect_contacts?.email ?? null,
      critic_pass: p.critic_pass,
      gate_overridden: p.gate_override !== null,
      events: p.events,
    }));
    for (const pick of selectExemplars(cands, { ...target, prospect_id: null }, OPTS)) reach.add(pick.pitch_id);
  }
  const blocked = new Set([w.excluded.dncAddress.id, w.excluded.dncDomain.id]);
  const reachable = [...reach].filter((id) => !blocked.has(id)).sort();
  assert.deepEqual(reachable, w.qualifying.map((q) => q.id).sort());
  assert.equal(exemplarReadiness({ pitches: w.pitches, dnc: w.dnc }, NOW).count, reachable.length);
});
