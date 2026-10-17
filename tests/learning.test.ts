/**
 * The learning core: one segment language, one definition of "it worked",
 * one way to choose between options and promote winners.
 */

import assert from "node:assert/strict";
import test from "node:test";
import {
  hunterIndustryFor,
  marketFor,
  normalizeIndustry,
  parseSegmentKey,
  segmentKey,
  segmentKeys,
  segmentOf,
  sizeFor,
} from "../lib/learning/segments.ts";
import { addressOutcome, scoreOutcome, type OutcomeEvent } from "../lib/learning/reward.ts";
import {
  chooseArm,
  meanReward,
  probabilityBest,
  reviewArms,
  sampleBeta,
  seededRng,
  type Arm,
} from "../lib/learning/bandit.ts";

// ── Segments ─────────────────────────────────────────────────────────────────

test("industries: the real prospect mix lands in specific buckets, not 'other'", () => {
  assert.equal(normalizeIndustry("Manufacturing"), "manufacturing");
  assert.equal(normalizeIndustry("Wholesale distributor"), "distribution");
  assert.equal(normalizeIndustry("Medical supplies distributor"), "distribution");
  assert.equal(normalizeIndustry("Law firm"), "legal");
  assert.equal(normalizeIndustry("Despacho de abogados"), "legal");
  assert.equal(normalizeIndustry("Hospital"), "healthcare");
  assert.equal(normalizeIndustry("Clínica dental"), "dental");
  assert.equal(normalizeIndustry("Chartered Professional Accountants"), "accounting");
  assert.equal(normalizeIndustry("Restaurante"), "restaurant");
  assert.equal(normalizeIndustry("Boutique hotel"), "hospitality");
  assert.equal(normalizeIndustry(null), "other");
});

test("industries: word boundaries stop the classic misfires", () => {
  assert.equal(normalizeIndustry("Lawn care"), "trades");      // not legal
  assert.equal(normalizeIndustry("Barber shop"), "beauty");    // not a bar
  assert.equal(normalizeIndustry("Food distributor"), "distribution"); // not a restaurant
  assert.equal(normalizeIndustry("Marketing automation"), "other");    // "auto" is not automotive
});

test("segments map onto the Hunter's buckets for cross-learning", () => {
  assert.equal(hunterIndustryFor("legal"), "proservices");
  assert.equal(hunterIndustryFor("construction"), "trades");
  assert.equal(hunterIndustryFor("restaurant"), "restaurant");
  assert.equal(hunterIndustryFor("manufacturing"), "other");
});

test("size and market follow the Hunter and the stored upper-case market", () => {
  assert.equal(sizeFor(1), "solo");
  assert.equal(sizeFor(8), "small");
  assert.equal(sizeFor(40), "mid");
  assert.equal(sizeFor(300), "large");
  assert.equal(sizeFor(null), "unknown");
  assert.equal(marketFor("CA"), "ca");
  assert.equal(marketFor(null, "es"), "mx");
});

test("segment keys back off from fine to coarse, and round-trip", () => {
  const seg = segmentOf({ market: "CA", industry: "Law firm", employee_size_estimate: 12 });
  assert.equal(segmentKey(seg), "ca:legal:mid");
  assert.deepEqual(segmentKeys(seg), ["ca:legal:mid", "ca:legal", "legal", "all"]);
  assert.deepEqual(parseSegmentKey("ca:legal:mid"), seg);
});

// ── Reward ───────────────────────────────────────────────────────────────────

const day = 86_400_000;
const t0 = new Date("2026-10-01T15:00:00Z");
const at = (days: number) => new Date(t0.getTime() + days * day).toISOString();
const sent: OutcomeEvent = { type: "sent", at: at(0) };

test("reward: the strongest signal wins, and is decisive", () => {
  const o = scoreOutcome(
    [sent, { type: "audit_scan", at: at(1), payload: { stage: "scan" } }, { type: "reply", at: at(2), payload: { intent: "wants_meeting" } }],
    new Date(at(3)),
  );
  assert.equal(o.value, 1);
  assert.equal(o.status, "settled");
  assert.ok(o.points > 10);
});

test("reward: running the free check alone is worth half, and waits for the window", () => {
  const o = scoreOutcome([sent, { type: "audit_scan", at: at(1), payload: { stage: "scan" } }], new Date(at(2)));
  assert.equal(o.value, 0.5);
  assert.equal(o.status, "pending");
});

test("reward: asking to talk through the Hunter counts as much as a meeting reply", () => {
  const o = scoreOutcome([sent, { type: "audit_scan", at: at(1), payload: { stage: "contact_request" } }], new Date(at(2)));
  assert.equal(o.value, 1);
  assert.equal(o.status, "settled");
});

test("reward: silence is pending until the window closes, then a settled zero", () => {
  assert.equal(scoreOutcome([sent], new Date(at(5))).status, "pending");
  const late = scoreOutcome([sent], new Date(at(15)));
  assert.equal(late.status, "settled");
  assert.equal(late.value, 0);
});

test("reward: an opt-out is a settled zero that costs points and flags a negative", () => {
  const o = scoreOutcome([sent, { type: "unsubscribe", at: at(1) }], new Date(at(2)));
  assert.equal(o.value, 0);
  assert.equal(o.negative, true);
  assert.ok(o.points < 0);
  assert.equal(o.status, "settled");
});

test("reward: a bounce teaches the address learner, not the writer", () => {
  const events: OutcomeEvent[] = [sent, { type: "bounce", at: at(0) }];
  assert.equal(scoreOutcome(events, new Date(at(1))).value, null);
  assert.equal(addressOutcome(events), "bounced");
  assert.equal(addressOutcome([sent]), "delivered");
});

test("reward: test-address events are ignored entirely", () => {
  const o = scoreOutcome([sent, { type: "reply", at: at(1), payload: { intent: "wants_meeting", test: true } }], new Date(at(2)));
  assert.equal(o.value, 0);
  assert.equal(o.status, "pending");
});

// ── Bandit ───────────────────────────────────────────────────────────────────

test("beta sampling has the right mean", () => {
  const rng = seededRng(7);
  let sum = 0;
  for (let i = 0; i < 20000; i++) sum += sampleBeta(3, 7, rng);
  assert.ok(Math.abs(sum / 20000 - 0.3) < 0.01);
});

const arm = (key: string, status: Arm["status"], reward: number, trials: number, negatives = 0): Arm => ({
  key, status, reward, trials, negatives,
});

test("choosing sends most traffic to the clearly better arm, but still explores", () => {
  const rng = seededRng(42);
  const arms = [arm("a", "champion", 5, 100), arm("b", "challenger", 30, 100), arm("new", "challenger", 0, 0)];
  const counts: Record<string, number> = { a: 0, b: 0, new: 0 };
  for (let i = 0; i < 5000; i++) counts[chooseArm(arms, { rng, controlShare: 0 })!.key]!++;
  assert.ok(counts.b! > counts.a! * 5);
  assert.ok(counts.new! > 0, "an untried arm still gets tried");
});

test("the champion keeps its control share", () => {
  const rng = seededRng(1);
  const arms = [arm("a", "champion", 1, 100), arm("b", "challenger", 50, 100)];
  let a = 0;
  for (let i = 0; i < 5000; i++) if (chooseArm(arms, { rng, controlShare: 0.2 })!.key === "a") a++;
  assert.ok(a / 5000 > 0.17 && a / 5000 < 0.23);
});

test("retired arms are never chosen", () => {
  const rng = seededRng(3);
  const arms = [arm("a", "champion", 1, 10), arm("dead", "retired", 100, 100)];
  for (let i = 0; i < 500; i++) assert.equal(chooseArm(arms, { rng })!.key, "a");
});

test("probability best concentrates on the winner", () => {
  const p = probabilityBest([arm("a", "champion", 10, 100), arm("b", "challenger", 25, 100)], { rng: seededRng(9) });
  assert.ok((p.get("b") ?? 0) > 0.95);
});

test("review: a clearly better challenger is promoted; the old champion stays for one round", () => {
  const { actions, arms } = reviewArms(
    [arm("old", "champion", 10, 100), arm("new", "challenger", 30, 100)],
    { rng: seededRng(5) },
  );
  assert.deepEqual(actions.map((a) => a.kind), ["promote"]);
  assert.equal(arms.find((a) => a.key === "new")!.status, "champion");
  assert.equal(arms.find((a) => a.key === "old")!.status, "challenger");
});

test("review: nothing is promoted or retired before enough trials", () => {
  const { actions } = reviewArms([arm("old", "champion", 1, 10), arm("new", "challenger", 9, 10)], { rng: seededRng(5) });
  assert.equal(actions.length, 0);
});

test("review: a clear loser retires", () => {
  const { actions, arms } = reviewArms(
    [arm("champ", "champion", 30, 100), arm("ok", "challenger", 28, 100), arm("bad", "challenger", 5, 100)],
    { rng: seededRng(11) },
  );
  assert.ok(actions.some((a) => a.kind === "retire" && a.key === "bad" && a.reason === "losing"));
  assert.equal(arms.find((a) => a.key === "bad")!.status, "retired");
});

test("review: an arm that drives opt-outs retires even if it wins on reward, and a champion is kept", () => {
  const { actions, arms } = reviewArms(
    [arm("pushy", "champion", 40, 100, 9), arm("calm", "challenger", 25, 100, 1)],
    { rng: seededRng(2), baselineNegativeRate: 0.02 },
  );
  assert.ok(actions.some((a) => a.kind === "retire" && a.key === "pushy" && a.reason === "negatives"));
  assert.equal(arms.find((a) => a.key === "calm")!.status, "champion");
});

test("mean reward starts from a weak prior", () => {
  assert.equal(meanReward(arm("x", "challenger", 0, 0)), 0.5);
  assert.ok(Math.abs(meanReward(arm("x", "challenger", 20, 100)) - 21 / 102) < 1e-9);
});
