/**
 * handsoff-autopilot (tasks/briefs/handsoff-autopilot.md): the autopilot
 * recovers from a bad day without a person.
 *
 *   1. veto + a quality trip or factual error restarts the veto clock (stays
 *      veto, pulls back waiting automatic approvals, insight + email); auto
 *      still drops to veto; nothing automatic returns shadow.
 *   2. the gmail_api breaker counts recorded Gmail send failures per inbox
 *      (today, after the latest resume) and can fire.
 *   3. a tick that hit errors leaves one autopilot.tick_errors audit row
 *      (frozen contract with health-alarms), a clean tick none.
 *
 * Runs the real runTick: tick.ts imports "server-only" and "@/" aliases, so a
 * loader hook (as in tests/autopilot-trust-split.test.ts) stubs every import
 * of tick.ts except the autopilot modules under test.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { register } from "node:module";
import test from "node:test";
import {
  evaluateBreakers,
  heldAction,
  nextStage,
  stageClockStart,
  VETO_RESTART_HOLD_REASON,
  type Stage,
  type StageMetrics,
} from "../lib/autopilot/governor.ts";
import { INBOX_RESUMED_ACTION } from "../lib/autopilot/inbox-resume.ts";
import {
  GMAIL_SEND_FAILED_ACTION,
  gmailFailuresToday,
  recordSendFailure,
} from "../lib/autopilot/send-failures.ts";

const u = (p: string) => new URL(p, import.meta.url).href;
const TICK = u("../lib/autopilot/tick.ts");
/** Imports that load for real; everything else tick.ts imports is stubbed. */
const REAL: Record<string, Record<string, string>> = {
  [TICK]: {
    "./governor": u("../lib/autopilot/governor.ts"),
    "./hold": u("../lib/autopilot/hold.ts"),
    "./bounce-breaker": u("../lib/autopilot/bounce-breaker.ts"),
    "./opt-out-count": u("../lib/autopilot/opt-out-count.ts"),
    "./send-failures": u("../lib/autopilot/send-failures.ts"),
  },
};

/** Every value import of a parent, by specifier (type-only names are stripped by node). */
function importsOf(url: string): Record<string, string[]> {
  const src = readFileSync(new URL(url), "utf8");
  const out: Record<string, string[]> = {};
  for (const [, names, from] of src.matchAll(/^import \{([^}]*)\} from "([^"]+)";/gm)) {
    out[from!] = names!.split(",").map((n) => n.trim()).filter((n) => n && !n.startsWith("type "));
  }
  for (const [, from] of src.matchAll(/^import \* as \w+ from "([^"]+)";/gm)) out[from!] = ["captureMessage", "captureException"];
  return out;
}
const STUBS = Object.fromEntries(Object.keys(REAL).map((p) => [p, importsOf(p)]));

const hooks = `
const REAL = ${JSON.stringify(REAL)};
const STUBS = ${JSON.stringify(STUBS)};
export async function resolve(spec, ctx, next) {
  const parent = ctx.parentURL;
  if (parent in REAL && !spec.startsWith("node:")) {
    if (REAL[parent][spec]) return { url: REAL[parent][spec], shortCircuit: true };
    return { url: "stub:" + encodeURIComponent(parent) + "|" + encodeURIComponent(spec), shortCircuit: true };
  }
  return next(spec, ctx);
}
export async function load(url, ctx, next) {
  if (!url.startsWith("stub:")) return next(url, ctx);
  const [parent, spec] = url.slice(5).split("|").map(decodeURIComponent);
  const names = (STUBS[parent] || {})[spec] || [];
  const src = names.map((n) =>
    "export const " + n + " = Object.hasOwn(globalThis.__stubValues, " + JSON.stringify(n) + ") ? globalThis.__stubValues[" + JSON.stringify(n) + "]" +
    " : (...a) => globalThis.__stubCall(" + JSON.stringify(n) + ", a);").join("\\n");
  return { format: "module", source: src, shortCircuit: true };
}`;
register("data:text/javascript," + encodeURIComponent(hooks));

// ── Stubs ────────────────────────────────────────────────────────────────────

type Row = Record<string, unknown>;
const calls: Array<{ name: string; args: unknown[] }> = [];
/** Stub functions that answer; any other stubbed function records the call and throws. */
const answers: Record<string, (...a: unknown[]) => unknown> = {};
const g = globalThis as unknown as { __stubValues: Record<string, unknown>; __stubCall: (n: string, a: unknown[]) => unknown };
g.__stubCall = (name, args) => {
  calls.push({ name, args });
  const f = answers[name];
  if (!f) throw new Error(`stub ${name} called`);
  return f(...args);
};
g.__stubValues = {
  NextResponse: { json: (body: unknown, init?: unknown) => ({ body, init }) },
  EMPTY_JOB_STATS: {},
  WRITER_FIXABLE: new Set<string>(),
  ATTRIBUTION_WINDOW_DAYS: 30,
  OUTCOME_EVENT_TYPES: [],
  EXEMPLAR_CANDIDATE_COLUMNS: "id",
};

// ── Fake Supabase (filters applied the way Postgres would) ───────────────────

const cmp = (a: unknown, b: unknown): number => {
  const ta = Date.parse(String(a));
  const tb = Date.parse(String(b));
  if (!Number.isNaN(ta) && !Number.isNaN(tb)) return ta - tb;
  return String(a) < String(b) ? -1 : String(a) > String(b) ? 1 : 0;
};

/** A select list as PostgREST reads it: "a, b, alias:fk(c, d)" → { a, b, alias: { c, d } }. */
type Cols = Map<string, Cols | null>;
function parseSelect(sel: string): Cols | null {
  if (sel.trim() === "*") return null;
  const cols: Cols = new Map();
  let depth = 0;
  let part = "";
  const flush = () => {
    const t = part.trim();
    part = "";
    if (!t) return;
    const m = t.match(/^(?:(\w+):)?(\w+)(?:!\w+)?(?:\((.*)\))?$/s);
    if (!m) throw new Error(`fake select can't read "${t}"`);
    cols.set(m[1] ?? m[2]!, m[3] === undefined ? null : parseSelect(m[3]));
  };
  for (const ch of sel) {
    if (ch === "(") depth++;
    if (ch === ")") depth--;
    if (ch === "," && depth === 0) flush();
    else part += ch;
  }
  flush();
  return cols;
}
/** Only the selected columns come back, embeds included: a column left out of the select is absent. */
function project(v: unknown, cols: Cols | null): unknown {
  if (cols === null || v === null || v === undefined) return v;
  if (Array.isArray(v)) return v.map((x) => project(x, cols));
  const out: Row = {};
  for (const [k, sub] of cols) if (k in (v as Row)) out[k] = sub ? project((v as Row)[k], sub) : (v as Row)[k];
  return out;
}

function fakeDb(tables: Record<string, Row[]>, failInsert: (table: string, rows: Row[]) => boolean = () => false) {
  let seq = 0;
  const db = {
    tables,
    writes: [] as string[],
    from(table: string) {
      const rows = (tables[table] ??= []);
      const filters: Array<(r: Row) => boolean> = [];
      let op: "select" | "update" | "insert" = "select";
      let patch: Row = {};
      let inserted: Row[] = [];
      let returning = false;
      let count = false;
      let head = false;
      let orderBy: { col: string; asc: boolean } | null = null;
      let lim: number | null = null;
      let range: [number, number] | null = null;
      let cols: Cols | null = null;
      const get = (r: Row, k: string): unknown => {
        const [col, key] = k.split("->>") as [string, string | undefined];
        if (key === undefined) return r[col] ?? null;
        const v = (r[col] as Row | null)?.[key];
        return v === undefined || v === null ? null : String(v);
      };
      const run = () => {
        if (op === "insert") {
          if (failInsert(table, inserted)) return { data: null, count: null, error: { message: "" } };
          rows.push(...inserted);
          return { data: null, count: null, error: null };
        }
        let hit = rows.filter((r) => filters.every((f) => f(r)));
        if (op === "update") {
          for (const r of hit) Object.assign(r, patch);
          return { data: returning ? hit.map((r) => ({ id: r.id })) : null, count: null, error: null };
        }
        if (orderBy) {
          const { col, asc } = orderBy;
          hit = [...hit].sort((a, b) => (asc ? 1 : -1) * cmp(a[col], b[col]));
        }
        if (range) hit = hit.slice(range[0], range[1] + 1);
        if (lim !== null) hit = hit.slice(0, lim);
        return { data: head ? null : hit.map((r) => project({ ...r }, cols)), count: count ? hit.length : null, error: null };
      };
      const b = {
        select(c?: string, o?: { count?: string; head?: boolean }) {
          if (op !== "select") returning = true;
          else if (c) cols = parseSelect(c);
          if (o?.count) count = true;
          if (o?.head) head = true;
          return b;
        },
        update(v: Row) {
          db.writes.push(`${table}.update`);
          op = "update";
          patch = v;
          return b;
        },
        insert(v: Row | Row[]) {
          db.writes.push(`${table}.insert`);
          op = "insert";
          inserted = (Array.isArray(v) ? v : [v]).map((r) => ({ id: `${table}-${++seq}`, created_at: new Date().toISOString(), ...r }));
          return b;
        },
        eq(k: string, v: unknown) { filters.push((r) => get(r, k) === v); return b; },
        neq(k: string, v: unknown) { filters.push((r) => get(r, k) !== v); return b; },
        in(k: string, vs: unknown[]) { filters.push((r) => vs.includes(get(r, k))); return b; },
        is(k: string, v: null) { filters.push((r) => get(r, k) === v); return b; },
        not(k: string, o: string, v: null) { assert.equal(o, "is"); filters.push((r) => get(r, k) !== v); return b; },
        gt(k: string, v: string) { filters.push((r) => get(r, k) !== null && cmp(get(r, k), v) > 0); return b; },
        gte(k: string, v: string) { filters.push((r) => get(r, k) !== null && cmp(get(r, k), v) >= 0); return b; },
        lt(k: string, v: string) { filters.push((r) => get(r, k) !== null && cmp(get(r, k), v) < 0); return b; },
        lte(k: string, v: string) { filters.push((r) => get(r, k) !== null && cmp(get(r, k), v) <= 0); return b; },
        order(col: string, o?: { ascending?: boolean }) { orderBy = { col, asc: o?.ascending !== false }; return b; },
        limit(n: number) { lim = n; return b; },
        range(a: number, z: number) { range = [a, z]; return b; },
        // Not needed by the rows under test: no filter (a query using them reads what it reads).
        or() { return b; },
        abortSignal() { return b; },
        maybeSingle() {
          const res = run();
          return Promise.resolve({ data: Array.isArray(res.data) ? (res.data[0] ?? null) : res.data, error: res.error });
        },
        then<T>(resolve: (v: ReturnType<typeof run>) => T, reject?: (e: unknown) => T) {
          return Promise.resolve(run()).then(resolve, reject);
        },
      };
      return b;
    },
  };
  return db;
}
type Db = ReturnType<typeof fakeDb>;

type TickModule = {
  runTick: (actor: unknown, now?: Date) => Promise<Row & { errors: string[]; breakers: Array<Row>; stageChange: Row | null; pulledBack?: number }>;
  recordTickErrors: (db: unknown, tenantId: string, errors: readonly string[]) => Promise<void>;
  TICK_ERRORS_ACTION: string;
};
const tick = (await import(TICK)) as TickModule;

const TENANT = "11111111-1111-1111-1111-111111111111";
const INBOX = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
const INBOX2 = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";
const DAY = 86_400_000;
const ago = (min: number) => new Date(Date.now() - min * 60_000).toISOString();
const ahead = (min: number) => new Date(Date.now() + min * 60_000).toISOString();
/** A time today (UTC) at least a little in the past, `min` minutes after midnight (capped to now - 1 min). */
const todayAt = (min: number) => {
  const midnight = new Date();
  midnight.setUTCHours(0, 0, 0, 0);
  return new Date(Math.min(midnight.getTime() + min * 60_000, Date.now() - 60_000)).toISOString();
};

/** Stubs any tick may call. Everything else stubbed throws (and lands in report.errors). */
function wire(extra: Record<string, (...a: unknown[]) => unknown> = {}) {
  calls.length = 0;
  for (const k of Object.keys(answers)) delete answers[k];
  Object.assign(answers, {
    sendNotification: async () => ({ sent: 1, failed: [] }),
    checkDeliverabilityHealth: async () => ({ blocklist: { listed_on: [] } }),
    analyzeSpamRate: () => ({ inboxRate: null }),
    holdSecret: () => "test-secret",
    editRatio: () => 0,
    learnFromOutcomes: async () => undefined,
    evolveSearchSpace: async () => null,
    weeklyReview: async () => null,
    ...extra,
  });
}
const actorFor = (db: Db) => ({ supabase: db, user: { tenantId: TENANT } });
const subjects = () => calls.filter((c) => c.name === "sendNotification").map((c) => (c.args[2] as { subject: string }).subject);
const tickErrorRows = (db: Db) => (db.tables.audit_log ?? []).filter((r) => r.action === "autopilot.tick_errors");

/** Kill switch off: runTick runs only its safety steps (pull-back, digest, breakers). Stage auto skips the digest. */
function safetyDb(inboxes: string[] = [INBOX], audit: Row[] = []): Db {
  return fakeDb({
    autonomy_state: [{ tenant_id: TENANT, stage: "auto", stage_since: ago(60 * 24 * 3), enabled: false }],
    sender_inboxes: inboxes.map((id, i) => ({ id, tenant_id: TENANT, email: `s${i}@runnareach.com`, paused: false, paused_reason: null })),
    pitches: [],
    pitch_events: [],
    audit_log: audit,
    learning_insights: [],
    domain_health: [],
    warmup_log: [],
  });
}
const failure = (inboxId: string, at: string, tenantId = TENANT): Row => ({
  id: `f-${Math.random()}`, tenant_id: tenantId, actor_id: null, action: GMAIL_SEND_FAILED_ACTION,
  entity_type: "sender_inbox", entity_id: inboxId, metadata: { pitch_id: null, error: "Gmail send failed (500)" }, created_at: at,
});
const resume = (inboxId: string, at: string): Row => ({
  id: `r-${Math.random()}`, tenant_id: TENANT, action: INBOX_RESUMED_ACTION, entity_type: "sender_inbox", entity_id: inboxId, metadata: {}, created_at: at,
});

// ── 1. Stage: veto restarts its clock, nothing automatic returns shadow ──────

const m0: StageMetrics = {
  daysInStage: 3, autoDecided: 0, autoApprovedUnedited: 0, autoFactualErrors: 0,
  autoScheduled: 10, autoVetoed: 0, autoBounceRate: 0, autoQualityTrips: 0,
};

test("nextStage: veto + a quality trip restarts the veto clock; veto + a factual error the same", () => {
  assert.deepEqual(nextStage("veto", { ...m0, autoQualityTrips: 1, autoQualityTripCodes: ["opt_out_spike"] }), {
    stage: "veto", reason: "a quality breaker tripped: opt_out_spike; veto clock restarted", restart: true,
  });
  assert.deepEqual(nextStage("veto", { ...m0, autoFactualErrors: 2 }), {
    stage: "veto", reason: "an automatic pitch had a factual or recipient error; veto clock restarted", restart: true,
  });
  // A veto that would otherwise be promoted is not: trouble wins.
  assert.equal(nextStage("veto", { ...m0, daysInStage: 30, autoScheduled: 500, autoQualityTrips: 1 }).restart, true);
});

test("nextStage: auto + a trip still drops to veto, no restart flag; a quiet veto has none either", () => {
  assert.deepEqual(nextStage("auto", { ...m0, autoQualityTrips: 1 }), { stage: "veto", reason: "a quality breaker tripped" });
  assert.deepEqual(nextStage("auto", { ...m0, autoFactualErrors: 1 }), { stage: "veto", reason: "an automatic pitch had a factual or recipient error" });
  assert.deepEqual(nextStage("veto", m0), { stage: "veto", reason: "collecting veto data" });
});

test("nextStage property: from veto, auto or off, no input ever returns shadow; restart only from veto", () => {
  let seed = 7;
  const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
  const pick = <T,>(xs: readonly T[]): T => xs[Math.floor(rnd() * xs.length)]!;
  for (let i = 0; i < 5000; i++) {
    const from = pick(["off", "shadow", "veto", "auto"] as const satisfies readonly Stage[]);
    const decided = Math.floor(rnd() * 300);
    const scheduled = Math.floor(rnd() * 300);
    const m: StageMetrics = {
      daysInStage: rnd() * 40,
      autoDecided: decided,
      autoApprovedUnedited: Math.floor(rnd() * (decided + 1)),
      autoFactualErrors: pick([0, 0, 0, 1, 3]),
      autoScheduled: scheduled,
      autoVetoed: Math.floor(rnd() * (scheduled + 1) * 0.1),
      autoBounceRate: rnd() * 0.05,
      autoQualityTrips: pick([0, 0, 0, 1, 2]),
    };
    const r = nextStage(from, m);
    if (from !== "shadow") assert.notEqual(r.stage, "shadow", `${from} ${JSON.stringify(m)}`);
    if (r.restart) assert.equal(from, "veto");
    if (r.restart) assert.equal(r.stage, "veto");
  }
});

/** Veto, enabled, three days in. One automatic approval waiting, one a person approved by hand, one opt_out_spike trip. */
function vetoDb(over: Partial<Row> = {}, trip = true): Db {
  const since = ago(60 * 24 * 3);
  const waiting = (id: string) => ({
    id, tenant_id: TENANT, status: "approved", autopilot_lane: "auto", autopilot_reasons: [], sent_at: null,
    scheduled_send_at: ahead(600), queued_at: ago(60), sender_inbox_id: INBOX, subject: `Hello ${id}`,
    prospects: { company_name: id }, body_original: "b", body_edited: null, created_at: ago(120),
  });
  const approval = (pitchId: string, autopilot: boolean) => ({
    id: `appr-${pitchId}`, tenant_id: TENANT, pitch_id: pitchId, event_type: "approved", event_at: ago(100), payload: { autopilot },
  });
  return fakeDb({
    autonomy_state: [{ tenant_id: TENANT, stage: "veto", stage_since: since, enabled: true, ...over }],
    sender_inboxes: [],
    pitches: [waiting("auto-1"), waiting("by-person")],
    pitch_events: [approval("auto-1", true), approval("by-person", false)],
    // The digest already ran this slot, so it stays quiet.
    audit_log: [{ id: "d", tenant_id: TENANT, action: "autopilot.digest", entity_type: "tenant", entity_id: TENANT, metadata: {}, created_at: ago(1) }],
    learning_insights: trip
      ? [{ id: "t", tenant_id: TENANT, kind: "breaker", evidence: { scope: "all", code: "opt_out_spike", reason: "4 opt-outs" }, created_at: ago(30) }]
      : [],
    domain_health: [],
    warmup_log: [],
    discovery_jobs: [],
  });
}

test("tick: veto + quality trip restarts stage_since, pulls back the AUTO approval, writes an insight and emails", async () => {
  const db = vetoDb();
  wire();
  const before = Date.now();
  const report = await tick.runTick(actorFor(db));
  assert.deepEqual(report.errors, []);
  const state = db.tables.autonomy_state![0]!;
  assert.equal(state.stage, "veto", "never shadow");
  assert.ok(Date.parse(String(state.stage_since)) >= before - 1000, "the veto clock restarted at now");
  assert.deepEqual(report.stageChange, { from: "veto", to: "veto", reason: "a quality breaker tripped: opt_out_spike; veto clock restarted" });

  const byId = Object.fromEntries(db.tables.pitches!.map((p) => [p.id, p]));
  assert.equal(byId["auto-1"]!.status, "draft", "the automatic approval is pulled back");
  assert.deepEqual(byId["auto-1"]!.autopilot_reasons, [VETO_RESTART_HOLD_REASON]);
  assert.ok(String(VETO_RESTART_HOLD_REASON).startsWith("held by the autopilot"), "not a person's veto (governor vetoedByPerson)");
  assert.equal(byId["by-person"]!.status, "approved", "a person's approval is never touched");
  assert.equal(report.pulledBack, 1);
  const held = db.tables.audit_log!.filter((r) => r.action === "pitch.held");
  assert.deepEqual(held.map((r) => [r.entity_id, r.metadata]), [["auto-1", { source: "demotion", stage: "veto" }]]);

  const stageInsights = db.tables.learning_insights!.filter((r) => r.kind === "stage");
  assert.equal(stageInsights.length, 1);
  assert.equal(stageInsights[0]!.title, "Autopilot veto clock restarted");
  assert.match(String(stageInsights[0]!.detail), /veto clock restarted/);
  assert.deepEqual(subjects().filter((x) => x.startsWith("Autopilot")), ["Autopilot restarted the veto clock"]);
  const body = (calls.find((c) => c.name === "sendNotification")!.args[2] as { body: string }).body;
  assert.match(body, /stays in veto; the 14-day \/ 100-scheduled count toward auto starts again today/);
  assert.match(body, /Pulled back 1 automatic email/);

  // The next tick: the trip predates the new clock, so nothing restarts again.
  wire();
  const again = await tick.runTick(actorFor(db));
  assert.equal(again.stageChange, null);
  assert.deepEqual(subjects().filter((x) => x.startsWith("Autopilot")), []);
});

test("tick: veto + a factual error (a rejected AUTO pitch) restarts the clock the same way", async () => {
  const db = vetoDb({}, false);
  db.tables.pitches!.push({ id: "rej", tenant_id: TENANT, status: "reviewer_rejected", autopilot_lane: "auto", body_original: "b", body_edited: null, sent_at: null, created_at: ago(60) });
  wire();
  const report = await tick.runTick(actorFor(db));
  assert.equal(db.tables.autonomy_state![0]!.stage, "veto");
  assert.equal(report.stageChange?.reason, "an automatic pitch had a factual or recipient error; veto clock restarted");
  assert.equal(report.pulledBack, 1);
});

test("tick: auto + quality trip still drops to veto (unchanged), with the old title and no pull-back", async () => {
  const db = vetoDb({ stage: "auto" });
  wire();
  const report = await tick.runTick(actorFor(db));
  assert.equal(db.tables.autonomy_state![0]!.stage, "veto");
  assert.deepEqual(report.stageChange, { from: "auto", to: "veto", reason: "a quality breaker tripped: opt_out_spike" });
  assert.equal(db.tables.learning_insights!.find((r) => r.kind === "stage")!.title, "Autopilot auto → veto");
  assert.equal(db.tables.pitches!.find((p) => p.id === "auto-1")!.status, "approved", "auto → veto never pulled back, and still doesn't");
});

test("tick: a failed clock write still pulls back, reports the error, sends no email", async () => {
  const db = vetoDb();
  const realFrom = db.from.bind(db);
  db.from = (table: string) => {
    const b = realFrom(table);
    if (table !== "autonomy_state") return b;
    const update = b.update.bind(b);
    b.update = (v: Row) => {
      const r = update(v);
      if (!("stage_since" in v)) return r;
      const failed: Record<string, unknown> = {
        then: (ok: (x: unknown) => unknown) => Promise.resolve({ data: null, error: { message: "" } }).then(ok),
      };
      failed.eq = failed.select = () => failed;
      return failed as unknown as typeof b;
    };
    return b;
  };
  wire();
  const report = await tick.runTick(actorFor(db));
  assert.equal(db.tables.pitches!.find((p) => p.id === "auto-1")!.status, "draft", "pulled back anyway");
  assert.ok(report.errors.some((e) => /^stage: veto clock restart not recorded \(no detail\); pulled back 1/.test(e)), report.errors.join(" | "));
  assert.deepEqual(subjects().filter((x) => x.startsWith("Autopilot")), []);
  assert.equal(tickErrorRows(db).length, 1, "and the health check can see it");
});

/** Three people unsubscribed in the last hour and one unpaused inbox: opt_out_spike fires INSIDE the tick. */
function spikeInsideTickDb(stage: Stage): Db {
  const db = vetoDb({ stage }, false);
  db.tables.sender_inboxes = [{ id: INBOX, tenant_id: TENANT, email: "s0@runnareach.com", paused: false, paused_reason: null }];
  for (const n of [1, 2, 3]) {
    db.tables.pitches!.push({ id: `old-${n}`, tenant_id: TENANT, prospect_id: `prospect-${n}`, status: "sent", autopilot_lane: "review", sent_at: ago(60 * 48), created_at: ago(60 * 72) });
    db.tables.pitch_events!.push({ id: `u-${n}`, tenant_id: TENANT, pitch_id: `old-${n}`, event_type: "unsubscribe", event_at: ago(30 + n), payload: {} });
  }
  return db;
}

for (const stage of ["veto", "auto"] as const) {
  test(`tick: a quality trip written INSIDE tick 1 (${stage}) acts once over ticks at t, t+15m, t+30m`, async () => {
    const db = spikeInsideTickDb(stage);
    const t = Date.now();
    const changes: unknown[] = [];
    const stageEmails: string[] = [];
    for (const k of [0, 15, 30]) {
      wire();
      const report = await tick.runTick(actorFor(db), new Date(t + k * 60_000));
      changes.push(report.stageChange && [report.stageChange.from, report.stageChange.to]);
      stageEmails.push(...subjects().filter((x) => /^Autopilot (restarted|moved)/.test(x)));
    }
    assert.deepEqual(db.tables.learning_insights!.filter((r) => r.kind === "breaker").map((r) => (r.evidence as Row).code), ["opt_out_spike"], "the trip was written in tick 1");
    assert.deepEqual(changes, [[stage, "veto"], null, null], "exactly one restart / demotion");
    assert.equal(stageEmails.length, 1, "one email");
    assert.equal(db.tables.autonomy_state![0]!.stage, "veto");
  });
}

test("tick: a person's stage change between the read and the write wins (guarded write, no pull-back, no email)", async () => {
  for (const stage of ["veto", "auto"] as const) {
    const db = vetoDb({ stage });
    const realFrom = db.from.bind(db);
    db.from = (table: string) => {
      const b = realFrom(table);
      if (table !== "autonomy_state") return b;
      const update = b.update.bind(b);
      b.update = (v: Row) => {
        if ("stage_since" in v) db.tables.autonomy_state![0]!.stage = "shadow"; // the person, just before
        return update(v);
      };
      return b;
    };
    wire();
    const report = await tick.runTick(actorFor(db));
    assert.equal(db.tables.autonomy_state![0]!.stage, "shadow", stage);
    assert.equal(report.stageChange, null, stage);
    assert.equal(db.tables.pitches!.find((p) => p.id === "auto-1")!.status, "approved", `${stage}: the next tick's shadow sweep holds it, not this one`);
    assert.deepEqual(subjects().filter((x) => x.startsWith("Autopilot")), [], stage);
  }
});

test("stageClockStart: the later of the write clock and 1 ms after the newest evidence", () => {
  const w = new Date("2026-10-22T17:50:23.221Z");
  assert.equal(stageClockStart(w, []), "2026-10-22T17:50:23.221Z");
  assert.equal(stageClockStart(w, [null, "2026-10-22T17:50:23.232Z", "2026-10-21T00:00:00Z"]), "2026-10-22T17:50:23.233Z");
  assert.equal(stageClockStart(w, ["2026-10-22T10:00:00Z", undefined, "not a date"]), "2026-10-22T17:50:23.221Z");
});

test("heldAction says the veto clock restarted for a restart pull-back, and stage dropped for a demotion", () => {
  const d = (reasons: string[]) => heldAction({ lane: "review", reasons, isRewrite: false, editedByPerson: false }, new Set());
  assert.deepEqual(d([VETO_RESTART_HOLD_REASON]), { action: "leave", why: "the autopilot pulled it back when the veto clock restarted" });
  assert.deepEqual(d(["held by the autopilot: stage dropped to shadow"]), { action: "leave", why: "the autopilot pulled it back when its stage dropped" });
});

// ── 2. The gmail_api breaker ─────────────────────────────────────────────────

test("evaluateBreakers: 3 Gmail errors today on an inbox trips gmail_api for that inbox; 2 does not", () => {
  const quiet = { hardBouncesToday: 0, optOutsThisWeek: 0, optOutWeeklyBaseline: 0, dmarcPassRate: null, blocklisted: false, warmupInboxRate: null };
  const inbox = (id: string, n: number) => ({ id, recentSends: 10, recentHardBounces: 0, apiErrorsToday: n });
  assert.deepEqual(evaluateBreakers({ ...quiet, inboxes: [inbox(INBOX, 3), inbox(INBOX2, 2)] }), [
    { scope: "inbox", inboxId: INBOX, code: "gmail_api", reason: "3 Gmail API errors today" },
  ]);
});

test("tick: 3 recorded Gmail failures today pause that inbox (gmail_api); 2 on another inbox do not", async () => {
  const db = safetyDb([INBOX, INBOX2], [
    failure(INBOX, todayAt(1)), failure(INBOX, todayAt(2)), failure(INBOX, todayAt(3)),
    failure(INBOX2, todayAt(1)), failure(INBOX2, todayAt(2)),
  ]);
  wire();
  const report = await tick.runTick(actorFor(db));
  assert.deepEqual(report.breakers.map((t) => [t.code, t.inboxId]), [["gmail_api", INBOX]]);
  const [a, b] = db.tables.sender_inboxes!;
  assert.equal(a!.paused, true);
  assert.equal(a!.paused_reason, "Autopilot breaker (gmail_api): 3 Gmail API errors today");
  assert.equal(b!.paused, false);
  assert.deepEqual(report.errors, []);
});

test("tick: failures before the latest resume, from yesterday, or of another tenant don't count", async () => {
  const yesterday = new Date(Date.now() - DAY).toISOString();
  const db = safetyDb([INBOX], [
    failure(INBOX, yesterday), failure(INBOX, yesterday), failure(INBOX, yesterday),
    failure(INBOX, todayAt(1)), failure(INBOX, todayAt(2)),
    resume(INBOX, todayAt(3)),
    failure(INBOX, todayAt(4)), failure(INBOX, todayAt(5)),
    failure(INBOX, todayAt(5), "22222222-2222-2222-2222-222222222222"),
  ]);
  wire();
  const report = await tick.runTick(actorFor(db));
  assert.deepEqual(report.breakers, [], "2 after the resume");
  assert.equal(db.tables.sender_inboxes![0]!.paused, false);
});

test("gmail_api counts distinct pitches: one pitch Gmail rejects on every retry never pauses the inbox alone", async () => {
  const same = (at: string) => ({ ...failure(INBOX, at), metadata: { pitch_id: "p-stuck", error: "Gmail send failed (400)" } });
  const db = safetyDb([INBOX], [same(todayAt(1)), same(todayAt(11)), same(todayAt(21)), same(todayAt(31)), { ...failure(INBOX, todayAt(41)), metadata: { pitch_id: "p-2", error: "x" } }]);
  assert.deepEqual(await gmailFailuresToday(db, TENANT, INBOX, new Date(), null), { count: 2, error: null });
  wire();
  const report = await tick.runTick(actorFor(db));
  assert.deepEqual(report.breakers, []);
  db.tables.audit_log!.push({ ...failure(INBOX, todayAt(42)), metadata: { pitch_id: "p-3", error: "x" } });
  wire();
  assert.deepEqual((await tick.runTick(actorFor(db))).breakers.map((t) => t.reason), ["3 Gmail API errors today"]);
});

test("gmailFailuresToday: counts today's rows for that inbox, and reports a read error instead of throwing", async () => {
  const now = new Date();
  const db = safetyDb([INBOX], [failure(INBOX, todayAt(1)), failure(INBOX2, todayAt(1)), { ...failure(INBOX, todayAt(1)), action: "pitch.held" }]);
  assert.deepEqual(await gmailFailuresToday(db, TENANT, INBOX, now, null), { count: 1, error: null });
  const broken = { from: () => ({ select: () => broken.q, q: null }) } as unknown as { q: unknown };
  const q: Record<string, unknown> = {};
  for (const m of ["eq", "gt"]) q[m] = () => q;
  q.gte = () => q;
  q.limit = () => Promise.resolve({ data: null, error: { message: "" } });
  (broken as { q: unknown }).q = q;
  assert.deepEqual(await gmailFailuresToday(broken, TENANT, INBOX, now, null), { count: 0, error: "gmail failures: no detail" });
});

test("recordSendFailure: one audit row with the contract shape, error cut to 300; never throws", async () => {
  const db = safetyDb([INBOX]);
  await recordSendFailure(db, { tenantId: TENANT, inboxId: INBOX, pitchId: "p1", error: "x".repeat(500) });
  const rows = db.tables.audit_log!;
  assert.equal(rows.length, 1);
  const { id: _id, created_at: _c, ...row } = rows[0]!;
  assert.deepEqual(row, {
    tenant_id: TENANT, actor_id: null, action: "gmail.send_failed", entity_type: "sender_inbox", entity_id: INBOX,
    metadata: { pitch_id: "p1", error: "x".repeat(300) },
  });
  const { warn } = console;
  console.warn = () => {};
  try {
    await recordSendFailure(fakeDb({}, () => true), { tenantId: TENANT, inboxId: INBOX, pitchId: null, error: "e" });
    await recordSendFailure({ from: () => { throw new Error("boom"); } }, { tenantId: TENANT, inboxId: INBOX, pitchId: null, error: "e" });
  } finally {
    console.warn = warn;
  }
});

const SEND_SITES = ["app/api/pitches/send-queue/route.ts", "app/api/pitches/follow-up/route.ts", "lib/pitches/send-action.ts"];

test("each send path records exactly once, inside the failed-send branch after the release (never on DNC/gate/claim refusals)", () => {
  for (const file of SEND_SITES) {
    const s = readFileSync(new URL(`../${file}`, import.meta.url), "utf8");
    assert.equal(s.match(/recordSendFailure\(/g)?.length, 1, `${file}: one call`);
    assert.equal(s.match(/await sendGmailMessage\(/g)?.length, 1, `${file}: one send`);
    const send = s.indexOf("await sendGmailMessage(");
    const branch = s.indexOf("if (!sendResult.ok) {", send);
    const call = s.indexOf("await recordSendFailure(");
    assert.ok(send > 0 && branch > send && call > branch, `${file}: after the failed send`);
    // The branch, up to its exit: only the slot + claim release come before the record, and the exit right after.
    const body = s.slice(branch + "if (!sendResult.ok) {".length, call).replace(/\/\/.*$/gm, "");
    const statements = body.split(";").map((x) => x.trim()).filter(Boolean);
    assert.deepEqual(statements.map((x) => x.replace(/\(.*$/s, "")), ["await releaseSendSlot", file.includes("follow-up") ? "await release" : "await releaseClaim"], file);
    const rest = s.slice(s.indexOf("\n", call) + 1);
    assert.match(rest, /^\s*(results\.push\([^\n]*\n\s*continue;|return )/, `${file}: the branch exits right after`);
    assert.match(s.slice(call, s.indexOf("\n", call)), /error: sendResult\.error \}\);$/);
  }
});

// ── 3. The tick-errors row (frozen contract with health-alarms) ──────────────

test("tick with errors writes exactly one autopilot.tick_errors row with the contract shape", async () => {
  const db = safetyDb([INBOX]);
  wire({ analyzeSpamRate: () => { throw new Error("placement unreadable"); } });
  const report = await tick.runTick(actorFor(db));
  assert.deepEqual(report.errors, ["breakers: placement unreadable"]);
  const rows = tickErrorRows(db);
  assert.equal(rows.length, 1);
  const { id: _id, created_at: _c, ...row } = rows[0]!;
  assert.deepEqual(row, {
    tenant_id: TENANT, actor_id: null, action: "autopilot.tick_errors", entity_type: "tenant", entity_id: TENANT,
    metadata: { errors: ["breakers: placement unreadable"] },
  });
  assert.equal(tick.TICK_ERRORS_ACTION, "autopilot.tick_errors");
});

test("a clean tick writes no tick_errors row", async () => {
  const db = safetyDb([INBOX]);
  wire();
  const report = await tick.runTick(actorFor(db));
  assert.deepEqual(report.errors, []);
  assert.deepEqual(tickErrorRows(db), []);
});

test("a failed tick_errors insert does not break the tick", async () => {
  const db = fakeDb(safetyDb([INBOX]).tables, (table, rows) => table === "audit_log" && rows.some((r) => r.action === "autopilot.tick_errors"));
  wire({ analyzeSpamRate: () => { throw new Error("placement unreadable"); } });
  const { warn } = console;
  const warned: unknown[] = [];
  console.warn = (...a: unknown[]) => { warned.push(a); };
  try {
    const report = await tick.runTick(actorFor(db));
    assert.deepEqual(report.errors, ["breakers: placement unreadable"]);
  } finally {
    console.warn = warn;
  }
  assert.deepEqual(tickErrorRows(db), []);
  assert.equal(warned.length, 1, "logged");
  await tick.recordTickErrors({ from: () => { throw new Error("boom"); } }, TENANT, ["x"]);
});

test("a throw outside any step still writes the tick_errors row, and the tick still fails", async () => {
  const db = safetyDb([INBOX]);
  const realFrom = db.from.bind(db);
  db.from = (table: string) => {
    if (table === "autonomy_state") throw new Error("state unreadable");
    return realFrom(table);
  };
  wire();
  await assert.rejects(tick.runTick(actorFor(db)), /state unreadable/);
  assert.deepEqual(tickErrorRows(db).map((r) => r.metadata), [{ errors: ["tick: state unreadable"] }]);
});

test("recordTickErrors: at most 20 errors, each cut to 300 chars", async () => {
  const db = safetyDb([]);
  await tick.recordTickErrors(db, TENANT, Array.from({ length: 25 }, (_, i) => `${i}:${"e".repeat(400)}`));
  const errors = (tickErrorRows(db)[0]!.metadata as { errors: string[] }).errors;
  assert.equal(errors.length, 20);
  assert.ok(errors.every((e) => e.length === 300));
  assert.ok(errors[0]!.startsWith("0:") && errors[19]!.startsWith("19:"));
});
