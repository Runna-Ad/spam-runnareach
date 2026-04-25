import assert from "node:assert/strict";
import test from "node:test";
import {
  scoreWithHeuristic,
  type RubricInputIcp,
  type RubricInputProspect,
  type RubricInputResearch,
} from "../lib/research/scoring/rubric.ts";

// ── Fixtures ────────────────────────────────────────────────────────────────

function baseProspect(overrides: Partial<RubricInputProspect> = {}): RubricInputProspect {
  return {
    industry: "DTC coffee",
    city: "Calgary",
    region: "Alberta",
    country_code: "CA",
    employee_size_estimate: 12,
    red_flags: [],
    ...overrides,
  };
}

function baseIcp(overrides: Partial<NonNullable<RubricInputIcp>> = {}): RubricInputIcp {
  return {
    industry_tags: ["coffee", "DTC"],
    geo_regions: ["Alberta", "British Columbia"],
    employee_size_min: 5,
    employee_size_max: 50,
    search_keywords: [],
    excluded_keywords: [],
    ...overrides,
  };
}

function fullResearch(overrides: Partial<NonNullable<RubricInputResearch>> = {}): RubricInputResearch {
  return {
    what_they_do: "Calgary roaster doing subscription beans nationally.",
    tech_stack: ["Shopify", "Klaviyo", "Recharge", "Google Analytics"],
    pain_points: [
      { pain_id: "1", pain_label: "weak packaging", evidence_quote: "shelf is bare" },
      { pain_id: "2", pain_label: "low email perf", evidence_url: "https://example.com" },
    ],
    evidence_urls: [
      "https://example.com/about",
      "https://example.com/contact",
      "https://example.com/team",
    ],
    ...overrides,
  };
}

// ── Score range ─────────────────────────────────────────────────────────────

test("composite_score is always within [0, 100]", () => {
  const result = scoreWithHeuristic(baseProspect(), fullResearch(), baseIcp());
  assert.ok(result.composite_score >= 0);
  assert.ok(result.composite_score <= 100);
});

test("ideal prospect with full research scores high (≥ 75)", () => {
  const result = scoreWithHeuristic(baseProspect(), fullResearch(), baseIcp());
  assert.ok(
    result.composite_score >= 75,
    `expected high score, got ${result.composite_score} — breakdown ${JSON.stringify(result.breakdown)}`,
  );
});

test("empty prospect with no research and no ICP scores low (< 50)", () => {
  const empty: RubricInputProspect = {
    industry: null,
    city: null,
    region: null,
    country_code: null,
    employee_size_estimate: null,
    red_flags: [],
  };
  const result = scoreWithHeuristic(empty, null, null);
  assert.ok(result.composite_score < 50, `expected low score, got ${result.composite_score}`);
});

// ── Bucket logic ────────────────────────────────────────────────────────────

test("industry match awards full 20 pts; mismatch awards 5", () => {
  const match = scoreWithHeuristic(baseProspect(), null, baseIcp());
  assert.equal(match.breakdown.industry_fit_pts, 20);

  const mismatch = scoreWithHeuristic(
    baseProspect({ industry: "auto repair" }),
    null,
    baseIcp(),
  );
  assert.equal(mismatch.breakdown.industry_fit_pts, 5);
});

test("size within ICP band awards full 15 pts; outside gets partial or 0", () => {
  const inBand = scoreWithHeuristic(
    baseProspect({ employee_size_estimate: 12 }),
    null,
    baseIcp(),
  );
  assert.equal(inBand.breakdown.size_fit_pts, 15);

  // 80 employees: above max=50 but within 50% slack (max 75) — actually
  // 80 > 75, so 0 pts.
  const farAbove = scoreWithHeuristic(
    baseProspect({ employee_size_estimate: 200 }),
    null,
    baseIcp(),
  );
  assert.equal(farAbove.breakdown.size_fit_pts, 0);

  // 60 employees: above max=50 but within slack [2.5, 75] — partial 6 pts.
  const nearBand = scoreWithHeuristic(
    baseProspect({ employee_size_estimate: 60 }),
    null,
    baseIcp(),
  );
  assert.equal(nearBand.breakdown.size_fit_pts, 6);
});

test("geo match checks region, city, and country_code (case-insensitive)", () => {
  const onRegion = scoreWithHeuristic(baseProspect(), null, baseIcp());
  assert.equal(onRegion.breakdown.geo_fit_pts, 15);

  // Reverse: ICP wants Quebec, prospect is in Alberta — no hit.
  const offGeo = scoreWithHeuristic(
    baseProspect(),
    null,
    baseIcp({ geo_regions: ["Quebec"] }),
  );
  assert.equal(offGeo.breakdown.geo_fit_pts, 0);

  // City-level match: ICP says "Calgary", prospect.region=Alberta + city=Calgary.
  const cityMatch = scoreWithHeuristic(
    baseProspect(),
    null,
    baseIcp({ geo_regions: ["Calgary"] }),
  );
  assert.equal(cityMatch.breakdown.geo_fit_pts, 15);
});

test("digital maturity caps at 15 and rewards marketing tools", () => {
  const minimal = scoreWithHeuristic(
    baseProspect(),
    fullResearch({ tech_stack: ["Wix"] }),
    baseIcp(),
  );
  assert.equal(minimal.breakdown.digital_maturity_pts, 3);

  const big = scoreWithHeuristic(
    baseProspect(),
    fullResearch({
      tech_stack: ["Shopify", "Klaviyo", "Recharge", "Google Analytics", "Meta Pixel"],
    }),
    baseIcp(),
  );
  // 3 capped tools (9) + marketing (4) + analytics (2) = 15.
  assert.equal(big.breakdown.digital_maturity_pts, 15);

  const noTech = scoreWithHeuristic(
    baseProspect(),
    fullResearch({ tech_stack: [] }),
    baseIcp(),
  );
  assert.equal(noTech.breakdown.digital_maturity_pts, 0);
});

test("pain points without evidence get penalized vs. with evidence", () => {
  const noEvidence = scoreWithHeuristic(
    baseProspect(),
    fullResearch({
      pain_points: [{ pain_id: "1", pain_label: "weak packaging" }],
    }),
    baseIcp(),
  );

  const withEvidence = scoreWithHeuristic(
    baseProspect(),
    fullResearch({
      pain_points: [
        { pain_id: "1", pain_label: "weak packaging", evidence_quote: "shelf bare" },
      ],
    }),
    baseIcp(),
  );

  assert.ok(
    withEvidence.breakdown.pain_signal_pts > noEvidence.breakdown.pain_signal_pts,
    "evidence-backed pain should score higher than label-only",
  );
});

test("red flags subtract up to 30 pts (capped)", () => {
  const noFlags = scoreWithHeuristic(baseProspect(), fullResearch(), baseIcp());
  const oneFlag = scoreWithHeuristic(
    baseProspect({ red_flags: ["dnc_listed"] }),
    fullResearch(),
    baseIcp(),
  );
  const fourFlags = scoreWithHeuristic(
    baseProspect({ red_flags: ["a", "b", "c", "d"] }),
    fullResearch(),
    baseIcp(),
  );

  assert.equal(oneFlag.breakdown.red_flag_penalty, 10);
  // 4 flags × 10 pts capped at 30
  assert.equal(fourFlags.breakdown.red_flag_penalty, 30);
  assert.ok(noFlags.composite_score > oneFlag.composite_score);
  assert.ok(oneFlag.composite_score > fourFlags.composite_score);
});

test("excluded keyword in industry halves the score", () => {
  const baseline = scoreWithHeuristic(baseProspect(), fullResearch(), baseIcp());

  const excluded = scoreWithHeuristic(
    baseProspect({ industry: "DTC coffee for cannabis brands" }),
    fullResearch(),
    baseIcp({ excluded_keywords: ["cannabis"] }),
  );

  assert.ok(
    excluded.composite_score <= Math.ceil(baseline.composite_score * 0.55),
    `expected ~50% halving, got ${excluded.composite_score} vs baseline ${baseline.composite_score}`,
  );
});

test("excluded keyword in research.what_they_do also triggers halving", () => {
  const baseline = scoreWithHeuristic(baseProspect(), fullResearch(), baseIcp());

  const excluded = scoreWithHeuristic(
    baseProspect(),
    fullResearch({
      what_they_do: "Coffee roaster that exclusively serves cannabis dispensaries.",
    }),
    baseIcp({ excluded_keywords: ["cannabis"] }),
  );

  assert.ok(excluded.composite_score < baseline.composite_score);
});

// ── Confidence ──────────────────────────────────────────────────────────────

test("confidence reflects input completeness", () => {
  const empty = scoreWithHeuristic(
    {
      industry: null,
      city: null,
      region: null,
      country_code: null,
      employee_size_estimate: null,
      red_flags: [],
    },
    null,
    null,
  );
  const full = scoreWithHeuristic(baseProspect(), fullResearch(), baseIcp());

  assert.ok(empty.confidence >= 0.2);
  assert.ok(empty.confidence <= 0.95);
  assert.ok(full.confidence >= empty.confidence);
  assert.ok(full.confidence <= 0.95);
});

// ── Determinism ─────────────────────────────────────────────────────────────

test("scorer is deterministic — same inputs produce same output", () => {
  const inputs: [RubricInputProspect, RubricInputResearch, RubricInputIcp] = [
    baseProspect(),
    fullResearch(),
    baseIcp(),
  ];
  const a = scoreWithHeuristic(...inputs);
  const b = scoreWithHeuristic(...inputs);
  assert.deepEqual(a, b);
});

// ── Reasoning text always populated ─────────────────────────────────────────

test("reasoning is never empty", () => {
  const result = scoreWithHeuristic(baseProspect(), fullResearch(), baseIcp());
  assert.ok(result.reasoning.length > 0);

  // Even with empty inputs we get a fallback explanation.
  const emptyResult = scoreWithHeuristic(
    {
      industry: null,
      city: null,
      region: null,
      country_code: null,
      employee_size_estimate: null,
      red_flags: [],
    },
    null,
    null,
  );
  assert.ok(emptyResult.reasoning.length > 0);
});
