/**
 * Pipeline guards (brief tasks/briefs/pipeline-guards.md): the pipeline only
 * moves a company forward, and no Claude money is spent on a company we may not
 * email. Drives the real generatePitchWith, deepResearchProspectWith and the
 * /api/discover/run slice against a fake Supabase client. Every value import
 * of those modules is stubbed by a loader hook (they use "@/" aliases and
 * next/*, which node cannot load here), except lib/prospects/status.ts (the
 * real predicate) and zod.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { register } from "node:module";
import test from "node:test";
import {
  DO_NOT_SEND_STATUSES,
  PROSPECT_STATUSES,
  isPastPipeline,
} from "../lib/prospects/status.ts";

const PITCH_URL = new URL("../lib/pitches/pitch-stage.ts", import.meta.url);
const DEEP_URL = new URL("../lib/research/deep-research-stage.ts", import.meta.url);
const ROUTE_URL = new URL("../app/api/discover/run/route.ts", import.meta.url);
const STATUS_URL = new URL("../lib/prospects/status.ts", import.meta.url);

const REAL = new Set(["@/lib/prospects/status", "zod"]);
const stubNames = (url: URL) => [
  ...new Set(
    [...readFileSync(url, "utf8").matchAll(/^import \{([^}]*)\} from "([^"]+)";/gm)]
      .filter(([, , from]) => !REAL.has(from!))
      .flatMap(([, names]) => names!.split(",").map((n) => n.trim()))
      .filter((n) => n && !n.startsWith("type ")),
  ),
];
const TARGETS = {
  [PITCH_URL.href]: stubNames(PITCH_URL),
  [DEEP_URL.href]: stubNames(DEEP_URL),
  [ROUTE_URL.href]: stubNames(ROUTE_URL),
};

const hooks = `
const STATUS = ${JSON.stringify(STATUS_URL.href)};
const TARGETS = ${JSON.stringify(TARGETS)};
export async function resolve(spec, ctx, next) {
  if (ctx.parentURL in TARGETS && spec !== "zod") {
    if (spec === "@/lib/prospects/status") return { url: STATUS, shortCircuit: true };
    return { url: "stub:" + ctx.parentURL, shortCircuit: true };
  }
  return next(spec, ctx);
}
export async function load(url, ctx, next) {
  if (!url.startsWith("stub:")) return next(url, ctx);
  const names = TARGETS[url.slice(5)];
  // A callable proxy: works for functions and for objects with static methods (NextResponse.json).
  const src = names.map((n) => "export const " + n + " = new Proxy(function () {}, { apply: (_t, _s, a) => globalThis.__guardStubs." + n + "(...a), get: (_t, k) => globalThis.__guardStubs." + n + "[k] });").join("\\n");
  return { format: "module", source: src, shortCircuit: true };
}`;
register("data:text/javascript," + encodeURIComponent(hooks));

// ── Fake Supabase ────────────────────────────────────────────────────────────

type Row = Record<string, unknown>;
type Db = {
  tables: Record<string, Row[]>;
  /** Called after every read of `prospects`, with the read's 0-based index. */
  onProspectRead?: (n: number) => void;
  prospectReads: number;
  /** Tables whose UPDATEs fail with this postgrest-shaped error. */
  failUpdates?: Record<string, { message: string }>;
};

type Result = { data: unknown; error: { message: string } | null; count?: number };

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
  select(_cols?: string, opts?: { head?: boolean }) {
    if (this.op !== "select") this.returning = true;
    if (opts?.head) this.head = true;
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
  order() { return this; }
  limit() { return this; }
  returns() { return this; }
  maybeSingle() { this.single = true; return this; }
  then<A = Result, B = never>(
    ok?: ((v: Result) => A | PromiseLike<A>) | null,
    bad?: ((e: unknown) => B | PromiseLike<B>) | null,
  ): PromiseLike<A | B> {
    return Promise.resolve(this.run()).then(ok, bad);
  }
  private run(): Result {
    const rows = (this.db.tables[this.table] ??= []);
    if (this.op === "insert") { rows.push({ ...this.values }); return { data: null, error: null }; }
    const hit = rows.filter((r) => this.filters.every((f) => f(r)));
    if (this.op === "select") {
      const out = hit.map((r) => ({ ...r }));
      if (this.table === "prospects") this.db.onProspectRead?.(this.db.prospectReads++);
      if (this.head) return { data: null, error: null, count: out.length };
      return { data: this.single ? (out[0] ?? null) : out, error: null };
    }
    if (this.op === "update" && this.db.failUpdates?.[this.table]) {
      return { data: null, error: this.db.failUpdates[this.table]! };
    }
    if (this.op === "delete") {
      for (const r of hit) rows.splice(rows.indexOf(r), 1);
    } else {
      for (const r of hit) Object.assign(r, this.values);
    }
    const out = this.returning ? hit.map((r) => ({ ...r })) : null;
    return { data: this.single ? (out?.[0] ?? null) : out, error: null };
  }
}

/** Installs the stubs; an unexpected one throws so a test can't pass by accident. */
function stub(impl: Record<string, unknown>, calls: string[]) {
  (globalThis as Record<string, unknown>).__guardStubs = new Proxy(impl, {
    get(t, name: string) {
      const f = t[name];
      if (!f) throw new Error(`no stub for ${name}`);
      if (typeof f !== "function") return f;
      return (...a: unknown[]) => { calls.push(name); return f(...a); };
    },
  });
}

const ACTOR_USER = { id: "u1", tenantId: "t1", role: "admin" };

// ── 1. The predicate ─────────────────────────────────────────────────────────

test("isPastPipeline over all 19 statuses", () => {
  const expected: Record<string, boolean> = {
    raw: false, enriched: false, researched: false, scored: false, match: false,
    no_match: true, pitched: true, queued: true, approved: true, sent: true,
    bounced: true, replied: true, booked: true, ghosted: true, lost: true, won: true,
    suppressed: true, archived_no_meeting: true, b_list: false,
  };
  assert.equal(PROSPECT_STATUSES.length, 19);
  assert.deepEqual(Object.keys(expected).sort(), [...PROSPECT_STATUSES].sort());
  for (const s of PROSPECT_STATUSES) assert.equal(isPastPipeline(s), expected[s], s);
  // Every do-not-send status is past the pipeline.
  for (const s of DO_NOT_SEND_STATUSES) assert.equal(isPastPipeline(s), true, s);
  assert.equal(isPastPipeline(null), false);
  assert.equal(isPastPipeline(undefined), false);
});

// ── 2. generatePitchWith: no Claude call on a do-not-send company ───────────

const CLAUDE_REACHED = "claude-reached";

async function pitch(status: string, opts: { parkAs?: string; recheckMissing?: boolean } = {}) {
  const calls: string[] = [];
  stub({
    revalidatePath: () => undefined,
    claudeIsAvailable: () => true,
    isUnderDailyCap: async () => ({ under: true, spent_today_usd: 0, cap_usd: 3 }),
    recordClaudeCall: async () => undefined,
    writeAuditLog: async () => undefined,
    hasUsableEmail: (e: unknown) => typeof e === "string" && e.includes("@"),
    isRoleBasedEmail: () => false,
    listNotableClients: async () => [],
    fetchBenchmarksForPitch: async () => [],
    chooseWriterArms: async () => ({ evidence: "benchmark", guidance: null }),
    fetchExemplars: async () => [],
    segmentOf: () => "seg",
    newAttributionCode: () => "code",
    senderForGenerator: () => ({ name: "Henry" }),
    buildHunterUrlForPitch: () => "https://hunter.example",
    renderIndustryTemplate: () => { throw new Error("heuristic reached"); },
    composeWithReview: async () => { throw new Error(CLAUDE_REACHED); },
  }, calls);
  const prospect: Row = {
    id: "00000000-0000-4000-8000-000000000001", tenant_id: "t1", company_name: "Acme",
    industry: null, language: "en", employee_size_estimate: 5, city: null, market: null,
    domain: "acme.ca", website_url: null, status,
  };
  const db: Db = {
    tables: {
      prospects: [prospect],
      prospect_research: [],
      prospect_contacts: [{ tenant_id: "t1", prospect_id: prospect.id, email: "ana@acme.ca", email_is_role_based: false, full_name: "Ana", role_title: null, priority_rank: 1 }],
      case_studies: [],
    },
    prospectReads: 0,
    // Read 0 is the pitch's initial load (no status column): park the company
    // right after it, before the re-check.
    onProspectRead: (n) => {
      if (n !== 0) return;
      if (opts.parkAs) prospect.status = opts.parkAs;
      if (opts.recheckMissing) db.tables.prospects = [];
    },
  };
  const supabase = { from: (t: string) => new Query(db, t) };
  const { generatePitchWith } = await import(PITCH_URL.href);
  let thrown: unknown = null;
  let result: unknown = null;
  try {
    result = await generatePitchWith({ supabase, user: ACTOR_USER }, prospect.id);
  } catch (e) {
    thrown = e;
  }
  const claude = calls.filter((c) => c === "composeWithReview").length;
  return { result: result as { ok: boolean; error?: string } | null, thrown, claude };
}

test("generatePitchWith: a sendable company reaches the Claude call (control)", async () => {
  for (const s of ["raw", "researched", "scored", "b_list"]) {
    const { claude, thrown } = await pitch(s);
    assert.equal(claude, 1, s);
    assert.equal((thrown as Error).message, CLAUDE_REACHED, s);
  }
});

test("generatePitchWith: suppressed (or any do-not-send) between the read and the call → no Claude call", async () => {
  for (const parkAs of DO_NOT_SEND_STATUSES) {
    const { result, claude, thrown } = await pitch("researched", { parkAs });
    assert.equal(thrown, null, parkAs);
    assert.equal(claude, 0, parkAs);
    assert.equal(result?.ok, false, parkAs);
    assert.match(result?.error ?? "", new RegExp(`company is ${parkAs}`), parkAs);
  }
});

test("generatePitchWith: the re-check fails closed when the row is gone", async () => {
  const { result, claude } = await pitch("researched", { recheckMissing: true });
  assert.equal(claude, 0);
  assert.equal(result?.ok, false);
});

// ── 3. Deep research refuses a do-not-send company before any paid call ─────

async function deep(status: string) {
  const calls: string[] = [];
  stub({
    revalidatePath: () => undefined,
    claudeIsAvailable: () => true,
    isUnderDailyCap: async () => ({ under: true, spent_today_usd: 0, cap_usd: 3 }),
    scrapeSite: async () => { throw new Error("paid-reached"); },
  }, calls);
  const db: Db = {
    tables: { prospects: [{ id: "p1", tenant_id: "t1", company_name: "Acme", website_url: "https://acme.ca", domain: "acme.ca", status, city: null }] },
    prospectReads: 0,
  };
  const supabase = { from: (t: string) => new Query(db, t) };
  const { deepResearchProspectWith } = await import(DEEP_URL.href);
  try {
    const r = await deepResearchProspectWith({ supabase, user: ACTOR_USER }, "p1");
    return { r, calls, thrown: null as unknown };
  } catch (e) {
    return { r: null, calls, thrown: e };
  }
}

test("deep research on a do-not-send company refuses with a clear message, no scrape, no Claude", async () => {
  for (const s of DO_NOT_SEND_STATUSES) {
    const { r, calls, thrown } = await deep(s);
    assert.equal(thrown, null, s);
    assert.equal(r.ok, false, s);
    assert.match(r.error, /Deep research skipped: this company is/, s);
    assert.ok(!calls.includes("scrapeSite"), s);
    assert.ok(!calls.some((c) => /claude|Claude/.test(c) && c !== "claudeIsAvailable"), s);
  }
  // Control: a raw company goes on to the (paid) scrape.
  const { thrown } = await deep("raw");
  assert.equal((thrown as Error).message, "paid-reached");
});

test("source: the deep-research UI action is the thin wrapper over the guarded stage", () => {
  const action = readFileSync(new URL("../lib/research/deep-research-action.ts", import.meta.url), "utf8");
  assert.match(action, /return deepResearchProspectWith\(await sessionActor\(\), prospectId, options\);/);
});

// ── 4. /api/discover/run: the unfinished sweep ───────────────────────────────

// The slice races each prospect against a timer it never clears (harmless in a
// function that ends; here it would hold the test process ~95s). Unref them.
const realSetTimeout = globalThis.setTimeout;
globalThis.setTimeout = ((fn: () => void, ms?: number) => {
  const t = realSetTimeout(fn, ms);
  t.unref();
  return t;
}) as typeof setTimeout;

type Run = { leave: string; outcome: string; error?: string };

/**
 * One pipeline slice over the given prospects (all start raw). Each fake run
 * leaves the status it names and reports the outcome. `meanwhile` runs once
 * every prospect has settled, before the sweep: another writer.
 */
async function slice(runs: Record<string, Run>, o: { skipPrune?: boolean; meanwhile?: (rows: Row[]) => void } = {}) {
  const calls: string[] = [];
  const ids = Object.keys(runs);
  const prospects: Row[] = ids.map((id) => ({ id, tenant_id: "t1", icp_id: "icp1", status: "raw", match_score: null }));
  const job: Row = {
    id: "job1", tenant_id: "t1", icp_id: "icp1", status: "running", phase: "pipeline", cursor: 0,
    prospect_ids: ids,
    stats: { new: 0, dup: 0, errors: [], pitched: 0, website_pitch: 0, needs_review: 0, suppressed: 0, error_count: 0, ...(o.skipPrune ? { skip_prune: true } : {}) },
  };
  const db: Db = { tables: { prospects, discovery_jobs: [job], pitches: [] }, prospectReads: 0 };
  const supabase = { from: (t: string) => new Query(db, t) };
  let settled = 0;
  stub({
    systemActorFromRequest: async () => ({ user: ACTOR_USER, supabase, system: true }),
    getCurrentUser: async () => null,
    createClient: async () => supabase,
    NextResponse: { json: (body: unknown) => ({ body }) },
    after: () => undefined,
    triggerNextSlice: async () => undefined,
    isUnderDailyCap: async () => ({ under: true, spent_today_usd: 0, cap_usd: 3 }),
    affordableProspects: () => 100,
    getRawProspectIdsWith: async () => ({ ok: true, ids: [] }),
    getProspectIdsForRunsWith: async () => ({ ok: true, ids: [] }),
    runAllSourcesWith: async () => ({ ok: false, error: "unused" }),
    pruneRunToTop30With: async () => ({ ok: true, kept: 0, deleted: 0 }),
    generatePitchWith: async () => ({ ok: false, error: "unused" }),
    processSingleProspectWith: async (_a: unknown, id: string) => {
      const run = runs[id]!;
      prospects.find((p) => p.id === id)!.status = run.leave;
      if (++settled === ids.length) o.meanwhile?.(prospects);
      return { prospect_id: id, company_name: "x", score: null, outcome: run.outcome, error: run.error };
    },
  }, calls);
  const { POST } = await import(ROUTE_URL.href);
  const req = new Request("http://localhost/api/discover/run", { method: "POST", body: JSON.stringify({ jobId: "job1" }) });
  const res = await POST(req);
  const status = Object.fromEntries(prospects.map((p) => [p.id, p.status]));
  return { res, status, job, calls };
}

test("route: a prospect researched then errored is swept; finished and skipped ones are not", async () => {
  const { status, job } = await slice({
    a: { leave: "researched", outcome: "error", error: "Final score failed: x" },
    b: { leave: "researched", outcome: "needs_review" }, // pitch failed: waits for the pitching phase
    c: { leave: "raw", outcome: "error", error: "prospect-timeout" },
    d: { leave: "b_list", outcome: "needs_review" },
    e: { leave: "sent", outcome: "skipped", error: "Skipped: already contacted (sent)" },
  });
  assert.deepEqual(status, { a: "suppressed", b: "researched", c: "suppressed", d: "b_list", e: "sent" });
  const stats = job.stats as Record<string, number>;
  // A skip is not an error.
  assert.equal(stats.error_count, 2);
  assert.equal(stats.processed, 5);
});

test("route: the sweep never touches a row another writer has moved on since", async () => {
  const { status } = await slice(
    { a: { leave: "researched", outcome: "error" }, b: { leave: "researched", outcome: "error" } },
    { meanwhile: (rows) => { rows[0]!.status = "pitched"; rows[1]!.status = "booked"; } },
  );
  assert.deepEqual(status, { a: "pitched", b: "booked" });
});

test("route: a hand-picked run (skip_prune) keeps its errored prospects, researched or raw", async () => {
  const { status } = await slice(
    { a: { leave: "researched", outcome: "error" }, b: { leave: "raw", outcome: "error" } },
    { skipPrune: true },
  );
  assert.deepEqual(status, { a: "researched", b: "raw" });
});

test("route source: the pitching phase filters with isPastPipeline (one predicate)", () => {
  const src = readFileSync(ROUTE_URL, "utf8");
  assert.match(src, /\.filter\(\(p\) => !isPastPipeline\(p\.status\)\)/);
  assert.doesNotMatch(src, /NON_PITCHABLE/);
});

test("source: the scrape bump and the deep-research suppress write check their error and report it", () => {
  const scrape = readFileSync(new URL("../lib/research/scrape-stage.ts", import.meta.url), "utf8");
  assert.match(scrape, /const \{ error: bumpErr \} = await supabase[\s\S]{0,300}status: "researched"[\s\S]{0,300}if \(bumpErr\) \{\s*statusWriteError =/);
  assert.match(scrape, /status_write_error: statusWriteError/);
  const deepSrc = readFileSync(DEEP_URL, "utf8");
  assert.match(deepSrc, /const \{ error: suppressErr \} = await supabase[\s\S]{0,300}status: "suppressed"[\s\S]{0,900}if \(suppressErr\) \{\s*statusWriteError =/);
  assert.match(deepSrc, /status_write_error: statusWriteError/);
});
