/**
 * redraft-pool (tasks/briefs/redraft-pool.md): a prospect we researched is not
 * thrown away for good because one draft failed.
 *
 *   1. chooseRecipient / fetchTopUsableContact: a contact the verifier said
 *      will not deliver is skipped; one it is unsure about is skipped only for
 *      an unflagged alternative; a stale verdict counts for nothing.
 *   2. heldAction: an unsure (or undeliverable) address with an alternative
 *      contact is rewritten, without one dropped as before; a person wins.
 *   3. runTick resolve: a verifier-unsure draft on a prospect with a second
 *      contact is regenerated (to that contact), with one contact dropped.
 *   4. runTick redraft: one fresh draft 14 days after a writing rejection,
 *      never for any other reason, once per prospect, 3 a tick, 10 a day,
 *      inside the AI cap.
 *
 * Runs the real runTick with the loader hook of tests/handsoff-autopilot.test.ts:
 * every import of tick.ts is stubbed except the modules under test.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { register } from "node:module";
import test from "node:test";
import { heldAction, laneFor, redraftOf, rejectedForWriting, type RedraftPitch } from "../lib/autopilot/governor.ts";
import { heldForWriting } from "../lib/learning/presend.ts";
import type * as ContactsTypes from "../lib/pitches/contacts.ts";
import type * as GateTypes from "../lib/pitches/gate.ts";
import { VERDICT_TTL_MS } from "../lib/research/verify-recipient.ts";

type ContactsModule = typeof ContactsTypes;

const u = (p: string) => new URL(p, import.meta.url).href;
const TICK = u("../lib/autopilot/tick.ts");
const CONTACTS = u("../lib/pitches/contacts.ts");
const GATE = u("../lib/pitches/gate.ts");
/** Imports that load for real; everything else these parents import is stubbed. */
const REAL: Record<string, Record<string, string>> = {
  [TICK]: {
    "./governor": u("../lib/autopilot/governor.ts"),
    "./hold": u("../lib/autopilot/hold.ts"),
    "./bounce-breaker": u("../lib/autopilot/bounce-breaker.ts"),
    "./opt-out-count": u("../lib/autopilot/opt-out-count.ts"),
    "./send-failures": u("../lib/autopilot/send-failures.ts"),
    "@/lib/pitches/contacts": CONTACTS,
    "@/lib/pitches/status-transitions": u("../lib/pitches/status-transitions.ts"),
  },
  [CONTACTS]: {
    "@/lib/research/email-utils": u("../lib/research/email-utils.ts"),
    "@/lib/research/verify-recipient": u("../lib/research/verify-recipient.ts"),
  },
  [GATE]: {
    "@/lib/research/email-utils": u("../lib/research/email-utils.ts"),
    "./send-gate": u("../lib/pitches/send-gate.ts"),
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
        returns() { return b; },
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

/** Columns the real tables have (types.ts / migrations 0040, 0047); a query for any other fails the test. */
const COLUMNS: Record<string, readonly string[]> = {
  pitches: [
    "id", "tenant_id", "prospect_id", "contact_id", "status", "parent_pitch_id", "created_at", "decision",
    "autopilot_lane", "autopilot_reasons", "body_edited", "auto_rejected", "auto_rejected_reason", "sent_at",
    "scheduled_send_at", "subject", "gate_verdict", "body_original", "gate_override",
  ],
  prospect_contacts: [
    "id", "tenant_id", "prospect_id", "email", "full_name", "priority_rank", "selected_by",
    "verify_verdict", "verify_reasons", "verify_checked_at",
  ],
  prospects: ["id", "tenant_id", "status", "cooldown_until", "domain", "company_name", "language"],
};
function checkedDb(tables: Record<string, Row[]>) {
  const db = fakeDb(tables);
  const from = db.from.bind(db);
  db.from = (table: string) => {
    const b = from(table);
    const known = COLUMNS[table];
    if (!known) return b;
    const select = b.select.bind(b);
    const check = (k: string) => {
      const col = k.split("->>")[0]!;
      assert.ok(known.includes(col), `${table}.${col} is not a real column`);
    };
    b.select = (c?: string, o?: { count?: string; head?: boolean }) => {
      // Plain columns only (an embed "alias:fk(...)" belongs to another table).
      for (const part of (c ?? "").split(",").map((p) => p.trim())) if (/^\w+$/.test(part)) check(part);
      return select(c, o);
    };
    for (const m of ["eq", "neq", "in", "is", "not", "gt", "gte", "lt", "lte", "order"] as const) {
      const orig = (b[m] as (...a: unknown[]) => unknown).bind(b);
      (b as unknown as Record<string, unknown>)[m] = (k: string, ...rest: unknown[]) => {
        check(k);
        return orig(k, ...rest);
      };
    }
    return b;
  };
  return db;
}

const WRITER_FIXABLE = new Set(["dash", "long_body"]);
g.__stubValues.WRITER_FIXABLE = WRITER_FIXABLE;
type TickModule = { runTick: (actor: unknown, now?: Date) => Promise<Row & { errors: string[] }> };
const tick = (await import(TICK)) as TickModule;
const contacts = (await import(CONTACTS)) as ContactsModule;
const gate = (await import(GATE)) as typeof GateTypes;

const TENANT = "11111111-1111-1111-1111-111111111111";
const DAY = 86_400_000;
const NOW = new Date();
const daysAgo = (d: number) => new Date(NOW.getTime() - d * DAY).toISOString();

type Report = Row & {
  errors: string[];
  resolved: { rewritten: number; dropped: number; waiting: string | null };
  redrafted?: { drafted: number; failed: number; waiting: string | null };
};

/** Stubs a tick may call; generatePitchWith writes a draft to the given contact like the real one. */
function wire(db: Db, extra: Record<string, (...a: unknown[]) => unknown> = {}) {
  calls.length = 0;
  for (const k of Object.keys(answers)) delete answers[k];
  let n = 0;
  Object.assign(answers, {
    sendNotification: async () => ({ sent: 1, failed: [] }),
    checkDeliverabilityHealth: async () => ({ blocklist: { listed_on: [] } }),
    analyzeSpamRate: () => ({ inboxRate: null }),
    holdSecret: () => "test-secret",
    editRatio: () => 0,
    learnFromOutcomes: async () => undefined,
    evolveSearchSpace: async () => null,
    weeklyReview: async () => null,
    isUnderDailyCap: async () => ({ under: true, spent_today_usd: 0.5, cap_usd: 3 }),
    isEmailOnDncList: async () => ({ blocked: false }),
    generatePitchWith: async (_actor: unknown, prospectId: string, opts?: { retryOf?: string }) => {
      // As pitch-stage.ts: clear the prospect's drafts, link the chosen recipient.
      const top = await contacts.fetchTopUsableContact(db as never, TENANT, prospectId, NOW);
      db.tables.pitches = db.tables.pitches!.filter((p) => !(p.prospect_id === prospectId && p.status === "draft"));
      const id = `new-${++n}`;
      db.tables.pitches!.push({
        id, tenant_id: TENANT, prospect_id: prospectId, contact_id: top?.id ?? null, status: "draft",
        parent_pitch_id: null, created_at: NOW.toISOString(), body_edited: null, autopilot_lane: null,
        autopilot_reasons: null, auto_rejected_reason: null,
        decision: { path: "claude", ...(opts?.retryOf ? { retry_of: opts.retryOf } : {}) },
      });
      return { ok: true, pitch_id: id, method: "claude", quality_self_score: 8, reasoning: "" };
    },
    ...extra,
  });
}
const actorFor = (db: Db) => ({ supabase: db, user: { tenantId: TENANT, role: "admin" } });
const generated = () => calls.filter((c) => c.name === "generatePitchWith");
const stepErrors = (r: Report) => r.errors.filter((e) => /^(resolve|redraft):/.test(e));

type ContactRow = Row & ContactsTypes.VerdictContact & { id: string };
function contact(id: string, prospectId: string, rank: number, over: Row = {}): ContactRow {
  return {
    id, tenant_id: TENANT, prospect_id: prospectId, email: `${id}@acme-dental.ca`, full_name: id, priority_rank: rank,
    selected_by: "scraper", verify_verdict: null, verify_reasons: null, verify_checked_at: null, ...over,
  } as ContactRow;
}
function baseDb(over: Partial<Record<string, Row[]>> = {}): Db {
  return checkedDb({
    // Shadow: no scheduling; the steps under test run as in every stage.
    autonomy_state: [{ tenant_id: TENANT, stage: "shadow", stage_since: daysAgo(3), enabled: true }],
    sender_inboxes: [],
    discovery_jobs: [],
    pitches: [],
    pitch_events: [],
    prospect_contacts: [],
    prospects: [],
    audit_log: [],
    learning_insights: [],
    learning_arms: [],
    domain_health: [],
    warmup_log: [],
    ...over,
  } as Record<string, Row[]>);
}

// ── 1. Recipient choice ──────────────────────────────────────────────────────

const fresh = daysAgo(1);
const stale = new Date(NOW.getTime() - VERDICT_TTL_MS - 60_000).toISOString();

test("chooseRecipient: a fresh drop verdict is skipped, even with no unflagged alternative", () => {
  const a = contact("a", "p", 1, { verify_verdict: "drop", verify_checked_at: fresh });
  const b = contact("b", "p", 2, { verify_verdict: "review", verify_checked_at: fresh });
  assert.equal(contacts.chooseRecipient([a, b], NOW)?.id, "b");
  assert.equal(contacts.chooseRecipient([a, contact("c", "p", 3)], NOW)?.id, "c");
});

test("chooseRecipient: a review verdict is skipped only when an unflagged contact exists", () => {
  const a = contact("a", "p", 1, { verify_verdict: "review", verify_checked_at: fresh });
  assert.equal(contacts.chooseRecipient([a, contact("b", "p", 2)], NOW)?.id, "b");
  // Only flagged alternatives: the same contact as today.
  const b = contact("b", "p", 2, { verify_verdict: "review", verify_checked_at: fresh });
  assert.equal(contacts.chooseRecipient([a, b], NOW)?.id, "a");
  const d = contact("d", "p", 2, { verify_verdict: "drop", verify_checked_at: fresh });
  assert.equal(contacts.chooseRecipient([a, d], NOW)?.id, "a");
});

test("chooseRecipient: a stale verdict (past the TTL) is ignored; no alternative = today's pick", () => {
  const a = contact("a", "p", 1, { verify_verdict: "drop", verify_checked_at: stale });
  assert.equal(contacts.chooseRecipient([a, contact("b", "p", 2)], NOW)?.id, "a");
  // Every usable contact undeliverable: today's pick, not none (the drop lane closes it).
  const only = contact("a", "p", 1, { verify_verdict: "drop", verify_checked_at: fresh });
  const junk = contact("j", "p", 0, { email: "info@example" });
  assert.equal(contacts.chooseRecipient([junk, only], NOW)?.id, "a");
  assert.equal(contacts.chooseRecipient([], NOW), null);
});

test("chooseRecipient property: with no fresh verdicts it is exactly pickTopUsableContact", () => {
  let seed = 11;
  const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
  for (let i = 0; i < 300; i++) {
    const list = Array.from({ length: 1 + Math.floor(rnd() * 5) }, (_, k) =>
      contact(`c${k}`, "p", Math.floor(rnd() * 4), {
        email: rnd() < 0.3 ? "noreply@" : `c${k}@acme-dental.ca`,
        verify_verdict: rnd() < 0.5 ? (["send", "review", "drop"] as const)[Math.floor(rnd() * 3)] : null,
        verify_checked_at: rnd() < 0.5 ? stale : null,
      }),
    );
    assert.equal(contacts.chooseRecipient(list, NOW)?.id, contacts.pickTopUsableContact(list)?.id);
  }
});

test("fetchTopUsableContact uses the rule (manual generation and the autopilot alike)", async () => {
  const db = baseDb({
    prospect_contacts: [
      contact("a", "p", 1, { verify_verdict: "review", verify_checked_at: fresh }),
      contact("b", "p", 2),
    ],
  });
  assert.equal((await contacts.fetchTopUsableContact(db as never, TENANT, "p", NOW))?.id, "b");
});

test("hasAlternativeRecipient: another unflagged contact, never the same one or the same address", () => {
  const a = contact("a", "p", 1, { verify_verdict: "review", verify_checked_at: fresh });
  assert.equal(contacts.hasAlternativeRecipient([a as never, contact("b", "p", 2) as never], "a", NOW), true);
  assert.equal(contacts.hasAlternativeRecipient([a as never], "a", NOW), false);
  const flagged = contact("b", "p", 2, { verify_verdict: "review", verify_checked_at: fresh });
  assert.equal(contacts.hasAlternativeRecipient([a as never, flagged as never], "a", NOW), false);
  const dup = contact("b", "p", 2, { email: "A@Acme-Dental.ca " });
  assert.equal(contacts.hasAlternativeRecipient([{ ...a, email: "a@acme-dental.ca" } as never, dup as never], "a", NOW), false);
  // The draft's contact is undeliverable and every other is only unsure: the rule picks a flagged one, no.
  const dead = contact("x", "p", 0, { verify_verdict: "drop", verify_checked_at: fresh });
  assert.equal(contacts.hasAlternativeRecipient([dead as never, a as never, flagged as never], "x", NOW), false);
  // A draft linked to no contact (or one with no address) is not "the same person" as the pick.
  assert.equal(contacts.hasAlternativeRecipient([{ ...a, email: null } as never, contact("b", "p", 2) as never], "a", NOW), true);
  // The stored verdict was never written: the rule would pick the same contact again.
  assert.equal(contacts.hasAlternativeRecipient([contact("a", "p", 1) as never, contact("b", "p", 2) as never], "a", NOW), false);
});

test("pitchRecipient (the /pitches display): the pitch's own usable contact, else the prospect's pick", () => {
  const a = contact("a", "p", 1, { verify_verdict: "review", verify_checked_at: fresh });
  const b = contact("b", "p", 2);
  assert.equal(contacts.pitchRecipient([a, b], "a", NOW)?.id, "a");
  assert.equal(contacts.pitchRecipient([a, b], "b", NOW)?.id, "b");
  assert.equal(contacts.pitchRecipient([a, b], null, NOW)?.id, "b");
  assert.equal(contacts.pitchRecipient([{ ...a, email: "noreply@" }, b], "a", NOW)?.id, "b");
  assert.equal(contacts.pitchRecipient([a, b], "gone", NOW)?.id, "b");
});

// ── 1b. The gate checks the pitch's own recipient ────────────────────────────

function gateDb(contactId: string | null): Db {
  return baseDb({
    prospects: [{ id: "p", tenant_id: TENANT, status: "pitched", cooldown_until: null, domain: "acme-dental.ca", company_name: "Acme Dental", language: "en" }],
    prospect_research: [],
    prospect_contacts: [
      contact("ana", "p", 1, { full_name: "Ana Ruiz", email: "ana@acme-dental.ca" }),
      contact("bo", "p", 2, { full_name: "Bo Chen", email: "bo@acme-dental.ca" }),
    ],
    pitches: [{
      id: "g1", tenant_id: TENANT, prospect_id: "p", contact_id: contactId, status: "draft", parent_pitch_id: null,
      subject: "a question", body_original: "Hi Bo,\n\nA short note.\n\nHenry", body_edited: null, gate_override: null,
    }],
  });
}
const SHARED = { benchmarkSources: [], clientNames: [] };
const greetingFlags = (r: Awaited<ReturnType<typeof gate.checkPitchGate>>) =>
  ((r?.verdict.failures ?? []) as Array<{ code: string }>).filter((f) => f.code.startsWith("greeting")).map((f) => f.code);

test("checkPitchGate: with no recipient given it checks the pitch's contact_id, not the priority-top contact", async () => {
  // "Hi Bo" on a pitch linked to Bo: no greeting flag (it was flagged against Ana before).
  assert.deepEqual(greetingFlags(await gate.checkPitchGate(gateDb("bo"), TENANT, "g1", { shared: SHARED, persist: false })), []);
  // Linked to Ana, or to no one (the prospect's top contact): "Hi Bo" is a mismatch.
  assert.deepEqual(greetingFlags(await gate.checkPitchGate(gateDb("ana"), TENANT, "g1", { shared: SHARED, persist: false })), ["greeting_mismatch"]);
  assert.deepEqual(greetingFlags(await gate.checkPitchGate(gateDb(null), TENANT, "g1", { shared: SHARED, persist: false })), ["greeting_mismatch"]);
  // A send path's explicit recipient still wins.
  const explicit = { email: "ana@acme-dental.ca", full_name: "Ana Ruiz", selected_by: "scraper" };
  assert.deepEqual(greetingFlags(await gate.checkPitchGate(gateDb("bo"), TENANT, "g1", { shared: SHARED, persist: false, recipient: explicit })), ["greeting_mismatch"]);
});

test("negative set: a pitch linked to the priority-top contact gets the same gate verdict and display as before", async () => {
  // Before this change the gate used the prospect's top contact (contact_id ignored): contact_id null takes that path.
  const strip = (r: Awaited<ReturnType<typeof gate.checkPitchGate>>) => {
    const v = r?.verdict as { checked_at?: string } | undefined;
    return v ? { ...v, checked_at: "x" } : v;
  };
  for (const body of ["Hi Ana,\n\nA short note.\n\nHenry", "Hi Bo,\n\nA short note.\n\nHenry", "Hello,\n\nA short note.\n\nHenry"]) {
    const linked = gateDb("ana");
    const old = gateDb(null);
    linked.tables.pitches![0]!.body_original = body;
    old.tables.pitches![0]!.body_original = body;
    assert.deepEqual(
      strip(await gate.checkPitchGate(linked, TENANT, "g1", { shared: SHARED, persist: false })),
      strip(await gate.checkPitchGate(old, TENANT, "g1", { shared: SHARED, persist: false })),
      body,
    );
  }
  const rows = [contact("ana", "p", 1, { full_name: "Ana Ruiz" }), contact("bo", "p", 2)];
  assert.equal(contacts.pitchRecipient(rows, "ana", NOW), contacts.pickTopUsableContact(rows));
});

// ── 2. heldAction ────────────────────────────────────────────────────────────

const UNSURE = "verifier unsure about the address";
const UNDELIVERABLE = "verifier says the address will not deliver";
const held = (reasons: string[], over: Partial<Parameters<typeof heldAction>[0]> = {}) =>
  heldAction({ lane: "review", reasons, isRewrite: false, editedByPerson: false, ...over }, WRITER_FIXABLE);

test("heldAction: unsure + an alternative contact → rewrite; without one → drop as today", () => {
  assert.deepEqual(held([UNSURE], { hasAlternativeContact: true }), { action: "rewrite" });
  assert.deepEqual(held([UNSURE, "AI review flagged issues", "gate: dash"], { hasAlternativeContact: true }), { action: "rewrite" });
  assert.deepEqual(held([UNSURE]), { action: "drop", why: `a rewrite can't fix: ${UNSURE}` });
  assert.deepEqual(held([UNSURE], { hasAlternativeContact: false }), { action: "drop", why: `a rewrite can't fix: ${UNSURE}` });
  // Another reason a new contact can't fix still drops it.
  assert.equal(held([UNSURE, "segment on probation after opt-outs"], { hasAlternativeContact: true }).action, "drop");
  // One rewrite only: a rewrite still unsure is dropped.
  assert.equal(held([UNSURE], { hasAlternativeContact: true, isRewrite: true }).action, "drop");
});

test("heldAction: the drop lane rewrites only an undeliverable address with an alternative", () => {
  assert.deepEqual(held([UNDELIVERABLE], { lane: "drop", hasAlternativeContact: true }), { action: "rewrite" });
  assert.deepEqual(held([UNDELIVERABLE], { lane: "drop" }), { action: "drop", why: UNDELIVERABLE });
  assert.deepEqual(held([UNDELIVERABLE, "no usable recipient address"], { lane: "drop", hasAlternativeContact: true }), {
    action: "drop", why: `${UNDELIVERABLE}; no usable recipient address`,
  });
  assert.deepEqual(held([UNDELIVERABLE], { lane: "drop", hasAlternativeContact: true, isRewrite: true }), { action: "drop", why: UNDELIVERABLE });
});

test("heldAction: a person's hold or edit wins over an alternative contact", () => {
  assert.equal(held(["held by a person: vetoed", UNSURE], { hasAlternativeContact: true }).action, "leave");
  assert.equal(held([UNSURE], { hasAlternativeContact: true, editedByPerson: true }).action, "leave");
  assert.equal(held(["held by the autopilot: stage dropped", UNSURE], { hasAlternativeContact: true }).action, "leave");
  assert.equal(held([UNDELIVERABLE], { lane: "drop", hasAlternativeContact: true, editedByPerson: true }).action, "leave");
});

test("laneFor is unchanged: an unsure address is never automatic", () => {
  const base = { gate: { pass: true, failures: [] }, critic: { pass: true, score: 0.9 }, recipientSelectedBy: "scraper", path: "claude" };
  assert.deepEqual(laneFor({ ...base, verify: "review" }), { lane: "review", reasons: [UNSURE] });
  assert.deepEqual(laneFor({ ...base, verify: "drop" }), { lane: "drop", reasons: [UNDELIVERABLE] });
});

// ── 3. runTick resolve: unsure address → the next contact ────────────────────

function unsureDb(withSecond: boolean): Db {
  return baseDb({
    prospects: [{ id: "p", tenant_id: TENANT, status: "pitched", cooldown_until: null, domain: "acme-dental.ca" }],
    prospect_contacts: [
      contact("a", "p", 1, { verify_verdict: "review", verify_checked_at: fresh }),
      ...(withSecond ? [contact("b", "p", 2)] : []),
    ],
    pitches: [{
      id: "d1", tenant_id: TENANT, prospect_id: "p", contact_id: "a", status: "draft", parent_pitch_id: null,
      created_at: daysAgo(0.1), body_edited: null, autopilot_lane: "review", autopilot_reasons: [UNSURE],
      auto_rejected_reason: null, decision: { path: "claude" },
    }],
  });
}

test("runTick: a verifier-unsure draft with a second contact is regenerated to that contact", async () => {
  const db = unsureDb(true);
  wire(db);
  const r = (await tick.runTick(actorFor(db), NOW)) as Report;
  assert.deepEqual(stepErrors(r), []);
  assert.equal(r.resolved.rewritten, 1);
  assert.equal(r.resolved.dropped, 0);
  assert.deepEqual(generated().map((c) => c.args[2]), [{ retryOf: "d1" }]);
  const draft = db.tables.pitches!.find((p) => p.status === "draft");
  assert.equal(draft?.contact_id, "b");
});

test("runTick: with one contact the verifier-unsure draft is dropped as today", async () => {
  const db = unsureDb(false);
  wire(db);
  const r = (await tick.runTick(actorFor(db), NOW)) as Report;
  assert.deepEqual(stepErrors(r), []);
  assert.equal(r.resolved.dropped, 1);
  assert.equal(generated().length, 0);
  const d1 = db.tables.pitches!.find((p) => p.id === "d1")!;
  assert.equal(d1.status, "auto_rejected");
  assert.equal(d1.auto_rejected_reason, `a rewrite can't fix: ${UNSURE}`);
});

test("runTick: contacts unreadable → no alternative is assumed, the draft drops", async () => {
  const db = unsureDb(true);
  const from = db.from.bind(db);
  db.from = (t: string) => {
    const b = from(t);
    if (t !== "prospect_contacts") return b;
    return { ...b, select: () => ({ eq: () => ({ eq: () => ({ order: () => ({ limit: async () => ({ data: null, error: { message: "" } }) }) }) }) }) } as never;
  };
  wire(db);
  const r = (await tick.runTick(actorFor(db), NOW)) as Report;
  assert.equal(r.resolved.dropped, 1);
  assert.equal(generated().length, 0);
});

test("runTick: a draft a person held is left alone, its contacts never read", async () => {
  const db = unsureDb(true);
  db.tables.pitches![0]!.autopilot_reasons = ["held by a person: vetoed", UNSURE];
  const from = db.from.bind(db);
  let contactReads = 0;
  db.from = (t: string) => {
    if (t === "prospect_contacts") contactReads++;
    return from(t);
  };
  wire(db);
  const r = (await tick.runTick(actorFor(db), NOW)) as Report;
  assert.deepEqual(r.resolved, { rewritten: 0, dropped: 0, waiting: null });
  assert.equal(contactReads, 0);
  assert.equal(db.tables.pitches![0]!.status, "draft");
});

// ── 4. runTick redraft ───────────────────────────────────────────────────────

const WRITER_REASON = "still held after one rewrite: AI review flagged issues";
function rejected(id: string, prospectId: string, ageDays: number, reason: string, decision: Row = { path: "claude" }): Row {
  return {
    id, tenant_id: TENANT, prospect_id: prospectId, contact_id: `${prospectId}-c`, status: "auto_rejected",
    parent_pitch_id: null, created_at: daysAgo(ageDays), body_edited: null, autopilot_lane: "drop",
    autopilot_reasons: [], auto_rejected: true, auto_rejected_reason: reason, decision,
  };
}
function poolDb(pitches: Row[], prospectOver: Record<string, Row> = {}): Db {
  const ids = [...new Set(pitches.map((p) => p.prospect_id as string))];
  return baseDb({
    pitches,
    prospects: ids.map((id) => ({ id, tenant_id: TENANT, status: "pitched", cooldown_until: null, domain: "acme-dental.ca", ...prospectOver[id] })),
    prospect_contacts: ids.map((id) => contact(`${id}-c`, id, 1)),
  });
}
const redrafts = (db: Db) => db.tables.pitches!.filter((p) => (p.decision as Row | null)?.redraft_of);

test("redraft: a writer rejection 15 days old gets one fresh draft marked redraft_of", async () => {
  const db = poolDb([rejected("old", "p1", 15, WRITER_REASON)]);
  wire(db);
  const r = (await tick.runTick(actorFor(db), NOW)) as Report;
  assert.deepEqual(stepErrors(r), []);
  assert.deepEqual(r.redrafted, { drafted: 1, failed: 0, waiting: null });
  assert.deepEqual(generated().map((c) => [c.args[1], c.args[2]]), [["p1", undefined]]);
  assert.deepEqual(redrafts(db).map((p) => [p.prospect_id, (p.decision as Row).redraft_of, p.status]), [["p1", "old", "draft"]]);
  // Next tick: the prospect now has a live draft and is not re-drafted again.
  calls.length = 0;
  await tick.runTick(actorFor(db), NOW);
  assert.equal(generated().filter((c) => c.args[2] === undefined).length, 0);
});

test("redraft: 13 days old → none", async () => {
  const db = poolDb([rejected("old", "p1", 13, WRITER_REASON)]);
  wire(db);
  const r = (await tick.runTick(actorFor(db), NOW)) as Report;
  assert.equal(r.redrafted?.drafted, 0);
  assert.equal(generated().length, 0);
});

test("redraft: address, person, template, probation, unknown reasons → none; writer reasons → yes", async () => {
  const no = [
    `a rewrite can't fix: ${UNSURE}`,
    UNDELIVERABLE,
    "no usable recipient address",
    `still held after one rewrite: written by a template (templates never go automatically)`,
    `a rewrite can't fix: segment on probation after opt-outs`,
    `still held after one rewrite: ${UNSURE}`,
    "held by a person: vetoed",
    "something new",
    `still held after one rewrite: AI review flagged issues; address source "anymail" not trusted`,
  ];
  for (const reason of no) {
    const db = poolDb([rejected("old", "p1", 20, reason)]);
    wire(db);
    const r = (await tick.runTick(actorFor(db), NOW)) as Report;
    assert.equal(r.redrafted?.drafted, 0, reason);
    assert.equal(generated().length, 0, reason);
  }
  for (const reason of ["AI review flagged issues", "still held after one rewrite: gate: dash", "AI review score 0.62 < 0.8", "rewrite failed: Could not save pitch: x"]) {
    const db = poolDb([rejected("old", "p1", 20, reason)]);
    wire(db);
    const r = (await tick.runTick(actorFor(db), NOW)) as Report;
    assert.equal(r.redrafted?.drafted, 1, reason);
  }
});

test("redraft: already re-drafted once (or a failed try) → none; two rejected drafts → none", async () => {
  for (const pitches of [
    [rejected("r2", "p1", 15, WRITER_REASON, { path: "claude", redraft_of: "r1" })],
    [rejected("r1", "p1", 15, WRITER_REASON, { path: "claude", redraft_failed: { at: daysAgo(1), error: "x" } })],
    [rejected("r1", "p1", 40, WRITER_REASON), rejected("r2", "p1", 20, WRITER_REASON)],
  ]) {
    const db = poolDb(pitches);
    wire(db);
    const r = (await tick.runTick(actorFor(db), NOW)) as Report;
    assert.equal(r.redrafted?.drafted, 0);
    assert.equal(generated().length, 0);
  }
});

test("redraft: a prospect with any other pitch (sent, approved, a draft, a follow-up) → none", async () => {
  for (const status of ["sent", "approved", "draft", "sending", "reviewer_rejected"]) {
    const other = { ...rejected("x", "p1", 30, WRITER_REASON), status, auto_rejected_reason: null };
    const db = poolDb([rejected("old", "p1", 15, WRITER_REASON), other]);
    wire(db);
    const r = (await tick.runTick(actorFor(db), NOW)) as Report;
    assert.equal(r.redrafted?.drafted, 0, status);
  }
  const child = { ...rejected("f", "p1", 30, WRITER_REASON), parent_pitch_id: "old" };
  const db = poolDb([rejected("old", "p1", 15, WRITER_REASON), child]);
  wire(db);
  assert.equal(((await tick.runTick(actorFor(db), NOW)) as Report).redrafted?.drafted, 0);
});

test("redraft: suppressed, sent, in cooldown, unreadable or DNC prospects → none", async () => {
  const cases: Array<[Row, Record<string, (...a: unknown[]) => unknown>]> = [
    [{ status: "suppressed" }, {}],
    [{ status: "sent" }, {}],
    [{ status: "booked" }, {}],
    [{ cooldown_until: new Date(NOW.getTime() + DAY).toISOString() }, {}],
    [{}, { isEmailOnDncList: async () => ({ blocked: true, reason: "on the list" }) }],
    [{}, { isEmailOnDncList: async () => ({ blocked: false, error: "lookup failed" }) }],
  ];
  for (const [over, extra] of cases) {
    const db = poolDb([rejected("old", "p1", 15, WRITER_REASON)], { p1: over });
    wire(db, extra);
    const r = (await tick.runTick(actorFor(db), NOW)) as Report;
    assert.equal(r.redrafted?.drafted, 0, JSON.stringify(over));
    assert.equal(generated().length, 0);
  }
  const gone = poolDb([rejected("old", "p1", 15, WRITER_REASON)]);
  gone.tables.prospects = [];
  wire(gone);
  assert.equal(((await tick.runTick(actorFor(gone), NOW)) as Report).redrafted?.drafted, 0);
});

test("redraft: at most 3 a tick and 10 a UTC day", async () => {
  const many = Array.from({ length: 8 }, (_, i) => rejected(`old${i}`, `p${i}`, 15 + i, WRITER_REASON));
  const db = poolDb(many);
  wire(db);
  const r = (await tick.runTick(actorFor(db), NOW)) as Report;
  assert.equal(r.redrafted?.drafted, 3);

  // 9 already today (one of them twice: a re-draft and its rewrite) → room for 1.
  const today: Row[] = Array.from({ length: 9 }, (_, i) => ({
    ...rejected(`t${i}`, `q${i}`, 0, WRITER_REASON), status: "draft", created_at: NOW.toISOString(), decision: { redraft_of: `z${i}` },
  }));
  today.push({ ...today[0]!, id: "t0-rewrite", decision: { redraft_of: "z0", retry_of: "t0" } });
  const db2 = poolDb([...many, ...today]);
  wire(db2);
  assert.equal(((await tick.runTick(actorFor(db2), NOW)) as Report).redrafted?.drafted, 1);

  const ten = [...today, { ...today[0]!, id: "t9", decision: { redraft_of: "z9" } }];
  const db3 = poolDb([...many, ...ten]);
  wire(db3);
  const r3 = (await tick.runTick(actorFor(db3), NOW)) as Report;
  assert.equal(r3.redrafted?.drafted, 0);
  assert.equal(r3.redrafted?.waiting, "10 re-drafts today");
});

test("redraft: the AI budget below the rewrite minimum → none", async () => {
  for (const cap of [{ under: false, spent_today_usd: 3.1, cap_usd: 3 }, { under: true, spent_today_usd: 2.9, cap_usd: 3 }]) {
    const db = poolDb([rejected("old", "p1", 15, WRITER_REASON)]);
    wire(db, { isUnderDailyCap: async () => cap });
    const r = (await tick.runTick(actorFor(db), NOW)) as Report;
    assert.equal(r.redrafted?.drafted, 0);
    assert.match(r.redrafted?.waiting ?? "", /^AI budget/);
    assert.equal(generated().length, 0);
  }
});

test("redraft: a failed generation is the prospect's one try (no retry every tick)", async () => {
  const db = poolDb([rejected("old", "p1", 15, WRITER_REASON)]);
  wire(db, { generatePitchWith: async () => ({ ok: false, error: "Status re-check failed: boom" }) });
  const r = (await tick.runTick(actorFor(db), NOW)) as Report;
  assert.deepEqual(r.redrafted, { drafted: 0, failed: 1, waiting: null });
  assert.deepEqual(((db.tables.pitches![0]!.decision as Row).redraft_failed as Row).error, "Status re-check failed: boom");
  calls.length = 0;
  await tick.runTick(actorFor(db), NOW);
  assert.equal(generated().length, 0);
});

test("redraft: a re-draft's rewrite keeps the redraft_of mark, so it is never re-drafted again", async () => {
  const db = poolDb([]);
  db.tables.prospects = [{ id: "p1", tenant_id: TENANT, status: "pitched", cooldown_until: null, domain: "acme-dental.ca" }];
  db.tables.prospect_contacts = [contact("p1-c", "p1", 1)];
  db.tables.pitches = [{
    id: "rd", tenant_id: TENANT, prospect_id: "p1", contact_id: "p1-c", status: "draft", parent_pitch_id: null,
    created_at: daysAgo(0.1), body_edited: null, autopilot_lane: "review", autopilot_reasons: ["AI review flagged issues"],
    auto_rejected_reason: null, decision: { path: "claude", redraft_of: "old" },
  }];
  wire(db);
  const r = (await tick.runTick(actorFor(db), NOW)) as Report;
  assert.equal(r.resolved.rewritten, 1);
  const rewrite = db.tables.pitches!.find((p) => p.status === "draft")!;
  assert.deepEqual(rewrite.decision, { path: "claude", retry_of: "rd", redraft_of: "old" });
  // Dropped later for its writing, 20 days on: one auto_rejected re-draft → none.
  Object.assign(rewrite, { status: "auto_rejected", auto_rejected_reason: WRITER_REASON, created_at: daysAgo(20) });
  calls.length = 0;
  await tick.runTick(actorFor(db), NOW);
  assert.equal(generated().length, 0);
});

// ── Classification stays the pre-send guardrail's ────────────────────────────

test("rejectedForWriting agrees with heldForWriting on every reason except a failed rewrite", () => {
  const reasons = [
    "AI review flagged issues", "AI review score 0.62 < 0.8", "gate: dash", "gate: unusable_email",
    `still held after one rewrite: AI review flagged issues; gate: long_body`, `a rewrite can't fix: ${UNSURE}`,
    UNDELIVERABLE, "held by a person", "", "rewrite failed: x",
  ];
  for (const r of reasons) {
    const want = r.startsWith("rewrite failed: ") ? true : heldForWriting(r, WRITER_FIXABLE);
    assert.equal(rejectedForWriting(r, WRITER_FIXABLE), want, r);
  }
  // A re-draft's own rejection is an ordinary reason the guardrail reads as before.
  assert.equal(heldForWriting("still held after one rewrite: AI review flagged issues", WRITER_FIXABLE), true);
  assert.equal(heldForWriting(`a rewrite can't fix: ${UNSURE}`, WRITER_FIXABLE), false);
});

test("redraftOf (pure): the newest pitch decides the age; empty → none", () => {
  const p = (id: string, age: number, over: Partial<RedraftPitch> = {}): RedraftPitch => ({
    id, status: "auto_rejected", created_at: daysAgo(age), auto_rejected_reason: "AI review flagged issues", decision: null, ...over,
  });
  assert.equal(redraftOf([], NOW, WRITER_FIXABLE), null);
  assert.equal(redraftOf([p("a", 14)], NOW, WRITER_FIXABLE), "a");
  assert.equal(redraftOf([p("a", 13.9)], NOW, WRITER_FIXABLE), null);
  assert.equal(redraftOf([p("a", 20, { created_at: "not a date" })], NOW, WRITER_FIXABLE), null);
});
