import assert from "node:assert/strict";
import test from "node:test";
import { classifyReplyHeuristic } from "../lib/replies/classify.ts";

const FROM = "sarah@example.com";

function classify(subject: string, body: string) {
  return classifyReplyHeuristic({ subject, body_text: body, from_email: FROM });
}

// ── auto_reply (highest priority) ───────────────────────────────────────────

test("auto_reply: 'Out of office' phrase", () => {
  const r = classify("Re: hi", "I am out of the office until April 30.");
  assert.equal(r.intent, "auto_reply");
  assert.equal(r.urgency, "cold");
  assert.equal(r.sentiment, "neutral");
});

test("auto_reply: 'automatic reply' / 'on vacation'", () => {
  assert.equal(classify("Auto: Hi", "Automatic reply — back Monday.").intent, "auto_reply");
  assert.equal(classify("", "I'm on vacation, will respond on return.").intent, "auto_reply");
  assert.equal(classify("OOO", "I will be back next week.").intent, "auto_reply");
});

test("auto_reply: maternity / paternity leave", () => {
  assert.equal(
    classify("", "I am on maternity leave until June.").intent,
    "auto_reply",
  );
});

// ── wrong_person ────────────────────────────────────────────────────────────

test("wrong_person: 'not the right person'", () => {
  const r = classify("Re: pitch", "Hey — I'm not the right person to talk to about this.");
  assert.equal(r.intent, "wrong_person");
});

test("wrong_person: 'please contact' someone else", () => {
  const r = classify("", "Please contact our marketing lead Sarah.");
  assert.equal(r.intent, "wrong_person");
});

test("wrong_person: 'forwarded to'", () => {
  const r = classify("", "Forwarded to our agency contact.");
  assert.equal(r.intent, "wrong_person");
});

// ── hard_no ─────────────────────────────────────────────────────────────────

test("hard_no: 'unsubscribe'", () => {
  const r = classify("", "Please unsubscribe me from this list.");
  assert.equal(r.intent, "hard_no");
  assert.equal(r.sentiment, "negative");
});

test("hard_no: 'not interested'", () => {
  assert.equal(classify("", "Thanks but not interested.").intent, "hard_no");
});

test("hard_no: 'remove me' / 'do not contact'", () => {
  assert.equal(classify("", "Remove me from your list.").intent, "hard_no");
  assert.equal(classify("", "Do not contact me again.").intent, "hard_no");
});

// ── wants_meeting (the hot one) ─────────────────────────────────────────────

test("wants_meeting: 'let's chat next week'", () => {
  const r = classify("Re: thoughts on your DTC", "Let's chat next week — I'm curious.");
  assert.equal(r.intent, "wants_meeting");
  assert.equal(r.urgency, "hot");
  assert.equal(r.sentiment, "positive");
});

test("wants_meeting: Calendly link", () => {
  const r = classify("", "Sure — grab time on https://calendly.com/me");
  assert.equal(r.intent, "wants_meeting");
});

test("wants_meeting: 'happy to jump on a call'", () => {
  assert.equal(
    classify("", "Happy to jump on a call this Thursday.").intent,
    "wants_meeting",
  );
});

test("wants_meeting: 'when works for you'", () => {
  assert.equal(
    classify("", "When works for you next week?").intent,
    "wants_meeting",
  );
});

// ── wants_info ──────────────────────────────────────────────────────────────

test("wants_info: 'send me more info'", () => {
  const r = classify("", "Could you send me more info on pricing?");
  assert.equal(r.intent, "wants_info");
  assert.equal(r.urgency, "warm");
  assert.equal(r.sentiment, "positive");
});

test("wants_info: 'share case studies'", () => {
  assert.equal(
    classify("", "Can you share some case studies from similar brands?").intent,
    "wants_info",
  );
});

test("wants_info: 'tell me more / curious'", () => {
  assert.equal(classify("", "Tell me more.").intent, "wants_info");
  assert.equal(classify("", "Curious — how does this work?").intent, "wants_info");
});

// ── not_now ─────────────────────────────────────────────────────────────────

test("not_now: 'circle back next quarter'", () => {
  const r = classify("", "Let's circle back next quarter.");
  assert.equal(r.intent, "not_now");
  assert.equal(r.urgency, "warm");
});

test("not_now: 'too busy right now'", () => {
  assert.equal(classify("", "Too busy right now — try again later.").intent, "not_now");
});

test("not_now: 'after the holidays'", () => {
  assert.equal(
    classify("", "Reach out after the holidays please.").intent,
    "not_now",
  );
});

// ── unclassified fallback ───────────────────────────────────────────────────

test("unclassified: empty body + subject leaves it for human", () => {
  const r = classify("", "");
  assert.equal(r.intent, "unclassified");
  assert.equal(r.urgency, null);
  assert.equal(r.sentiment, null);
});

test("unclassified: ambiguous text", () => {
  const r = classify("Re: hi", "ok thanks");
  assert.equal(r.intent, "unclassified");
});

// ── precedence: most-specific wins ──────────────────────────────────────────

test("precedence: auto_reply beats wants_meeting in same body", () => {
  // Vacation OOO that mentions a meeting — still OOO until they're back.
  const r = classify(
    "OOO",
    "I'm out of the office. Happy to jump on a call when I'm back.",
  );
  assert.equal(r.intent, "auto_reply");
});

test("precedence: hard_no beats wants_info", () => {
  const r = classify("", "Not interested — please remove me. Tell me more would be a waste.");
  assert.equal(r.intent, "hard_no");
});

// ── case-insensitive ───────────────────────────────────────────────────────

test("case-insensitive matching", () => {
  assert.equal(classify("OUT OF OFFICE", "ON VACATION").intent, "auto_reply");
  assert.equal(classify("UNSUBSCRIBE", "remove me").intent, "hard_no");
  assert.equal(classify("Let's Schedule a Call", "").intent, "wants_meeting");
});

// ── reasoning is always populated ──────────────────────────────────────────

test("reasoning is never empty", () => {
  const cases = [
    ["", "out of office"],
    ["", "let's chat"],
    ["", ""],
    ["", "ok thanks"],
  ];
  for (const [s, b] of cases) {
    const r = classify(s ?? "", b ?? "");
    assert.ok(r.reasoning.length > 0, `empty reasoning for "${b}"`);
  }
});

// ── determinism ────────────────────────────────────────────────────────────

test("classifier is deterministic", () => {
  const a = classify("Re: hi", "Let's chat next week.");
  const b = classify("Re: hi", "Let's chat next week.");
  assert.deepEqual(a, b);
});
