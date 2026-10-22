/**
 * autopilot-trust-split, end to end through the code prod runs:
 *
 *   - the tick route ticks a tenant with the kill switch OFF, and the real
 *     runTick then runs only its safety steps: the pull-back (before the
 *     digest), the digest, and the breakers (pause + email). Nothing else.
 *   - the weekly report's producer (lib/reports/snapshot.ts gatherWeeklyRaw)
 *     carries autopilot_reasons, so a pull-back is not counted as a veto.
 *
 * route.ts, tick.ts and snapshot.ts import "server-only", "@/" aliases and
 * Next, which node cannot load here, so a loader hook (as in
 * tests/pipeline-status-rule.test.ts) stubs every import of those three files
 * except the autopilot modules under test (governor, hold, bounce-breaker,
 * opt-out-count, and tick itself for the route). Each stub records its calls; the db is a fake that
 * applies the filters the way Postgres would.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { register } from "node:module";
import test from "node:test";
import { buildWeeklyStats, type WeeklyRaw } from "../lib/reports/weekly.ts";

const u = (p: string) => new URL(p, import.meta.url).href;
const ROUTE = u("../app/api/autopilot/tick/route.ts");
const TICK = u("../lib/autopilot/tick.ts");
const SNAPSHOT = u("../lib/reports/snapshot.ts");
/** Imports that load for real; everything else a parent imports is stubbed. */
const REAL: Record<string, Record<string, string>> = {
  [ROUTE]: { "@/lib/autopilot/tick": TICK },
  [TICK]: {
    "./governor": u("../lib/autopilot/governor.ts"),
    "./hold": u("../lib/autopilot/hold.ts"),
    "./bounce-breaker": u("../lib/autopilot/bounce-breaker.ts"),
    "./opt-out-count": u("../lib/autopilot/opt-out-count.ts"),
  },
  [SNAPSHOT]: {},
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
  // The cron heartbeat (tests/health-alarms.test.ts) passes the run through.
  withHeartbeat: (_job: unknown, run: () => unknown) => run(),
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

function fakeDb(tables: Record<string, Row[]>) {
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

// ── The route with the kill switch off ───────────────────────────────────────

const TENANT = "11111111-1111-1111-1111-111111111111";
const INBOX = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
const ago = (min: number) => new Date(Date.now() - min * 60_000).toISOString();
const ahead = (min: number) => new Date(Date.now() + min * 60_000).toISOString();

/**
 * Kill switch off in veto. One inbox, 30 sends, 2 fresh hard bounces (the
 * inbox_bounces breaker). One automatic approval waiting to send within the
 * digest horizon, one a person approved by hand.
 */
function killSwitchDb(over: Partial<Row> = {}): Db {
  const pitches: Row[] = Array.from({ length: 30 }, (_, i) => ({
    id: `sent-${i}`, tenant_id: TENANT, sender_inbox_id: INBOX, status: "sent", sent_at: ago(60 + i), autopilot_lane: "auto",
  }));
  const waiting = (id: string) => ({
    id, tenant_id: TENANT, status: "approved", autopilot_lane: "auto", autopilot_reasons: [], sent_at: null,
    scheduled_send_at: ahead(120), queued_at: ago(600), sender_inbox_id: INBOX, subject: `Hello ${id}`, prospects: { company_name: id },
  });
  pitches.push(waiting("auto-1"), waiting("by-person"));
  const approval = (pitchId: string, autopilot: boolean) => ({
    id: `appr-${pitchId}`, tenant_id: TENANT, pitch_id: pitchId, event_type: "approved", event_at: ago(600), payload: { autopilot },
  });
  return fakeDb({
    autonomy_state: [{ tenant_id: TENANT, stage: "veto", stage_since: ago(60 * 24), enabled: false, ...over }],
    sender_inboxes: [{ id: INBOX, tenant_id: TENANT, email: "pedro@runnareach.com", paused: false, paused_reason: null }],
    pitches,
    pitch_events: [
      approval("auto-1", true),
      approval("by-person", false),
      { id: "b1", tenant_id: TENANT, pitch_id: "sent-0", event_type: "bounce", event_at: ago(10) },
      { id: "b2", tenant_id: TENANT, pitch_id: "sent-1", event_type: "bounce", event_at: ago(9) },
    ],
    audit_log: [],
    learning_insights: [],
    domain_health: [],
    warmup_log: [],
  });
}

/** Stubs the off tick may call: the email (sendNotification), DNS, placement, the digest secret. */
function wire(db: Db) {
  calls.length = 0;
  for (const k of Object.keys(answers)) delete answers[k];
  Object.assign(answers, {
    isSchedulerAuthorized: async () => true,
    createServiceRoleClient: () => db,
    systemActorFor: async (tenantId: unknown) => ({ supabase: db, user: { tenantId } }),
    sendNotification: async () => ({ sent: 1, failed: [] }),
    checkDeliverabilityHealth: async () => ({ blocklist: { listed_on: [] } }),
    analyzeSpamRate: () => ({ inboxRate: null }),
    holdSecret: () => "test-secret",
  });
}

const emails = () =>
  calls.filter((c) => c.name === "sendNotification").map((c) => c.args[2] as { subject: string; body: string });
const subjects = () => emails().map((e) => e.subject);
const digestBody = () => emails().find((e) => !e.subject.startsWith("Autopilot paused"))?.body ?? "";

test("route: a tenant with the kill switch off is ticked, and gets the pull-back, the digest and the breakers, nothing else", async () => {
  const db = killSwitchDb();
  wire(db);
  const { GET } = (await import(ROUTE)) as { GET: (req: unknown) => Promise<{ body: { ok: boolean; reports: Array<Row> } }> };
  const res = await GET({ headers: new Map() });
  assert.equal(res.body.ok, true);
  assert.equal(res.body.reports.length, 1, "the kill-switched tenant reached runTick");
  const report = res.body.reports[0]!;
  assert.equal(report.skipped, "autopilot off for this tenant");
  assert.deepEqual(report.errors, []);

  // Breakers: the inbox is paused and the team is emailed.
  const inbox = db.tables.sender_inboxes![0]!;
  assert.equal(inbox.paused, true);
  assert.match(String(inbox.paused_reason), /^Autopilot breaker \(inbox_bounces\): 2 hard bounces in the last 30 sends/);
  assert.deepEqual((report.breakers as Array<Row>).map((t) => t.code), ["inbox_bounces"]);

  // Pull-back: the automatic approval is held with the kill-switch reason; the person's stays.
  const byId = Object.fromEntries(db.tables.pitches!.map((p) => [p.id, p]));
  assert.equal(byId["auto-1"]!.status, "draft");
  assert.deepEqual(byId["auto-1"]!.autopilot_reasons, ["held by the autopilot: autopilot switched off"]);
  assert.equal(byId["by-person"]!.status, "approved");
  assert.equal(report.pulledBack, 1);

  // The digest ran AFTER the pull-back: it lists the person's approval, not auto-1.
  assert.equal(report.digest, 1);
  assert.match(digestBody(), /Hello by-person/);
  assert.doesNotMatch(digestBody(), /Hello auto-1/, "the digest never lists an approval this tick held");
  assert.equal(subjects().filter((x) => x === "Autopilot paused sending: 2 hard bounces in the last 30 sends").length, 1, "the breaker's email");

  // Nothing else ran: no pipeline stub called, no stage write.
  const allowed = new Set(Object.keys(answers));
  assert.deepEqual(calls.filter((c) => !allowed.has(c.name)).map((c) => c.name), []);
  assert.ok(!db.writes.includes("autonomy_state.update"), "no stage step");
});

test("route: with an automatic approval and no breaker, the off tick holds it before the digest could list it", async () => {
  const db = killSwitchDb({ enabled: true, stage: "off" });
  db.tables.pitch_events = db.tables.pitch_events!.filter((e) => e.event_type !== "bounce");
  wire(db);
  const { GET } = (await import(ROUTE)) as { GET: (req: unknown) => Promise<{ body: { reports: Array<Row> } }> };
  const report = (await GET({ headers: new Map() })).body.reports[0]!;
  assert.deepEqual(report.breakers, []);
  assert.equal(db.tables.sender_inboxes![0]!.paused, false);
  const auto1 = db.tables.pitches!.find((p) => p.id === "auto-1")!;
  // Stage off with the switch on: the stage reason, not the kill switch's.
  assert.deepEqual(auto1.autopilot_reasons, ["held by the autopilot: stage dropped to off"]);
  assert.equal(report.digest, 1, "only the person's approval");
  assert.doesNotMatch(digestBody(), /Hello auto-1/);
  assert.equal(subjects().length, 1, "the digest only: no breaker email");
});

// ── The weekly report's producer ─────────────────────────────────────────────

test("snapshot: autoScheduled rows carry autopilot_reasons, so a pull-back is not a person's veto", async () => {
  const day = 86_400_000;
  const now = new Date("2026-10-19T13:10:00Z");
  const at = (d: number) => new Date(now.getTime() - d * day).toISOString();
  const approval = (id: string, d: number, status: string, reasons: string[] | null, embedAsArray = false) => {
    const pitch = { status, autopilot_reasons: reasons, prospect_contacts: { email: `owner-${id}@acme.ca` } };
    return {
      id: `e-${id}`, tenant_id: "t1", event_type: "approved", event_at: at(d), payload: { autopilot: true },
      pitches: embedAsArray ? [pitch] : pitch,
    };
  };
  const db = fakeDb({
    pitch_events: [
      approval("sent", 1, "sent", []),
      approval("vetoed", 1, "draft", ["held by a person from the digest link"]),
      approval("rejected", 2, "reviewer_rejected", null),
      approval("pulled-shadow", 2, "draft", ["held by the autopilot: stage dropped to shadow"]),
      approval("pulled-switch", 3, "draft", ["held by the autopilot: autopilot switched off"], true),
    ],
  });
  wire(db);
  answers.exemplarsEnabled = () => false;
  const { gatherWeeklyRaw } = (await import(SNAPSHOT)) as { gatherWeeklyRaw: (t: string, n: Date) => Promise<WeeklyRaw> };
  const raw = await gatherWeeklyRaw("t1", now);
  assert.deepEqual(
    raw.autoScheduled?.map((r) => r.reasons),
    // Oldest first (the query orders by event_at).
    [["held by the autopilot: autopilot switched off"], null, ["held by the autopilot: stage dropped to shadow"], [], ["held by a person from the digest link"]],
  );
  assert.equal(buildWeeklyStats(raw).vetoed, 2, "the digest hold and the rejection; both pull-backs excluded");
});

test("snapshot: the weekly review's attempt markers are not counted as insights", async () => {
  const now = new Date("2026-10-26T13:10:00Z");
  const db = fakeDb({
    learning_insights: [
      { id: "i1", tenant_id: "t1", learner: "review", kind: "observation", title: "Replies ask about price", created_at: "2026-10-24T10:00:00Z" },
      { id: "i2", tenant_id: "t1", learner: "review.attempt", kind: "observation", title: "Weekly AI review ran", created_at: "2026-10-24T09:59:00Z" },
      { id: "i3", tenant_id: "t1", learner: "review.attempt", kind: "observation", title: "Weekly AI review failed (parse)", created_at: "2026-10-23T10:00:00Z" },
      { id: "i4", tenant_id: "t1", learner: "governor", kind: "breaker", title: "Paused an inbox", created_at: "2026-10-23T11:00:00Z" },
    ],
  });
  wire(db);
  answers.exemplarsEnabled = () => false;
  const { gatherWeeklyRaw } = (await import(SNAPSHOT)) as { gatherWeeklyRaw: (t: string, n: Date) => Promise<WeeklyRaw> };
  const raw = await gatherWeeklyRaw("t1", now);
  assert.deepEqual((raw.insights ?? []).map((r) => r.title), ["Replies ask about price"]);
  // learn.ts imports server-only, so read its constant from source: snapshot.ts filters on this exact value.
  const learnSrc = readFileSync(new URL("../lib/autopilot/learn.ts", import.meta.url), "utf8");
  assert.match(learnSrc, /export const REVIEW_ATTEMPT_LEARNER = "review\.attempt";/);
});
