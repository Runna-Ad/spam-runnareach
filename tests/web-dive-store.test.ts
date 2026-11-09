/**
 * web-dive store and migration 0055: webFactsFor (60-day limit, failed rows
 * ignored, bad entries dropped, never throws), webLookState, the route's
 * claim / save / release / count / spend reads, and the migration's shape. The
 * fake database rejects any column the migrations do not create.
 */

import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import test from "node:test";
import { DO_NOT_SEND_STATUSES } from "../lib/prospects/status.ts";
import { CRON_JOBS, cronsOf } from "../lib/reports/heartbeat.ts";
import { scheduledRuns } from "../lib/reports/health.ts";
import type { DiveOutcome } from "../lib/research/web-dive/dive.ts";
import {
  claimWebResearch,
  divesStartedSince,
  lookStateFrom,
  releaseWebResearch,
  saveWebResearch,
  spentLast24h,
  webFactsFor,
  webLookState,
  webLookStates,
  webResearchRow,
  type WebDiveDb,
  type WebResearchDb,
} from "../lib/research/web-dive/store.ts";

const sql = readFileSync(new URL("../supabase/migrations/0055_web_research.sql", import.meta.url), "utf8");
const code = sql.replace(/--.*$/gm, "");
const NOW = new Date("2026-11-10T16:00:00Z");
const daysAgo = (d: number) => new Date(NOW.getTime() - d * 86_400_000).toISOString();
const minsAgo = (m: number) => new Date(NOW.getTime() - m * 60_000).toISOString();

// ── Schema: columns as the migrations create them ───────────────────────────

const SCHEMA: Record<string, Set<string>> = (() => {
  const out: Record<string, Set<string>> = {};
  const dir = new URL("../supabase/migrations/", import.meta.url);
  for (const f of readdirSync(dir).filter((x) => x.endsWith(".sql")).sort()) {
    const text = readFileSync(new URL(f, dir), "utf8");
    for (const [, table, body] of text.matchAll(/create table (?:if not exists )?(?:public\.)?(\w+) \(([\s\S]*?)\n\);/gi)) {
      const cols = out[table!.toLowerCase()] ?? new Set<string>();
      for (const l of body!.split("\n")) {
        const c = l.trim().match(/^([a-z_][a-z0-9_]*)\s/i)?.[1]?.toLowerCase();
        if (c && !["primary", "unique", "constraint", "foreign", "check"].includes(c)) cols.add(c);
      }
      out[table!.toLowerCase()] = cols;
    }
  }
  return out;
})();

type Row = Record<string, unknown>;
type Res = { data: unknown; error: { message: string } | null; count?: number | null };

/** A query builder over in-memory rows, filtering the way Postgres would; unknown columns fail the test. */
function fakeDb(tables: Record<string, Row[]>, o: { fail?: Record<string, { message: string }>; throwOn?: string; rpc?: (fn: string, args: Row) => Res } = {}) {
  const calls: Array<{ table: string; op: string; cols?: string; values?: Row }> = [];
  const col = (table: string, k: string) => {
    const known = SCHEMA[table];
    assert.ok(known, `no table ${table} in the migrations`);
    assert.ok(known.has(k), `${table} has no column ${k}`);
  };
  const builder = (table: string, op: "select" | "update" | "delete", values: Row = {}) => {
    const filters: Array<(r: Row) => boolean> = [];
    let orderBy: { k: string; asc: boolean } | null = null;
    let lim: number | null = null;
    let range: [number, number] | null = null;
    let cols: string | null = null;
    let count = false;
    let head = false;
    let returning = false;
    for (const k of Object.keys(values)) col(table, k);
    const run = (): Res => {
      if (o.throwOn === table) throw new Error("network down");
      const err = o.fail?.[table];
      if (err) return { data: null, error: err };
      const rows = (tables[table] ??= []);
      let hit = rows.filter((r) => filters.every((f) => f(r)));
      if (op === "update") {
        for (const r of hit) Object.assign(r, values);
        return { data: returning ? hit.map((r) => ({ id: r.id })) : null, error: null };
      }
      if (op === "delete") {
        for (const r of hit) rows.splice(rows.indexOf(r), 1);
        return { data: null, error: null };
      }
      if (orderBy) {
        const { k, asc } = orderBy;
        hit = [...hit].sort((a, b) => (asc ? 1 : -1) * String(a[k]).localeCompare(String(b[k])));
      }
      const total = hit.length;
      if (range) hit = hit.slice(range[0], range[1] + 1);
      if (lim !== null) hit = hit.slice(0, lim);
      const pick = (r: Row) => (cols ? Object.fromEntries(cols.split(",").map((c) => c.trim()).map((c) => [c, r[c]])) : r);
      return { data: head ? null : hit.map(pick), error: null, count: count ? total : null };
    };
    const b = {
      select(c: string, opts?: { count?: "exact"; head?: boolean }) {
        if (op !== "select") returning = true;
        else {
          cols = c;
          for (const k of c.split(",").map((x) => x.trim())) col(table, k);
        }
        if (opts?.count) count = true;
        if (opts?.head) head = true;
        calls.push({ table, op, cols: c, values });
        return b;
      },
      eq(k: string, v: string) { col(table, k); filters.push((r) => r[k] === v); return b; },
      neq(k: string, v: string) { col(table, k); filters.push((r) => r[k] !== v); return b; },
      in(k: string, v: readonly string[]) { col(table, k); filters.push((r) => v.includes(r[k] as string)); return b; },
      gt(k: string, v: string) { col(table, k); filters.push((r) => String(r[k]) > v); return b; },
      gte(k: string, v: string) { col(table, k); filters.push((r) => String(r[k]) >= v); return b; },
      order(k: string, opt: { ascending: boolean }) { col(table, k); orderBy = { k, asc: opt.ascending }; return b; },
      limit(n: number) { lim = n; return b; },
      range(a: number, z: number) { range = [a, z]; return b; },
      abortSignal() { return b; },
      then<A, B>(ok?: ((v: Res) => A | PromiseLike<A>) | null, bad?: ((e: unknown) => B | PromiseLike<B>) | null) {
        return new Promise<Res>((resolve) => resolve(run())).then(ok, bad);
      },
    };
    return b;
  };
  const db = {
    calls,
    from(table: string) {
      return {
        select: (c: string, opts?: { count?: "exact"; head?: boolean }) => builder(table, "select").select(c, opts),
        update: (v: Row) => {
          calls.push({ table, op: "update", values: v });
          return builder(table, "update", v);
        },
        delete: () => {
          calls.push({ table, op: "delete" });
          return builder(table, "delete");
        },
      };
    },
    rpc(fn: string, args: Row) {
      const res = o.rpc ? o.rpc(fn, args) : { data: [], error: null };
      const b = { abortSignal: () => b, then: <A, B>(ok?: ((v: Res) => A) | null, bad?: ((e: unknown) => B) | null) => Promise.resolve(res).then(ok, bad) };
      return b;
    },
  };
  return db;
}

const FACT = { fact: "A reviewer says nobody answered.", quote: "nobody ever answered the phone", url: "https://www.yelp.ca/biz/x", title: "X - Yelp", kind: "problem" };
const row = (over: Row): Row => ({
  id: `w-${Math.random()}`, tenant_id: "t1", prospect_id: "p1", status: "ok", facts: [], searches: 4, cost_usd: 0.21,
  model: "m", error: null, dropped: [], started_at: daysAgo(1), finished_at: daysAgo(1), ...over,
});
const readDb = (rows: Row[], o: Parameters<typeof fakeDb>[1] = {}) => fakeDb({ web_research: rows }, o) as unknown as WebResearchDb;

// ── webFactsFor ──────────────────────────────────────────────────────────────

test("webFactsFor: the newest ok row's facts, re-validated; bad entries dropped", async () => {
  const facts = await webFactsFor(readDb([row({ facts: [FACT, { fact: "x", kind: "news" }, null, { ...FACT, quote: "short" }] })]), "t1", "p1", NOW);
  assert.deepEqual(facts, [FACT]);
});

test("webFactsFor: older than 60 days is not read; a newer empty row wins over an older ok one", async () => {
  assert.deepEqual(await webFactsFor(readDb([row({ facts: [FACT], started_at: daysAgo(61) })]), "t1", "p1", NOW), []);
  assert.deepEqual(await webFactsFor(readDb([row({ facts: [FACT], started_at: daysAgo(59) })]), "t1", "p1", NOW), [FACT]);
  const rows = [row({ facts: [FACT], started_at: daysAgo(10) }), row({ status: "empty", facts: [], started_at: daysAgo(2) })];
  assert.deepEqual(await webFactsFor(readDb(rows), "t1", "p1", NOW), []);
});

test("webFactsFor: failed, abandoned and pending rows are ignored, another tenant's or prospect's never read", async () => {
  const rows = [
    row({ facts: [FACT], started_at: daysAgo(10) }),
    row({ status: "failed", facts: [{ ...FACT, fact: "failed row" }], started_at: daysAgo(1) }),
    row({ status: "abandoned", started_at: daysAgo(1) }),
    row({ status: "pending", started_at: minsAgo(1) }),
    row({ tenant_id: "t2", facts: [{ ...FACT, fact: "other tenant" }], started_at: minsAgo(5) }),
    row({ prospect_id: "p2", facts: [{ ...FACT, fact: "other prospect" }], started_at: minsAgo(5) }),
  ];
  assert.deepEqual(await webFactsFor(readDb(rows), "t1", "p1", NOW), [FACT]);
});

test("webFactsFor never throws: an empty-message error or a throw is []", async () => {
  assert.deepEqual(await webFactsFor(readDb([row({ facts: [FACT] })], { fail: { web_research: { message: "" } } }), "t1", "p1", NOW), []);
  assert.deepEqual(await webFactsFor(readDb([row({ facts: [FACT] })], { throwOn: "web_research" }), "t1", "p1", NOW), []);
  assert.deepEqual(await webFactsFor(readDb([]), "t1", "p1", NOW), []);
});

// ── webLookState ─────────────────────────────────────────────────────────────

test("lookStateFrom: done on ok or empty in 60 days; gave_up on 2 failures without one; else waiting", () => {
  const r = (status: string, started_at: string) => ({ status, started_at });
  assert.equal(lookStateFrom([], NOW), "waiting");
  assert.equal(lookStateFrom([r("ok", daysAgo(3))], NOW), "done");
  assert.equal(lookStateFrom([r("empty", daysAgo(59))], NOW), "done");
  assert.equal(lookStateFrom([r("empty", daysAgo(61))], NOW), "waiting");
  assert.equal(lookStateFrom([r("failed", daysAgo(1))], NOW), "waiting");
  assert.equal(lookStateFrom([r("failed", daysAgo(1)), r("abandoned", daysAgo(2))], NOW), "gave_up");
  assert.equal(lookStateFrom([r("failed", daysAgo(1)), r("failed", daysAgo(61))], NOW), "waiting");
  assert.equal(lookStateFrom([r("failed", daysAgo(1)), r("failed", daysAgo(2)), r("ok", daysAgo(3))], NOW), "done");
  // A dive running now is waiting; one killed (pending past 10 minutes) counts as abandoned.
  assert.equal(lookStateFrom([r("failed", daysAgo(1)), r("pending", minsAgo(2))], NOW), "waiting");
  assert.equal(lookStateFrom([r("failed", daysAgo(1)), r("pending", minsAgo(11))], NOW), "gave_up");
});

test("webLookState / webLookStates: per prospect, and a read error is waiting (never done)", async () => {
  const rows = [row({ status: "ok" }), row({ prospect_id: "p2", status: "failed" }), row({ prospect_id: "p2", status: "failed", started_at: daysAgo(2) })];
  assert.equal(await webLookState(readDb(rows), "t1", "p1", NOW), "done");
  assert.equal(await webLookState(readDb(rows), "t1", "p2", NOW), "gave_up");
  assert.equal(await webLookState(readDb(rows), "t1", "p3", NOW), "waiting");
  assert.equal(await webLookState(readDb(rows, { fail: { web_research: { message: "" } } }), "t1", "p1", NOW), "waiting");
  const many = await webLookStates(readDb(rows), "t1", ["p1", "p2", "p3"], NOW);
  assert.equal(many.error, null);
  assert.deepEqual([...many.states], [["p1", "done"], ["p2", "gave_up"], ["p3", "waiting"]]);
  const failed = await webLookStates(readDb(rows, { throwOn: "web_research" }), "t1", ["p1"], NOW);
  assert.match(failed.error ?? "", /web_research read failed/);
  assert.equal(failed.states.get("p1"), "waiting");
});

// ── The route's writes ───────────────────────────────────────────────────────

const OUT: DiveOutcome = { status: "ok", facts: [FACT as DiveOutcome["facts"][number]], dropped: [], searches: 4, costUsd: 0.21, model: "m", error: null, searchDisabled: false };

test("claim: the RPC with p_limit; rows mapped; a malformed row skipped; an empty-message error throws", async () => {
  const seen: Array<[string, Row]> = [];
  const good = { id: "w1", tenant_id: "t1", prospect_id: "p1", company_name: "CrushCamp", city: "Calgary", region: "AB", country_code: "CA", domain: "crushcamp.ca", website_url: " ", industry: null };
  const db = fakeDb({}, { rpc: (fn, args) => (seen.push([fn, args]), { data: [good, { id: "w2" }], error: null }) }) as unknown as WebDiveDb;
  const due = await claimWebResearch(db, 1, 5_000);
  assert.deepEqual(seen, [["claim_web_research", { p_limit: 1 }]]);
  assert.deepEqual(due, [{ research_id: "w1", id: "p1", tenant_id: "t1", company_name: "CrushCamp", city: "Calgary", region: "AB", country_code: "CA", domain: "crushcamp.ca", website_url: null, industry: null }]);
  const bad = fakeDb({}, { rpc: () => ({ data: null, error: { message: "" } }) }) as unknown as WebDiveDb;
  await assert.rejects(claimWebResearch(bad, 1, 5_000), /claim_web_research/);
});

test("save: only a row still pending; the columns are the table's; facts only on ok; drops clipped", async () => {
  const rows = [row({ id: "w1", status: "pending", facts: [], finished_at: null })];
  const db = fakeDb({ web_research: rows }) as unknown as WebDiveDb;
  assert.deepEqual(await saveWebResearch(db, "w1", OUT, NOW, 5_000), { ok: true });
  assert.equal(rows[0]!.status, "ok");
  assert.deepEqual(rows[0]!.facts, [FACT]);
  assert.equal(rows[0]!.finished_at, NOW.toISOString());
  // Swept as abandoned meanwhile: not overwritten.
  const swept = [row({ id: "w2", status: "abandoned" })];
  const r = await saveWebResearch(fakeDb({ web_research: swept }) as unknown as WebDiveDb, "w2", OUT, NOW, 5_000);
  assert.equal(r.ok, false);
  assert.equal(swept[0]!.status, "abandoned");
  const many = Array.from({ length: 30 }, () => ({ candidate: { fact: "f".repeat(900), quote: "q", url: "u", kind: "context" }, reason: "name_not_found" as const }));
  const failedRow = webResearchRow({ ...OUT, status: "failed", error: "x", dropped: many }, NOW);
  assert.deepEqual(failedRow.facts, []);
  assert.equal((failedRow.dropped as unknown[]).length, 20);
  assert.equal(((failedRow.dropped as Array<{ candidate: { fact: string } }>)[0]!.candidate.fact).length, 400);
  const err = await saveWebResearch(fakeDb({ web_research: [] }, { fail: { web_research: { message: "" } } }) as unknown as WebDiveDb, "w1", OUT, NOW, 5_000);
  assert.deepEqual(err, { ok: false, error: "empty error" });
});

test("release deletes only our own pending row; the 24h count excludes the claim; spend sums and fails closed", async () => {
  const rows = [row({ id: "w1", status: "pending" }), row({ id: "w2", status: "ok" })];
  const db = fakeDb({ web_research: rows, cost_tracking: [] }) as unknown as WebDiveDb;
  await releaseWebResearch(db, "w2", 5_000);
  assert.equal(rows.length, 2, "a finished row is never released");
  await releaseWebResearch(db, "w1", 5_000);
  assert.deepEqual(rows.map((r) => r.id), ["w2"]);

  const recent = [row({ id: "a", started_at: minsAgo(30) }), row({ id: "b", started_at: minsAgo(60), status: "failed" }), row({ id: "c", started_at: daysAgo(2) }), row({ id: "d", tenant_id: "t2", started_at: minsAgo(5) })];
  const counted = await divesStartedSince(fakeDb({ web_research: recent }) as unknown as WebDiveDb, "t1", new Date(NOW.getTime() - 86_400_000), "a", 5_000);
  assert.deepEqual(counted, { count: 1 });

  const cost = (usd: number, at: string, over: Row = {}) => ({ id: `c${Math.random()}`, tenant_id: "t1", category: "anthropic", sub_category: "m", entity_type: "pitch", entity_id: null, cost_usd: usd, metadata: {}, incurred_at: at, ...over });
  const costs = [cost(1.2, minsAgo(10)), cost(0.3, minsAgo(100)), cost(9, daysAgo(2)), cost(5, minsAgo(10), { tenant_id: "t2" }), cost(4, minsAgo(10), { category: "google_places" })];
  const spent = await spentLast24h(fakeDb({ cost_tracking: costs }) as unknown as WebDiveDb, "t1", NOW, 5_000);
  assert.ok("usd" in spent && Math.abs(spent.usd - 1.5) < 1e-9, JSON.stringify(spent));
  const err = await spentLast24h(fakeDb({ cost_tracking: costs }, { fail: { cost_tracking: { message: "" } } }) as unknown as WebDiveDb, "t1", NOW, 5_000);
  assert.ok("error" in err);
  const thrown = await spentLast24h(fakeDb({ cost_tracking: costs }, { throwOn: "cost_tracking" }) as unknown as WebDiveDb, "t1", NOW, 5_000);
  assert.ok("error" in thrown);
});

// ── Migration 0055 ───────────────────────────────────────────────────────────

test("0055: table with RLS on, tenant read-only policy, claim function service-role only, indexes", () => {
  assert.match(code, /alter table public\.web_research enable row level security/);
  assert.match(code, /create policy web_research_tenant_read on public\.web_research\s+for select/);
  assert.doesNotMatch(code, /create policy[^;]*for (all|insert|update|delete)\b/);
  assert.match(code, /revoke all on function public\.claim_web_research\(integer\) from public, anon, authenticated/);
  assert.match(code, /grant execute on function public\.claim_web_research\(integer\) to service_role/);
  assert.match(code, /idx_web_research_latest\s+on public\.web_research \(tenant_id, prospect_id, started_at desc\)/);
  assert.match(code, /unique index if not exists web_research_one_pending\s+on public\.web_research \(prospect_id\) where status = 'pending'/);
  for (const c of ["id", "tenant_id", "prospect_id", "status", "facts", "searches", "cost_usd", "model", "error", "dropped", "started_at", "finished_at"]) {
    assert.ok(SCHEMA.web_research?.has(c), c);
  }
});

test("0055: the status list is the dive's outcomes plus pending and abandoned", () => {
  const statuses = /check \(status in \(([^)]*)\)\)/.exec(code)?.[1]?.replace(/'|\s/g, "").split(",") ?? [];
  const outcomes: DiveOutcome["status"][] = ["ok", "empty", "failed"];
  assert.deepEqual(statuses, ["pending", ...outcomes, "abandoned"]);
});

test("0055 claim: match + gate passed, never a do-not-send status, 60-day cache, 2 tries, a later run, no pitch, sweep first", () => {
  const listed = /p\.status not in \(([^)]*)\)/.exec(code)?.[1]?.split(",").map((s) => s.trim().replace(/'/g, "")) ?? [];
  assert.deepEqual(listed.sort(), [...DO_NOT_SEND_STATUSES].sort());
  assert.match(code, /p\.status = 'match'/);
  assert.match(code, /p\.pitch_gate_passed = true/);
  assert.match(code, /w\.status in \('ok', 'empty'\)\s+and w\.started_at > now\(\) - interval '60 days'/);
  assert.match(code, /w\.status in \('failed', 'abandoned'\)\s+and w\.started_at > now\(\) - interval '60 days'\) < 2/);
  assert.match(code, /w\.started_at > now\(\) - interval '10 minutes'/);
  assert.match(code, /from public\.pitches pi\s+where pi\.tenant_id = p\.tenant_id\s+and pi\.prospect_id = p\.id/);
  assert.match(code, /order by p\.updated_at asc/);
  assert.match(code, /for update of p skip locked/);
  assert.ok(code.indexOf("set status = 'abandoned'") < code.indexOf("return query"), "sweep at the START of a run");
  assert.match(code, /w\.status = 'pending'\s+and w\.started_at < now\(\) - interval '10 minutes'/);
});

test("0055: the schedule is the one CRON_JOBS watches, 160 runs a week on minutes no other job uses; header states order, rollback, CPU", () => {
  assert.deepEqual(CRON_JOBS["web-dive"], {
    route: "/api/research/web-dive",
    schedules: [{ pgJob: "spam-web-dive", cron: "3,18,33,48 15-22 * * 1-5", migration: "0055" }],
  });
  assert.match(code, /cron\.schedule\('spam-web-dive', '3,18,33,48 15-22 \* \* 1-5', \$job\$select public\.spam_cron_call\('\/api\/research\/web-dive'\)\$job\$\)/);
  const t = (iso: string) => new Date(iso).getTime();
  assert.equal(scheduledRuns(cronsOf("web-dive"), t("2026-11-01T23:59:00Z"), t("2026-11-08T23:59:00Z"), 1000), 160);
  // No other scheduled job runs on the same minute.
  const others = (Object.keys(CRON_JOBS) as Array<keyof typeof CRON_JOBS>).filter((j) => j !== "web-dive").flatMap((j) => cronsOf(j));
  for (let m = t("2026-11-02T15:00:00Z"); m < t("2026-11-02T23:00:00Z"); m += 60_000) {
    if (scheduledRuns(cronsOf("web-dive"), m - 60_000, m, 1) === 1) assert.equal(scheduledRuns(others, m - 60_000, m, 1), 0, new Date(m).toISOString());
  }
  assert.match(sql, /Before: 0 calls\. After: 160 calls a week/);
  assert.match(sql, /SHIP ORDER: deploy the code FIRST/);
  assert.match(sql, /ROLLBACK: select cron\.unschedule\('spam-web-dive'\);/);
  assert.doesNotMatch(code, /unschedule|drop |delete from/i);
});

test("route: one heartbeat per authorized run, nothing between the 401 and the wrapped run; WEB_DIVE_MODEL with the default", () => {
  const src = readFileSync(new URL("../app/api/research/web-dive/route.ts", import.meta.url), "utf8");
  assert.equal((src.match(/withHeartbeat\(/g) ?? []).length, 1);
  const unauthorized = src.indexOf("{ status: 401 }");
  const call = src.indexOf('return withHeartbeat("web-dive", () => ');
  assert.ok(unauthorized > 0 && call > unauthorized);
  assert.match(src.slice(src.indexOf("\n", unauthorized), call), /^\n\s*\}\n\s*$/);
  assert.equal(`app${CRON_JOBS["web-dive"].route}/route.ts`, "app/api/research/web-dive/route.ts");
  assert.match(src, /process\.env\.WEB_DIVE_MODEL\?\.trim\(\) \|\| ANTHROPIC_DEFAULT_MODEL/);
  assert.match(src, /isSchedulerAuthorized\(req\)/);
});
