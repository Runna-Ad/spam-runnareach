/**
 * replies-optout-durability: a stored "remove me" reply always ends with the
 * sender on do_not_contact_list, even when the poll run that stored it failed
 * or was killed before the opt-out landed (lib/replies/optout-repair.ts).
 *
 * The sweep runs against a fake of the Supabase query builder that applies every
 * filter the way Postgres would and rejects any column the migrations do not
 * create (PostgREST answers 42703), driving the REAL recordOptOut. The route test
 * loads app/api/replies/poll/route.ts through a loader hook (as in
 * tests/autopilot-trust-split.test.ts): every import is stubbed except the sweep.
 */

import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { register } from "node:module";
import test from "node:test";
import { recordOptOut } from "../lib/compliance/opt-out.ts";
import {
  BOUNCE_REPAIR_WINDOW_MS,
  REPAIR_SETTLE_MS,
  REPAIRS_PER_RUN,
  repairMissedOptOuts,
  type RepairDeps,
} from "../lib/replies/optout-repair.ts";

const src = (p: string) => readFileSync(new URL(`../${p}`, import.meta.url), "utf8");

// ── Schema: columns as the migrations create them ───────────────────────────

const SCHEMA: Record<string, Set<string>> = (() => {
  const out: Record<string, Set<string>> = {};
  const dir = new URL("../supabase/migrations/", import.meta.url);
  for (const f of readdirSync(dir).filter((x) => x.endsWith(".sql")).sort()) {
    const sql = readFileSync(new URL(f, dir), "utf8");
    for (const [, table, body] of sql.matchAll(/create table (?:if not exists )?(?:public\.)?(\w+) \(([\s\S]*?)\n\);/gi)) {
      const cols = out[table!.toLowerCase()] ?? new Set<string>();
      for (const l of body!.split("\n")) {
        const c = l.trim().match(/^([a-z_][a-z0-9_]*)\s/i)?.[1]?.toLowerCase();
        if (c && !["primary", "unique", "constraint", "foreign", "check"].includes(c)) cols.add(c);
      }
      out[table!.toLowerCase()] = cols;
    }
    for (const [, table, body] of sql.matchAll(/alter table (?:if exists )?(?:only )?(?:public\.)?(\w+)([\s\S]*?);/gi)) {
      const cols = out[table!.toLowerCase()];
      if (!cols) continue;
      for (const [, c] of body!.matchAll(/add column (?:if not exists )?(\w+)/gi)) cols.add(c!.toLowerCase());
    }
  }
  return out;
})();

test("schema helper reads the tables the sweep touches", () => {
  for (const [t, c] of [
    ["replies", "from_email"],
    ["replies", "classified_at"],
    ["do_not_contact_list", "domain"],
    ["pitches", "sender_inbox_id"],
    ["pitches", "next_followup_at"],
    ["sender_inboxes", "email"],
    ["pitch_events", "event_at"],
  ] as const) {
    assert.ok(SCHEMA[t]?.has(c), `${t}.${c}`);
  }
  assert.equal(SCHEMA.replies?.has("created_at"), false, "replies has no created_at: the fake must reject it");
});

// ── Fake Supabase ───────────────────────────────────────────────────────────

type Row = Record<string, unknown>;
type Tables = Record<string, Row[]>;
type Op = "select" | "insert" | "update";

const cmp = (a: unknown, b: unknown): number => {
  const ta = Date.parse(String(a));
  const tb = Date.parse(String(b));
  if (!Number.isNaN(ta) && !Number.isNaN(tb)) return ta - tb;
  return String(a) < String(b) ? -1 : String(a) > String(b) ? 1 : 0;
};

let nextId = 1;

function fakeDb(tables: Tables, opts: { fail?: Partial<Record<`${string}.${Op}`, string>> } = {}) {
  const log: Array<{ table: string; op: Op }> = [];
  function check(table: string, cols: string[]) {
    const known = SCHEMA[table];
    assert.ok(known, `fake: unknown table ${table}`);
    for (const c of cols) assert.ok(known.has(c), `fake: column ${table}.${c} does not exist (42703)`);
  }
  return {
    tables,
    log,
    from(table: string) {
      const filters: Array<(r: Row) => boolean> = [];
      let op: Op = "select";
      let cols: string[] | null = null;
      let payload: Row | Row[] | null = null;
      let patch: Row | null = null;
      let order: { col: string; asc: boolean } | null = null;
      let limit: number | null = null;
      let single = false;
      let returning = false;
      const where = (col: string, f: (v: unknown) => boolean) => {
        check(table, [col]);
        filters.push((r) => f(r[col]));
        return b;
      };
      const run = () => {
        log.push({ table, op });
        const failure = opts.fail?.[`${table}.${op}`];
        if (failure !== undefined) return { data: null, error: { message: failure } };
        const rows = (tables[table] ??= []);
        if (op === "insert") {
          const list = Array.isArray(payload) ? payload : [payload!];
          check(table, list.flatMap((p) => Object.keys(p)));
          // Column defaults the code relies on (0001: event_at / created_at default now()).
          const defaults: Row = {};
          for (const c of ["event_at", "created_at"]) if (SCHEMA[table]!.has(c)) defaults[c] = new Date().toISOString();
          const added = list.map((p) => ({ id: `id-${nextId++}`, ...defaults, ...p }));
          rows.push(...added);
          const data = returning ? (single ? (added[0] ?? null) : added) : null;
          return { data, error: null };
        }
        let hit = rows.filter((r) => filters.every((f) => f(r)));
        if (op === "update") {
          check(table, Object.keys(patch!));
          for (const r of hit) Object.assign(r, patch);
          return { data: returning ? hit : null, error: null };
        }
        if (order) hit = [...hit].sort((x, y) => (order!.asc ? 1 : -1) * cmp(x[order!.col], y[order!.col]));
        if (limit !== null) hit = hit.slice(0, limit);
        const project = (r: Row) => (cols ? Object.fromEntries(cols.map((c) => [c, r[c] ?? null])) : { ...r });
        if (single) return { data: hit[0] ? project(hit[0]) : null, error: null };
        return { data: hit.map(project), error: null };
      };
      const b = {
        select(sel?: string) {
          if (op === "select") {
            cols = sel && sel.trim() !== "*" ? sel.split(",").map((c) => c.trim()) : null;
            if (cols) check(table, cols);
          } else returning = true;
          return b;
        },
        insert(p: Row | Row[]) {
          op = "insert";
          payload = p;
          return b;
        },
        update(p: Row) {
          op = "update";
          patch = p;
          return b;
        },
        eq: (c: string, v: unknown) => where(c, (x) => x === v),
        in: (c: string, vs: unknown[]) => where(c, (x) => vs.includes(x)),
        is: (c: string, v: unknown) => where(c, (x) => (x ?? null) === v),
        gte: (c: string, v: unknown) => where(c, (x) => x != null && cmp(x, v) >= 0),
        lt: (c: string, v: unknown) => where(c, (x) => x != null && cmp(x, v) < 0),
        not(c: string, o: string, v: string | null) {
          if (o === "is") return where(c, (x) => (x ?? null) !== v);
          assert.ok(o === "in" && v !== null, "fake: only not(col, 'in' | 'is', …)");
          const list = v.replace(/^\(|\)$/g, "").split(",").map((s) => s.trim().replace(/^"|"$/g, ""));
          return where(c, (x) => !list.includes(String(x)));
        },
        order(c: string, o?: { ascending?: boolean }) {
          check(table, [c]);
          order = { col: c, asc: o?.ascending !== false };
          return b;
        },
        limit(n: number) {
          limit = n;
          return b;
        },
        maybeSingle() {
          single = true;
          return b;
        },
        then<T>(ok: (v: ReturnType<typeof run>) => T, ko?: (e: unknown) => T) {
          return Promise.resolve().then(run).then(ok, ko);
        },
      };
      return b;
    },
  };
}

// ── Fixtures ────────────────────────────────────────────────────────────────

const T = "tenant-1";
const NOW = Date.parse("2026-10-20T18:00:00Z");
const ago = (ms: number) => new Date(NOW - ms).toISOString();
const DAY = 24 * 60 * 60 * 1000;

function hardNo(id: string, from: string, over: Row = {}): Row {
  return {
    id,
    tenant_id: T,
    prospect_id: `p-${id}`,
    pitch_id: `pitch-${id}`,
    from_email: from,
    subject: "Re: hello",
    body_text: "Please remove me from your list.",
    intent: "hard_no",
    received_at: ago(DAY),
    classified_at: ago(DAY),
    ...over,
  };
}

const NDR = (addr: string) =>
  `Delivery Status Notification (Failure)\n\nYour message wasn't delivered to ${addr} because the address couldn't be found.\n\nFinal-Recipient: rfc822; ${addr}\nStatus: 5.1.1`;

function bounce(id: string, addr: string, over: Row = {}): Row {
  return {
    id,
    tenant_id: T,
    prospect_id: `p-${id}`,
    pitch_id: "pitch-b",
    from_email: "mailer-daemon@googlemail.com",
    subject: "Delivery Status Notification (Failure)",
    body_text: NDR(addr),
    intent: "bounced",
    received_at: ago(DAY),
    classified_at: ago(30 * 60_000),
    ...over,
  };
}

function world(over: Partial<Tables> = {}): Tables {
  return {
    replies: [],
    do_not_contact_list: [],
    prospects: [],
    pitches: [{ id: "pitch-b", tenant_id: T, prospect_id: "p-b", sender_inbox_id: "inbox-1", status: "sent", parent_pitch_id: null, sent_at: ago(2 * DAY) }],
    sender_inboxes: [{ id: "inbox-1", tenant_id: T, email: "pedro@runnareach.com" }],
    pitch_events: [],
    audit_log: [],
    ...over,
  };
}

/** The real recordOptOut, counted. */
function spy(impl: typeof recordOptOut = recordOptOut) {
  const calls: Array<Parameters<typeof recordOptOut>[1]> = [];
  const fn: typeof recordOptOut = async (db, args) => {
    calls.push(args);
    return impl(db, args);
  };
  return { fn, calls };
}

const deps = (s: ReturnType<typeof spy>, over: Partial<RepairDeps> = {}): RepairDeps => ({
  recordOptOut: s.fn,
  now: () => NOW,
  deadline: NOW + 60_000,
  ...over,
});

const dncFor = (t: Tables, email: string) => t.do_not_contact_list!.filter((r) => r.email === email);
const optOutAudits = (t: Tables) => t.audit_log!.filter((r) => r.action === "prospect.opted_out");

// ── Opt-outs ────────────────────────────────────────────────────────────────

test("stored hard_no not on the list → recordOptOut once, DNC row present, note names the reply", async () => {
  const t = world({ replies: [hardNo("r1", "Owner@Acme.ca")], prospects: [{ id: "p-r1", tenant_id: T, status: "contacted" }] });
  const s = spy();
  const r = await repairMissedOptOuts(fakeDb(t), deps(s));
  assert.equal(s.calls.length, 1);
  assert.equal(s.calls[0]!.email, "owner@acme.ca");
  assert.equal(s.calls[0]!.source, "reply");
  assert.equal(s.calls[0]!.prospectId, "p-r1");
  assert.match(s.calls[0]!.note ?? "", /sweep.*reply r1/);
  assert.equal(dncFor(t, "owner@acme.ca").length, 1);
  assert.equal(t.prospects![0]!.status, "suppressed");
  assert.deepEqual(r.optOuts, { repaired: 1, failed: 0, pending: 0 });
  assert.deepEqual(r.errors, []);

  // The next run finds it on the list: no call, no second row, no second audit.
  const s2 = spy();
  const r2 = await repairMissedOptOuts(fakeDb(t), deps(s2));
  assert.equal(s2.calls.length, 0);
  assert.deepEqual(r2.optOuts, { repaired: 0, failed: 0, pending: 0 });
  assert.equal(dncFor(t, "owner@acme.ca").length, 1);
  assert.equal(optOutAudits(t).length, 1);
});

test("already on the list by address (reply in any case) → no call, no second row, no audit", async () => {
  const t = world({
    replies: [hardNo("r1", "owner@acme.ca"), hardNo("r2", "Boss@Shop.mx")],
    do_not_contact_list: [
      { id: "d1", tenant_id: T, entry_type: "unsubscribed", email: "owner@acme.ca" },
      { id: "d2", tenant_id: T, entry_type: "unsubscribed", email: "boss@shop.mx" },
    ],
  });
  const s = spy();
  const db = fakeDb(t);
  const r = await repairMissedOptOuts(db, deps(s));
  assert.equal(s.calls.length, 0);
  assert.equal(t.do_not_contact_list!.length, 2);
  assert.equal(optOutAudits(t).length, 0);
  assert.equal(db.log.filter((l) => l.op !== "select").length, 0, "no writes at all");
  assert.deepEqual(r.optOuts, { repaired: 0, failed: 0, pending: 0 });
});

test("a legacy mixed-case DNC row does not block a send, so it does not count: the lowercase twin is added", async () => {
  const t = world({
    replies: [hardNo("r1", "Hand@Entered.ca")],
    do_not_contact_list: [{ id: "d1", tenant_id: T, entry_type: "existing_client", email: "Hand@Entered.ca" }],
  });
  const s = spy();
  await repairMissedOptOuts(fakeDb(t), deps(s));
  assert.deepEqual(s.calls.map((c) => c.email), ["hand@entered.ca"]);
  assert.equal(dncFor(t, "hand@entered.ca").length, 1);
});

test("on the list by a domain row → no call, and the sweep never writes a domain row", async () => {
  const t = world({
    replies: [hardNo("r1", "owner@acme.ca"), hardNo("r2", "someone@gmail.com")],
    do_not_contact_list: [{ id: "d1", tenant_id: T, entry_type: "competitor", domain: "acme.ca" }],
  });
  const s = spy();
  await repairMissedOptOuts(fakeDb(t), deps(s));
  assert.deepEqual(s.calls.map((c) => c.email), ["someone@gmail.com"]);
  assert.equal(t.do_not_contact_list!.filter((r) => r.domain && r.id !== "d1").length, 0, "no domain row written");
  assert.equal(t.do_not_contact_list!.filter((r) => r.email === "someone@gmail.com" && !r.domain).length, 1);
});

test("another tenant's DNC row does not count", async () => {
  const t = world({
    replies: [hardNo("r1", "owner@acme.ca")],
    do_not_contact_list: [{ id: "d1", tenant_id: "tenant-2", entry_type: "unsubscribed", email: "owner@acme.ca" }],
  });
  const s = spy();
  await repairMissedOptOuts(fakeDb(t), deps(s));
  assert.equal(s.calls.length, 1);
});

test("recordOptOut ok:false → counted failed, error reported, retried next run", async () => {
  const t = world({ replies: [hardNo("r1", "owner@acme.ca")] });
  const s = spy(async () => ({ ok: false, error: "DNC insert failed: boom" }));
  const r = await repairMissedOptOuts(fakeDb(t), deps(s));
  assert.deepEqual(r.optOuts, { repaired: 0, failed: 1, pending: 0 });
  assert.match(r.errors.join("\n"), /reply r1 failed: DNC insert failed: boom/);

  const s2 = spy();
  const r2 = await repairMissedOptOuts(fakeDb(t), deps(s2));
  assert.equal(s2.calls.length, 1, "found again on the next run");
  assert.deepEqual(r2.optOuts, { repaired: 1, failed: 0, pending: 0 });
});

test("the real recordOptOut failing on the DNC insert → failed, nothing written, retried", async () => {
  const t = world({ replies: [hardNo("r1", "owner@acme.ca")] });
  const s = spy();
  const r = await repairMissedOptOuts(fakeDb(t, { fail: { "do_not_contact_list.insert": "" } }), deps(s));
  assert.deepEqual(r.optOuts, { repaired: 0, failed: 1, pending: 0 });
  assert.equal(t.do_not_contact_list!.length, 0);
  const r2 = await repairMissedOptOuts(fakeDb(t), deps(spy()));
  assert.equal(r2.optOuts.repaired, 1);
});

test("a throwing recordOptOut is counted failed and the rest still run", async () => {
  const t = world({ replies: [hardNo("r1", "a@acme.ca", { received_at: ago(DAY) }), hardNo("r2", "b@acme.ca", { received_at: ago(2 * DAY) })] });
  let n = 0;
  const s = spy(async (db, args) => {
    if (n++ === 0) throw new Error("socket hang up");
    return recordOptOut(db, args);
  });
  const r = await repairMissedOptOuts(fakeDb(t), deps(s));
  assert.deepEqual(r.optOuts, { repaired: 1, failed: 1, pending: 0 });
});

test(`more than ${REPAIRS_PER_RUN} → the rest wait for the next run`, async () => {
  const replies = Array.from({ length: REPAIRS_PER_RUN + 3 }, (_, i) =>
    hardNo(`r${i}`, `owner${i}@acme.ca`, { received_at: ago((i + 1) * 60 * 60 * 1000) }),
  );
  const t = world({ replies });
  const s = spy();
  const r = await repairMissedOptOuts(fakeDb(t), deps(s));
  assert.equal(s.calls.length, REPAIRS_PER_RUN);
  assert.deepEqual(r.optOuts, { repaired: REPAIRS_PER_RUN, failed: 0, pending: 3 });
  const r2 = await repairMissedOptOuts(fakeDb(t), deps(spy()));
  assert.deepEqual(r2.optOuts, { repaired: 3, failed: 0, pending: 0 });
  assert.equal(t.do_not_contact_list!.length, REPAIRS_PER_RUN + 3);
});

test("past the deadline → no repair starts (and no read either when out of time up front)", async () => {
  const t = world({ replies: [hardNo("r1", "a@acme.ca"), hardNo("r2", "b@acme.ca")] });
  let clock = NOW;
  const s = spy(async (db, args) => {
    clock += 30_000; // a slow repair eats the budget
    return recordOptOut(db, args);
  });
  const r = await repairMissedOptOuts(fakeDb(t), deps(s, { now: () => clock, deadline: NOW + 20_000 }));
  assert.deepEqual(r.optOuts, { repaired: 1, failed: 0, pending: 1 });

  const db = fakeDb(world({ replies: [hardNo("r3", "c@acme.ca")] }));
  await repairMissedOptOuts(db, deps(spy(), { deadline: NOW - 1 }));
  assert.equal(db.log.length, 0);
});

test("a reply read error → no writes, error reported", async () => {
  const t = world({ replies: [hardNo("r1", "a@acme.ca")] });
  const s = spy();
  const db = fakeDb(t, { fail: { "replies.select": "" } });
  const r = await repairMissedOptOuts(db, deps(s));
  assert.equal(s.calls.length, 0);
  assert.equal(db.log.filter((l) => l.op !== "select").length, 0);
  assert.match(r.errors.join("\n"), /hard_no replies read failed: query failed with no error message/);
});

test("a DNC read error (empty 5xx body) → no writes: an unreadable list is not a missing entry", async () => {
  const t = world({ replies: [hardNo("r1", "a@acme.ca")] });
  const s = spy();
  const db = fakeDb(t, { fail: { "do_not_contact_list.select": "" } });
  const r = await repairMissedOptOuts(db, deps(s));
  assert.equal(s.calls.length, 0);
  assert.equal(db.log.filter((l) => l.op !== "select").length, 0);
  assert.match(r.errors.join("\n"), /opt-out repair: DNC lookup failed/);
  assert.deepEqual(r.optOuts, { repaired: 0, failed: 0, pending: 0 });
});

test("a reply stored moments ago is left to the run that stored it", async () => {
  const t = world({ replies: [hardNo("r1", "a@acme.ca", { classified_at: ago(REPAIR_SETTLE_MS - 1000) })] });
  const s = spy();
  await repairMissedOptOuts(fakeDb(t), deps(s));
  assert.equal(s.calls.length, 0);
  const s2 = spy();
  await repairMissedOptOuts(fakeDb(t), deps(s2, { now: () => NOW + 2000, deadline: NOW + 60_000 }));
  assert.equal(s2.calls.length, 1);
});

test("two hard_no replies from one sender → one repair", async () => {
  const t = world({ replies: [hardNo("r1", "a@acme.ca"), hardNo("r2", "A@acme.ca", { received_at: ago(2 * DAY) })] });
  const s = spy();
  await repairMissedOptOuts(fakeDb(t), deps(s));
  assert.equal(s.calls.length, 1);
  assert.equal(optOutAudits(t).length, 1);
});

test("no reply other than hard_no (or a parseable recent bounce) causes a DNC write", async () => {
  const intents = ["wants_meeting", "wants_info", "not_now", "wrong_person", "auto_reply", "unclassified"];
  const t = world({
    replies: intents.map((intent, i) => hardNo(`r${i}`, `x${i}@acme.ca`, { intent, body_text: "unsubscribe me" })),
  });
  const s = spy();
  const db = fakeDb(t);
  await repairMissedOptOuts(db, deps(s));
  assert.equal(s.calls.length, 0);
  assert.equal(db.log.filter((l) => l.op !== "select").length, 0);
});

test("prod shape (2026-10-20): two old hard_no senders off the list, prospects already suppressed → repaired: 2, then 0", async () => {
  const t = world({
    replies: [
      hardNo("acadian", "calgauthier@gmail.com", { received_at: "2026-07-11T16:00:00Z", classified_at: "2026-07-11T16:01:00Z" }),
      hardNo("caliber", "info@highcaliberproducts.com", { received_at: "2026-07-23T17:00:00Z", classified_at: "2026-07-23T17:01:00Z" }),
    ],
    prospects: [
      { id: "p-acadian", tenant_id: T, status: "suppressed", suppressed_at: "2026-07-11T16:05:00Z", suppressed_reason: "Opted out (reply)" },
      { id: "p-caliber", tenant_id: T, status: "suppressed", suppressed_at: "2026-07-23T17:05:00Z", suppressed_reason: "Opted out (reply)" },
    ],
    pitches: [
      { id: "root-acadian", tenant_id: T, prospect_id: "p-acadian", status: "sent", parent_pitch_id: null, sent_at: "2026-07-10T15:00:00Z", sequence_paused_at: "2026-07-11T16:05:00Z" },
      { id: "root-caliber", tenant_id: T, prospect_id: "p-caliber", status: "sent", parent_pitch_id: null, sent_at: "2026-07-22T15:00:00Z", sequence_paused_at: "2026-07-23T17:05:00Z" },
    ],
  });
  const before = JSON.stringify({ prospects: t.prospects, pitches: t.pitches });
  const s = spy();
  const r = await repairMissedOptOuts(fakeDb(t), deps(s));
  assert.deepEqual(r.optOuts, { repaired: 2, failed: 0, pending: 0 });
  // No phantom `unsubscribe` events dated now (the autopilot's opt_out_spike counts them), no rewrite of the old suppression.
  assert.deepEqual(s.calls.map((c) => c.prospectId), [null, null]);
  assert.equal(t.pitch_events!.length, 0);
  assert.equal(JSON.stringify({ prospects: t.prospects, pitches: t.pitches }), before);
  assert.equal(optOutAudits(t).length, 2);
  assert.equal(t.do_not_contact_list!.length, 2);
  assert.ok(t.do_not_contact_list!.every((d) => d.email && !d.domain && d.entry_type === "unsubscribed"), "address rows only");
  const r2 = await repairMissedOptOuts(fakeDb(t), deps(spy()));
  assert.deepEqual(r2.optOuts, { repaired: 0, failed: 0, pending: 0 });
});

test("a prospect still live gets exactly the writes the live poll path would make (unsubscribe event on the root pitch)", async () => {
  const live = (): Tables =>
    world({
      prospects: [{ id: "p-r1", tenant_id: T, status: "contacted" }],
      pitches: [
        { id: "root", tenant_id: T, prospect_id: "p-r1", status: "sent", parent_pitch_id: null, sent_at: ago(3 * DAY), sequence_paused_at: null, next_followup_at: ago(-DAY) },
        { id: "fu1", tenant_id: T, prospect_id: "p-r1", status: "sent", parent_pitch_id: "root", sent_at: ago(2 * DAY), sequence_paused_at: null, next_followup_at: ago(-DAY) },
      ],
    });
  // What the poll does live: recordOptOut with the prospect id.
  const direct = live();
  const dDb = fakeDb(direct);
  await recordOptOut(dDb, { tenantId: T, prospectId: "p-r1", email: "owner@acme.ca", source: "reply", note: "x" });
  // What the sweep does for the same stored reply.
  const swept = live();
  swept.replies!.push(hardNo("r1", "owner@acme.ca"));
  const sDb = fakeDb(swept);
  const s = spy();
  await repairMissedOptOuts(sDb, deps(s));
  assert.equal(s.calls[0]!.prospectId, "p-r1");
  const writes = (db: ReturnType<typeof fakeDb>) => db.log.filter((l) => l.op !== "select").map((l) => `${l.op} ${l.table}`);
  assert.deepEqual(writes(sDb), writes(dDb));
  assert.equal(swept.pitch_events!.length, 1);
  assert.equal(swept.pitch_events![0]!.pitch_id, "root");
  assert.equal(swept.pitch_events![0]!.event_type, "unsubscribe");
  assert.ok(swept.pitch_events![0]!.event_at, "event_at default applied");
  assert.equal(swept.prospects![0]!.status, "suppressed");
  assert.ok(swept.pitches!.every((p) => p.sequence_paused_at && p.next_followup_at === null));
});

test("prospect gone, or in any do-not-send status → DNC row + audit only (prospectId null)", async () => {
  const t = world({
    replies: [hardNo("r1", "a@acme.ca"), hardNo("r2", "b@acme.ca"), hardNo("r3", "c@acme.ca"), hardNo("r4", "d@acme.ca", { prospect_id: null })],
    prospects: [
      { id: "p-r2", tenant_id: T, status: "booked" },
      { id: "p-r3", tenant_id: T, status: "no_match" },
    ],
  });
  const s = spy();
  const r = await repairMissedOptOuts(fakeDb(t), deps(s));
  assert.deepEqual(s.calls.map((c) => c.prospectId), [null, null, null, null]);
  assert.equal(r.optOuts.repaired, 4);
  assert.equal(t.prospects![0]!.status, "booked");
  assert.equal(t.pitch_events!.length, 0);
});

test("a prospects read error → no opt-out writes, error reported", async () => {
  const t = world({ replies: [hardNo("r1", "a@acme.ca")] });
  const s = spy();
  const db = fakeDb(t, { fail: { "prospects.select": "" } });
  const r = await repairMissedOptOuts(db, deps(s));
  assert.equal(s.calls.length, 0);
  assert.equal(db.log.filter((l) => l.op !== "select").length, 0);
  assert.match(r.errors.join("\n"), /opt-out repair: prospects read failed/);
});

// ── Bounces ─────────────────────────────────────────────────────────────────

test("recent bounce whose DNC insert never landed → address added as bounced, once", async () => {
  const t = world({ replies: [bounce("b1", "dead@clinica.mx")] });
  const r = await repairMissedOptOuts(fakeDb(t), deps(spy()));
  assert.deepEqual(r.bounces, { repaired: 1, failed: 0, pending: 0 });
  const rows = dncFor(t, "dead@clinica.mx");
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.entry_type, "bounced");
  assert.match(String(rows[0]!.notes), /reply b1/);
  const r2 = await repairMissedOptOuts(fakeDb(t), deps(spy()));
  assert.deepEqual(r2.bounces, { repaired: 0, failed: 0, pending: 0 });
  assert.equal(dncFor(t, "dead@clinica.mx").length, 1);
});

test("bounces: never our own address, never a delay notice, never older than the window, never without the inbox", async () => {
  const t = world({
    replies: [
      bounce("own", "pedro@runnareach.com", { body_text: "Final-Recipient: rfc822; pedro@runnareach.com\nStatus: 5.1.1" }),
      bounce("delay", "slow@acme.ca", {
        subject: "Delivery Status Notification (Delay)",
        body_text: "Message temporarily deferred. The server will retry delivery to slow@acme.ca. Final-Recipient: rfc822; slow@acme.ca\nWill-Retry-Until: tomorrow",
      }),
      bounce("old", "old@acme.ca", { classified_at: ago(BOUNCE_REPAIR_WINDOW_MS + 60_000) }),
      bounce("orphan", "orphan@acme.ca", { pitch_id: null }),
      bounce("noinbox", "noinbox@acme.ca", { pitch_id: "pitch-x" }),
      bounce("unparsed", "", { body_text: "Something went wrong." }),
    ],
    pitches: [
      { id: "pitch-b", tenant_id: T, sender_inbox_id: "inbox-1" },
      { id: "pitch-x", tenant_id: T, sender_inbox_id: null },
    ],
  });
  const db = fakeDb(t);
  const r = await repairMissedOptOuts(db, deps(spy()));
  assert.deepEqual(r.bounces, { repaired: 0, failed: 0, pending: 0 });
  assert.equal(t.do_not_contact_list!.length, 0);
});

test("bounces: a bounced row a person removed in /compliance after the window is not put back", async () => {
  // Live path added it, Pedro deleted it (removeDnc hard-deletes): nothing on the list now.
  const t = world({ replies: [bounce("b1", "full@acme.ca", { classified_at: ago(BOUNCE_REPAIR_WINDOW_MS + 60_000) })] });
  const db = fakeDb(t);
  const r = await repairMissedOptOuts(db, deps(spy()));
  assert.deepEqual(r.bounces, { repaired: 0, failed: 0, pending: 0 });
  assert.equal(db.log.filter((l) => l.op !== "select").length, 0);
});

test("bounces: the repair window is about 2 hours, pinned at a fixed age (a lift 3 h after the bounce sticks)", async () => {
  // Fixed ages, not relative to the constant: setting the window back to 14 days must fail here.
  assert.ok(BOUNCE_REPAIR_WINDOW_MS <= 3 * 60 * 60_000, "window must stay a few hours, not days");
  const t = world({ replies: [bounce("b1", "full@acme.ca", { classified_at: ago(3 * 60 * 60_000) })] });
  const db = fakeDb(t);
  const r = await repairMissedOptOuts(db, deps(spy()));
  assert.deepEqual(r.bounces, { repaired: 0, failed: 0, pending: 0 });
  assert.equal(db.log.filter((l) => l.op !== "select").length, 0);
});

test("bounces: an NDR imported late (old received_at, fresh classified_at) is still repaired", async () => {
  const t = world({ replies: [bounce("b1", "dead@clinica.mx", { received_at: ago(20 * DAY), classified_at: ago(30 * 60_000) })] });
  const r = await repairMissedOptOuts(fakeDb(t), deps(spy()));
  assert.deepEqual(r.bounces, { repaired: 1, failed: 0, pending: 0 });
});

test("bounces: a bounced address already listed (address or domain) is not added again; an insert error is counted", async () => {
  const t = world({
    replies: [bounce("b1", "dead@clinica.mx"), bounce("b2", "gone@closed.ca")],
    do_not_contact_list: [{ id: "d1", tenant_id: T, entry_type: "bounced", email: "dead@clinica.mx" }],
  });
  const r = await repairMissedOptOuts(fakeDb(t, { fail: { "do_not_contact_list.insert": "" } }), deps(spy()));
  assert.deepEqual(r.bounces, { repaired: 0, failed: 1, pending: 0 });
  assert.match(r.errors.join("\n"), /bounce repair for reply b2 failed/);
});

test("opt-outs go first and share the per-run bound with bounces", async () => {
  const replies = [
    ...Array.from({ length: REPAIRS_PER_RUN - 1 }, (_, i) => hardNo(`r${i}`, `o${i}@acme.ca`)),
    bounce("b1", "dead1@clinica.mx"),
    bounce("b2", "dead2@clinica.mx"),
  ];
  const t = world({ replies });
  const r = await repairMissedOptOuts(fakeDb(t), deps(spy()));
  assert.deepEqual(r.optOuts, { repaired: REPAIRS_PER_RUN - 1, failed: 0, pending: 0 });
  assert.deepEqual(r.bounces, { repaired: 1, failed: 0, pending: 1 });
});

test("a bounce read error leaves the opt-out repairs in place and reports it", async () => {
  const t = world({ replies: [hardNo("r1", "a@acme.ca"), bounce("b1", "dead@clinica.mx")] });
  const r = await repairMissedOptOuts(fakeDb(t, { fail: { "sender_inboxes.select": "timeout" } }), deps(spy()));
  assert.equal(r.optOuts.repaired, 1);
  assert.equal(r.bounces.repaired, 0);
  assert.match(r.errors.join("\n"), /bounce repair: sender inboxes read failed: timeout/);
  assert.equal(dncFor(t, "dead@clinica.mx").length, 0);
});

// ── The route ───────────────────────────────────────────────────────────────

const u = (p: string) => new URL(p, import.meta.url).href;
const ROUTE = u("../app/api/replies/poll/route.ts");
const REAL: Record<string, Record<string, string>> = {
  [ROUTE]: { "@/lib/replies/optout-repair": u("../lib/replies/optout-repair.ts") },
};

function importsOf(url: string): Record<string, string[]> {
  const text = readFileSync(new URL(url), "utf8");
  const out: Record<string, string[]> = {};
  for (const [, names, from] of text.matchAll(/^import \{([^}]*)\} from "([^"]+)";/gm)) {
    out[from!] = names!
      .split(",")
      .map((n) => n.trim())
      .filter((n) => n && !n.startsWith("type "));
  }
  return out;
}
const STUBS = { [ROUTE]: importsOf(ROUTE) };

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

test("route: the sweep runs after the start-of-run alerts and before the thread poll, and its result is in the report", async () => {
  const t = world({ replies: [hardNo("r1", "owner@acme.ca")], pitches: [] });
  const db = fakeDb(t);
  const order: string[] = [];
  const g = globalThis as unknown as { __stubValues: Record<string, unknown>; __stubCall: (n: string, a: unknown[]) => unknown };
  g.__stubValues = {
    NextResponse: { json: (body: unknown, init?: unknown) => ({ body, init }) },
    // The cron heartbeat (tests/health-alarms.test.ts) passes the run through.
    withHeartbeat: (_job: unknown, run: () => unknown) => run(),
  };
  g.__stubCall = (name, args) => {
    switch (name) {
      case "isSchedulerAuthorized":
        return Promise.resolve(true);
      case "createServiceRoleClient":
        return {
          from(table: string) {
            if (table === "pitches") order.push("thread poll");
            if (table === "do_not_contact_list") order.push("sweep");
            return db.from(table);
          },
        };
      case "supabaseLeadAlertStore":
        return {};
      case "sendPendingLeadAlerts":
        order.push(args.length > 2 ? "end alerts" : "start alerts");
        return Promise.resolve({ sent: 0, failed: [] });
      case "recordOptOut": // the route's own import (the live hard_no path); the sweep loads the real one
      default:
        throw new Error(`stub ${name} called`);
    }
  };
  const { GET } = (await import(ROUTE)) as {
    GET: (req: unknown) => Promise<{ body: { opt_out_repair: unknown; bounce_repair: unknown; errors: string[] } }>;
  };
  const res = await GET({ nextUrl: new URL("https://x/api/replies/poll"), headers: new Headers() });
  assert.deepEqual(res.body.opt_out_repair, { repaired: 1, failed: 0, pending: 0 });
  assert.deepEqual(res.body.bounce_repair, { repaired: 0, failed: 0, pending: 0 });
  assert.deepEqual(res.body.errors, []);
  assert.equal(dncFor(t, "owner@acme.ca").length, 1);
  const firstSweep = order.indexOf("sweep");
  assert.ok(order.indexOf("start alerts") < firstSweep, order.join(" → "));
  assert.ok(firstSweep < order.indexOf("thread poll"), order.join(" → "));
  assert.equal(order.at(-1), "end alerts");
});

test("route source: DEAD_STATUSES keeps no_match out, with the reason; postponeSequence untouched", () => {
  const route = src("app/api/replies/poll/route.ts");
  const dead = route.match(/const DEAD_STATUSES = new Set\(\[([^\]]*)\]\)/)?.[1] ?? "";
  assert.ok(dead.includes('"suppressed"'));
  assert.equal(dead.includes("no_match"), false);
  assert.match(route, /Not "no_match": its threads still carry opt-outs/);
  assert.match(route, /\.lt\("next_followup_at", until\);/);
});
