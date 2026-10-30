/**
 * Brief tasks/briefs/benchmark-matching.md: a pitch is offered the sourced
 * statistics about the pain it leads with, for a business like this one, and
 * every offered row says which of the prospect's pains it is for.
 *
 * Real data: tests/fixtures/prod-prospect-pains-2026-10-21.txt (259 prospects)
 * and tests/fixtures/prod-benchmarks-2026-10-21.json (the 48 active rows).
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { __test__ } from "../lib/anthropic/client.ts";
import {
  MAX_BENCHMARKS_PER_PAIN,
  MAX_BENCHMARKS_TOTAL,
  fetchActiveBenchmarkFigures,
  fetchBenchmarksForPitch,
  industryOverlaps,
  matchBenchmarks,
  resolvePainCodes,
} from "../lib/benchmarks/queries.ts";
import { industryFamily } from "../lib/benchmarks/industry-families.ts";
import { PITCH_PROMPT_VERSION } from "../lib/pitches/claude-composer.ts";
import { detectCitedBenchmark } from "../lib/pitches/decision.ts";
import type { GeneratorInputs } from "../lib/pitches/generator.ts";
import { composeWithReview } from "../lib/pitches/review.ts";

process.env.ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY ?? "test-key";

// ── Fixtures ──────────────────────────────────────────────────────────────────

type FixtureRow = {
  id: string;
  figure: string;
  publisher: string;
  pain_codes: string[];
  industry_scope: string[];
  market: string | null;
  vendor: boolean;
};
const FIXTURE_ROWS = JSON.parse(
  readFileSync(new URL("./fixtures/prod-benchmarks-2026-10-21.json", import.meta.url), "utf8"),
) as FixtureRow[];

type ProspectLine = { industry: string; market: string; pains: string[]; count: number };
const PROSPECTS: ProspectLine[] = readFileSync(
  new URL("./fixtures/prod-prospect-pains-2026-10-21.txt", import.meta.url),
  "utf8",
)
  .split("\n")
  .filter((l) => l.trim() && !l.startsWith("#"))
  .map((l) => {
    const [industry = "", market = "", pains = "", count = "0"] = l.split("|");
    return { industry, market, pains: pains.split(",").filter(Boolean), count: Number(count) };
  });

/** A fixture row as the benchmarks table holds it (0029 + 0050 columns). */
type DbRow = {
  id: string;
  tenant_id: string;
  statistic: string;
  figure: string;
  publisher: string;
  source_url: string;
  pain_codes: string[];
  industry_scope: string[];
  market: string | null;
  caveat: string | null;
  is_vendor_sourced: boolean;
  is_active: boolean;
  verified_at: string | null;
  rejected_at?: string | null;
  created_at: string;
};
const T = "tenant-1";
const DB_ROWS: DbRow[] = FIXTURE_ROWS.map((r, i) => ({
  id: r.id,
  tenant_id: T,
  statistic: `${r.publisher}: ${r.figure}`,
  figure: r.figure,
  publisher: r.publisher,
  source_url: `https://example.org/${i}`,
  pain_codes: r.pain_codes,
  industry_scope: r.industry_scope,
  market: r.market,
  caveat: null,
  is_vendor_sourced: r.vendor,
  is_active: true,
  verified_at: "2026-10-16T00:00:00Z",
  created_at: new Date(Date.UTC(2026, 9, 1, 0, i)).toISOString(),
}));
const asCandidates = FIXTURE_ROWS.map((r) => ({ ...r, is_vendor_sourced: r.vendor }));

// ── Fake Supabase (rejects columns the real tables do not have) ──────────────

const COLUMNS: Record<string, Set<string>> = {
  // 0029_benchmarks.sql + 0050 (rejected_at and friends).
  benchmarks: new Set([
    "id", "tenant_id", "statistic", "figure", "pain_codes", "industry_scope", "market", "source_url",
    "publisher", "published_date", "is_vendor_sourced", "caveat", "verified_by", "verified_at", "is_active",
    "created_at", "updated_at", "rejected_at", "wanted_fact_id", "proposed_at",
  ]),
  // 0001_initial_schema.sql
  pain_taxonomy: new Set([
    "id", "tenant_id", "code", "display_name_en", "display_name_es", "description_en",
    "evidence_phrases_en", "evidence_phrases_es", "is_active", "created_at", "updated_at",
  ]),
};

type Tables = { benchmarks?: Array<Partial<DbRow> & Record<string, unknown>>; pain_taxonomy?: Array<Record<string, unknown>> };

function fakeSupabase(tables: Tables, opts: { failBenchmarks?: boolean } = {}) {
  return {
    from(table: string) {
      const cols = COLUMNS[table];
      assert.ok(cols, `unknown table ${table}`);
      const check = (c: string) => assert.ok(cols.has(c), `${table}.${c} does not exist`);
      let rows = [...((tables as Record<string, Array<Record<string, unknown>>>)[table] ?? [])];
      const orders: Array<[string, boolean]> = [];
      const q = {
        select(s: string) {
          for (const c of s.split(",").map((x) => x.trim()).filter(Boolean)) check(c);
          return q;
        },
        eq(c: string, v: unknown) { check(c); rows = rows.filter((r) => r[c] === v); return q; },
        in(c: string, v: unknown[]) { check(c); rows = rows.filter((r) => v.includes(r[c])); return q; },
        not(c: string, op: string, v: unknown) {
          check(c); assert.equal(op, "is"); assert.equal(v, null);
          rows = rows.filter((r) => r[c] !== null && r[c] !== undefined); return q;
        },
        is(c: string, v: unknown) {
          check(c); assert.equal(v, null);
          rows = rows.filter((r) => r[c] === null || r[c] === undefined); return q;
        },
        overlaps(c: string, v: string[]) {
          check(c); rows = rows.filter((r) => (r[c] as string[]).some((x) => v.includes(x))); return q;
        },
        order(c: string, o?: { ascending?: boolean }) { check(c); orders.push([c, o?.ascending !== false]); return q; },
        returns() { return q; },
        then(res: (v: { data: unknown; error: unknown }) => unknown, rej?: (e: unknown) => unknown) {
          if (table === "benchmarks" && opts.failBenchmarks) {
            return Promise.resolve({ data: null, error: { message: "" } }).then(res, rej);
          }
          const sorted = [...rows].sort((a, b) => {
            for (const [c, asc] of orders) {
              const x = String(a[c]), y = String(b[c]);
              if (x !== y) return (x < y ? -1 : 1) * (asc ? 1 : -1);
            }
            return 0;
          });
          return Promise.resolve({ data: sorted, error: null }).then(res, rej);
        },
      };
      return q;
    },
  } as never;
}

const fetchFor = (industry: string | null, market: string | null, painIds: string[], tables: Tables = { benchmarks: DB_ROWS }) =>
  fetchBenchmarksForPitch(fakeSupabase(tables), T, { painIds, industry, market });

const byFigure = (figure: string, publisher: string) => {
  const r = FIXTURE_ROWS.find((x) => x.figure === figure && x.publisher.startsWith(publisher));
  assert.ok(r, `fixture row ${publisher} ${figure}`);
  return r.id;
};

// ── 1. Real data ──────────────────────────────────────────────────────────────

/** Today's rule before this brief (queries.ts at 71bd7f4), for the "before" column. */
function oldRule(p: ProspectLine): FixtureRow[] {
  return FIXTURE_ROWS.filter((r) => r.pain_codes.some((c) => p.pains.includes(c)))
    .filter((r) => industryOverlaps(r.industry_scope, p.industry))
    .filter((r) => !r.market || r.market === "GLOBAL" || r.market === p.market);
}

test("prod fixture: no offered row lacks the pain it is offered for, and first-pain coverage improves", () => {
  const total = PROSPECTS.reduce((n, p) => n + p.count, 0);
  assert.equal(total, 259);

  let before = 0;
  let after = 0;
  let otherPainsOnlyBefore = 0;
  const missesAfter = new Map<string, number>();

  for (const p of PROSPECTS) {
    const first = p.pains[0];
    const old = oldRule(p);
    if (old.some((r) => first && r.pain_codes.includes(first))) before += p.count;
    else if (old.length > 0) otherPainsOnlyBefore += p.count;

    const offered = matchBenchmarks(
      asCandidates,
      p.pains.map((code) => ({ code, label: null })),
      { industry: p.industry, market: p.market },
    );
    assert.ok(offered.length <= MAX_BENCHMARKS_TOTAL, `${p.industry}: ${offered.length} rows`);
    for (const o of offered) {
      assert.ok(o.for_pains.length > 0, `${p.industry}: row ${o.row.figure} offered for no pain`);
      for (const f of o.for_pains) {
        assert.ok(o.row.pain_codes.includes(f.code), `${p.industry}: ${o.row.figure} tagged ${f.code} it is not about`);
        assert.ok(p.pains.includes(f.code), `${p.industry}: ${o.row.figure} tagged ${f.code} the prospect lacks`);
      }
      // Every pain the row is about and the prospect has is named.
      for (const c of o.row.pain_codes) {
        if (p.pains.includes(c)) assert.ok(o.for_pains.some((f) => f.code === c), `${o.row.figure} missing ${c}`);
      }
      // Market rule.
      assert.ok(!o.row.market || o.row.market === "GLOBAL" || o.row.market === p.market);
    }
    if (first && offered.some((o) => o.for_pains.some((f) => f.code === first))) after += p.count;
    else missesAfter.set(p.industry, (missesAfter.get(p.industry) ?? 0) + p.count);
  }

  const misses = [...missesAfter.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  console.log(`first evidenced pain gets >=1 row: before ${before}/${total}, after ${after}/${total}`);
  console.log(`(before: ${otherPainsOnlyBefore} got rows only for OTHER pains)`);
  console.log(`misses after, by industry: ${misses.map(([i, n]) => `${i} ${n}`).join(", ") || "none"}`);

  // Same matching as the conductor's script, so the baseline must reproduce.
  assert.equal(before, 215);
  assert.equal(otherPainsOnlyBefore, 42);
  assert.ok(after >= before, `coverage fell: ${after} < ${before}`);
});

// ── 2. The prod case ──────────────────────────────────────────────────────────

test("prod case: boutique / CA leading with no cart recovery gets the cart rows, each tagged with that pain", async () => {
  const pains = ["no_content_velocity", "abandoned_cart_loss", "low_customer_retention", "poor_social_engagement"];
  const out = await fetchFor("boutique", "CA", pains);

  // The three cart rows lead that pain, each about that pain alone.
  const cartIds = [byFigure("70.22%", "Baymard"), byFigure("40%", "Baymard"), byFigure("More than 90 percent", "McKinsey")];
  const cart = out.filter((b) => b.for_pains.some((f) => f.code === "abandoned_cart_loss"));
  assert.deepEqual(cart.slice(0, 3).map((b) => b.id), cartIds);
  for (const b of cart.slice(0, 3)) assert.deepEqual(b.for_pains.map((f) => f.code), ["abandoned_cart_loss"]);

  // Bain is tagged retention only. HBR (universal) is ranked below Omnisend
  // (same family as boutique, vendor) by decision 3 and falls off the
  // 3-per-pain cap; were it offered, it would be tagged retention only too.
  for (const id of [byFigure("25% to 95%", "Bain"), byFigure("5 to 25 times", "Harvard")]) {
    const b = out.find((x) => x.id === id);
    if (b) assert.deepEqual(b.for_pains.map((f) => f.code), ["low_customer_retention"]);
  }
  assert.ok(out.some((x) => x.id === byFigure("25% to 95%", "Bain")));

  // No row is offered for a pain it is not about (Wyzowl was the prod case's
  // "85%" presented next to a cart pain).
  for (const b of out) {
    const row = FIXTURE_ROWS.find((r) => r.id === b.id);
    for (const f of b.for_pains) assert.ok(row?.pain_codes.includes(f.code));
  }

  // Pinned order: pains in evidence order, then rank within a pain.
  assert.deepEqual(
    out.map((b) => `${b.publisher.split(" ")[0]} ${b.figure} [${b.for_pains.map((f) => f.code).join(",")}]`),
    [
      "Wyzowl 85% [no_content_velocity,poor_social_engagement]",
      "Baymard 70.22% [abandoned_cart_loss]",
      "Baymard 40% [abandoned_cart_loss]",
      "McKinsey More than 90 percent [abandoned_cart_loss]",
      "McKinsey 60% [low_customer_retention]",
      "Omnisend 30% [abandoned_cart_loss,low_customer_retention]",
      "Bain 25% to 95% [low_customer_retention]",
      "Sprout 73% [poor_social_engagement]",
    ],
  );
});

// ── 3. Order and caps ─────────────────────────────────────────────────────────

const cand = (id: string, over: Partial<{ pain_codes: string[]; industry_scope: string[]; market: string | null; is_vendor_sourced: boolean }> = {}) => ({
  id,
  pain_codes: ["p1"],
  industry_scope: [],
  market: null,
  is_vendor_sourced: false,
  ...over,
});

test("order within a pain: direct, then family, then universal; non-vendor before vendor; then input order", () => {
  const rows = [
    cand("universal"),
    cand("family-vendor", { industry_scope: ["retail"], is_vendor_sourced: true }),
    cand("direct-vendor", { industry_scope: ["boutique"], is_vendor_sourced: true }),
    cand("family", { industry_scope: ["online store"] }),
    cand("direct", { industry_scope: ["boutique"] }),
  ];
  const ids = (pains: string[], n = 9) =>
    matchBenchmarks(rows, pains.map((code) => ({ code, label: null })), { industry: "boutique", market: "CA" })
      .slice(0, n)
      .map((o) => o.row.id);
  assert.deepEqual(ids(["p1"]), ["direct", "direct-vendor", "family"]);
  // Deterministic: same input, same output.
  assert.deepEqual(ids(["p1"]), ids(["p1"]));
});

test("at most 3 per pain and 8 in total; pains take turns so later pains are not starved", () => {
  const rows = ["a", "b", "c", "d", "e"].flatMap((p) =>
    [1, 2, 3, 4].map((n) => cand(`${p}${n}`, { pain_codes: [p] })),
  );
  const out = matchBenchmarks(rows, ["a", "b", "c", "d", "e"].map((code) => ({ code, label: null })), {
    industry: "boutique",
    market: "CA",
  });
  assert.equal(out.length, MAX_BENCHMARKS_TOTAL);
  for (const p of ["a", "b", "c", "d", "e"]) {
    const n = out.filter((o) => o.row.pain_codes.includes(p)).length;
    assert.ok(n >= 1 && n <= MAX_BENCHMARKS_PER_PAIN, `${p}: ${n}`);
  }
  assert.deepEqual(out.map((o) => o.row.id), ["a1", "a2", "b1", "b2", "c1", "c2", "d1", "e1"]);
});

test("for_pains carries the label and the prospect's own pain id", async () => {
  const uuid = "11111111-2222-4333-8444-555555555555";
  const out = await fetchFor("boutique", "CA", [uuid], {
    benchmarks: DB_ROWS,
    pain_taxonomy: [{ id: uuid, tenant_id: T, code: "abandoned_cart_loss", display_name_en: "No cart or browse abandonment recovery" }],
  });
  assert.equal(out.length, 3);
  for (const b of out) {
    assert.deepEqual(b.for_pains, [{ code: "abandoned_cart_loss", label: "No cart or browse abandonment recovery", pain_id: uuid }]);
  }
});

test("resolvePainCodes: (id, code) pairs in input order, slugs pass through, unknown uuids dropped, never throws", async () => {
  const a = "11111111-2222-4333-8444-555555555555";
  const unknown = "99999999-2222-4333-8444-555555555555";
  const sb = fakeSupabase({ pain_taxonomy: [{ id: a, tenant_id: T, code: "abandoned_cart_loss", display_name_en: "x" }] });
  assert.deepEqual(await resolvePainCodes(sb, T, ["no_proof", unknown, a, ""]), [
    { id: "no_proof", code: "no_proof" },
    { id: a, code: "abandoned_cart_loss" },
  ]);
  const throwing = { from() { throw new Error("boom"); } } as never;
  assert.deepEqual(await resolvePainCodes(throwing, T, [a]), []);
});

// ── 4. Negative set ───────────────────────────────────────────────────────────

test("inactive, unverified or rejected rows are never offered", async () => {
  const base = DB_ROWS.find((r) => r.figure === "70.22%");
  assert.ok(base);
  const rows = [
    { ...base, id: "inactive", is_active: false },
    { ...base, id: "unverified", verified_at: null },
    { ...base, id: "rejected", is_active: false, rejected_at: "2026-10-21T00:00:00Z" },
    // Not reachable under 0050's CHECK, but the query says it twice.
    { ...base, id: "rejected-active", rejected_at: "2026-10-21T00:00:00Z" },
    { ...base, id: "ok" },
  ];
  const out = await fetchFor("online store", "CA", ["abandoned_cart_loss"], { benchmarks: rows });
  assert.deepEqual(out.map((b) => b.id), ["ok"]);
});

test("market: a CA-scoped row never reaches an MX prospect", async () => {
  const base = DB_ROWS.find((r) => r.figure === "70.22%");
  assert.ok(base);
  const rows = [{ ...base, id: "ca", market: "CA" }, { ...base, id: "global", market: "GLOBAL" }, { ...base, id: "none", market: null }];
  assert.deepEqual((await fetchFor("tienda", "MX", ["abandoned_cart_loss"], { benchmarks: rows })).map((b) => b.id), ["global", "none"]);
  assert.deepEqual((await fetchFor("tienda", "CA", ["abandoned_cart_loss"], { benchmarks: rows })).map((b) => b.id), ["ca", "global", "none"]);
});

const ONLINE_STORE_IDS = new Set(
  FIXTURE_ROWS.filter((r) => r.industry_scope.includes("online store")).map((r) => r.id),
);

for (const industry of ["construction", "law firm", "hospital", "spa", "boutique hotel"]) {
  test(`negative: ${industry} with abandoned_cart_loss gets no online-store row`, async () => {
    const out = await fetchFor(industry, "CA", ["abandoned_cart_loss", "low_customer_retention"]);
    const leaked = out.filter((b) => ONLINE_STORE_IDS.has(b.id));
    assert.deepEqual(leaked.map((b) => `${b.publisher} ${b.figure}`), []);
  });
}

test("negative: boutique hotel is lodging, never retail", () => {
  assert.equal(industryFamily("boutique hotel"), "lodging");
  assert.equal(industryFamily("Boutique "), "retail");
  assert.equal(industryFamily("construction"), null);
  // Pedro 2026-10-21: outdoor gear and clothing shops are retail.
  assert.equal(industryFamily("outdoor"), "retail");
  assert.equal(industryFamily(null), null);
});

test("negative: industry null gets universal rows only", async () => {
  const out = await fetchFor(null, "CA", ["abandoned_cart_loss", "low_customer_retention", "no_content_velocity"]);
  assert.ok(out.length > 0);
  for (const b of out) {
    const row = FIXTURE_ROWS.find((r) => r.id === b.id);
    assert.deepEqual(row?.industry_scope, [], `${b.publisher} ${b.figure} is scoped`);
  }
});

test("a failed benchmarks query or no resolvable pain returns [] (never throws)", async () => {
  assert.deepEqual(await fetchBenchmarksForPitch(fakeSupabase({ benchmarks: DB_ROWS }, { failBenchmarks: true }), T, { painIds: ["abandoned_cart_loss"], industry: "retail", market: "CA" }), []);
  assert.deepEqual(await fetchFor("retail", "CA", []), []);
  assert.deepEqual(await fetchFor("retail", "CA", ["99999999-2222-4333-8444-555555555555"]), []);
  const throwing = { from() { throw new Error("boom"); } } as never;
  assert.deepEqual(await fetchBenchmarksForPitch(throwing, T, { painIds: ["x"], industry: null, market: null }), []);
});

test("detectCitedBenchmark is unchanged by the new for_pains field", async () => {
  const out = await fetchFor("boutique", "CA", ["abandoned_cart_loss"]);
  const first = out[0];
  assert.ok(first);
  assert.deepEqual(detectCitedBenchmark(`About ${first.figure} of carts are left behind.`, out), { id: first.id, figure: first.figure });
  assert.equal(detectCitedBenchmark("No number here.", out), null);
});

test("send gate figures are unchanged: every active verified figure, whatever its pain or industry", async () => {
  const rows = [
    ...DB_ROWS,
    { ...DB_ROWS[0]!, id: "inactive", figure: "1.23%", is_active: false },
    { ...DB_ROWS[0]!, id: "unverified", figure: "4.56%", verified_at: null },
  ];
  const expected = DB_ROWS.map((r) => r.figure);
  assert.deepEqual(await fetchActiveBenchmarkFigures(fakeSupabase({ benchmarks: rows }), T), expected);

  // gate.ts loadGateShared (its own query, "@/" imports, not loadable here)
  // is outside this change; the diff does not touch it.
});

test("the no_benchmark arm still sends an empty list (pitch-stage.ts, first generation)", () => {
  // Source guard: the stage needs a loader-hook harness to run (see
  // tests/pipeline-guards.test.ts); this pins the one line that decides it.
  const src = readFileSync(new URL("../lib/pitches/pitch-stage.ts", import.meta.url), "utf8");
  // The showcase first email (writer.showcase "first") is offered none either.
  assert.match(src, /const offeredBenchmarks = showcaseFirst \|\| writerArms\.evidence === "no_benchmark" \? \[\] : benchmarks;/);
  assert.match(src, /benchmarks: offeredBenchmarks,/);
});

// ── 5. Writer and critic see for_pains ────────────────────────────────────────

type Req = { system?: { text: string }[] | string; messages: { content: string }[] };
const sysText = (r: Req) => (typeof r.system === "string" ? r.system : (r.system ?? []).map((b) => b.text).join("\n"));
const isCritic = (r: Req) => sysText(r).includes("You review a cold email");
const payloadOf = (r: Req) => {
  const m = /```json\n([\s\S]*?)\n```/.exec(r.messages[0]?.content ?? "");
  assert.ok(m?.[1], "payload block");
  return JSON.parse(m[1]) as Record<string, unknown>;
};

const BODY =
  "Hi Ana,\n\nHenry from Runna Advertising here. Your shop has no reminder for people who leave a cart, and Baymard finds about 70.22% of online carts are left before checkout.\n\n👉 Run Boutique Sol through our free check, about 30 seconds: https://runna-hunter.vercel.app/?market=ca\n\nHenry\nRunna Advertising";

test("writer and critic payloads carry for_pains; FACTS and rule 2 say how to use it", async () => {
  const calls: Req[] = [];
  __test__.setClient({
    messages: {
      create: async (r: Req) => {
        calls.push(r);
        const text = isCritic(r)
          ? JSON.stringify({ score: 0.95, issues: [] })
          : JSON.stringify({
              subject: "carts left at boutique sol",
              preview_text: "nothing reminds people who leave a cart",
              body: BODY,
              pain_id: "pain-cart",
              contact_email: "ana@boutiquesol.ca",
              measurable_result_included: true,
              quality_self_score: 0.8,
              reasoning: "x",
            });
        return { content: [{ type: "text", text }], usage: { input_tokens: 100, output_tokens: 50 } };
      },
    },
  } as never);

  const inputs: GeneratorInputs = {
    prospect: { id: "p", company_name: "Boutique Sol", industry: "boutique", language: "en", employee_size_estimate: 5, city: "Calgary", market: "CA", what_they_do: "women's clothing boutique", tech_stack: ["Shopify"] },
    pains: [{ pain_id: "pain-cart", pain_label: "No cart or browse abandonment recovery", evidence_quote: "no abandoned cart email flow detected on checkout" }],
    contacts: [{ full_name: "Ana Ruiz", email: "ana@boutiquesol.ca", email_is_role_based: false, role_title: null }],
    case_studies: [],
    notable_clients: [],
    benchmarks: [
      {
        id: "b1", statistic: "About 70.22% of online carts are abandoned.", figure: "70.22%", publisher: "Baymard Institute", source_url: "https://baymard.com",
        caveat: null, for_pains: [{ code: "abandoned_cart_loss", label: "No cart or browse abandonment recovery", pain_id: "pain-cart" }],
      },
    ],
    sender: { full_name: "Henry", tenant_display_name: "Runna Advertising" },
    deep_pitch_url: "https://runna-hunter.vercel.app/?market=ca",
  };
  const r = await composeWithReview(inputs, { deadline: Date.now() + 48_000 });
  assert.equal(r.ok, true);

  const writer = calls.find((c) => !isCritic(c));
  const critic = calls.find(isCritic);
  assert.ok(writer && critic);

  assert.deepEqual(payloadOf(writer).benchmarks, [
    { statistic: "About 70.22% of online carts are abandoned.", figure: "70.22%", publisher: "Baymard Institute", caveat: null, for_pains: [{ pain_id: "pain-cart", pain: "No cart or browse abandonment recovery" }] },
  ]);
  assert.deepEqual(payloadOf(critic).benchmarks, [
    { statistic: "About 70.22% of online carts are abandoned.", figure: "70.22%", publisher: "Baymard Institute", caveat: null, for_pains: [{ pain_id: "pain-cart", pain: "No cart or browse abandonment recovery" }] },
  ]);
  assert.deepEqual(payloadOf(critic).pain_evidence, [
    { pain_id: "pain-cart", pain: "No cart or browse abandonment recovery", evidence: "no abandoned cart email flow detected on checkout", observed: true },
  ]);

  assert.match(sysText(writer), /cite a benchmark ONLY if one of its for_pains is the pain you lead with \(the same pain_id\), otherwise use no number at all/);
  assert.match(writer.messages[0]?.content ?? "", /Use one only if one of its for_pains has the pain_id you lead with \(see FACTS\); if none does, the email has no statistic\./);
  assert.match(sysText(critic), /2\. A statistic that is not one of payload\.benchmarks, is about a different problem \(its for_pains does not include the pain the email is about\)/);
  assert.equal(PITCH_PROMPT_VERSION, "pitch-v3.4-2026-10-30");
});
