/**
 * Meetings and deals as outcomes: a booked meeting (or a won / lost deal on
 * it) is the email's full success, for every learner that reads reward.ts.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { OUTCOME_EVENT_TYPES, POINTS, addressOutcome, scoreOutcome, type OutcomeEvent } from "../lib/learning/reward.ts";
import type { Segment } from "../lib/learning/segments.ts";
import { selectExemplars, type ExemplarCandidate, type ExemplarTarget } from "../lib/pitches/exemplars.ts";

const NOW = new Date("2026-10-17T12:00:00Z");
const daysAgo = (d: number) => new Date(NOW.getTime() - d * 86_400_000).toISOString();

const sent = (d: number): OutcomeEvent => ({ type: "sent", at: daysAgo(d), payload: null });
const booked = (d: number, test?: boolean): OutcomeEvent => ({
  type: "meeting_booked",
  at: daysAgo(d),
  payload: { opportunity_id: "opp-1", calendar_event_id: "cal-1", attendee: "owner@firm.ca", start: daysAgo(d - 3), ...(test ? { test } : {}) } as OutcomeEvent["payload"],
});
const won = (d: number): OutcomeEvent => ({
  type: "won",
  at: daysAgo(d),
  payload: { opportunity_id: "opp-1", close_date: daysAgo(d).slice(0, 10), value: 12000 } as OutcomeEvent["payload"],
});
const lost = (d: number, reason = "booking cancelled"): OutcomeEvent => ({
  type: "lost",
  at: daysAgo(d),
  payload: { opportunity_id: "opp-1", close_date: daysAgo(d).slice(0, 10), loss_reason: reason } as OutcomeEvent["payload"],
});
const bounce = (d: number): OutcomeEvent => ({ type: "bounce", at: daysAgo(d), payload: null });

test("meeting outcomes: points are exported like the others", () => {
  assert.equal(POINTS.meeting_booked, 20);
  assert.equal(POINTS.won, 40);
  assert.equal(POINTS.lost, 0);
});

test("meeting outcomes: sent + meeting_booked → value 1, settled at once, 20 points", () => {
  const o = scoreOutcome([sent(2), booked(1)], NOW);
  assert.equal(o.value, 1);
  assert.equal(o.status, "settled");
  assert.equal(o.points, 20);
  assert.deepEqual(o.signals, ["meeting_booked"]);
  assert.equal(o.negative, false);
});

test("meeting outcomes: a won deal adds 40 on top of the meeting's 20", () => {
  const o = scoreOutcome([sent(20), booked(15), won(3)], NOW);
  assert.equal(o.value, 1);
  assert.equal(o.points, 60);
  assert.equal(o.status, "settled");
  assert.deepEqual(o.signals, ["meeting_booked", "won"]);
});

test("meeting outcomes: a lost deal or cancelled booking is still the email's success", () => {
  for (const reason of ["booking cancelled", "went with a competitor"]) {
    const o = scoreOutcome([sent(5), booked(4), lost(2, reason)], NOW);
    assert.equal(o.value, 1);
    assert.equal(o.points, 20);
    assert.equal(o.status, "settled");
    assert.equal(o.negative, false);
    assert.deepEqual(o.signals, ["meeting_booked", "lost"]);
  }
  // A lost on its own (no booking event) still means a deal existed.
  const alone = scoreOutcome([sent(5), lost(1, "no budget")], NOW);
  assert.equal(alone.value, 1);
  assert.equal(alone.points, 0);
  assert.equal(alone.status, "settled");
});

test("meeting outcomes: won alone settles at value 1 and 40 points", () => {
  const o = scoreOutcome([sent(5), won(1)], NOW);
  assert.equal(o.value, 1);
  assert.equal(o.points, 40);
  assert.equal(o.status, "settled");
});

test("meeting outcomes: no sent event → value null and pending (teaches the writer nothing)", () => {
  const o = scoreOutcome([booked(1)], NOW);
  assert.equal(o.value, null);
  assert.equal(o.status, "pending");
  assert.equal(o.sentAt, null);
});

test("meeting outcomes: a booking outweighs a bounce for value; addressOutcome unchanged", () => {
  const events = [sent(5), bounce(5), booked(1)];
  const o = scoreOutcome(events, NOW);
  assert.equal(o.value, 1);
  assert.equal(o.status, "settled");
  assert.equal(o.points, 20);
  assert.equal(addressOutcome(events), "bounced");
  // Order does not matter.
  assert.equal(scoreOutcome([sent(5), booked(1), bounce(0)], NOW).value, 1);
  // A bounce with no opportunity event is still excluded.
  assert.equal(scoreOutcome([sent(5), bounce(5)], NOW).value, null);
});

test("meeting outcomes: test-flagged events of the new types are ignored", () => {
  const o = scoreOutcome([sent(2), booked(1, true)], NOW);
  assert.equal(o.value, 0);
  assert.equal(o.points, 0);
  assert.equal(o.status, "pending");
  assert.deepEqual(o.signals, []);
  const flagged = (e: OutcomeEvent): OutcomeEvent => ({ ...e, payload: { ...e.payload, test: true } });
  const all = scoreOutcome([sent(2), flagged(won(1)), flagged(lost(1))], NOW);
  assert.equal(all.points, 0);
  assert.deepEqual(all.signals, []);
  assert.equal(all.status, "pending");
});

test("meeting outcomes: OUTCOME_EVENT_TYPES includes meeting_booked, won and lost", () => {
  for (const t of ["meeting_booked", "won", "lost"]) assert.ok(OUTCOME_EVENT_TYPES.includes(t), t);
  for (const t of ["sent", "reply", "audit_scan", "bounce", "unsubscribe"]) assert.ok(OUTCOME_EVENT_TYPES.includes(t), t);
});

test("meeting outcomes: a candidate whose only signal is meeting_booked qualifies as an exemplar", () => {
  const segment: Segment = { industry: "legal", market: "ca", size: "small" };
  const target: ExemplarTarget = { segment, lang: "en", prospect_id: "p-target" };
  const candidate: ExemplarCandidate & { events: OutcomeEvent[] } = {
    pitch_id: "pitch-booked",
    prospect_id: "prospect-booked",
    parent_pitch_id: null,
    status: "sent",
    sent_at: daysAgo(30),
    lang: "en",
    industry: "Law firm",
    market: "CA",
    recipient_email: "owner@firm-booked.ca",
    critic_pass: true,
    gate_overridden: false,
    events: [sent(30), booked(25)],
  };
  // The loader only hands the selector event types it selected.
  assert.ok(candidate.events.every((e) => OUTCOME_EVENT_TYPES.includes(e.type)));
  const picked = selectExemplars([candidate], target, { now: NOW });
  assert.deepEqual(picked.map((p) => p.pitch_id), ["pitch-booked"]);
  assert.ok((scoreOutcome(candidate.events, NOW).value ?? 0) >= 0.5);
});
