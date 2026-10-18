/** The scout: search cells learn from what they paid off. */

import assert from "node:assert/strict";
import test from "node:test";
import { seededRng } from "../lib/learning/bandit.ts";
import { funnelForProspect } from "../lib/learning/outcomes.ts";
import {
  candidateCells,
  cellArm,
  cellKey,
  chooseCell,
  dailyAllowance,
  discoveryBudget,
  parseCellKey,
  prospectReward,
  scoutCredits,
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

const ids = (prefix: string, from: number, to: number) => Array.from({ length: to - from + 1 }, (_, i) => `${prefix}${from + i}`);

/** What learnFromOutcomes does with the credits: each prospect's funnel by its status, into the cell's arm. */
const trialsByCell = (credits: Map<string, string[]>, status: (id: string) => string) =>
  Object.fromEntries([...credits].map(([key, list]) => [key, cellArm({ key, status: "challenger", emptyRuns: 0, funnels: list.map((id) => funnelForProspect(status(id), [])) }).trials]));

test("a two-batch autopilot job credits its cell for both batches", () => {
  // As the worker leaves the row: the crawl found 70; batch 1 researched 50, the
  // refill batch the other 20; then the pitching phase overwrote prospect_ids
  // with the two high scorers that still needed a pitch.
  const found = ids("p", 1, 70);
  const credits = scoutCredits([{ cellKey: "i1|dentist|calgary", foundIds: found, prospectIds: ["p3", "p41"] }]);
  assert.deepEqual(credits.get("i1|dentist|calgary"), found);
  assert.deepEqual(trialsByCell(credits, () => "researched"), { "i1|dentist|calgary": 70 });
});

test("a refill from another crawl is credited to the cell whose crawl found it", () => {
  // Job A's crawl found a1–a3 but researched only a1–a2; job B's refill took a3
  // (the ICP's oldest raw prospect) after its own b1–b2.
  const credits = scoutCredits([
    { cellKey: "A", foundIds: ["a1", "a2", "a3"], prospectIds: ["a1", "a2"] },
    { cellKey: "B", foundIds: ["b1", "b2"], prospectIds: ["a3"] },
  ]);
  assert.deepEqual(credits.get("A"), ["a1", "a2", "a3"]);
  assert.deepEqual(credits.get("B"), ["b1", "b2"]);
  // A find nobody researched (still raw, or pruned) is pending, not a failure.
  assert.deepEqual(trialsByCell(credits, (id) => (id === "b2" ? "raw" : "researched")), { A: 3, B: 1 });
});

test("a job whose own finds are unknown credits nothing, never the ICP's raw pool", () => {
  const credits = scoutCredits([{ cellKey: "A", foundIds: [], prospectIds: ["x1", "x2"] }]);
  assert.deepEqual(credits.get("A"), []);
});

test("jobs from before found_ids fall back to prospect_ids, never over another crawl's finds", () => {
  const credits = scoutCredits([
    { cellKey: "old1", prospectIds: ["x1", "x2", "n1"] },
    { cellKey: "old2", foundIds: null, prospectIds: ["x2", "x3"] },
    { cellKey: "new", foundIds: ["n1", "n2"], prospectIds: ["n2"] },
  ]);
  assert.deepEqual(credits.get("old1"), ["x1", "x2"]);
  // x2 sat in both old lists: once, to the earlier job.
  assert.deepEqual(credits.get("old2"), ["x3"]);
  assert.deepEqual(credits.get("new"), ["n1", "n2"]);
});

test("candidate cells: every keyword in every region, deduplicated", () => {
  const cells = candidateCells([
    { id: "a", search_keywords: ["dentist", "Dentist "], geo_regions: ["Calgary", "Edmonton"] },
    { id: "b", search_keywords: ["despacho"], geo_regions: [] },
  ]);
  assert.deepEqual(cells.map(cellKey).sort(), ["a|dentist|calgary", "a|dentist|edmonton", "b|despacho|"]);
});

test("technologies and bare attributes never become search cells", () => {
  const cells = candidateCells([
    { id: "a", search_keywords: ["Shopify", "direct to consumer", "Meta Pixel", "premium", "fitness studio"], geo_regions: ["Alberta"] },
  ]);
  assert.deepEqual(cells.map(cellKey), ["a|fitness studio|alberta"]);
});

test("discovery budget feeds tomorrow's capacity, no more", () => {
  assert.equal(discoveryBudget({ dailySendCapacity: 20, pitchesWaiting: 40, pitchYield: 0.2 }), 0);
  assert.equal(discoveryBudget({ dailySendCapacity: 5, pitchesWaiting: 4, pitchYield: 0.2 }), 30);
  // Never more than 100 a day while the platform learns, however low the yield.
  assert.equal(discoveryBudget({ dailySendCapacity: 20, pitchesWaiting: 10, pitchYield: 0.2 }), 100);
  assert.equal(discoveryBudget({ dailySendCapacity: 20, pitchesWaiting: 0, pitchYield: 0.01 }), 100);
});

test("the daily budget is spent across jobs, and empty crawls are capped too", () => {
  assert.equal(dailyAllowance({ budget: 200, researchedToday: 0, jobsToday: 0 }).prospects, 200);
  assert.equal(dailyAllowance({ budget: 200, researchedToday: 150, jobsToday: 2 }).prospects, 50);
  assert.equal(dailyAllowance({ budget: 200, researchedToday: 230, jobsToday: 3 }).prospects, 0);
  // Six jobs that found nothing still stop the seventh.
  assert.equal(dailyAllowance({ budget: 200, researchedToday: 0, jobsToday: 6 }).prospects, 0);
});
