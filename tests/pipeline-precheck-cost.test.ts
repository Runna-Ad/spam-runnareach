/**
 * The pipeline's pre-check bar is 20 and SnapVerify's paid Claude call is
 * recorded once (brief: tasks/briefs/claude-calls-accounted.md). Drives the real
 * processSingleProspectWith against a fake Supabase client, with every import
 * stubbed by a loader hook except lib/prospects/status.ts and zod (same harness
 * as tests/pipeline-status-rule.test.ts).
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { register } from "node:module";
import test from "node:test";

const STAGE_URL = new URL("../lib/discover/pipeline-stage.ts", import.meta.url);
const STATUS_URL = new URL("../lib/prospects/status.ts", import.meta.url);
const STAGE_SRC = readFileSync(STAGE_URL, "utf8");

// Each target's value imports to stub (type-only imports are stripped by node).
const REAL = new Set(["@/lib/prospects/status", "zod"]);
const stubNames = (src: string) =>
  [...src.matchAll(/^import \{([^}]*)\} from "([^"]+)";/gm)]
    .filter(([, , from]) => !REAL.has(from!))
    .flatMap(([, names]) => names!.split(",").map((n) => n.trim()).filter(Boolean));
const TARGETS = {
  [STAGE_URL.href]: stubNames(STAGE_SRC),
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
  const src = names.map((n) => "export const " + n + " = (...a) => globalThis.__pipelineStubs." + n + "(...a);").join("\\n");
  return { format: "module", source: src, shortCircuit: true };
}`;
register("data:text/javascript," + encodeURIComponent(hooks));

// ── Fake Supabase ────────────────────────────────────────────────────────────

type Row = Record<string, unknown>;
type Db = {
  tables: Record<string, Row[]>;
  /** Runs once, after the first read of `prospects` (the pipeline's snapshot). */
  afterFirstProspectRead?: (row: Row) => void;
  prospectReads: number;
  statusWrites: Row[];
  /** When set, every prospects UPDATE fails with this postgrest-shaped error. */
  failProspectUpdates?: { message: string };
};

type Res = { data: unknown; error: { message: string } | null };

class Query implements PromiseLike<Res> {
  private op: "select" | "update" | "insert" = "select";
  private values: Row = {};
  private returning = false;
  private single = false;
  private filters: ((r: Row) => boolean)[] = [];
  private db: Db;
  private table: string;
  constructor(db: Db, table: string) { this.db = db; this.table = table; }
  select() {
    if (this.op === "update") this.returning = true;
    return this;
  }
  update(v: Row) { this.op = "update"; this.values = v; return this; }
  insert(v: Row) { this.op = "insert"; this.values = v; return this; }
  eq(k: string, v: unknown) { this.filters.push((r) => r[k] === v); return this; }
  in(k: string, v: unknown[]) { this.filters.push((r) => v.includes(r[k])); return this; }
  not(k: string, op: string, v: unknown) {
    if (op === "is") this.filters.push((r) => r[k] !== v);
    else {
      const set = new Set(String(v).replace(/[()]/g, "").split(","));
      this.filters.push((r) => !set.has(String(r[k])));
    }
    return this;
  }
  returns() { return this; }
  maybeSingle() { this.single = true; return this; }
  then<A = Res, B = never>(
    ok?: ((v: Res) => A | PromiseLike<A>) | null,
    bad?: ((e: unknown) => B | PromiseLike<B>) | null,
  ): PromiseLike<A | B> {
    return Promise.resolve(this.run()).then(ok, bad);
  }
  private run(): Res {
    const rows = (this.db.tables[this.table] ??= []);
    if (this.op === "insert") { rows.push({ ...this.values }); return { data: null, error: null }; }
    const hit = rows.filter((r) => this.filters.every((f) => f(r)));
    if (this.op === "select") {
      const out = hit.map((r) => ({ ...r }));
      if (this.table === "prospects" && this.db.prospectReads++ === 0 && hit[0]) {
        this.db.afterFirstProspectRead?.(hit[0]);
      }
      return { data: this.single ? (out[0] ?? null) : out, error: null };
    }
    if (this.table === "prospects" && this.db.failProspectUpdates) return { data: null, error: this.db.failProspectUpdates };
    if (this.table === "prospects" && "status" in this.values) this.db.statusWrites.push({ ...this.values });
    for (const r of hit) Object.assign(r, this.values);
    const out = this.returning ? hit.map((r) => ({ ...r })) : null;
    return { data: this.single ? (out?.[0] ?? null) : out, error: null };
  }
}

// ── Run ──────────────────────────────────────────────────────────────────────

const SNAP_CALL = { model: "claude-haiku-4-5", usage: { cost_usd: 0.001 }, fallback_reason: null };

async function run(scores: number[], snap: Row = { found: false, reason: "none", claudeCall: SNAP_CALL }) {
  const calls: { name: string; args: unknown[] }[] = [];
  const queue = [...scores];
  const impl: Record<string, (...a: unknown[]) => unknown> = {
    revalidatePath: () => undefined,
    writeAuditLog: async () => undefined,
    isRoleBasedEmail: () => false,
    hasUsableEmail: (e) => typeof e === "string" && e.includes("@"),
    normalizeDomain: (d) => d,
    googlePlacesIsAvailable: () => false,
    searchBrave: async () => ({ ok: false }),
    searchGooglePlaces: async () => ({ ok: false }),
    scrapeWebsiteWith: async () => ({ ok: true }),
    scoreProspectWith: async () => ({ ok: true, composite_score: queue.shift() ?? 0 }),
    deepResearchProspectWith: async () => ({ ok: true }),
    runStructuredResearchWith: async () => ({ ok: true }),
    snapVerifyEnrich: async () => snap,
    recordSnapVerifyCall: async () => undefined,
    enrichContactsForProspect: async () => undefined,
    generatePitchWith: async () => ({ ok: false, error: "no" }),
    generateWebsitePitchWith: async () => ({ ok: false, error: "no" }),
  };
  (globalThis as Record<string, unknown>).__pipelineStubs = new Proxy(impl, {
    get(t, name: string) {
      const f = t[name];
      if (!f) throw new Error(`no stub for ${name}`);
      return (...a: unknown[]) => { calls.push({ name, args: a }); return f(...a); };
    },
  });
  const row: Row = {
    id: "p1", tenant_id: "t1", company_name: "Acme", city: null, country_code: "CA", red_flags: [],
    domain: "acme.ca", website_url: "https://acme.ca", icp_id: "icp1", status: "raw", suppressed_reason: null,
  };
  const db: Db = { tables: { prospects: [row], prospect_contacts: [], prospect_research: [] }, prospectReads: 0, statusWrites: [] };
  const supabase = { from: (t: string) => new Query(db, t) };
  const { processSingleProspectWith } = await import(STAGE_URL.href);
  const result = await processSingleProspectWith({ supabase, user: { id: "u1", tenantId: "t1", role: "admin" } }, "p1");
  const names = calls.map((c) => c.name);
  return { result, row, names, calls };
}

// ── Tests ────────────────────────────────────────────────────────────────────

test("pre-check: a structural score of 0-19 is suppressed with no deep research, no SnapVerify, no second score", async () => {
  for (const s of [0, 9, 10, 19]) {
    const { result, row, names } = await run([s]);
    assert.equal(result.outcome, "suppressed", String(s));
    assert.equal(row.status, "suppressed", String(s));
    assert.match(String(row.suppressed_reason), new RegExp(`structural score ${s}\\b`), String(s));
    for (const paid of ["deepResearchProspectWith", "snapVerifyEnrich", "runStructuredResearchWith"]) {
      assert.ok(!names.includes(paid), `${s}: ${paid}`);
    }
    assert.equal(names.filter((n) => n === "scoreProspectWith").length, 1, String(s));
  }
});

test("pre-check: exactly 20 is researched, in the same order of paid steps", async () => {
  const { names } = await run([20, 40]);
  const paid = names.filter((n) =>
    ["scoreProspectWith", "deepResearchProspectWith", "snapVerifyEnrich", "runStructuredResearchWith"].includes(n));
  assert.deepEqual(paid, ["scoreProspectWith", "deepResearchProspectWith", "snapVerifyEnrich", "runStructuredResearchWith", "scoreProspectWith"]);
});

test("snapVerify in the pipeline: its paid call is recorded exactly once, found or not; no call, no row", async () => {
  for (const snap of [
    { found: false, reason: "none", claudeCall: SNAP_CALL },
    { found: false, reason: "parse", claudeCall: { ...SNAP_CALL, fallback_reason: "parse" } },
    { found: true, email: "ana@acme.ca", full_name: "Ana", role_title: null, confidence: 90, method: "smtp_verified", claudeCall: SNAP_CALL },
  ]) {
    const { calls } = await run([30, 40], snap);
    const rec = calls.filter((c) => c.name === "recordSnapVerifyCall");
    assert.equal(rec.length, 1, snap.reason ?? "found");
    assert.deepEqual(rec[0]!.args, ["t1", "p1", snap.claudeCall]);
  }
  const { names } = await run([30, 40], { found: false, reason: "no people", claudeCall: null });
  assert.ok(!names.includes("recordSnapVerifyCall"));
});
