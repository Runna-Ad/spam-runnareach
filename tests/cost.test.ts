/**
 * computeCostUsd must bill cached prompt tokens: writes at 1.25× input price,
 * reads at 0.1×. They used to be dropped, so the daily cap undercounted.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { computeCostUsd } from "../lib/anthropic/client.ts";

const SONNET = "claude-sonnet-4-5-20250929"; // $3 in / $15 out per MTok

test("plain input + output", () => {
  assert.equal(computeCostUsd(SONNET, 1_000_000, 1_000_000), 18);
});

test("cache reads cost 0.1× and cache writes 1.25× the input price", () => {
  assert.equal(computeCostUsd(SONNET, 0, 0, 1_000_000, 0), 0.3);
  assert.equal(computeCostUsd(SONNET, 0, 0, 0, 1_000_000), 3.75);
  // a typical cached pitch call: 300 fresh + 4,500 cached-read + 600 out
  assert.equal(computeCostUsd(SONNET, 300, 600, 4_500, 0), 0.01125);
});
