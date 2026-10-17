/** The Hunter learns which findings lead somewhere. */

import assert from "node:assert/strict";
import test from "node:test";
import { findingWeights } from "../lib/learning/hunter-weights.ts";

test("a finding shown to visitors who then asked to talk rises above one that never converts", () => {
  const w = findingWeights(
    [
      { industry: "proservices", findingIds: ["referral-program", "search-ads"], contacted: true },
      { industry: "proservices", findingIds: ["referral-program", "search-ads"], contacted: false },
      { industry: "proservices", findingIds: ["search-ads"], contacted: false },
    ],
    [],
  );
  assert.ok(w.proservices!["referral-program"]! > w.proservices!["search-ads"]!);
  assert.equal(w.proservices!["referral-program"], 0.5); // (1+1)/(2+2)
});

test("S.P.A.M. outcomes count for the finding the email pinned; unsettled or unpinned pitches don't", () => {
  const w = findingWeights([], [
    { industry: "trades", lead: "google-local", value: 1 },
    { industry: "trades", lead: "google-local", value: 0 },
    { industry: "trades", lead: null, value: 1 },
    { industry: "trades", lead: "high-intent-ads", value: null },
  ]);
  assert.deepEqual(w, { trades: { "google-local": 0.5 } });
});

test("no evidence, no opinion", () => {
  assert.deepEqual(findingWeights([], []), {});
});
