/** The scout: search cells learn from what they paid off. */

import assert from "node:assert/strict";
import test from "node:test";
import { seededRng } from "../lib/learning/bandit.ts";
import {
  candidateCells,
  cellArm,
  cellKey,
  chooseCell,
  dailyAllowance,
  discoveryBudget,
  parseCellKey,
  prospectReward,
  type CellStats,
  type ProspectFunnel,
} from "../lib/learning/scout.ts";

test("a cell key round-trips and ignores case and spacing", () => {
  const key = cellKey({ icpId: "i1", keyword: " Law Firm ", region: "Calgary" });
  assert.equal(key, "i1|law firm|calgary");
  assert.deepEqual(parseCellKey(key), { icpId: "i1", keyword: "law firm", region: "calgary" });
  assert.equal(parseCellKey(cellKey({ icpId: "i1", keyword: "x", region: null })).region, null);
});

test("prospect reward: chains and dead sites are 0, pitch-ready is early credit, outcomes dominate", () => {
  assert.equal(prospectReward({ qualified: null, pitchReady: false, outcomeValue: null }), null);
  assert.equal(prospectReward({ qualified: false, pitchReady: false, outcomeValue: null }), 0);
  assert.equal(prospectReward({ qualified: true, pitchReady: false, outcomeValue: null }), 0.15);
  assert.ok(Math.abs(prospectReward({ qualified: true, pitchReady: true, outcomeValue: null })! - 0.3) < 1e-9);
  assert.ok(Math.abs(prospectReward({ qualified: true, pitchReady: true, outcomeValue: 1 })! - 1) < 1e-9);
});

const funnels = (n: number, f: ProspectFunnel): ProspectFunnel[] => Array.from({ length: n }, () => f);

test("cell arms count only settled prospects", () => {
  const arm = cellArm({
    key: "k", status: "challenger", emptyRuns: 0,
    funnels: [...funnels(4, { qualified: true, pitchReady: true, outcomeValue: null }), ...funnels(3, { qualified: null, pitchReady: false, outcomeValue: null })],
  });
  assert.equal(arm.trials, 4);
  assert.ok(Math.abs(arm.reward - 1.2) < 1e-9);
});

test("the scout learns to avoid a cell full of chains, and skips exhausted cells", () => {
  const good: CellStats = { key: "i1|dentist|calgary", status: "challenger", emptyRuns: 0, funnels: funnels(30, { qualified: true, pitchReady: true, outcomeValue: 0.5 }) };
  const chains: CellStats = { key: "i1|pharmacy|calgary", status: "challenger", emptyRuns: 0, funnels: funnels(30, { qualified: false, pitchReady: false, outcomeValue: null }) };
  const tapped: CellStats = { key: "i1|lawyer|calgary", status: "challenger", emptyRuns: 3, funnels: funnels(30, { qualified: true, pitchReady: true, outcomeValue: 1 }) };
  const rng = seededRng(4);
  const picks: Record<string, number> = {};
  for (let i = 0; i < 1000; i++) {
    const c = chooseCell([good, chains, tapped], { rng })!;
    picks[c.keyword] = (picks[c.keyword] ?? 0) + 1;
  }
  assert.ok((picks.dentist ?? 0) > 950);
  assert.equal(picks.lawyer ?? 0, 0);
});

test("candidate cells: every keyword in every region, deduplicated", () => {
  const cells = candidateCells([
    { id: "a", search_keywords: ["dentist", "Dentist "], geo_regions: ["Calgary", "Edmonton"] },
    { id: "b", search_keywords: ["despacho"], geo_regions: [] },
  ]);
  assert.deepEqual(cells.map(cellKey).sort(), ["a|dentist|calgary", "a|dentist|edmonton", "b|despacho|"]);
});

test("discovery budget feeds tomorrow's capacity, no more", () => {
  assert.equal(discoveryBudget({ dailySendCapacity: 20, pitchesWaiting: 40, pitchYield: 0.2 }), 0);
  assert.equal(discoveryBudget({ dailySendCapacity: 20, pitchesWaiting: 10, pitchYield: 0.2 }), 150);
  assert.equal(discoveryBudget({ dailySendCapacity: 20, pitchesWaiting: 0, pitchYield: 0.01 }), 200); // floor on yield, cap per day
});

test("the daily budget is spent across jobs, and empty crawls are capped too", () => {
  assert.equal(dailyAllowance({ budget: 200, researchedToday: 0, jobsToday: 0 }).prospects, 200);
  assert.equal(dailyAllowance({ budget: 200, researchedToday: 150, jobsToday: 2 }).prospects, 50);
  assert.equal(dailyAllowance({ budget: 200, researchedToday: 230, jobsToday: 3 }).prospects, 0);
  // Six jobs that found nothing still stop the seventh.
  assert.equal(dailyAllowance({ budget: 200, researchedToday: 0, jobsToday: 6 }).prospects, 0);
});
