/**
 * The pipeline and other automated writers never un-park a prospect (Pedro
 * 2026-10-18: the status rule wins; a person's direct status change still can). Drives the real processSingleProspectWith and
 * bulkScoreProspects against a fake Supabase client: every dependency they
 * import is stubbed by a loader hook (they use "@/" aliases and next/cache,
 * which node cannot load here), except lib/prospects/status.ts (the real rule)
 * and zod.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { register } from "node:module";
import test from "node:test";
import {
  DO_NOT_SEND_STATUSES,
  PROSPECT_STATUSES,
  isPastPipeline,
  mayOverwriteStatus,
} from "../lib/prospects/status.ts";

const STAGE_URL = new URL("../lib/discover/pipeline-stage.ts", import.meta.url);
const BULK_URL = new URL("../lib/discover/bulk-actions.ts", import.meta.url);
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
  [BULK_URL.href]: stubNames(readFileSync(BULK_URL, "utf8")),
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

// ── Stubs ────────────────────────────────────────────────────────────────────

/** Every stub that does paid or external work (Claude, scraping, email finders). */
const PAID = [
  "scrapeWebsiteWith", "scoreProspectWith", "deepResearchProspectWith", "runStructuredResearchWith",
  "generatePitchWith", "generateWebsitePitchWith", "snapVerifyEnrich", "enrichContactsForProspect",
  "searchBrave", "searchGooglePlaces",
];

type Scenario = {
  label: string;
  /** The status write this lane ends in (the brief's numbered writes). */
  writes: string;
  prospect: Row;
  contacts: Row[];
  scores: number[];
  pitchOk?: boolean;
  websitePitchOk?: boolean;
};

const BASE = { id: "p1", tenant_id: "t1", company_name: "Acme", city: null, country_code: "CA", red_flags: [] };
const SITE = { domain: "acme.ca", website_url: "https://acme.ca", icp_id: "icp1" };
const NO_SITE = { domain: null, website_url: null };
const CONTACT = [{ prospect_id: "p1", tenant_id: "t1", email: "ana@acme.ca" }];

const SCENARIOS: Scenario[] = [
  { label: "no website, no ICP", writes: "suppressed", prospect: { ...NO_SITE, icp_id: null }, contacts: [], scores: [] },
  { label: "no website, no contact", writes: "suppressed", prospect: { ...NO_SITE, icp_id: "icp1" }, contacts: [], scores: [] },
  { label: "no website, website pitch", writes: "pitched", prospect: { ...NO_SITE, icp_id: "icp1" }, contacts: CONTACT, scores: [], websitePitchOk: true },
  { label: "no website, website pitch fails", writes: "suppressed", prospect: { ...NO_SITE, icp_id: "icp1" }, contacts: CONTACT, scores: [], websitePitchOk: false },
  { label: "structural score < 10", writes: "suppressed", prospect: SITE, contacts: [], scores: [5] },
  { label: "final score < 50", writes: "suppressed", prospect: SITE, contacts: [], scores: [30, 40] },
  { label: "final score 50–69", writes: "b_list", prospect: SITE, contacts: [], scores: [30, 60] },
  { label: "≥ 70, no contact", writes: "suppressed", prospect: SITE, contacts: [], scores: [30, 80] },
  { label: "≥ 70, pitched", writes: "pitched", prospect: SITE, contacts: CONTACT, scores: [30, 80], pitchOk: true },
];

async function run(s: Scenario, status: string, parkAs?: string, failProspectUpdates?: { message: string }) {
  const calls: string[] = [];
  const scores = [...s.scores];
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
    scoreProspectWith: async () => ({ ok: true, composite_score: scores.shift() ?? 0 }),
    deepResearchProspectWith: async () => ({ ok: true }),
    runStructuredResearchWith: async () => ({ ok: true }),
    snapVerifyEnrich: async () => ({ found: false }),
    enrichContactsForProspect: async () => undefined,
    generatePitchWith: async () => (s.pitchOk ? { ok: true } : { ok: false, error: "no" }),
    generateWebsitePitchWith: async () => (s.websitePitchOk ? { ok: true } : { ok: false, error: "no" }),
  };
  (globalThis as Record<string, unknown>).__pipelineStubs = new Proxy(impl, {
    get(t, name: string) {
      const f = t[name];
      if (!f) throw new Error(`no stub for ${name}`);
      return (...a: unknown[]) => { calls.push(name); return f(...a); };
    },
  });
  const row: Row = { ...BASE, ...s.prospect, status, suppressed_reason: null };
  const db: Db = {
    tables: { prospects: [row], prospect_contacts: s.contacts.map((c) => ({ ...c })), prospect_research: [] },
    prospectReads: 0,
    statusWrites: [],
    afterFirstProspectRead: parkAs ? (r) => { r.status = parkAs; } : undefined,
    failProspectUpdates,
  };
  const supabase = { from: (t: string) => new Query(db, t) };
  const { processSingleProspectWith } = await import(STAGE_URL.href);
  const actor = { supabase, user: { id: "u1", tenantId: "t1", role: "admin" } };
  const result = await processSingleProspectWith(actor, "p1");
  return { result, row, db, paid: calls.filter((c) => PAID.includes(c)) };
}

// ── Tests ────────────────────────────────────────────────────────────────────

const PARKED = ["suppressed", "no_match", "won", "lost", "booked", "archived_no_meeting"];

test("PARKED is exactly DO_NOT_SEND_STATUSES", () => {
  assert.deepEqual(new Set(PARKED), DO_NOT_SEND_STATUSES);
});

test("a contacted or parked prospect is skipped: no status write, no paid call, outcome skipped with its status", async () => {
  const past = PROSPECT_STATUSES.filter(isPastPipeline);
  for (const must of ["sent", "replied", "pitched", ...PARKED]) assert.ok(past.includes(must as never), must);
  for (const s of SCENARIOS) {
    for (const status of past) {
      const { result, row, db, paid } = await run(s, status);
      const at = `${s.label} / ${status}`;
      assert.equal(result.outcome, "skipped", at);
      assert.match(result.error ?? "", new RegExp(`\\(${status}\\)$`), at);
      assert.equal(row.status, status, at);
      assert.deepEqual(db.statusWrites, [], at);
      assert.deepEqual(paid, [], at);
    }
  }
});

test("b_list and the early funnel are re-run (not skipped)", async () => {
  for (const status of PROSPECT_STATUSES.filter((x) => !isPastPipeline(x))) {
    const s = SCENARIOS[6]!; // final score 50–69
    const { result, paid } = await run(s, status);
    assert.notEqual(result.outcome, "skipped", status);
    assert.ok(paid.includes("scoreProspectWith"), status);
  }
});

test("a failed first read (empty-message error) ends as error before anything else: no writes, no paid call", async () => {
  for (const status of ["replied", "raw"]) {
    const calls: string[] = [];
    (globalThis as Record<string, unknown>).__pipelineStubs = new Proxy({}, {
      get: (_t, name: string) => (...a: unknown[]) => { calls.push(name); void a; return undefined; },
    });
    const row: Row = { ...BASE, ...SITE, status };
    const writes: unknown[] = [];
    const supabase = {
      from: () => ({
        select() { return this; }, eq() { return this; },
        maybeSingle: async () => ({ data: null, error: { message: "" } }),
        update: (v: unknown) => { writes.push(v); throw new Error("no write expected"); },
      }),
    };
    const { processSingleProspectWith } = await import(STAGE_URL.href);
    const result = await processSingleProspectWith({ supabase, user: { id: "u1", tenantId: "t1", role: "admin" } }, "p1");
    assert.equal(result.outcome, "error", status);
    assert.match(result.error, /^Prospect read failed/, status);
    assert.deepEqual(writes, [], status);
    assert.deepEqual(calls.filter((c) => PAID.includes(c)), [], status);
    assert.equal(row.status, status);
  }
});

test("a failed status write is reported as an error, never as the lane's outcome", async () => {
  for (const s of SCENARIOS) {
    const { result } = await run(s, "raw", undefined, { message: "" });
    assert.equal(result.outcome, "error", s.label);
    assert.match(result.error ?? "", new RegExp(`^Status write \\(${s.writes}\\) failed`), s.label);
  }
});

test("the scenarios reach every status write they name (sanity: a raw prospect)", async () => {
  for (const s of SCENARIOS) {
    const { row } = await run(s, "raw");
    assert.equal(row.status, s.writes, s.label);
  }
});

test("a raw prospect's outcomes are unchanged", async () => {
  const outcomes = [];
  for (const s of SCENARIOS) outcomes.push((await run(s, "raw")).result.outcome);
  assert.deepEqual(outcomes, [
    "suppressed", "suppressed", "website_pitch", "suppressed", "suppressed",
    "suppressed", "needs_review", "suppressed", "pitched",
  ]);
});

test("parked between the read and the write: the guard refuses the move and the outcome is suppressed", async () => {
  for (const s of SCENARIOS) {
    for (const parkAs of PARKED) {
      const { result, row } = await run(s, "raw", parkAs);
      const at = `${s.label} / parked as ${parkAs}`;
            // The rule decides: a move it refuses leaves the parked status; one it allows
      // (no_match → suppressed, both do-not-send) is fine. Never sendable again.
      assert.equal(row.status, mayOverwriteStatus(parkAs, s.writes, "automation") ? s.writes : parkAs, at);
      assert.ok(DO_NOT_SEND_STATUSES.has(String(row.status)), at);
      assert.equal(result.outcome, "suppressed", at);
    }
  }
});

test("parked during a run whose pitch failed: counted suppressed, not needs_review", async () => {
  const s: Scenario = { label: "≥ 70, pitch fails", writes: "", prospect: SITE, contacts: CONTACT, scores: [30, 80], pitchOk: false };
  assert.equal((await run(s, "raw")).result.outcome, "needs_review");
  for (const parkAs of PARKED) {
    const { result, row } = await run(s, "raw", parkAs);
    assert.equal(result.outcome, "suppressed", parkAs);
    assert.equal(row.status, parkAs, parkAs);
  }
});

test("source: every status write in processSingleProspectWith goes through the guarded writeStatus", () => {
  const start = STAGE_SRC.indexOf("export async function processSingleProspectWith");
  const end = STAGE_SRC.indexOf("\nexport ", start + 1);
  const body = STAGE_SRC.slice(start, end);
  const helper = body.slice(body.indexOf("async function writeStatus"), body.indexOf("let hasWebsite"));
  assert.match(helper, /protectedStatusFilter\(fields\.status, "automation"\)/);
  assert.match(helper, /\.not\("status", "in", guard\)/);
  const rest = body.replace(helper, "");
  // No raw prospects UPDATE outside the helper sets a status.
  for (const m of rest.matchAll(/\.update\(\{([^}]*)\}\)/g)) {
    assert.doesNotMatch(m[1]!, /\bstatus\s*:/, m[0]);
  }
  assert.ok((rest.match(/writeStatus\(\{/g) ?? []).length >= 9);
});

test("source: bulkScoreProspects and deep research guard their suppress write; no bulk restore", () => {
  const bulk = readFileSync(new URL("../lib/discover/bulk-actions.ts", import.meta.url), "utf8");
  const fn = bulk.slice(bulk.indexOf("export async function bulkScoreProspects"));
  const scoreFn = fn.slice(0, fn.indexOf("\nexport ", 1));
  assert.doesNotMatch(scoreFn, /status:\s*"researched"/);
  assert.match(scoreFn, /status: "suppressed"[\s\S]*?\.not\("status", "in", protectedStatusFilter\("suppressed", "automation"\)!\)/);
  const deep = readFileSync(new URL("../lib/research/deep-research-stage.ts", import.meta.url), "utf8");
  assert.match(deep, /status: "suppressed"[\s\S]*?\.not\("status", "in", protectedStatusFilter\("suppressed", "automation"\)!\)/);
});

test("bulkScore: a parked prospect scoring ≥ 40 stays parked; one booked or pitched after the read is not suppressed", async () => {
  const id = (n: number) => `00000000-0000-4000-8000-00000000000${n}`;
  const rows: Row[] = [
    { id: id(1), tenant_id: "t1", status: "suppressed", suppressed_reason: "Auto: score 30 below 50" },
    { id: id(2), tenant_id: "t1", status: "no_match", suppressed_reason: null },
    { id: id(3), tenant_id: "t1", status: "raw", suppressed_reason: null },
    { id: id(4), tenant_id: "t1", status: "raw", suppressed_reason: null },
    { id: id(5), tenant_id: "t1", status: "booked", suppressed_reason: null },
    { id: id(6), tenant_id: "t1", status: "raw", suppressed_reason: null },
  ];
  const score: Record<string, number> = { [id(1)]: 55, [id(2)]: 65, [id(3)]: 20, [id(4)]: 20, [id(5)]: 20, [id(6)]: 20 };
  const audits: unknown[] = [];
  const db: Db = {
    tables: { prospects: rows },
    prospectReads: 0,
    statusWrites: [],
    // After the status read: id 3 is booked (a calendar booking mid-request) and
    // id 6 is pitched by a pipeline run. The rule's guard allows suppressed over
    // pitched; only the early-funnel WHERE refuses it.
    afterFirstProspectRead: () => { rows[2]!.status = "booked"; rows[5]!.status = "pitched"; },
  };
  const supabase = { from: (t: string) => new Query(db, t) };
  (globalThis as Record<string, unknown>).__pipelineStubs = {
    revalidatePath: () => undefined,
    requireUser: async () => ({ id: "u1", tenantId: "t1", role: "admin" }),
    createClient: async () => supabase,
    scoreProspect: async (pid: string) => ({ ok: true, composite_score: score[pid] }),
    writeAuditLog: async (a: unknown) => { audits.push(a); },
  };
  const { bulkScoreProspects } = await import(BULK_URL.href);
  const res = await bulkScoreProspects({ prospect_ids: rows.map((r) => r.id) });
  assert.equal(res.ok, true);
  assert.deepEqual(rows.map((r) => r.status), ["suppressed", "no_match", "booked", "suppressed", "booked", "pitched"]);
  assert.equal(rows[0]!.suppressed_reason, "Auto: score 30 below 50");
  // Only the row that actually moved is audited.
  assert.equal(audits.length, 1);
});
