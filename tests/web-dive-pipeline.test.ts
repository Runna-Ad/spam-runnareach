/**
 * web-dive, the pipeline side: a prospect that passes every gate is no longer
 * drafted by the pipeline; it goes to `match` (gate passed) with an audit row
 * { kind: waiting_for_looks }, and the discovery job keeps counting it right:
 * pitch-ready (stats.pitched, the tick's pitch yield), never an error, in the
 * ICP's pitched pool, and never drafted by the job's pitching catch-up.
 *
 * Drives the real processSingleProspectWith and the /api/discover/run slice
 * against a fake Supabase client; their other value imports are stubbed by a
 * loader hook, except lib/prospects/status.ts, lib/research/web-dive/looks.ts
 * and zod.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { register } from "node:module";
import test from "node:test";
import { WAITING_FOR_LOOKS } from "../lib/research/web-dive/looks.ts";

const STAGE_URL = new URL("../lib/discover/pipeline-stage.ts", import.meta.url);
const ROUTE_URL = new URL("../app/api/discover/run/route.ts", import.meta.url);
const REAL: Record<string, string> = {
  "@/lib/prospects/status": new URL("../lib/prospects/status.ts", import.meta.url).href,
  "@/lib/research/web-dive/looks": new URL("../lib/research/web-dive/looks.ts", import.meta.url).href,
};
const stubNames = (url: URL) => [
  ...new Set(
    [...readFileSync(url, "utf8").matchAll(/^import \{([^}]*)\} from "([^"]+)";/gm)]
      .filter(([, , from]) => !(from! in REAL) && from !== "zod")
      .flatMap(([, names]) => names!.split(",").map((n) => n.trim()))
      .filter((n) => n && !n.startsWith("type ")),
  ),
];
const TARGETS = { [STAGE_URL.href]: stubNames(STAGE_URL), [ROUTE_URL.href]: stubNames(ROUTE_URL) };

const hooks = `
const REAL = ${JSON.stringify(REAL)};
const TARGETS = ${JSON.stringify(TARGETS)};
export async function resolve(spec, ctx, next) {
  if (ctx.parentURL in TARGETS && spec !== "zod") {
    if (REAL[spec]) return { url: REAL[spec], shortCircuit: true };
    return { url: "stub:" + ctx.parentURL, shortCircuit: true };
  }
  return next(spec, ctx);
}
export async function load(url, ctx, next) {
  if (!url.startsWith("stub:")) return next(url, ctx);
  const names = TARGETS[url.slice(5)];
  const src = names.map((n) => "export const " + n + " = new Proxy(function () {}, { apply: (_t, _s, a) => globalThis.__wdStubs." + n + "(...a), get: (_t, k) => globalThis.__wdStubs." + n + "[k] });").join("\\n");
  return { format: "module", source: src, shortCircuit: true };
}`;
register("data:text/javascript," + encodeURIComponent(hooks));

type Row = Record<string, unknown>;
type Result = { data: unknown; error: { message: string } | null; count?: number };
type Db = { tables: Record<string, Row[]> };

class Query implements PromiseLike<Result> {
  private op: "select" | "update" | "insert" | "delete" = "select";
  private values: Row = {};
  private returning = false;
  private single = false;
  private head = false;
  private filters: ((r: Row) => boolean)[] = [];
  private db: Db;
  private table: string;
  constructor(db: Db, table: string) { this.db = db; this.table = table; }
  select(_c?: string, o?: { head?: boolean }) {
    if (this.op !== "select") this.returning = true;
    if (o?.head) this.head = true;
    return this;
  }
  update(v: Row) { this.op = "update"; this.values = v; return this; }
  insert(v: Row) { this.op = "insert"; this.values = v; return this; }
  delete() { this.op = "delete"; return this; }
  eq(k: string, v: unknown) { this.filters.push((r) => r[k] === v); return this; }
  gte(k: string, v: number) { this.filters.push((r) => Number(r[k]) >= v); return this; }
  in(k: string, v: unknown[]) { this.filters.push((r) => v.includes(r[k])); return this; }
  not(k: string, op: string, v: unknown) {
    if (op === "is") this.filters.push((r) => r[k] !== v);
    else {
      const set = new Set(String(v).replace(/[()]/g, "").split(","));
      this.filters.push((r) => !set.has(String(r[k])));
    }
    return this;
  }
  or(expr: string) {
    const m = /^(\w+)\.is\.null,\1\.lt\.(\d+)$/.exec(expr);
    if (!m) throw new Error(`fake .or: unsupported ${expr}`);
    this.filters.push((r) => r[m[1]!] == null || Number(r[m[1]!]) < Number(m[2]));
    return this;
  }
  order() { return this; }
  limit() { return this; }
  returns() { return this; }
  maybeSingle() { this.single = true; return this; }
  then<A = Result, B = never>(ok?: ((v: Result) => A | PromiseLike<A>) | null, bad?: ((e: unknown) => B | PromiseLike<B>) | null): PromiseLike<A | B> {
    return Promise.resolve(this.run()).then(ok, bad);
  }
  private run(): Result {
    const rows = (this.db.tables[this.table] ??= []);
    if (this.op === "insert") { rows.push({ ...this.values }); return { data: null, error: null }; }
    const hit = rows.filter((r) => this.filters.every((f) => f(r)));
    if (this.op === "select") {
      const out = hit.map((r) => ({ ...r }));
      if (this.head) return { data: null, error: null, count: out.length };
      return { data: this.single ? (out[0] ?? null) : out, error: null };
    }
    if (this.op === "delete") for (const r of hit) rows.splice(rows.indexOf(r), 1);
    else for (const r of hit) Object.assign(r, this.values);
    const out = this.returning ? hit.map((r) => ({ ...r })) : null;
    return { data: this.single ? (out?.[0] ?? null) : out, error: null };
  }
}

function stub(impl: Record<string, unknown>, calls: string[]) {
  (globalThis as Record<string, unknown>).__wdStubs = new Proxy(impl, {
    get(t, name: string) {
      const f = t[name];
      if (!f) throw new Error(`no stub for ${name}`);
      if (typeof f !== "function") return f;
      return (...a: unknown[]) => { calls.push(name); return f(...a); };
    },
  });
}

const USER = { id: "u1", tenantId: "t1", role: "admin" };

// ── The pipeline ─────────────────────────────────────────────────────────────

async function pipeline(o: { parkAs?: string } = {}) {
  const calls: string[] = [];
  const audits: Row[] = [];
  const scores = [30, 85];
  stub({
    revalidatePath: () => undefined,
    writeAuditLog: async (a: Row) => void audits.push(a),
    isRoleBasedEmail: () => false,
    hasUsableEmail: (e: unknown) => typeof e === "string" && e.includes("@"),
    normalizeDomain: (d: unknown) => d,
    googlePlacesIsAvailable: () => false,
    searchBrave: async () => ({ ok: false }),
    searchGooglePlaces: async () => ({ ok: false }),
    scrapeWebsiteWith: async () => ({ ok: true }),
    scoreProspectWith: async () => ({ ok: true, composite_score: scores.shift() ?? 0 }),
    deepResearchProspectWith: async () => ({ ok: true }),
    runStructuredResearchWith: async () => ({ ok: true }),
    snapVerifyEnrich: async () => ({ found: false }),
    enrichContactsForProspect: async () => undefined,
    generateWebsitePitchWith: async () => ({ ok: true }),
  }, calls);
  const row: Row = { id: "p1", tenant_id: "t1", company_name: "CrushCamp", status: "raw", domain: "crushcamp.ca", website_url: "https://crushcamp.ca", icp_id: "icp1", city: "Calgary", country_code: "CA", red_flags: [], pitch_gate_passed: false };
  let reads = 0;
  const db: Db = { tables: { prospects: [row], prospect_contacts: [{ prospect_id: "p1", tenant_id: "t1", email: "ana@crushcamp.ca" }], prospect_research: [] } };
  const supabase = {
    from: (t: string) => {
      const q = new Query(db, t);
      // A person parks it right after the pipeline's first read.
      if (t === "prospects" && o.parkAs && reads++ === 1) row.status = o.parkAs;
      return q;
    },
  };
  const { processSingleProspectWith } = await import(STAGE_URL.href);
  const result = await processSingleProspectWith({ supabase, user: USER }, "p1");
  return { result, row, audits, calls };
}

test("pipeline: ≥ 70 with a contact → status match, gate passed, outcome match, an audit row waiting_for_looks; no draft", async () => {
  const { result, row, audits, calls } = await pipeline();
  assert.equal(result.outcome, "match");
  assert.equal(result.score, 85);
  assert.equal(row.status, "match");
  assert.equal(row.pitch_gate_passed, true);
  const waiting = audits.filter((a) => (a.metadata as Row | undefined)?.kind === WAITING_FOR_LOOKS);
  assert.equal(waiting.length, 1);
  assert.deepEqual(waiting[0], { tenantId: "t1", actorId: "u1", action: "prospect.scored", entityType: "prospect", entityId: "p1", metadata: { kind: "waiting_for_looks", score: 85, source: "pipeline" } });
  assert.ok(!calls.includes("generatePitchWith"));
  const src = readFileSync(STAGE_URL, "utf8");
  assert.doesNotMatch(src, /generatePitchWith/, "the pipeline no longer imports the first-email writer");
  assert.match(src, /import \{ WAITING_FOR_LOOKS \} from "@\/lib\/research\/web-dive\/looks";/);
});

test("pipeline: parked during the run → stays parked, counted suppressed, no waiting_for_looks row", async () => {
  const { result, row, audits } = await pipeline({ parkAs: "booked" });
  assert.equal(row.status, "booked");
  assert.equal(result.outcome, "suppressed");
  assert.equal(audits.filter((a) => (a.metadata as Row | undefined)?.kind === WAITING_FOR_LOOKS).length, 0);
});

// ── The shared last step (pipeline and the job's catch-up) ───────────────────

async function shared(rows: Row[], contacts: Row[], o: { failContacts?: boolean } = {}) {
  const calls: string[] = [];
  const audits: Row[] = [];
  stub({
    writeAuditLog: async (a: Row) => void audits.push(a),
    hasUsableEmail: (e: unknown) => typeof e === "string" && e.includes("@") && !e.startsWith("noreply"),
  }, calls);
  const db: Db = { tables: { prospects: rows, prospect_contacts: contacts } };
  const supabase = {
    from: (t: string) => {
      if (t === "prospect_contacts" && o.failContacts) {
        const fail = { select: () => fail, eq: () => fail, not: () => fail, returns: () => Promise.resolve({ data: null, error: { message: "" } }) };
        return fail;
      }
      return new Query(db, t);
    },
  };
  const mod = (await import(STAGE_URL.href)) as {
    enterMatchWith: (a: unknown, id: string, score: number | null, source: string) => Promise<{ moved: boolean; error?: string }>;
    usableContactsWith: (a: unknown, id: string) => Promise<{ usable: number; total: number; error: string | null }>;
  };
  return { mod, actor: { supabase, user: USER }, audits, calls };
}

test("usableContactsWith: the pipeline's usable-email rule; a read error is reported (presence), never 'no contacts'", async () => {
  const contacts = [
    { prospect_id: "p1", tenant_id: "t1", email: "ana@crushcamp.ca" },
    { prospect_id: "p1", tenant_id: "t1", email: "noreply@crushcamp.ca" },
    { prospect_id: "p1", tenant_id: "t1", email: null },
    { prospect_id: "p1", tenant_id: "t2", email: "other@tenant.ca" },
  ];
  const ok = await shared([], contacts);
  assert.deepEqual(await ok.mod.usableContactsWith(ok.actor, "p1"), { usable: 1, total: 2, error: null });
  const failed = await shared([], contacts, { failContacts: true });
  assert.deepEqual(await failed.mod.usableContactsWith(failed.actor, "p1"), { usable: 0, total: 0, error: "no message" });
});

test("enterMatchWith: match + gate passed through the guarded write, the waiting_for_looks row only when it moved", async () => {
  const row: Row = { id: "p1", tenant_id: "t1", status: "researched", pitch_gate_passed: false };
  const s = await shared([row], []);
  assert.deepEqual(await s.mod.enterMatchWith(s.actor, "p1", null, "catch_up"), { moved: true });
  assert.equal(row.status, "match");
  assert.equal(row.pitch_gate_passed, true);
  assert.deepEqual(s.audits.map((a) => a.metadata), [{ kind: WAITING_FOR_LOOKS, score: null, source: "catch_up" }]);
  // Parked (booked) meanwhile: the status rule refuses the move, no row.
  const parked: Row = { id: "p1", tenant_id: "t1", status: "booked", pitch_gate_passed: false };
  const p = await shared([parked], []);
  assert.deepEqual(await p.mod.enterMatchWith(p.actor, "p1", null, "catch_up"), { moved: false });
  assert.equal(parked.status, "booked");
  assert.deepEqual(p.audits, []);
});

// ── The discovery job ────────────────────────────────────────────────────────

type Run = { leave: string; outcome: string; error?: string; score?: number | null };

async function slice(runs: Record<string, Run>, o: { usable?: Record<string, number> } = {}) {
  const calls: string[] = [];
  const ids = Object.keys(runs);
  const prospects: Row[] = ids.map((id) => ({ id, tenant_id: "t1", icp_id: "icp1", status: "raw", match_score: null }));
  const job: Row = {
    id: "job1", tenant_id: "t1", icp_id: "icp1", status: "running", phase: "pipeline", cursor: 0, prospect_ids: ids,
    stats: { new: 0, dup: 0, errors: [], pitched: 0, website_pitch: 0, needs_review: 0, suppressed: 0, error_count: 0 },
  };
  const db: Db = { tables: { prospects, discovery_jobs: [job], pitches: [] } };
  const supabase = { from: (t: string) => new Query(db, t) };
  const pitchedIds: string[] = [];
  stub({
    systemActorFromRequest: async () => ({ user: USER, supabase, system: true }),
    getCurrentUser: async () => null,
    createClient: async () => supabase,
    NextResponse: { json: (body: unknown) => ({ body }) },
    after: () => undefined,
    triggerNextSlice: async () => undefined,
    isUnderDailyCap: async () => ({ under: true, spent_today_usd: 0, cap_usd: 5 }),
    affordableProspects: () => 100,
    getRawProspectIdsWith: async () => ({ ok: true, ids: [] }),
    getProspectIdsForRunsWith: async () => ({ ok: true, ids: [] }),
    runAllSourcesWith: async () => ({ ok: false, error: "unused" }),
    pruneRunToTop30With: async () => ({ ok: true, kept: 0, deleted: 0 }),
    usableContactsWith: async (_a: unknown, id: string) => ({ usable: o.usable?.[id] ?? 1, total: 1, error: null }),
    // As pipeline-stage.ts: the guarded match write (tested above), recorded here.
    enterMatchWith: async (_a: unknown, id: string, _score: unknown, source: string) => {
      pitchedIds.push(`${id}:${source}`);
      const row = prospects.find((p) => p.id === id)!;
      row.status = "match";
      return { moved: true };
    },
    processSingleProspectWith: async (_a: unknown, id: string) => {
      const run = runs[id]!;
      const row = prospects.find((p) => p.id === id)!;
      row.status = run.leave;
      if (run.score !== undefined) row.match_score = run.score;
      return { prospect_id: id, company_name: "x", score: run.score ?? null, outcome: run.outcome, error: run.error };
    },
  }, calls);
  const { POST } = await import(ROUTE_URL.href);
  const req = () => new Request("http://localhost/api/discover/run", { method: "POST", body: JSON.stringify({ jobId: "job1" }) });
  await POST(req());
  for (let i = 0; i < 4 && job.status === "running"; i++) await POST(req());
  return { job, pitchedIds, calls, status: Object.fromEntries(prospects.map((p) => [p.id, p.status])) };
}

test("discovery job: a match outcome counts as pitch-ready, never as an error; the catch-up never drafts it; it is in the pitched pool", async () => {
  const { job, pitchedIds, status } = await slice({
    m1: { leave: "match", outcome: "match", score: 85 },
    m2: { leave: "match", outcome: "match", score: 72 },
    hi: { leave: "researched", outcome: "error", error: "prospect-timeout", score: 90 },
  });
  const stats = job.stats as { pitched: number; error_count: number; errors: string[]; processed: number; pitched_pool: number };
  // Two match outcomes, plus hi once the catch-up moved it into match.
  assert.equal(stats.pitched, 3);
  assert.equal(stats.error_count, 1);
  assert.deepEqual(stats.errors, ["prospect-timeout"]);
  assert.equal(stats.processed, 3);
  // Only the researched high scorer reaches the catch-up; the match ones wait for the tick.
  assert.deepEqual(pitchedIds, ["hi:catch_up"]);
  assert.equal(status.m1, "match");
  assert.equal(status.m2, "match");
  assert.equal(stats.pitched_pool, 2);
  assert.equal(job.status, "done");
});

test("catch-up never drafts: a 70+ prospect left researched (its deadline ran out) goes to match after the usable-contact check", async () => {
  const { job, pitchedIds, calls, status } = await slice(
    {
      late: { leave: "researched", outcome: "error", error: "prospect-timeout", score: 88 },
      nocontact: { leave: "researched", outcome: "error", error: "prospect-timeout", score: 91 },
    },
    { usable: { nocontact: 0 } },
  );
  assert.deepEqual(pitchedIds, ["late:catch_up"]);
  assert.equal(status.late, "match");
  // No usable contact: left as it is, for a person (no paid call in the catch-up).
  assert.equal(status.nocontact, "researched");
  assert.deepEqual(calls.filter((c) => c === "usableContactsWith").length, 2);
  assert.equal((job.stats as { pitched: number }).pitched, 1);
  const src = readFileSync(ROUTE_URL, "utf8");
  assert.doesNotMatch(src, /generatePitchWith/, "the job never writes a first email");
  assert.match(src, /enterMatchWith\(actor, id, null, "catch_up"\)/);
});
