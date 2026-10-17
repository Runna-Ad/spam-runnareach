/** Smarter ICPs: the search space grows toward what converts. */

import assert from "node:assert/strict";
import test from "node:test";
import { hunterDemand, industryScore, proposeCells, type IndustryEvidence } from "../lib/learning/icp.ts";
import { cellKey } from "../lib/learning/scout.ts";
import type { SegmentIndustry } from "../lib/learning/segments.ts";

const ev = (reward: number, trials: number, hunterScans = 0): IndustryEvidence => ({ reward, trials, hunterScans });

test("industry score: evidence beats the prior, one lucky hit doesn't dominate", () => {
  assert.ok(industryScore(ev(15, 30)) > industryScore(ev(1, 30)));
  assert.ok(industryScore(ev(1, 1)) < industryScore(ev(12, 30)));
  assert.ok(industryScore(ev(0, 0, 20)) > industryScore(ev(0, 0, 0)), "Hunter demand nudges an untested industry up");
});

test("hunter demand splits a bucket across the industries inside it", () => {
  const d = hunterDemand([{ industry: "proservices" }, { industry: "proservices" }, { industry: "restaurant" }, { industry: "other" }]);
  assert.ok(Math.abs((d.get("legal") ?? 0) - 2 / 3) < 1e-9);
  assert.equal(d.get("restaurant"), 1);
  assert.equal(d.has("other"), false);
});

const icps = [
  { id: "ca1", market: "CA", search_keywords: ["law firm"], geo_regions: ["Calgary", "Edmonton", "Red Deer"] },
  { id: "mx1", market: "MX", search_keywords: ["despacho de abogados"], geo_regions: ["Monterrey"] },
];

test("proposals: top industries in each ICP's language and regions, skipping what it searches", () => {
  const evidence = new Map<SegmentIndustry, IndustryEvidence>([
    ["dental", ev(12, 30)],
    ["legal", ev(10, 30)],
    ["restaurant", ev(1, 30)],
  ]);
  const out = proposeCells({ icps, evidence, existingKeys: new Set() });
  const keys = out.map((o) => cellKey(o.cell));
  assert.ok(keys.includes("ca1|dental clinic|calgary"));
  assert.ok(keys.includes("ca1|dental clinic|edmonton"));
  assert.ok(!keys.some((k) => k.endsWith("red deer")), "regions per ICP are capped");
  assert.ok(keys.includes("mx1|clínica dental|monterrey"));
  assert.ok(!keys.includes("ca1|law firm|calgary"), "already searched");
  assert.ok(!keys.some((k) => k.includes("restaurant")), "only the top industries");
});

test("proposals: nothing for industries with no evidence, existing cells are skipped, and the cap holds", () => {
  assert.equal(proposeCells({ icps, evidence: new Map(), existingKeys: new Set() }).length, 0);
  const evidence = new Map<SegmentIndustry, IndustryEvidence>([["dental", ev(12, 30)]]);
  const out = proposeCells({ icps, evidence, existingKeys: new Set(["ca1|dental clinic|calgary"]) });
  assert.ok(!out.map((o) => cellKey(o.cell)).includes("ca1|dental clinic|calgary"));
  const many = new Map<SegmentIndustry, IndustryEvidence>([["dental", ev(12, 30)], ["legal", ev(11, 30)]]);
  assert.ok(proposeCells({ icps, evidence: many, existingKeys: new Set(), maxNew: 2 }).length <= 2);
});
