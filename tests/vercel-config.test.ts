/** vercel.json function limits: Vercel applies the FIRST pattern that matches. */

import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import test from "node:test";

const config = JSON.parse(readFileSync(new URL("../vercel.json", import.meta.url), "utf8")) as {
  functions: Record<string, { maxDuration?: number }>;
};
const patterns = Object.keys(config.functions);

test("the catch-all comes last, or it shadows every per-route limit", () => {
  // With "app/**" first, every route got 60s and the 120s overrides never
  // applied: discovery slices and the autopilot tick were killed mid-run.
  assert.equal(patterns.at(-1), "app/**");
});

test("every per-route limit names a route file that exists", () => {
  for (const p of patterns.slice(0, -1)) {
    assert.ok(!p.includes("*"), `${p}: only the last pattern may be a glob`);
    assert.ok(existsSync(new URL(`../${p}`, import.meta.url)), `${p} does not exist`);
  }
});
