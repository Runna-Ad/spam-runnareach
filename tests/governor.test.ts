/**
 * The governor: lanes, circuit breakers and autonomy stages. These are the
 * rules learning can never change, so every edge is pinned here.
 */

import assert from "node:assert/strict";
import test from "node:test";
import {
  evaluateBreakers,
  heldAction,
  HELD_BY_AUTOPILOT,
  inboxBouncesTrip,
  laneFor,
  nextStage,
  type BreakerMetrics,
  type LaneInput,
  type StageMetrics,
} from "../lib/autopilot/governor.ts";

const clean: LaneInput = {
  gate: { pass: true, failures: [] },
  critic: { pass: true, score: 0.9 },
  verify: "send",
  recipientSelectedBy: "scraper",
  path: "claude",
};

test("lane: a fully clean AI pitch to a verified address goes AUTO", () => {
  assert.deepEqual(laneFor(clean), { lane: "auto", reasons: [] });
});

test("lane: any gate flag, even review-level, goes to a person", () => {
  const r = laneFor({ ...clean, gate: { pass: false, failures: [{ code: "domain_ownership_unsure", severity: "review" }] } });
  assert.equal(r.lane, "review");
  assert.ok(r.reasons.includes("gate: domain_ownership_unsure"));
});

test("lane: the AI reviewer must pass with a confident score", () => {
  assert.equal(laneFor({ ...clean, critic: { pass: false, score: 0.9 } }).lane, "review");
  assert.equal(laneFor({ ...clean, critic: { pass: true, score: 0.7 } }).lane, "review");
  assert.equal(laneFor({ ...clean, critic: null }).lane, "review");
});

test("lane: templates never go automatically", () => {
  assert.equal(laneFor({ ...clean, path: "template" }).lane, "review");
  assert.equal(laneFor({ ...clean, path: "website_template" }).lane, "review");
  assert.equal(laneFor({ ...clean, path: "website_claude" }).lane, "auto");
});

test("lane: unverified or untrusted addresses go to a person", () => {
  assert.equal(laneFor({ ...clean, verify: "review" }).lane, "review");
  assert.equal(laneFor({ ...clean, verify: null }).lane, "review");
  assert.equal(laneFor({ ...clean, recipientSelectedBy: "guess" }).lane, "review");
});

test("lane: a segment on probation goes to a person", () => {
  assert.equal(laneFor({ ...clean, segmentOnProbation: true }).lane, "review");
});

test("lane: undeliverable addresses are dropped, not reviewed", () => {
  assert.equal(laneFor({ ...clean, verify: "drop" }).lane, "drop");
  assert.equal(laneFor({ ...clean, gate: { pass: false, failures: [{ code: "unusable_email", severity: "block" }] } }).lane, "drop");
});

const quiet: BreakerMetrics = {
  inboxes: [{ id: "i1", recentSends: 50, recentHardBounces: 0, apiErrorsToday: 0 }],
  hardBouncesToday: 0,
  optOutsThisWeek: 0,
  optOutWeeklyBaseline: 0.5,
  dmarcPassRate: 0.99,
  blocklisted: false,
  warmupInboxRate: 0.95,
};

test("breakers: a healthy day trips nothing", () => {
  assert.deepEqual(evaluateBreakers(quiet), []);
});

test("breakers: 2 hard bounces in 50 pauses that inbox; 1 does not", () => {
  const two = evaluateBreakers({ ...quiet, inboxes: [{ id: "i1", recentSends: 50, recentHardBounces: 2, apiErrorsToday: 0 }] });
  assert.deepEqual(two.map((t) => [t.scope, t.code, t.inboxId]), [["inbox", "inbox_bounces", "i1"]]);
  assert.equal(evaluateBreakers({ ...quiet, inboxes: [{ id: "i1", recentSends: 50, recentHardBounces: 1, apiErrorsToday: 0 }] }).length, 0);
});

test("breakers: a few bounces on a tiny sample don't trip the inbox breaker", () => {
  assert.equal(evaluateBreakers({ ...quiet, inboxes: [{ id: "i1", recentSends: 5, recentHardBounces: 2, apiErrorsToday: 0 }] }).length, 0);
});

test("breakers: the inbox_bounces thresholds are unchanged (>= 20 sends, >= 2 bounces, >= 4%)", () => {
  // Independent oracle: the rule as written before it was shared with the send-queue.
  for (let sends = 0; sends <= 80; sends++) {
    for (let bounces = 0; bounces <= Math.min(sends, 6); bounces++) {
      const expected = sends >= 20 && bounces >= 2 && bounces / sends >= 0.04;
      const inbox = { id: "i1", recentSends: sends, recentHardBounces: bounces };
      const shared = inboxBouncesTrip(inbox);
      assert.equal(shared !== null, expected, `${bounces} of ${sends}`);
      const viaEvaluate = evaluateBreakers({ ...quiet, inboxes: [{ ...inbox, apiErrorsToday: 0 }] }).filter((t) => t.code === "inbox_bounces");
      assert.deepEqual(viaEvaluate, shared ? [shared] : [], `${bounces} of ${sends}`);
    }
  }
  assert.deepEqual(inboxBouncesTrip({ id: "i1", recentSends: 48, recentHardBounces: 2 }), {
    scope: "inbox",
    inboxId: "i1",
    code: "inbox_bounces",
    reason: "2 hard bounces in the last 48 sends",
  });
});

test("breakers: global trips pause everything", () => {
  const codes = (m: Partial<BreakerMetrics>) => evaluateBreakers({ ...quiet, ...m }).map((t) => t.code);
  assert.deepEqual(codes({ hardBouncesToday: 3 }), ["bounces_today"]);
  assert.deepEqual(codes({ optOutsThisWeek: 3 }), ["opt_out_spike"]);
  assert.deepEqual(codes({ dmarcPassRate: 0.85 }), ["dmarc"]);
  assert.deepEqual(codes({ blocklisted: true }), ["blocklist"]);
  assert.deepEqual(codes({ warmupInboxRate: 0.7 }), ["placement"]);
  assert.deepEqual(codes({ dmarcPassRate: null, warmupInboxRate: null }), []);
});

const m0: StageMetrics = {
  daysInStage: 0, autoDecided: 0, autoApprovedUnedited: 0, autoFactualErrors: 0,
  autoScheduled: 0, autoVetoed: 0, autoBounceRate: 0, autoBreakerTrips: 0,
};

test("stages: shadow promotes to veto only with enough time, volume and agreement", () => {
  assert.equal(nextStage("shadow", { ...m0, daysInStage: 8, autoDecided: 120, autoApprovedUnedited: 110 }).stage, "veto");
  assert.equal(nextStage("shadow", { ...m0, daysInStage: 3, autoDecided: 120, autoApprovedUnedited: 120 }).stage, "shadow");
  assert.equal(nextStage("shadow", { ...m0, daysInStage: 8, autoDecided: 120, autoApprovedUnedited: 100 }).stage, "shadow");
  assert.equal(nextStage("shadow", { ...m0, daysInStage: 8, autoDecided: 120, autoApprovedUnedited: 119, autoFactualErrors: 1 }).stage, "shadow");
});

test("stages: veto promotes to auto on a low veto and bounce rate", () => {
  assert.equal(nextStage("veto", { ...m0, daysInStage: 15, autoScheduled: 150, autoVetoed: 3, autoBounceRate: 0.01 }).stage, "auto");
  assert.equal(nextStage("veto", { ...m0, daysInStage: 15, autoScheduled: 150, autoVetoed: 10, autoBounceRate: 0.01 }).stage, "veto");
  assert.equal(nextStage("veto", { ...m0, daysInStage: 15, autoScheduled: 150, autoVetoed: 1, autoBounceRate: 0.03 }).stage, "veto");
});

test("stages: trouble from automatic sends demotes a stage at once", () => {
  assert.equal(nextStage("auto", { ...m0, autoBreakerTrips: 1 }).stage, "veto");
  assert.equal(nextStage("veto", { ...m0, autoFactualErrors: 1 }).stage, "shadow");
  assert.equal(nextStage("auto", { ...m0 }).stage, "auto");
});

test("stages: off stays off (turning the autopilot on is a person's call)", () => {
  assert.equal(nextStage("off", { ...m0, daysInStage: 99, autoDecided: 999, autoApprovedUnedited: 999 }).stage, "off");
});

// ── Held drafts: nothing waits on a person ────────────────────────────────────

const FIXABLE = new Set(["banned_jargon", "unsourced_metric", "em_dash"]);
const held = (reasons: string[], over: Partial<{ lane: "review" | "drop"; isRewrite: boolean; editedByPerson: boolean }> = {}) =>
  heldAction({ lane: "review", reasons, isRewrite: false, editedByPerson: false, ...over }, FIXABLE);

test("held draft: what a rewrite can fix gets one rewrite", () => {
  assert.deepEqual(held(["AI review flagged issues"]), { action: "rewrite" });
  assert.deepEqual(held(["written by a template (templates never go automatically)"]), { action: "rewrite" });
  assert.deepEqual(held(["gate: banned_jargon", "AI review did not run", "address not verified yet"]), { action: "rewrite" });
});

test("held draft: a rewrite that is held again is dropped, not rewritten forever", () => {
  const r = held(["AI review flagged issues"], { isRewrite: true });
  assert.equal(r.action, "drop");
  assert.match(r.action === "drop" ? r.why : "", /still held after one rewrite/);
});

test("held draft: an unsure or untrusted address, a data gate or probation is dropped without a rewrite", () => {
  for (const reasons of [
    ["AI review flagged issues", "verifier unsure about the address"],
    ['address source "guess" not trusted'],
    ["gate: domain_ownership_unsure"],
    ["segment on probation after opt-outs"],
  ]) {
    const r = held(reasons);
    assert.equal(r.action, "drop", reasons.join("; "));
  }
});

test("held draft: DROP is closed at once; a person's edit or hold is left alone", () => {
  assert.equal(held(["verifier says the address will not deliver"], { lane: "drop" }).action, "drop");
  assert.equal(held(["AI review flagged issues"], { editedByPerson: true }).action, "leave");
  assert.equal(held(["held by a person after the autopilot scheduled it"]).action, "leave");
});

test("held draft: one the autopilot pulled back on a demotion is left for a person, never rewritten or dropped", () => {
  for (const over of [{}, { isRewrite: true }, { lane: "drop" as const }]) {
    assert.equal(held([`${HELD_BY_AUTOPILOT}: stage dropped to shadow`], over).action, "leave");
  }
  // A look-alike that doesn't start with the prefix gets no such pass.
  assert.equal(held(["verifier unsure about the address", `not ${HELD_BY_AUTOPILOT}`]).action, "drop");
});
