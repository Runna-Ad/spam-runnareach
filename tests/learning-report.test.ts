import assert from "node:assert/strict";
import test from "node:test";
import { summarizeArms, type ArmRow } from "../lib/learning/report.ts";

function arm(p: Partial<ArmRow> & { key: string }): ArmRow {
  return {
    learner: "writer.evidence",
    status: "challenger",
    origin: "seed",
    reward: 0,
    trials: 0,
    negatives: 0,
    updated_at: "2026-10-17T00:00:00Z",
    ...p,
  };
}

test("5 trials is too early and hides the rate", () => {
  const [g] = summarizeArms([arm({ key: "a", trials: 5, reward: 4 })]);
  const a = g?.active[0];
  assert.equal(a?.confidence, "too early");
  assert.equal(a?.rate, null);
  assert.equal(a?.trials, 5);
});

test("20 trials is early with the rate; 19 is still too early", () => {
  const [g] = summarizeArms([arm({ key: "a", trials: 20, reward: 5 }), arm({ key: "b", trials: 19, reward: 5 })]);
  const a = g?.active.find((x) => x.key === "a");
  assert.equal(a?.confidence, "early");
  assert.equal(a?.rate, 0.25);
  assert.equal(g?.active.find((x) => x.key === "b")?.confidence, "too early");
});

test("100 trials is settled; 99 is early", () => {
  const [g] = summarizeArms([arm({ key: "a", trials: 150, reward: 30, negatives: 7 }), arm({ key: "b", trials: 99, reward: 9 })]);
  const a = g?.active.find((x) => x.key === "a");
  assert.equal(a?.confidence, "settled");
  assert.equal(a?.rate, 0.2);
  assert.equal(a?.negatives, 7);
  assert.equal(g?.active.find((x) => x.key === "b")?.confidence, "early");
});

test("retired arms are grouped separately", () => {
  const [g] = summarizeArms([arm({ key: "a", status: "champion" }), arm({ key: "old", status: "retired", trials: 200 })]);
  assert.deepEqual(g?.active.map((x) => x.key), ["a"]);
  assert.deepEqual(g?.retired.map((x) => x.key), ["old"]);
});

test("grouped by learner, champion first", () => {
  const groups = summarizeArms([
    arm({ learner: "scout.cell", key: "z" }),
    arm({ key: "chal", status: "challenger", trials: 50 }),
    arm({ key: "champ", status: "champion", trials: 1 }),
    arm({ learner: "mystery", key: "m" }),
  ]);
  assert.deepEqual(groups.map((g) => g.learner), ["writer.evidence", "scout.cell", "mystery"]);
  assert.deepEqual(groups[0]?.active.map((x) => x.key), ["champ", "chal"]);
});
