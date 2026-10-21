/**
 * Weekly wanted-fact research (lib/benchmarks/research.ts, brief tasks/briefs/fact-research.md).
 *
 * The fake response (tests/fixtures/fact-research-response.json) has the real
 * shape: server_tool_use, web_search_tool_result lists, text blocks carrying
 * citations[], and the final fenced JSON. The fake db rejects any column the
 * migrations (0029 benchmarks + 0050) do not create, like PostgREST does.
 */

import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import test from "node:test";
import type Anthropic from "@anthropic-ai/sdk";
import { __test__, ANTHROPIC_DEFAULT_MODEL, computeCostUsd } from "../lib/anthropic/client.ts";
import type { CostRecordInput } from "../lib/anthropic/cost-tracking.ts";
import {
  checkCandidate,
  containsDigitGroup,
  digitGroups,
  handleFactResearch,
  normalizeUrl,
  readEvidence,
  researchCost,
  runFactResearch,
  supabaseResearchStore,
  type CreateMessage,
  type RunDeps,
} from "../lib/benchmarks/research.ts";

// ── Schema the fake db enforces ─────────────────────────────────────────────
const mig = (f: string) => readFileSync(new URL(`../supabase/migrations/${f}`, import.meta.url), "utf8");
function createdColumns(sql: string, table: string): string[] {
  const m = sql.match(new RegExp(`create table if not exists public\\.${table} \\(([\\s\\S]*?)\\n\\);`));
  assert.ok(m, `create table ${table} not found`);
  return m[1]!.split("\n").map((l) => l.trim()).filter((l) => /^[a-z_]+ /.test(l) && !/^(check|constraint|unique|primary)\b/.test(l))
    .map((l) => l.split(" ")[0]!);
}
const m0029 = readdirMigration("0029");
function readdirMigration(prefix: string): string {
  const name = readdirSync(new URL("../supabase/migrations/", import.meta.url)).find((f) => f.startsWith(prefix));
  assert.ok(name, `migration ${prefix} missing`);
  return mig(name);
}
const m0050 = mig("0050_wanted_facts.sql");
const SCHEMA: Record<string, Set<string>> = {
  wanted_facts: new Set(createdColumns(m0050, "wanted_facts")),
  benchmarks: new Set([
    ...createdColumns(m0029, "benchmarks"),
    ...[...m0050.matchAll(/add column if not exists ([a-z_]+)/g)].map((x) => x[1]!),
  ]),
};

test("the fake db schema matches the migrations", () => {
  for (const c of ["status", "researched_at", "research_note", "request_count", "last_requested_at"]) assert.ok(SCHEMA.wanted_facts!.has(c), c);
  for (const c of ["wanted_fact_id", "proposed_at", "proposal_note", "rejected_at", "is_active", "verified_at", "caveat"]) assert.ok(SCHEMA.benchmarks!.has(c), c);
  assert.ok(!SCHEMA.benchmarks!.has("created"));
});

// ── Fake Supabase ───────────────────────────────────────────────────────────
type Row = Record<string, unknown>;
class FakeDb {
  tables: Record<string, Row[]> = { wanted_facts: [], benchmarks: [] };
  inserts: Array<{ table: string; rows: Row[] }> = [];
  updates: Array<{ table: string; patch: Row; filters: string[] }> = [];
  failInsert: string | null = null;
  from = (table: string) => {
    const cols = SCHEMA[table];
    assert.ok(cols, `unknown table ${table}`);
    const check = (c: string) => assert.ok(cols.has(c), `column ${table}.${c} does not exist (42703)`);
    const filters: Array<(r: Row) => boolean> = [];
    const described: string[] = [];
    const orders: Array<[string, boolean]> = [];
    let lim = Infinity;
    let from = 0;
    let to = Infinity;
    let mode: "select" | "insert" | "update" = "select";
    let payload: Row | Row[] = {};
    const db = { tables: this.tables, inserts: this.inserts, updates: this.updates, failInsert: () => this.failInsert };
    const q = {
      select(s: string) { s.split(",").map((x) => x.trim()).forEach(check); return q; },
      eq(c: string, v: unknown) { check(c); described.push(`${c}=${String(v)}`); filters.push((r) => r[c] === v); return q; },
      lt(c: string, v: string) { check(c); filters.push((r) => typeof r[c] === "string" && (r[c] as string) < v); return q; },
      in(c: string, vs: unknown[]) { check(c); described.push(`${c} in ${vs.join("|")}`); filters.push((r) => vs.includes(r[c])); return q; },
      order(c: string, o?: { ascending?: boolean }) { check(c); orders.push([c, o?.ascending ?? true]); return q; },
      limit(n: number) { lim = n; return q; },
      range(a: number, b: number) { from = a; to = b; return q; },
      insert(rows: Row[]) { mode = "insert"; payload = rows; rows.forEach((r) => Object.keys(r).forEach(check)); return q; },
      update(patch: Row) { mode = "update"; payload = patch; Object.keys(patch).forEach(check); return q; },
      then(resolve: (v: { data: unknown; error: { message: string } | null }) => void) {
        if (mode === "insert") {
          const fail = db.failInsert();
          if (fail !== null) return resolve({ data: null, error: { message: fail } });
          db.inserts.push({ table, rows: payload as Row[] });
          db.tables[table]!.push(...(payload as Row[]));
          return resolve({ data: null, error: null });
        }
        const rows = db.tables[table]!.filter((r) => filters.every((f) => f(r)));
        if (mode === "update") {
          db.updates.push({ table, patch: payload as Row, filters: described });
          rows.forEach((r) => Object.assign(r, payload));
          return resolve({ data: null, error: null });
        }
        const sorted = [...rows].sort((a, b) => {
          for (const [c, asc] of orders) {
            const x = a[c] as string | number;
            const y = b[c] as string | number;
            if (x !== y) return (x < y ? -1 : 1) * (asc ? 1 : -1);
          }
          return 0;
        });
        resolve({ data: sorted.slice(from, Math.min(to + 1, from + lim)).map((r) => ({ ...r })), error: null });
      },
    };
    return q;
  };
}

// ── Fixtures ────────────────────────────────────────────────────────────────
const RESPONSE = JSON.parse(readFileSync(new URL("./fixtures/fact-research-response.json", import.meta.url), "utf8")) as {
  content: Array<Record<string, unknown>>;
  stop_reason: string;
  usage: Record<string, unknown>;
};
const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;
const T1 = "11111111-1111-4111-8111-111111111111";
const T2 = "22222222-2222-4222-8222-222222222222";
const NOW = Date.parse("2026-10-28T14:20:00Z");
const daysAgo = (d: number) => new Date(NOW - d * 86_400_000).toISOString();

let n = 0;
function fact(over: Row = {}): Row {
  n++;
  return {
    id: `f${n}000000-0000-4000-8000-000000000000`,
    tenant_id: T1,
    fact: `how many stores have no cart recovery ${n}`,
    fact_key: `k${n}`,
    pain_code: "no_cart_recovery",
    industry: "e-commerce",
    market: "MX",
    source: "writer",
    request_count: 1,
    last_pitch_id: null,
    first_requested_at: daysAgo(10),
    last_requested_at: daysAgo(1),
    status: "open",
    researched_at: null,
    research_note: null,
    created_at: daysAgo(10),
    updated_at: daysAgo(1),
    ...over,
  };
}

function harness(opts: {
  facts?: Row[];
  benchmarks?: Row[];
  tenants?: string[];
  respond?: (call: number) => unknown;
  callMs?: number | ((call: number) => number);
  capUnderCalls?: number;
} = {}) {
  const db = new FakeDb();
  db.tables.wanted_facts = (opts.facts ?? []).map((r) => ({ ...r }));
  db.tables.benchmarks = (opts.benchmarks ?? []).map((r) => ({ ...r }));
  let clock = NOW;
  const calls: Array<Record<string, unknown>> = [];
  const callStarts: number[] = [];
  const costs: CostRecordInput[] = [];
  const emails: Array<{ tenantId: string; subject: string; body: string }> = [];
  const warnings: string[] = [];
  let capChecks = 0;
  const create: CreateMessage = async (params) => {
    calls.push(params);
    callStarts.push(clock - NOW);
    const i = calls.length;
    const ms = typeof opts.callMs === "function" ? opts.callMs(i) : (opts.callMs ?? 20_000);
    clock += ms;
    const r = opts.respond ? opts.respond(i) : clone(RESPONSE);
    if (r instanceof Error) throw r;
    return r;
  };
  const deps: RunDeps = {
    store: supabaseResearchStore(db),
    tenantIds: async () => opts.tenants ?? [T1],
    underCap: async () => ({ under: capChecks++ < (opts.capUnderCalls ?? Infinity) }),
    recordCost: async (c) => { costs.push(c); },
    notify: async (tenantId, m) => { emails.push({ tenantId, ...m }); return { sent: 2, failed: [] }; },
    warn: (m) => warnings.push(m),
    clock: () => clock,
    create,
    appUrl: "https://spam.example",
  };
  return { db, deps, calls, callStarts, costs, emails, warnings, elapsed: () => clock - NOW };
}

const BAYMARD = "https://baymard.com/lists/cart-abandonment-rate";

// ── Pure invariant pieces ───────────────────────────────────────────────────
test("digitGroups / containsDigitGroup: whole groups, separators folded, no digits → none", () => {
  assert.deepEqual(digitGroups("70.22%"), ["70.22"]);
  assert.deepEqual(digitGroups("5 to 25 times"), ["5", "25"]);
  assert.deepEqual(digitGroups("1,000 stores."), ["1.000"]);
  assert.deepEqual(digitGroups("70,22 %"), ["70.22"]);
  assert.deepEqual(digitGroups("seven in ten"), []);
  assert.equal(containsDigitGroup("rate is 70.22%.", "70.22"), true);
  assert.equal(containsDigitGroup("rate is 170.225", "70.22"), false);
  assert.equal(containsDigitGroup("rate is 70.2", "70.22"), false);
  assert.equal(containsDigitGroup("in 2025, 25 times", "25"), true);
});

test("normalizeUrl drops only whitespace, #fragment and trailing slashes", () => {
  assert.equal(normalizeUrl(" https://a.com/x/#top "), "https://a.com/x");
  assert.equal(normalizeUrl("https://a.com/x?y=1"), "https://a.com/x?y=1");
  assert.notEqual(normalizeUrl("http://a.com/x"), normalizeUrl("https://a.com/x"));
});

test("checkCandidate: each of the three checks rejects on its own", () => {
  const ev = readEvidence(RESPONSE.content);
  assert.equal(ev.results.length, 4);
  assert.equal(ev.citations.length, 2);
  assert.equal(checkCandidate({ source_url: `${BAYMARD}/`, figure: "70.22%" }, ev, []).keep, true);
  const r = (c: { source_url: string; figure: string }, ex: Parameters<typeof checkCandidate>[2] = []) => {
    const x = checkCandidate(c, ev, ex);
    return x.keep ? "keep" : x.reason;
  };
  assert.equal(r({ source_url: "https://www.invented-source.com/stats", figure: "45%" }), "url_not_in_search_results");
  assert.equal(r({ source_url: BAYMARD, figure: "80%" }), "figure_not_in_citation_from_url");
  assert.equal(r({ source_url: BAYMARD, figure: "seventy percent" }), "figure_has_no_digits");
  assert.equal(r({ source_url: "https://www.shopify.com/blog/cart-abandonment", figure: "70.22%" }), "figure_not_in_citation_from_url");
  assert.equal(r({ source_url: BAYMARD, figure: "70.22%" }, [{ source_url: `${BAYMARD}/`, figure: "70.22 %", wanted_fact_id: null, rejected_at: "2026-10-01" }]), "duplicate_source_and_figure");
});

test("property: a kept candidate always has its url in results and every figure digit group in one citation from that url", () => {
  const ev = readEvidence(RESPONSE.content);
  const urls = [BAYMARD, `${BAYMARD}/`, "https://www.klaviyo.com/marketing-resources/abandoned-cart-benchmarks", "https://www.statista.com/statistics/477804/online-shopping-cart-abandonment-rate-worldwide/", "https://x.invalid/a", ""];
  const figures = ["70.22%", "3.65%", "49", "70.22% to 49", "70", "22", "0.22", "70.2", "3.65", "65%", "3 to 65", "none", "2025", "70.22 of 3.65"];
  let kept = 0;
  for (const source_url of urls) {
    for (const figure of figures) {
      const c = checkCandidate({ source_url, figure }, ev, []);
      if (!c.keep) continue;
      kept++;
      // Independent third matcher: strip everything but digits and dots from both sides.
      const onlyNum = (s: string) => s.replace(/[^0-9.\s]/g, " ").split(/\s+/).map((t) => t.replace(/^\.+|\.+$/g, "")).filter(Boolean);
      const host = new URL(source_url).host;
      assert.ok(ev.results.some((r) => new URL(r.url).host === host && r.url.replace(/\/$/, "") === source_url.replace(/\/$/, "")));
      const cites = ev.citations.filter((x) => x.url.replace(/\/$/, "") === source_url.replace(/\/$/, ""));
      assert.ok(cites.some((x) => onlyNum(figure).every((g) => onlyNum(x.cited_text).includes(g))), `${figure} @ ${source_url}`);
    }
  }
  assert.ok(kept >= 4, `expected some keeps, got ${kept}`);
});

// ── Acceptance 1: the realistic response end to end ─────────────────────────
test("one passing proposal is written with the exact insert payload; invented, uncited and cross-url figures are dropped", async () => {
  const f = fact({ request_count: 5 });
  const h = harness({ facts: [f] });
  const report = await runFactResearch(h.deps, { dry: false });

  assert.equal(h.calls.length, 1);
  assert.equal(h.db.inserts.length, 1);
  const rows = h.db.inserts[0]!.rows;
  assert.equal(rows.length, 1);
  const row = rows[0]!;
  const note = row.proposal_note as string;
  assert.deepEqual({ ...row, proposal_note: "<checked below>" }, {
    tenant_id: T1,
    wanted_fact_id: f.id,
    proposed_at: new Date(NOW + 20_000).toISOString(),
    is_active: false,
    verified_at: null,
    verified_by: null,
    statistic: "Roughly 70.22% of online shopping carts are abandoned before checkout, across 49 studies.",
    figure: "70.22%",
    pain_codes: ["no_cart_recovery"],
    industry_scope: ["e-commerce", "online store"],
    market: "GLOBAL",
    source_url: BAYMARD,
    publisher: "Baymard Institute",
    published_date: "2025-06-12",
    is_vendor_sourced: false,
    caveat: "Meta-analysis of 49 studies, mostly US and global e-commerce, 2006 to 2025, published by Baymard Institute.",
    proposal_note: "<checked below>",
  });
  assert.match(note, /^Cited: "The average documented online shopping cart abandonment rate is 70\.22%\./);
  assert.match(note, /Why solid: Independent UX research firm/);
  assert.ok(!("rejected_at" in row));

  const stored = h.db.tables.wanted_facts![0]!;
  assert.equal(stored.status, "proposed");
  assert.equal(stored.researched_at, new Date(NOW + 20_000).toISOString());
  const rn = stored.research_note as string;
  assert.match(rn, /45% \(https:\/\/www\.invented-source\.com\/stats\): url_not_in_search_results/);
  assert.match(rn, /80% \(https:\/\/baymard\.com[^)]*\): figure_not_in_citation_from_url/);
  assert.match(rn, /3\.65% \(https:\/\/www\.statista\.com[^)]*\): figure_not_in_citation_from_url/);
  // The status write only moves a fact that is still open/no_source.
  assert.deepEqual(h.db.updates[0]!.filters, [`id=${f.id}`, `tenant_id=${T1}`, "status in open|no_source"]);

  assert.equal(h.emails.length, 1);
  assert.match(h.emails[0]!.subject, /^1 sourced statistic wait/);
  assert.match(h.emails[0]!.body, /- 70\.22%, Baymard Institute\. For: "how many stores/);
  assert.match(h.emails[0]!.body, /https:\/\/spam\.example\/benchmarks/);
  assert.equal(report.emailed, 2);
  assert.equal(h.costs.length, 1);
  assert.equal(h.costs[0]!.entity_type, "fact_research");
  assert.equal(h.costs[0]!.entity_id, f.id);
});

test("every row this code inserts is inactive and unverified, whatever the model says", async () => {
  const r = clone(RESPONSE);
  const last = r.content.at(-1)!;
  last.text = (last.text as string).replace('"is_vendor_sourced": false, "caveat": "Meta', '"is_active": true, "verified_at": "2026-10-01", "verified_by": "x", "is_vendor_sourced": false, "caveat": "Meta');
  const h = harness({ facts: [fact()], respond: () => r });
  await runFactResearch(h.deps, { dry: false });
  const rows = h.db.inserts.flatMap((i) => i.rows);
  assert.equal(rows.length, 1);
  for (const row of rows) {
    assert.equal(row.is_active, false);
    assert.equal(row.verified_at, null);
    assert.equal(row.verified_by, null);
  }
});

test("duplicate source + figure (any state, rejected included) is dropped; the fact goes no_source", async () => {
  const f = fact();
  const h = harness({
    facts: [f],
    benchmarks: [{ id: "b1", tenant_id: T1, source_url: `${BAYMARD}/`, figure: "70.22%", wanted_fact_id: null, rejected_at: "2026-10-20T00:00:00Z" }],
  });
  await runFactResearch(h.deps, { dry: false });
  assert.equal(h.db.inserts.length, 0);
  const stored = h.db.tables.wanted_facts![0]!;
  assert.equal(stored.status, "no_source");
  assert.match(stored.research_note as string, /70\.22% \([^)]*\): duplicate_source_and_figure/);
  assert.equal(h.emails.length, 0);
});

test("killed between insert and status: the next run sees its own rows and marks the fact proposed without re-inserting", async () => {
  const f = fact();
  const h = harness({
    facts: [f],
    benchmarks: [{ id: "b1", tenant_id: T1, source_url: BAYMARD, figure: "70.22%", wanted_fact_id: f.id, rejected_at: null }],
  });
  await runFactResearch(h.deps, { dry: false });
  assert.equal(h.db.inserts.length, 0);
  assert.equal(h.db.tables.wanted_facts![0]!.status, "proposed");
  assert.equal(h.emails.length, 0);
});

test("two proposals with the same source + figure in one answer: only the first is written", async () => {
  const r = clone(RESPONSE);
  const last = r.content.at(-1)!;
  const t = last.text as string;
  const json = JSON.parse(t.slice(t.indexOf("```json") + 7, t.lastIndexOf("```"))) as { proposals: unknown[] };
  json.proposals = [json.proposals[0], json.proposals[0]];
  last.text = "```json\n" + JSON.stringify(json) + "\n```";
  const h = harness({ facts: [fact()], respond: () => r });
  await runFactResearch(h.deps, { dry: false });
  assert.equal(h.db.inserts[0]!.rows.length, 1);
});

// ── Selection ───────────────────────────────────────────────────────────────
test("selection: dismissed, proposed and recent no_source facts are never picked; top 2 by request_count then recency", async () => {
  const facts = [
    fact({ status: "dismissed", request_count: 99 }),
    fact({ status: "proposed", request_count: 98 }),
    fact({ status: "no_source", request_count: 97, researched_at: daysAgo(29) }),
    fact({ status: "no_source", request_count: 3, researched_at: daysAgo(31) }),
    fact({ status: "open", request_count: 3, last_requested_at: daysAgo(5) }),
    fact({ status: "open", request_count: 1 }),
    fact({ status: "open", request_count: 50, tenant_id: T2 }),
  ];
  const h = harness({ facts, callMs: 1_000 });
  await runFactResearch(h.deps, { dry: false });
  const asked = h.calls.map((c) => ((c.messages as Array<{ content: string }>)[0]!.content).split("\n")[0]);
  assert.deepEqual(asked, [`Wanted fact: ${facts[3]!.fact}`, `Wanted fact: ${facts[4]!.fact}`]);
});

// ── Acceptance 3: error paths ───────────────────────────────────────────────
test("a search error object (HTTP 200) with no results keeps the fact open with a note", async () => {
  const r = clone(RESPONSE);
  r.content = [
    { type: "server_tool_use", id: "srvtoolu_x", name: "web_search", input: { query: "q" } },
    { type: "web_search_tool_result", tool_use_id: "srvtoolu_x", content: { type: "web_search_tool_result_error", error_code: "unavailable" } },
    { type: "text", text: "Search was unavailable.\n```json\n{\"proposals\": [], \"no_source_reason\": \"search unavailable\"}\n```" },
  ];
  const f = fact();
  const h = harness({ facts: [f], respond: () => r });
  const report = await runFactResearch(h.deps, { dry: false });
  assert.equal(report.facts[0]!.kind, "search_error");
  const stored = h.db.tables.wanted_facts![0]!;
  assert.equal(stored.status, "open");
  assert.equal(stored.researched_at, null);
  assert.match(stored.research_note as string, /Search errors: unavailable/);
  assert.equal(h.costs.length, 1);
});

test("a search error next to a successful search does not hide the good proposal", async () => {
  const r = clone(RESPONSE);
  r.content.splice(1, 0,
    { type: "server_tool_use", id: "srvtoolu_e", name: "web_search", input: { query: "q" } },
    { type: "web_search_tool_result", tool_use_id: "srvtoolu_e", content: { type: "web_search_tool_result_error", error_code: "too_many_requests" } });
  const h = harness({ facts: [fact()], respond: () => r });
  await runFactResearch(h.deps, { dry: false });
  assert.equal(h.db.inserts[0]!.rows.length, 1);
  assert.match(h.db.tables.wanted_facts![0]!.research_note as string, /Search errors: too_many_requests/);
});

test("pause_turn: no proposals even when the text holds valid JSON; cost recorded; fact stays open", async () => {
  const r = clone(RESPONSE);
  r.stop_reason = "pause_turn";
  const h = harness({ facts: [fact()], respond: () => r });
  const report = await runFactResearch(h.deps, { dry: false });
  assert.equal(report.facts[0]!.kind, "unfinished");
  assert.equal(h.db.inserts.length, 0);
  assert.equal(h.db.tables.wanted_facts![0]!.status, "open");
  assert.match(h.db.tables.wanted_facts![0]!.research_note as string, /pause_turn/);
  assert.equal(h.costs.length, 1);
});

test("unparseable JSON: cost still recorded, fact stays open with a note, no retry in the run", async () => {
  const r = clone(RESPONSE);
  r.content.at(-1)!.text = "Here you go: ```json\n{\"proposals\": [ {\"figure\": \n```";
  const h = harness({ facts: [fact()], respond: () => r });
  const report = await runFactResearch(h.deps, { dry: false });
  assert.equal(h.calls.length, 1);
  assert.equal(report.facts[0]!.kind, "parse_error");
  assert.equal(h.costs.length, 1);
  assert.ok(h.costs[0]!.usage.cost_usd > 0);
  assert.equal(h.db.inserts.length, 0);
  const stored = h.db.tables.wanted_facts![0]!;
  assert.equal(stored.status, "open");
  assert.match(stored.research_note as string, /No usable answer/);
});

test("\"web search not enabled\": note on the fact, stays open, run stops, one warning, no email", async () => {
  const err = Object.assign(new Error('400 {"type":"error","error":{"type":"invalid_request_error","message":"Web search is not enabled for this organization."}}'), { status: 400 });
  const h = harness({ facts: [fact({ request_count: 9 }), fact()], tenants: [T1], respond: () => err });
  const report = await runFactResearch(h.deps, { dry: false });
  assert.equal(h.calls.length, 1);
  assert.equal(report.stopped, "search_disabled");
  assert.equal(h.warnings.length, 1);
  assert.equal(h.emails.length, 0);
  assert.equal(h.costs.length, 0);
  const [a, b] = h.db.tables.wanted_facts!;
  assert.equal(a!.status, "open");
  assert.match(a!.research_note as string, /web search not enabled/);
  assert.equal(b!.research_note, null);
});

test("cap reached before the first call: zero calls, zero writes, no email", async () => {
  const h = harness({ facts: [fact(), fact()], capUnderCalls: 0 });
  const report = await runFactResearch(h.deps, { dry: false });
  assert.equal(report.stopped, "cap");
  assert.equal(h.calls.length, 0);
  assert.equal(h.db.inserts.length + h.db.updates.length, 0);
  assert.equal(h.emails.length, 0);
});

test("cap reached before the second call: one call, its writes, then stop", async () => {
  const h = harness({ facts: [fact({ request_count: 2 }), fact()], capUnderCalls: 1 });
  const report = await runFactResearch(h.deps, { dry: false });
  assert.equal(report.stopped, "cap");
  assert.equal(h.calls.length, 1);
  assert.equal(h.db.tables.wanted_facts![0]!.status, "proposed");
  assert.equal(h.db.tables.wanted_facts![1]!.status, "open");
  assert.equal(h.db.tables.wanted_facts![1]!.research_note, null);
});

// ── Acceptance 4: budget ────────────────────────────────────────────────────
test("budget: 50 s calls → at most 2 calls per run, the second starting with ≥ 55 s left; returns before 120 s", async () => {
  const facts = [fact({ request_count: 4 }), fact({ request_count: 3 }), fact({ tenant_id: T2, request_count: 9 }), fact({ tenant_id: T2 })];
  const h = harness({ facts, tenants: [T1, T2], callMs: 50_000 });
  const report = await runFactResearch(h.deps, { dry: false });
  assert.equal(h.calls.length, 2);
  assert.equal(report.stopped, "deadline");
  assert.deepEqual(h.callStarts, [0, 50_000]);
  for (const s of h.callStarts) assert.ok(105_000 - s >= 55_000);
  assert.ok(h.elapsed() < 120_000, `elapsed ${h.elapsed()}`);
});

test("budget: a first call of 51 s leaves < 55 s, so the second never starts", async () => {
  const h = harness({ facts: [fact({ request_count: 2 }), fact()], callMs: 51_000 });
  const report = await runFactResearch(h.deps, { dry: false });
  assert.equal(h.calls.length, 1);
  assert.equal(report.stopped, "deadline");
  assert.equal(h.db.tables.wanted_facts![1]!.research_note, null);
});

test("the call uses the default model, a 5-use web_search tool and asks for cited sentences + JSON", async () => {
  const h = harness({ facts: [fact()] });
  await runFactResearch(h.deps, { dry: true });
  const c = h.calls[0]!;
  assert.equal(c.model, ANTHROPIC_DEFAULT_MODEL);
  assert.deepEqual(c.tools, [{ type: "web_search_20250305", name: "web_search", max_uses: 5 }]);
  assert.match(c.system as string, /cites the search result/);
});

// ── Acceptance 5: cost ──────────────────────────────────────────────────────
test("cost = token cost + $0.01 per web search request; web_search_requests in metadata", async () => {
  const u = { input_tokens: 18_450, output_tokens: 1_210, cache_read_input_tokens: 100, cache_creation_input_tokens: 50, server_tool_use: { web_search_requests: 3 } };
  const tokens = computeCostUsd(ANTHROPIC_DEFAULT_MODEL, 18_450, 1_210, 100, 50);
  const { usage, webSearchRequests } = researchCost(ANTHROPIC_DEFAULT_MODEL, u);
  assert.equal(webSearchRequests, 3);
  assert.equal(usage.cost_usd, Math.round((tokens + 0.03) * 1e6) / 1e6);
  assert.ok(Math.abs(usage.cost_usd - tokens - 0.03) < 1e-9);
  assert.equal(researchCost(ANTHROPIC_DEFAULT_MODEL, { input_tokens: 0, output_tokens: 0 }).usage.cost_usd, 0);

  const h = harness({ facts: [fact()] });
  await runFactResearch(h.deps, { dry: false });
  const rec = h.costs[0]!;
  assert.equal(rec.usage.cost_usd, Math.round((computeCostUsd(ANTHROPIC_DEFAULT_MODEL, 18_450, 1_210) + 0.03) * 1e6) / 1e6);
  assert.equal(rec.metadata?.web_search_requests, 3);
  assert.equal(rec.model, ANTHROPIC_DEFAULT_MODEL);
});

// ── Acceptance 6: dry run through the handler and the real client seam ──────
test("?dry=1 researches one fact, writes nothing, sends nothing, returns the proposals (real getClient path)", async () => {
  let created: unknown = null;
  __test__.setClient({ messages: { create: async (p: unknown) => { created = p; return clone(RESPONSE); } } } as unknown as Anthropic);
  try {
    const h = harness({ facts: [fact({ request_count: 3 }), fact(), fact({ tenant_id: T2 })], tenants: [T1, T2] });
    const { create: _unused, ...withoutCreate } = h.deps;
    void _unused;
    const res = await handleFactResearch(new Request("https://x.test/api/benchmarks/research?dry=1"), { ...withoutCreate, authorize: async () => true });
    assert.equal(res.status, 200);
    const body = (await res.json()) as { dry: boolean; calls: number; proposals: Array<Record<string, unknown>>; dropped: unknown[] };
    assert.ok(created, "went through getClient()");
    assert.equal(body.dry, true);
    assert.equal(body.calls, 1);
    assert.equal(body.proposals.length, 1);
    assert.equal(body.proposals[0]!.figure, "70.22%");
    assert.equal(body.proposals[0]!.is_active, false);
    assert.equal(body.dropped.length, 3);
    assert.equal(h.db.inserts.length, 0);
    assert.equal(h.db.updates.length, 0);
    assert.equal(h.emails.length, 0);
    assert.equal(h.costs.length, 1, "the paid call is still recorded");
  } finally {
    __test__.reset();
  }
});

test("unauthorized: 401, no reads, no calls", async () => {
  const h = harness({ facts: [fact()] });
  let read = false;
  const res = await handleFactResearch(new Request("https://x.test/api/benchmarks/research"), {
    ...h.deps,
    tenantIds: async () => { read = true; return [T1]; },
    authorize: async () => false,
  });
  assert.equal(res.status, 401);
  assert.equal(read, false);
  assert.equal(h.calls.length, 0);
});

test("a failed proposal insert leaves the fact open with a note and sends no email", async () => {
  const h = harness({ facts: [fact()] });
  h.db.failInsert = "";
  await runFactResearch(h.deps, { dry: false });
  const stored = h.db.tables.wanted_facts![0]!;
  assert.equal(stored.status, "open");
  assert.match(stored.research_note as string, /Proposals not saved \(database error \(empty message\)\)/);
  assert.equal(h.emails.length, 0);
});
