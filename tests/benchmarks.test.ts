import assert from "node:assert/strict";
import test from "node:test";
import { caveatForPrompt } from "../lib/benchmarks/queries.ts";

test("caveatForPrompt keeps the how-to-say-it part and drops provenance notes", () => {
  const c =
    "Healthcare appointments; 25% is relative. Say 'in clinics'. Source-checked by Claude on 2026-10-16 against search excerpts… Review on /benchmarks.";
  assert.equal(caveatForPrompt(c), "Healthcare appointments; 25% is relative. Say 'in clinics'.");
  assert.equal(caveatForPrompt("Plain caveat. Activated 2026-10-16 under Pedro's instruction."), "Plain caveat.");
  assert.equal(caveatForPrompt(null), null);
  assert.equal(caveatForPrompt("Source-checked by Claude only."), "Source-checked by Claude only.");
  assert.ok((caveatForPrompt("x".repeat(500)) ?? "").length <= 280);
});

test("industryOverlaps matches whole words only (spa is not despacho)", async () => {
  const { industryOverlaps } = await import("../lib/benchmarks/queries.ts");
  assert.equal(industryOverlaps(["despacho de abogados", "law firm"], "spa"), false);
  assert.equal(industryOverlaps(["despacho contable"], "spa"), false);
  assert.equal(industryOverlaps(["spa", "salón de belleza"], "spa"), true);
  assert.equal(industryOverlaps(["hotel", "hotel chain"], "hotel chain"), true);
  assert.equal(industryOverlaps(["hotel"], "boutique hotel"), true);
  assert.equal(industryOverlaps(["restaurant group"], "restaurant"), true);
  assert.equal(industryOverlaps(["clínica"], "clínica dental"), true);
  assert.equal(industryOverlaps([], "anything"), true);
  assert.equal(industryOverlaps(["manufacturer"], null), false);
});
