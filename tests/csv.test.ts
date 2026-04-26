import assert from "node:assert/strict";
import test from "node:test";
import { parseCsv, parseProspectCsv } from "../lib/discover/csv.ts";

// ── parseCsv (the low-level cell parser) ───────────────────────────────────

test("parseCsv: simple header + one row", () => {
  const r = parseCsv("a,b,c\n1,2,3");
  assert.deepEqual(r.headers, ["a", "b", "c"]);
  assert.equal(r.rows.length, 1);
  assert.deepEqual(r.rows[0], { a: "1", b: "2", c: "3" });
});

test("parseCsv: lowercases + trims headers", () => {
  const r = parseCsv("  Company_Name , MARKET\nAcme,CA");
  assert.deepEqual(r.headers, ["company_name", "market"]);
  assert.equal(r.rows[0]?.company_name, "Acme");
});

test("parseCsv: handles quoted fields with embedded commas", () => {
  const r = parseCsv('a,b\n"hello, world","x"');
  assert.equal(r.rows[0]?.a, "hello, world");
  assert.equal(r.rows[0]?.b, "x");
});

test("parseCsv: handles escaped double-quotes inside quoted fields", () => {
  const r = parseCsv('a\n"she said ""hi"""');
  assert.equal(r.rows[0]?.a, 'she said "hi"');
});

test("parseCsv: handles CRLF line endings", () => {
  const r = parseCsv("a,b\r\n1,2\r\n3,4");
  assert.equal(r.rows.length, 2);
  assert.equal(r.rows[1]?.a, "3");
});

test("parseCsv: skips fully blank lines", () => {
  const r = parseCsv("a,b\n1,2\n\n3,4\n");
  assert.equal(r.rows.length, 2);
});

test("parseCsv: empty input → empty result", () => {
  const r = parseCsv("");
  assert.equal(r.headers.length, 0);
  assert.equal(r.rows.length, 0);
});

// ── parseProspectCsv (the schema-validating wrapper) ───────────────────────

test("parseProspectCsv: missing required header → single error, no rows", () => {
  const r = parseProspectCsv("name,market\nAcme,CA"); // header is 'name', not 'company_name'
  assert.equal(r.rows.length, 0);
  assert.equal(r.errors.length, 1);
  assert.match(r.errors[0]!.reason, /Missing required header: company_name/);
});

test("parseProspectCsv: rejects rows with empty company_name", () => {
  const csv = "company_name,market\n,CA\nAcme,CA";
  const r = parseProspectCsv(csv);
  assert.equal(r.rows.length, 1);
  assert.equal(r.errors.length, 1);
  assert.match(r.errors[0]!.reason, /company_name is empty/);
  assert.equal(r.errors[0]!.row, 2); // line 2 is the bad one (header is line 1)
});

test("parseProspectCsv: rejects invalid markets", () => {
  const csv = "company_name,market\nAcme,FR\nBeta,CA";
  const r = parseProspectCsv(csv);
  assert.equal(r.rows.length, 1);
  assert.equal(r.errors.length, 1);
  assert.match(r.errors[0]!.reason, /market must be one of/);
});

test("parseProspectCsv: market is case-insensitive (uppercases)", () => {
  const r = parseProspectCsv("company_name,market\nAcme,ca");
  assert.equal(r.rows.length, 1);
  assert.equal(r.rows[0]?.market, "CA");
});

test("parseProspectCsv: optional fields default to null", () => {
  const r = parseProspectCsv("company_name,market\nAcme,CA");
  assert.equal(r.rows[0]?.domain, null);
  assert.equal(r.rows[0]?.industry, null);
  assert.equal(r.rows[0]?.city, null);
  assert.equal(r.rows[0]?.region, null);
});

test("parseProspectCsv: language defaults to undefined unless 'es'", () => {
  const r1 = parseProspectCsv("company_name,market,language\nAcme,MX,es");
  const r2 = parseProspectCsv("company_name,market,language\nAcme,MX,en");
  const r3 = parseProspectCsv("company_name,market\nAcme,MX");
  assert.equal(r1.rows[0]?.language, "es");
  assert.equal(r2.rows[0]?.language, undefined);
  assert.equal(r3.rows[0]?.language, undefined);
});

test("parseProspectCsv: totalRows counts data rows ignoring header", () => {
  const csv = "company_name,market\nA,CA\nB,CA\nC,CA";
  const r = parseProspectCsv(csv);
  assert.equal(r.totalRows, 3);
  assert.equal(r.rows.length, 3);
});

test("parseProspectCsv: bad rows + good rows in same file", () => {
  const csv = "company_name,market\nGood,CA\n,XX\nAlsoBad,FR\nGood2,US";
  const r = parseProspectCsv(csv);
  assert.equal(r.rows.length, 2);
  assert.equal(r.errors.length, 2);
});
