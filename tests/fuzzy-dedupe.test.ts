import assert from "node:assert/strict";
import test from "node:test";
import {
  findDuplicate,
  nameSimilarity,
  normalizeCompanyName,
  normalizeDomain,
} from "../lib/discover/fuzzy-dedupe.ts";

// ── normalizeCompanyName ────────────────────────────────────────────────────

test("normalizeCompanyName: strips Inc/LLC/Corp/Ltd suffixes", () => {
  assert.equal(normalizeCompanyName("Acme Inc"), "acme");
  assert.equal(normalizeCompanyName("Acme, LLC"), "acme");
  assert.equal(normalizeCompanyName("Acme Corp."), "acme");
  assert.equal(normalizeCompanyName("Acme Limited"), "acme");
  assert.equal(normalizeCompanyName("ACME, Inc."), "acme");
});

test("normalizeCompanyName: strips diacritics", () => {
  assert.equal(normalizeCompanyName("Café São Paulo"), "cafe sao paulo");
  assert.equal(normalizeCompanyName("Münchner Brauerei"), "munchner brauerei");
});

test("normalizeCompanyName: strips 'the' and 'and' as filler", () => {
  assert.equal(normalizeCompanyName("The Coffee Co"), "coffee");
  assert.equal(normalizeCompanyName("Acme and Sons"), "acme sons");
});

test("normalizeCompanyName: collapses extra whitespace", () => {
  assert.equal(normalizeCompanyName("  Acme    Coffee  "), "acme coffee");
});

// ── normalizeDomain ─────────────────────────────────────────────────────────

test("normalizeDomain: strips protocol + www + path", () => {
  assert.equal(normalizeDomain("https://www.runna.agency/about?ref=foo"), "runna.agency");
  assert.equal(normalizeDomain("http://example.com"), "example.com");
  assert.equal(normalizeDomain("www.shop.example.com"), "shop.example.com");
});

test("normalizeDomain: bare domain passes through unchanged", () => {
  assert.equal(normalizeDomain("runna.agency"), "runna.agency");
  assert.equal(normalizeDomain("RUNNA.AGENCY"), "runna.agency");
});

test("normalizeDomain: returns null for malformed input", () => {
  assert.equal(normalizeDomain(""), null);
  assert.equal(normalizeDomain("not-a-domain"), null);
  assert.equal(normalizeDomain("ftp://"), null);
});

// ── nameSimilarity ──────────────────────────────────────────────────────────

test("nameSimilarity: identical strings = 1.0", () => {
  assert.equal(nameSimilarity("acme", "acme"), 1);
});

test("nameSimilarity: completely different = 0", () => {
  assert.equal(nameSimilarity("abc", "xyz"), 0);
});

test("nameSimilarity: small typo gets high score", () => {
  // "acme coffee" vs "acme coffe" — single-char delete
  assert.ok(nameSimilarity("acme coffee", "acme coffe") >= 0.85);
});

test("nameSimilarity: prefix-only match scores below the dedupe threshold", () => {
  // "acme" inside "acme bakery" — we don't want this to false-positive as
  // the same company. Bigram Jaccard penalizes extra tokens heavily.
  const score = nameSimilarity("acme", "acme bakery");
  assert.ok(score > 0.2 && score < 0.85, `expected medium-low score, got ${score}`);
});

test("nameSimilarity: two empty strings collapse to identical (1.0)", () => {
  // The bigram falls-back to a single-element set for length<2 strings,
  // so two empties produce identical singleton sets and score 1.0.
  // For dedupe this is the right call: two empty-name rows ARE dupes.
  assert.equal(nameSimilarity("", ""), 1);
});

test("nameSimilarity: empty vs non-empty → low/0 score", () => {
  assert.ok(nameSimilarity("", "acme") < 0.5);
});

// ── findDuplicate ───────────────────────────────────────────────────────────

test("findDuplicate: matches by exact normalized domain", () => {
  const existing = [
    { name: "A", domain: "https://www.example.com/about" },
    { name: "B", domain: "shop.example.com" },
  ];
  const idx = findDuplicate({ name: "X", domain: "EXAMPLE.COM" }, existing);
  assert.equal(idx, 0);
});

test("findDuplicate: domain conflict means different companies even if names match", () => {
  // Same name "Acme Coffee" but different domains → not a duplicate.
  const existing = [{ name: "Acme Coffee", domain: "acmecoffee.ca" }];
  const idx = findDuplicate(
    { name: "Acme Coffee", domain: "acmecoffee.com" },
    existing,
  );
  assert.equal(idx, -1);
});

test("findDuplicate: matches by name when no domain on either side", () => {
  const existing = [{ name: "Acme Coffee Co", domain: null }];
  const idx = findDuplicate({ name: "ACME COFFEE COMPANY", domain: null }, existing);
  assert.equal(idx, 0);
});

test("findDuplicate: returns -1 when no match", () => {
  const existing = [{ name: "Acme", domain: "acme.com" }];
  const idx = findDuplicate({ name: "Beta", domain: "beta.com" }, existing);
  assert.equal(idx, -1);
});

test("findDuplicate: empty existing list always returns -1", () => {
  const idx = findDuplicate({ name: "Acme", domain: "acme.com" }, []);
  assert.equal(idx, -1);
});
