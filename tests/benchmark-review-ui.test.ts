/**
 * The /benchmarks review actions against a fake Supabase client. lib/benchmarks/actions.ts
 * is loaded with its three imports (next/cache, @/lib/auth, @/lib/supabase/server) stubbed
 * by a loader hook; zod stays real.
 */

import assert from "node:assert/strict";
import { register } from "node:module";
import test from "node:test";
import {
  leaveOutReviewQueue,
  sortWantedFacts,
  type WantedFactRow,
} from "../lib/benchmarks/proposals.ts";

const ACTIONS_URL = new URL("../lib/benchmarks/actions.ts", import.meta.url);

const hooks = `
const TARGET = ${JSON.stringify(ACTIONS_URL.href)};
const NAMES = { "next/cache": ["revalidatePath"], "@/lib/auth": ["requireUser"], "@/lib/supabase/server": ["createClient"] };
export async function resolve(spec, ctx, next) {
  if (ctx.parentURL === TARGET && spec in NAMES) return { url: "stub:" + spec, shortCircuit: true };
  return next(spec, ctx);
}
export async function load(url, ctx, next) {
  if (!url.startsWith("stub:")) return next(url, ctx);
  const names = NAMES[url.slice(5)];
  const src = names.map((n) => "export const " + n + " = (...a) => globalThis.__stubs." + n + "(...a);").join("\\n");
  return { format: "module", source: src, shortCircuit: true };
}`;
register("data:text/javascript," + encodeURIComponent(hooks));

type Row = Record<string, unknown>;
type Call = { table: string; op: string; values?: Row; filters: string[] };
type Res = { data: unknown; error: { message: string } | null };

const TENANT = "00000000-0000-4000-8000-000000000001";
const ID = "00000000-0000-4000-8000-0000000000aa";

class Query implements PromiseLike<Res> {
  op = "select";
  list = false;
  values: Row = {};
  filters: ((r: Row) => boolean)[] = [];
  desc: string[] = [];
  env: Env;
  table: string;
  constructor(env: Env, table: string) {
    this.env = env;
    this.table = table;
  }
  select() { return this; }
  update(v: Row) { this.op = "update"; this.values = v; return this; }
  eq(k: string, v: unknown) { this.desc.push(`${k}=${v}`); this.filters.push((r) => r[k] === v); return this; }
  in(k: string, v: unknown[]) { this.desc.push(`${k} in ${v.join("|")}`); this.filters.push((r) => v.includes(r[k])); return this; }
  is(k: string, v: null) { this.desc.push(`${k} is null`); this.filters.push((r) => (r[k] ?? null) === v); return this; }
  not(k: string, _op: string, v: null) { this.desc.push(`${k} not null`); this.filters.push((r) => (r[k] ?? null) !== v); return this; }
  maybeSingle() { return this; }
  limit() { this.list = true; return this; }
  then<A = Res, B = never>(ok?: ((v: Res) => A | PromiseLike<A>) | null, bad?: ((e: unknown) => B | PromiseLike<B>) | null) {
    return Promise.resolve(this.run()).then(ok, bad);
  }
  run(): Res {
    this.env.calls.push({ table: this.table, op: this.op, values: this.values, filters: this.desc });
    const rows = (this.env.tables[this.table] ??= []);
    const hit = rows.filter((r) => this.filters.every((f) => f(r)));
    if (this.op === "select") {
      const out = this.list ? hit.map((r) => ({ id: r.id })) : hit[0] ? { ...hit[0] } : null;
      if (this.table === "benchmarks" && env.afterBenchmarkRead) {
        const fn = env.afterBenchmarkRead;
        env.afterBenchmarkRead = undefined;
        fn();
      }
      return { data: out, error: null };
    }
    for (const r of hit) Object.assign(r, this.values);
    return { data: hit.map((r) => ({ id: r.id, wanted_fact_id: r.wanted_fact_id })), error: null };
  }
}

type Env = {
  tables: Record<string, Row[]>;
  calls: Call[];
  rpcs: { fn: string; args: Row }[];
  rpcError: { message: string } | null;
  role: "admin" | "reviewer" | "viewer";
  revalidated: string[];
  /** Runs once, right after the first benchmarks read (simulates another tab). */
  afterBenchmarkRead?: () => void;
};
const env: Env = { tables: {}, calls: [], rpcs: [], rpcError: null, role: "reviewer", revalidated: [] };

(globalThis as Record<string, unknown>).__stubs = {
  revalidatePath: (p: string) => env.revalidated.push(p),
  requireUser: async () => ({ id: "user-1", role: env.role, tenantId: TENANT }),
  createClient: async () => ({
    from: (t: string) => new Query(env, t),
    rpc: async (fn: string, args: Row) => {
      env.rpcs.push({ fn, args });
      return { data: env.rpcError ? null : "new-id", error: env.rpcError };
    },
  }),
};

const actions = await import("../lib/benchmarks/actions.ts");

function reset(role: Env["role"] = "reviewer") {
  env.role = role;
  env.calls = [];
  env.rpcs = [];
  env.rpcError = null;
  env.revalidated = [];
  env.afterBenchmarkRead = undefined;
  env.tables = {
    benchmarks: [
      { id: ID, tenant_id: TENANT, wanted_fact_id: "wf1", verified_at: null, rejected_at: null, is_active: false, statistic: "s", figure: "f" },
    ],
    wanted_facts: [{ id: ID, tenant_id: TENANT, status: "open" }],
  };
}

const edit = {
  benchmark_id: ID,
  statistic: "  41% of stores lose carts  ",
  figure: "41%",
  caveat: "",
  industry_scope: ["ecommerce"],
  market: "CA",
  is_vendor_sourced: true,
};

test("every new action refuses a viewer before any database call", async () => {
  reset("viewer");
  const results = await Promise.all([
    actions.updateBenchmarkProposal(edit),
    actions.rejectBenchmarkProposal({ benchmark_id: ID }),
    actions.addWantedFact({ fact: "a perfectly fine fact", pain_code: "abandoned_cart_loss" }),
    actions.setWantedFactStatus({ wanted_fact_id: ID, status: "dismissed" }),
    actions.setBenchmarkActive({ benchmark_id: ID, is_active: true }),
  ]);
  for (const r of results) assert.deepEqual(r, { ok: false, error: "Viewers cannot change benchmarks." });
  assert.equal(env.calls.length, 0);
  assert.equal(env.rpcs.length, 0);
});

test("editing writes only to an unverified, unrejected proposal of this tenant", async () => {
  reset();
  const res = await actions.updateBenchmarkProposal(edit);
  assert.deepEqual(res, { ok: true });
  const call = env.calls[0]!;
  assert.equal(call.table, "benchmarks");
  for (const f of [`id=${ID}`, `tenant_id=${TENANT}`, "verified_at is null", "rejected_at is null", "wanted_fact_id not null"]) {
    assert.ok(call.filters.includes(f), `missing filter ${f}`);
  }
  assert.equal(call.values?.statistic, "41% of stores lose carts");
  assert.equal(call.values?.caveat, null);
  assert.ok(!("is_active" in (call.values ?? {})), "an edit never activates");
  assert.deepEqual(env.revalidated, ["/benchmarks"]);
});

test("editing or rejecting a proposal already reviewed in another tab reports it and changes nothing", async () => {
  for (const state of [{ verified_at: "2026-10-21T00:00:00Z" }, { rejected_at: "2026-10-21T00:00:00Z" }, { wanted_fact_id: null }]) {
    reset();
    Object.assign(env.tables.benchmarks![0]!, state);
    const before = JSON.stringify(env.tables.benchmarks);
    const e = await actions.updateBenchmarkProposal(edit);
    const r = await actions.rejectBenchmarkProposal({ benchmark_id: ID });
    assert.equal(e.ok, false);
    assert.match(e.ok ? "" : e.error, /already reviewed/i);
    assert.equal(r.ok, false);
    assert.match(r.ok ? "" : r.error, /already reviewed/i);
    assert.equal(JSON.stringify(env.tables.benchmarks), before);
  }
});

test("an empty figure is refused before the database", async () => {
  reset();
  const res = await actions.updateBenchmarkProposal({ ...edit, figure: "   " });
  assert.equal(res.ok, false);
  assert.equal(env.calls.length, 0);
});

test("rejecting sets rejected_at, keeps the row and never activates it", async () => {
  reset();
  const res = await actions.rejectBenchmarkProposal({ benchmark_id: ID });
  assert.deepEqual(res, { ok: true });
  const row = env.tables.benchmarks![0]!;
  assert.ok(typeof row.rejected_at === "string");
  assert.equal(row.is_active, false);
  assert.equal(env.calls[0]!.op, "update");
});

test("activating stamps the approver; a rejected row is refused in words", async () => {
  reset();
  assert.deepEqual(await actions.setBenchmarkActive({ benchmark_id: ID, is_active: true }), { ok: true });
  const row = env.tables.benchmarks![0]!;
  assert.equal(row.is_active, true);
  assert.equal(row.verified_by, "user-1");
  assert.ok(typeof row.verified_at === "string");

  reset();
  env.tables.benchmarks![0]!.rejected_at = "2026-10-21T00:00:00Z";
  const res = await actions.setBenchmarkActive({ benchmark_id: ID, is_active: true });
  assert.equal(res.ok, false);
  assert.match(res.ok ? "" : res.error, /rejected/i);
  assert.equal(env.tables.benchmarks![0]!.is_active, false);
  assert.ok(!env.calls.some((c) => c.op === "update"), "no write attempted");
});

test("a reject from another tab between the check and the approve is not approved", async () => {
  reset();
  env.tables.benchmarks![0]!.rejected_at = null;
  env.afterBenchmarkRead = () => {
    env.tables.benchmarks![0]!.rejected_at = "2026-10-21T00:00:00Z";
  };
  const res = await actions.setBenchmarkActive({ benchmark_id: ID, is_active: true });
  assert.equal(res.ok, false);
  assert.match(res.ok ? "" : res.error, /already reviewed/i);
  assert.equal(env.tables.benchmarks![0]!.is_active, false);
  assert.equal(env.tables.benchmarks![0]!.verified_at, null);
});

const OTHER = "00000000-0000-4000-8000-0000000000bb";
const withFact = (status: string, others: Row[]) => {
  reset();
  env.tables.wanted_facts = [{ id: "wf1", tenant_id: TENANT, status }];
  env.tables.benchmarks!.push(...others);
};

test("rejecting the last live proposal reopens its proposed fact", async () => {
  withFact("proposed", [{ id: OTHER, tenant_id: TENANT, wanted_fact_id: "wf1", verified_at: null, rejected_at: "2026-10-01T00:00:00Z", is_active: false }]);
  assert.deepEqual(await actions.rejectBenchmarkProposal({ benchmark_id: ID }), { ok: true });
  assert.equal(env.tables.wanted_facts![0]!.status, "open");
  const w = env.calls.find((c) => c.table === "wanted_facts")!;
  for (const f of [`tenant_id=${TENANT}`, "id=wf1", "status=proposed"]) assert.ok(w.filters.includes(f), f);
});

test("rejecting one of two proposals leaves the fact proposed (pending or approved sibling)", async () => {
  for (const sibling of [{ verified_at: null }, { verified_at: "2026-10-20T00:00:00Z", is_active: true }]) {
    withFact("proposed", [{ id: OTHER, tenant_id: TENANT, wanted_fact_id: "wf1", rejected_at: null, is_active: false, ...sibling }]);
    assert.deepEqual(await actions.rejectBenchmarkProposal({ benchmark_id: ID }), { ok: true });
    assert.equal(env.tables.wanted_facts![0]!.status, "proposed");
  }
});

test("rejecting the last proposal of a dismissed fact leaves it dismissed", async () => {
  withFact("dismissed", []);
  assert.deepEqual(await actions.rejectBenchmarkProposal({ benchmark_id: ID }), { ok: true });
  assert.equal(env.tables.wanted_facts![0]!.status, "dismissed");
});

test("deactivating leaves verified_by / verified_at alone", async () => {
  reset();
  Object.assign(env.tables.benchmarks![0]!, { is_active: true, verified_by: "u", verified_at: "t" });
  await actions.setBenchmarkActive({ benchmark_id: ID, is_active: false });
  const row = env.tables.benchmarks![0]!;
  assert.equal(row.is_active, false);
  assert.equal(row.verified_by, "u");
  assert.equal(row.verified_at, "t");
});

test("only setBenchmarkActive ever sets is_active true", async () => {
  reset();
  await actions.updateBenchmarkProposal(edit);
  await actions.rejectBenchmarkProposal({ benchmark_id: ID });
  await actions.setWantedFactStatus({ wanted_fact_id: ID, status: "open" });
  for (const c of env.calls) assert.notEqual(c.values?.is_active, true);
});

test("addWantedFact calls the RPC as 'manual' with the session tenant", async () => {
  reset();
  const res = await actions.addWantedFact({ fact: "  share of stores with no cart email  ", pain_code: "abandoned_cart_loss" });
  assert.deepEqual(res, { ok: true });
  assert.deepEqual(env.rpcs, [
    {
      fn: "record_wanted_fact",
      args: {
        p_tenant_id: TENANT,
        p_fact: "share of stores with no cart email",
        p_source: "manual",
        p_pain_code: "abandoned_cart_loss",
      },
    },
  ]);
});

test("a database length error on a 5-character fact becomes a readable form error", async () => {
  reset();
  env.rpcError = { message: 'new row for relation "wanted_facts" violates check constraint "wanted_facts_fact_check"' };
  const res = await actions.addWantedFact({ fact: "short", pain_code: "abandoned_cart_loss" });
  assert.equal(res.ok, false);
  assert.equal(res.ok ? "" : res.error, "A fact needs 8 to 300 characters. Describe it in a full phrase.");
});

test("dismiss and look-again carry their allowed from-states and tenant in the WHERE", async () => {
  reset();
  await actions.setWantedFactStatus({ wanted_fact_id: ID, status: "dismissed" });
  assert.ok(env.calls[0]!.filters.includes("status in open|proposed|no_source"));
  assert.ok(env.calls[0]!.filters.includes(`tenant_id=${TENANT}`));
  assert.equal(env.tables.wanted_facts![0]!.status, "dismissed");

  env.calls = [];
  assert.deepEqual(await actions.setWantedFactStatus({ wanted_fact_id: ID, status: "open" }), { ok: true });
  assert.ok(env.calls[0]!.filters.includes("status in dismissed|no_source"));

  // Already open: "Look again" finds nothing to change and says so.
  const again = await actions.setWantedFactStatus({ wanted_fact_id: ID, status: "open" });
  assert.equal(again.ok, false);
});

test("the library list leaves out pending proposals and rejected rows, nothing else", () => {
  const mk = (id: string) => ({ id }) as never;
  const kept = leaveOutReviewQueue([mk("a"), mk("b"), mk("c"), mk("d")], [{ id: "b" }], [{ id: "d" }]);
  assert.deepEqual(kept.map((k) => k.id), ["a", "c"]);
});

test("wanted facts sort open, proposed, no_source, dismissed, then most-asked first", () => {
  const f = (id: string, status: WantedFactRow["status"], request_count: number) => ({ id, status, request_count }) as WantedFactRow;
  const sorted = sortWantedFacts([f("d", "dismissed", 9), f("n", "no_source", 5), f("o1", "open", 1), f("p", "proposed", 3), f("o2", "open", 4)]);
  assert.deepEqual(sorted.map((x) => x.id), ["o2", "o1", "p", "n", "d"]);
});

test("batch 7 audit: a wanted fact needs a pain (statistics are offered by pain), refused before any database call", async () => {
  reset();
  const res = await actions.addWantedFact({ fact: "how many stores have no cart recovery", pain_code: "" });
  assert.equal(res.ok, false);
  assert.equal(res.ok ? "" : res.error, "Pick the problem this fact is about.");
  assert.equal(env.rpcs.length, 0);
});

test("batch 7 audit: proposal market accepts only CA, MX, GLOBAL or empty (case-folded); US is refused in words", async () => {
  reset();
  const us = await actions.updateBenchmarkProposal({ ...edit, market: "US" });
  assert.equal(us.ok, false);
  assert.match(us.ok ? "" : us.error, /For US data use GLOBAL/);
  assert.equal(env.calls.length, 0);
  reset();
  await actions.updateBenchmarkProposal({ ...edit, market: "ca" });
  const write = env.calls.find((c) => c.op === "update");
  assert.equal((write?.values as { market?: string } | undefined)?.market, "CA");
});
