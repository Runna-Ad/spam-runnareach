/**
 * optout-alarm-people: the opt_out_spike breaker counts PEOPLE who opted out,
 * not timeline events (lib/autopilot/opt-out-count.ts). One "remove me" reply
 * writes a hard_no `reply` on the thread's pitch and an `unsubscribe` on the
 * root pitch; it is one person.
 *
 * Runs optOutMetrics against a fake of the Supabase query builder that rejects
 * any column 0001 does not create (PostgREST answers 42703), then feeds the
 * result through the real evaluateBreakers.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { evaluateBreakers, type BreakerMetrics } from "../lib/autopilot/governor.ts";
import { OPT_OUT_READ_LIMIT, optOutMetrics } from "../lib/autopilot/opt-out-count.ts";

const src = (p: string) => readFileSync(new URL(`../${p}`, import.meta.url), "utf8");

type Row = Record<string, unknown>;

/** Columns of a table as migration 0001 creates it. */
function columnsOf(table: string): string[] {
  const sql = src("supabase/migrations/0001_initial_schema.sql");
  const m = sql.match(new RegExp(`create table ${table} \\(([\\s\\S]*?)\\n\\);`));
  assert.ok(m, `create table ${table} not found in 0001`);
  return m[1]!
    .split("\n")
    .map((l) => l.trim().match(/^([a-z_][a-z0-9_]*)\s/)?.[1])
    .filter((c): c is string => !!c && !["primary", "unique", "constraint", "foreign", "check"].includes(c));
}

const SCHEMA: Record<string, string[]> = { pitch_events: columnsOf("pitch_events"), pitches: columnsOf("pitches") };

test("schema helper: pitch_events has event_at and pitch_id but no prospect_id or created_at; pitches has prospect_id", () => {
  assert.ok(SCHEMA.pitch_events!.includes("event_at") && SCHEMA.pitch_events!.includes("pitch_id"));
  assert.ok(!SCHEMA.pitch_events!.includes("prospect_id") && !SCHEMA.pitch_events!.includes("created_at"));
  assert.ok(SCHEMA.pitches!.includes("prospect_id"));
});

type Fail = { table: string; kind: "rows" | "count"; message: string };

/** Chainable postgrest fake: select (rows or count/head), eq (incl. payload->>key), gte, in, limit. */
function fakeDb(tables: Record<string, Row[]>, fails: Fail[] = []) {
  const reads: string[] = [];
  return {
    reads,
    from(table: string) {
      const unknown: string[] = [];
      const use = (col: string) => {
        const base = col.split("->")[0]!;
        if (!SCHEMA[table]?.includes(base)) unknown.push(col);
      };
      const filters: Array<(r: Row) => boolean> = [];
      let head = false;
      let lim: number | null = null;
      const val = (r: Row, k: string): unknown => {
        const [base, key] = k.split("->>");
        if (key !== undefined) return ((r[base!] ?? {}) as Row)[key] ?? null;
        return r[k] ?? null;
      };
      const run = () => {
        reads.push(`${table}:${head ? "count" : "rows"}`);
        if (unknown.length) return { data: null, count: null, error: { message: `column ${table}.${unknown[0]} does not exist`, code: "42703" } };
        const f = fails.find((x) => x.table === table && x.kind === (head ? "count" : "rows"));
        if (f) return { data: null, count: null, error: { message: f.message } };
        let hit = (tables[table] ?? []).filter((r) => filters.every((fn) => fn(r)));
        if (head) return { data: null, count: hit.length, error: null };
        if (lim !== null) hit = hit.slice(0, lim);
        return { data: hit.map((r) => ({ ...r })), count: null, error: null };
      };
      const b = {
        select(c: string, o?: { count?: string; head?: boolean }) {
          for (const col of c.split(",").map((x) => x.trim()).filter(Boolean)) use(col);
          if (o?.head) head = true;
          return b;
        },
        eq(k: string, v: unknown) {
          use(k);
          filters.push((r) => val(r, k) === v);
          return b;
        },
        in(k: string, vs: unknown[]) {
          use(k);
          filters.push((r) => vs.includes(val(r, k)));
          return b;
        },
        gte(k: string, v: string) {
          use(k);
          filters.push((r) => Date.parse(String(val(r, k))) >= Date.parse(v));
          return b;
        },
        limit(n: number) {
          lim = n;
          return b;
        },
        then<T>(ok: (v: ReturnType<typeof run>) => T, ko?: (e: unknown) => T) {
          return Promise.resolve(run()).then(ok, ko);
        },
      };
      return b;
    },
  };
}

const TENANT = "t1";
const NOW = new Date("2026-10-20T12:00:00Z");
const daysAgo = (d: number) => new Date(NOW.getTime() - d * 86_400_000).toISOString();

/** A world of prospects, each with a root pitch and a follow-up pitch. */
function world() {
  const pitches: Row[] = [];
  const events: Row[] = [];
  let n = 0;
  const pitch = (prospect: string, which: "root" | "fu") => {
    const id = `${prospect}-${which}`;
    if (!pitches.some((p) => p.id === id)) pitches.push({ id, tenant_id: TENANT, prospect_id: prospect });
    return id;
  };
  const ev = (pitchId: string, type: string, at: string, payload: Row = {}) =>
    events.push({ id: `e${++n}`, tenant_id: TENANT, pitch_id: pitchId, event_type: type, event_at: at, payload });
  return {
    tables: { pitches, pitch_events: events },
    /** A "remove me" reply: hard_no on the thread's (follow-up) pitch + unsubscribe on the root, like the poll + recordOptOut. */
    replyOptOut(prospect: string, at = daysAgo(1)) {
      ev(pitch(prospect, "fu"), "reply", at, { intent: "hard_no" });
      ev(pitch(prospect, "root"), "unsubscribe", at, { source: "reply" });
    },
    /** A link click: unsubscribe only. */
    linkOptOut(prospect: string, at = daysAgo(1)) {
      ev(pitch(prospect, "root"), "unsubscribe", at, { source: "link" });
    },
    other(prospect: string, type: string, at = daysAgo(1), payload: Row = {}) {
      ev(pitch(prospect, "root"), type, at, payload);
    },
  };
}

const quiet: Omit<BreakerMetrics, "optOutsThisWeek" | "optOutWeeklyBaseline"> = {
  inboxes: [],
  hardBouncesToday: 0,
  dmarcPassRate: null,
  blocklisted: false,
  warmupInboxRate: null,
};

async function run(w: ReturnType<typeof world>, fails: Fail[] = []) {
  const db = fakeDb(w.tables, fails);
  const m = await optOutMetrics(db, TENANT, NOW);
  const trips = evaluateBreakers({ ...quiet, optOutsThisWeek: m.optOutsThisWeek, optOutWeeklyBaseline: m.optOutWeeklyBaseline });
  return { ...m, tripped: trips.some((t) => t.code === "opt_out_spike"), db };
}

// ── Acceptance 2: people, not events ────────────────────────────────────────

test("one hard_no reply (reply + unsubscribe on different pitch ids) is 1 person: no trip", async () => {
  const w = world();
  w.replyOptOut("p1");
  const r = await run(w);
  assert.deepEqual([r.optOutsThisWeek, r.tripped, r.errors], [1, false, []]);
});

test("two people opting out by reply is 2: no trip", async () => {
  const w = world();
  w.replyOptOut("p1");
  w.replyOptOut("p2");
  const r = await run(w);
  assert.deepEqual([r.optOutsThisWeek, r.tripped], [2, false]);
});

test("one reply opt-out + one link click from another person is 2: no trip", async () => {
  const w = world();
  w.replyOptOut("p1");
  w.linkOptOut("p2");
  const r = await run(w);
  assert.deepEqual([r.optOutsThisWeek, r.tripped], [2, false]);
});

test("three different people with no history is 3: trips opt_out_spike", async () => {
  const w = world();
  w.replyOptOut("p1");
  w.replyOptOut("p2");
  w.linkOptOut("p3");
  const r = await run(w);
  assert.deepEqual([r.optOutsThisWeek, r.tripped], [3, true]);
});

test("the same person replying twice (and clicking the link) is 1", async () => {
  const w = world();
  w.replyOptOut("p1", daysAgo(3));
  w.replyOptOut("p1", daysAgo(1));
  w.linkOptOut("p1", daysAgo(0.5));
  const r = await run(w);
  assert.deepEqual([r.optOutsThisWeek, r.tripped], [1, false]);
});

test("a hard_no reply whose unsubscribe never landed (poll killed before recordOptOut) still counts as 1", async () => {
  const w = world();
  w.other("p1", "reply", daysAgo(1), { intent: "hard_no" });
  const r = await run(w);
  assert.equal(r.optOutsThisWeek, 1);
});

test("other replies and events don't count: soft_no, interested, bounce, opened", async () => {
  const w = world();
  w.other("p1", "reply", daysAgo(1), { intent: "soft_no" });
  w.other("p2", "reply", daysAgo(1), { intent: "interested" });
  w.other("p3", "bounce", daysAgo(1), { bounce_type: "hard" });
  w.other("p4", "opened", daysAgo(1));
  const r = await run(w);
  assert.deepEqual([r.optOutsThisWeek, r.optOutWeeklyBaseline], [0, 0]);
});

test("events older than 30 days count in neither window; 8-29 days count only in the baseline", async () => {
  const w = world();
  w.replyOptOut("old", daysAgo(31));
  w.replyOptOut("mid", daysAgo(10));
  const r = await run(w);
  assert.equal(r.optOutsThisWeek, 0);
  assert.equal(r.optOutWeeklyBaseline, (1 / 30) * 7);
});

test("baseline: 10 people over 30 days (baseline ~2.3), 5 this week of them: no trip; 7: trip", async () => {
  for (const [thisWeek, trips] of [
    [5, false],
    [7, true],
  ] as const) {
    const w = world();
    for (let i = 0; i < 10; i++) w.replyOptOut(`p${i}`, i < thisWeek ? daysAgo(2) : daysAgo(15));
    const r = await run(w);
    assert.equal(r.optOutsThisWeek, thisWeek);
    assert.ok(Math.abs(r.optOutWeeklyBaseline - 70 / 30) < 1e-9, String(r.optOutWeeklyBaseline));
    assert.equal(r.tripped, trips, `${thisWeek} this week`);
  }
});

test("another tenant's opt-outs don't count", async () => {
  const w = world();
  w.replyOptOut("p1");
  w.tables.pitch_events.push({ id: "x", tenant_id: "t2", pitch_id: "p1-root", event_type: "unsubscribe", event_at: daysAgo(1), payload: {} });
  const r = await run(w);
  assert.equal(r.optOutsThisWeek, 1);
});

test("an event whose pitch the lookup doesn't return counts as its own person (never fewer)", async () => {
  const w = world();
  w.replyOptOut("p1");
  for (const id of ["gone1", "gone2"]) {
    w.tables.pitch_events.push({ id, tenant_id: TENANT, pitch_id: id, event_type: "unsubscribe", event_at: daysAgo(1), payload: {} });
  }
  const r = await run(w);
  assert.equal(r.optOutsThisWeek, 3);
});

test("the reads are bounded and select only pitch_id/event_at and id/prospect_id", () => {
  const s = src("lib/autopilot/opt-out-count.ts");
  assert.match(s, /\.select\("pitch_id, event_at"\)/);
  assert.match(s, /\.select\("id, prospect_id"\)/);
  assert.equal((s.match(/\.limit\(OPT_OUT_READ_LIMIT\)/g) ?? []).length, 2);
});

// ── Acceptance 3: a read error falls back to the event count, reported ──────

test("a failed pitch_events read falls back to the old event count (not 0) and reports it", async () => {
  const w = world();
  w.replyOptOut("p1");
  w.replyOptOut("p2", daysAgo(10));
  const r = await run(w, [{ table: "pitch_events", kind: "rows", message: "boom" }]);
  // Old behaviour: p1 = 2 events this week; p1 + p2 = 4 events in 30 days.
  assert.equal(r.optOutsThisWeek, 2);
  assert.equal(r.optOutWeeklyBaseline, (4 / 30) * 7);
  assert.equal(r.errors.length, 1);
  assert.match(r.errors[0]!, /opt-out people count failed \(pitch_events unsubscribe: boom\); using the event count/);
});

test("a failed pitches lookup falls back too", async () => {
  const w = world();
  w.replyOptOut("p1");
  const r = await run(w, [{ table: "pitches", kind: "rows", message: "" }]);
  assert.equal(r.optOutsThisWeek, 2);
  assert.match(r.errors[0]!, /pitches: read failed/);
});

test("an empty-body 5xx error ({ message: '' }) is still an error, not success", async () => {
  const w = world();
  w.replyOptOut("p1");
  const r = await run(w, [{ table: "pitch_events", kind: "rows", message: "" }]);
  assert.equal(r.optOutsThisWeek, 2);
  assert.equal(r.errors.length, 1);
});

test("a read that hits the limit falls back to the exact event count", async () => {
  const w = world();
  for (let i = 0; i < OPT_OUT_READ_LIMIT; i++) w.linkOptOut(`p${i}`);
  const r = await run(w);
  assert.equal(r.optOutsThisWeek, OPT_OUT_READ_LIMIT);
  assert.match(r.errors[0]!, /hit the read limit/);
});

test("when the fallback count fails too, both failures are reported", async () => {
  const w = world();
  w.replyOptOut("p1");
  const r = await run(w, [
    { table: "pitch_events", kind: "rows", message: "boom" },
    { table: "pitch_events", kind: "count", message: "down" },
  ]);
  assert.equal(r.errors.length, 3);
  assert.match(r.errors[1]!, /7 days.*down/);
  assert.match(r.errors[2]!, /30 days.*down/);
});

test("the fake rejects a column 0001 doesn't create (so a wrong select fails the tests)", async () => {
  const db = fakeDb({ pitch_events: [] });
  const r = await db.from("pitch_events").select("prospect_id").eq("tenant_id", TENANT);
  assert.equal(r.error?.message, "column pitch_events.prospect_id does not exist");
});

// ── Acceptance 4: the tick gets its opt-out numbers from this module ────────

test("runBreakers takes optOutsThisWeek and the baseline from optOutMetrics and reports its errors", () => {
  const s = src("lib/autopilot/tick.ts");
  const body = s.slice(s.indexOf("async function runBreakers"), s.indexOf("// ── 2. Watchdog"));
  assert.match(s, /import \{ optOutMetrics \} from "\.\/opt-out-count";/);
  assert.match(body, /optOutMetrics\(db, tenantId, now\)/);
  assert.match(body, /errors\.push\(\.\.\.optOuts\.errors\)/);
  assert.match(body, /optOutsThisWeek: optOuts\.optOutsThisWeek,/);
  assert.match(body, /optOutWeeklyBaseline: optOuts\.optOutWeeklyBaseline,/);
  assert.ok(!body.includes('"unsubscribe"') && !body.includes('"hard_no"'), "runBreakers must not count opt-outs itself");
  assert.match(s, /runBreakers\(db, tenantId, now, report\.errors\)/);
});

test("the opt_out_spike rule in governor.ts is unchanged", () => {
  assert.match(
    src("lib/autopilot/governor.ts"),
    /if \(m\.optOutsThisWeek >= 3 && m\.optOutsThisWeek >= 3 \* Math\.max\(m\.optOutWeeklyBaseline, 1\)\) \{/,
  );
});
