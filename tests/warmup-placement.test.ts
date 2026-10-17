import { test } from "node:test";
import assert from "node:assert/strict";
import { analyzeSpamRate, isRfcMessageId, placementFromCheck } from "../lib/warmup/intelligence.ts";
import type { WarmupLogEntry } from "../lib/warmup/types.ts";

test("isRfcMessageId: a Gmail Message-ID header is searchable", () => {
  assert.equal(isRfcMessageId("CAJx9mQ=abc+def@mail.gmail.com"), true);
});

test("isRfcMessageId: Gmail's internal hex id is not (what every pre-fix send stored)", () => {
  assert.equal(isRfcMessageId("19a2b3c4d5e6f708"), false);
  assert.equal(isRfcMessageId(null), false);
  assert.equal(isRfcMessageId(""), false);
});

test("isRfcMessageId: angle brackets or spaces mean it wasn't stripped", () => {
  assert.equal(isRfcMessageId("<abc@mail.gmail.com>"), false);
  assert.equal(isRfcMessageId("abc @mail.gmail.com"), false);
});

test("placementFromCheck: found in inbox → inbox", () => {
  assert.equal(placementFromCheck({ foundInInbox: true, foundInSpam: false }), true);
});

test("placementFromCheck: found in spam → SPAM, even though the check rescued it", () => {
  // The old code stored foundInInbox || movedToInbox, so a rescued spam
  // placement was counted as inbox and the spam rate could never rise.
  assert.equal(placementFromCheck({ foundInInbox: false, foundInSpam: true }), false);
});

test("placementFromCheck: found nowhere → unknown (stays pending)", () => {
  assert.equal(placementFromCheck({ foundInInbox: false, foundInSpam: false }), null);
});

test("spam placements now reach the pause decision", () => {
  const log = (landed: boolean | null): WarmupLogEntry =>
    ({ direction: "sent", landed_in_inbox: landed }) as WarmupLogEntry;
  const checks = [
    { foundInInbox: true, foundInSpam: false },
    { foundInInbox: true, foundInSpam: false },
    { foundInInbox: true, foundInSpam: false },
    { foundInInbox: false, foundInSpam: true },
    { foundInInbox: false, foundInSpam: true },
  ];
  const analysis = analyzeSpamRate(checks.map((c) => log(placementFromCheck(c))));
  assert.equal(analysis.inSpam, 2);
  assert.equal(analysis.shouldPause, true);
});
