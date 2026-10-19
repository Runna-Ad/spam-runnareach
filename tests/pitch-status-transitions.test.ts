/**
 * Which status moves a person (or the autopilot) may make on a pitch.
 * transitionPitchStatusWith puts allowedFrom(next) in the UPDATE's WHERE, so
 * this table is what stands between a stale /pitches tab and a pitch the
 * queue already claimed or sent.
 */

import assert from "node:assert/strict";
import test from "node:test";
import {
  PITCH_STATUSES,
  allowedFrom,
  transitionRefusedMessage,
  transitionVerdict,
} from "../lib/pitches/status-transitions.ts";

// The brief's table, written out independently of the module.
const EXPECTED: Record<string, string[]> = {
  queued_for_approval: ["draft"],
  approved: ["draft", "queued_for_approval"],
  reviewer_rejected: ["draft", "queued_for_approval", "approved", "auto_rejected"],
  draft: ["queued_for_approval", "approved", "reviewer_rejected", "auto_rejected"],
};
const TARGETS = Object.keys(EXPECTED);

test("PITCH_STATUSES is the 9-value prod enum", () => {
  assert.deepEqual(
    [...PITCH_STATUSES].sort(),
    ["approved", "auto_rejected", "bounced", "draft", "failed", "queued_for_approval", "reviewer_rejected", "sending", "sent"],
  );
});

for (const current of PITCH_STATUSES) {
  for (const next of TARGETS) {
    const want = current === next ? "noop" : EXPECTED[next]!.includes(current) ? "allowed" : "refused";
    test(`${current} → ${next}: ${want}`, () => {
      assert.equal(transitionVerdict(current, next), want);
      // The WHERE never lets a same-status or refused row through either.
      assert.equal(allowedFrom(next).includes(current), want === "allowed");
    });
  }
}

test("nothing moves a pitch out of sending, sent, bounced or failed", () => {
  for (const locked of ["sending", "sent", "bounced", "failed"]) {
    for (const next of TARGETS) assert.equal(transitionVerdict(locked, next), "refused", `${locked} → ${next}`);
  }
});

test("an unknown target allows nothing", () => {
  assert.deepEqual(allowedFrom("sent"), []);
  assert.deepEqual(allowedFrom("sending"), []);
  assert.equal(transitionVerdict("approved", "sending"), "refused");
});

test("allowedFrom returns a copy (callers can't widen the table)", () => {
  allowedFrom("approved").push("sent");
  assert.deepEqual(allowedFrom("approved"), ["draft", "queued_for_approval"]);
});

test("refusal message: one sentence, names the observed status, not a person's hold", () => {
  const msg = transitionRefusedMessage("sending");
  assert.equal(msg, "This pitch is now sending; nothing was changed.");
  // The autopilot stores "approval refused: <msg>"; the governor reads the
  // "held by a person" prefix (lib/autopilot/governor.ts HELD_BY_PERSON) as a veto.
  assert.ok(!msg.startsWith("held by a person"));
  assert.ok(!`approval refused: ${msg}`.startsWith("held by a person"));
  assert.equal(msg.split(". ").length, 1);
});

test("transitionPitchStatusWith puts the from-state in the UPDATE's WHERE", async () => {
  const { readFileSync } = await import("node:fs");
  const s = readFileSync(new URL("../lib/pitches/pitch-stage.ts", import.meta.url), "utf8");
  const start = s.indexOf("export async function transitionPitchStatusWith(");
  assert.ok(start >= 0);
  const body = s.slice(start, s.indexOf("\nexport ", start + 10));
  const update = body.indexOf(".update(");
  assert.ok(update >= 0);
  const stmt = body.slice(update, body.indexOf(";", update));
  assert.ok(stmt.includes(`.in("status", allowedFrom(next))`), "WHERE status in allowedFrom(next)");
  assert.ok(stmt.includes(`.select("id")`), "0 rows updated must be detectable");
  assert.match(body, /verdict === "noop"\) return \{ ok: true \}/, "same status is a no-op");
});

test("a failed re-read after a 0-row UPDATE reports what was observed, not a diagnosis", async () => {
  const { readFileSync } = await import("node:fs");
  const s = readFileSync(new URL("../lib/pitches/pitch-stage.ts", import.meta.url), "utf8");
  const start = s.indexOf("export async function transitionPitchStatusWith(");
  const body = s.slice(start, s.indexOf("\nexport ", start + 10));
  assert.ok(!body.includes(`"gone"`), "the pitch was never observed to be gone");
  assert.match(body, /error: rereadErr \} = await supabase/, "the re-read's error is read");
  assert.match(body, /if \(!now\) return \{ ok: false, error: "Pitch not found\." \}/);
});
