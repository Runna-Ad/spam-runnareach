/**
 * Send-path hardening (phase 3 batch 4):
 *   1. every send counts against the inbox's daily cap exactly once, even when
 *      two send runs overlap (atomic slot RPC, migration 0049)
 *   2. a failed Gmail send gives its slot back; an accepted one keeps it
 *   3. the send-queue stops claiming before maxDuration
 *   4. an autopilot approval whose address turned "review" goes back to a person
 *   5. follow-ups obey the same bounce stop as the send-queue
 *
 * The routes import Next/Gmail and can't load under node:test, so the logic
 * lives in lib/pitches/daily-cap.ts (tested with fakes) and the call sites are
 * checked from source.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  CLAIM_RESERVE_MS,
  SEND_ROUTE_MAX_MS,
  effectiveSendsToday,
  hasTimeToClaim,
  releaseSendSlot,
  reserveSendSlot,
  utcToday,
  type SlotClient,
} from "../lib/pitches/daily-cap.ts";
import {
  APPROVAL_EVENT_COLUMNS,
  DOUBTFUL_ADDRESS_HOLD,
  holdDoubtfulAutoApproval,
  latestApproval,
  sendTimeVerdictAction,
} from "../lib/pitches/send-time-hold.ts";
import { heldAction, HELD_BY_AUTOPILOT } from "../lib/autopilot/governor.ts";
import { BOUNCE_BREAKER, inboxBounceBlock } from "../lib/autopilot/bounce-breaker.ts";

const TENANT = "11111111-1111-1111-1111-111111111111";
const INBOX = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
const src = (p: string) => readFileSync(new URL(`../${p}`, import.meta.url), "utf8");
const yieldNow = () => new Promise<void>((r) => setImmediate(r));

// ── Fake sender_inboxes row + slot RPCs ──────────────────────────────────────

type InboxRow = { sends_today: number; last_reset_date: string; daily_cap: number };

/**
 * The two RPCs as migration 0049 defines them. atomic=true: one statement, the
 * row lock serializes callers (the check and the write happen together).
 * atomic=false: the old read → yield → write, so overlapping callers race.
 * The read snapshots BEFORE it yields, or two runs never overlap.
 */
function slotDb(
  row: InboxRow,
  opts: { atomic: boolean; failReserve?: string; today?: string },
): SlotClient & { calls: string[]; setToday: (d: string) => void } {
  let today = opts.today ?? utcToday();
  const calls: string[] = [];
  return {
    calls,
    setToday: (d: string) => {
      today = d;
    },
    async rpc(fn: string, args: Record<string, unknown>) {
      calls.push(fn);
      if (fn === "spam_reserve_send_slot") {
        if (opts.failReserve !== undefined) return { data: null, error: { message: opts.failReserve } };
        if (opts.atomic) {
          const eff = row.last_reset_date === today ? row.sends_today : 0;
          if (eff >= row.daily_cap) return { data: null, error: null };
          row.sends_today = eff + 1;
          row.last_reset_date = today;
          await yieldNow();
          return { data: today, error: null };
        }
        const snap = { ...row };
        await yieldNow();
        const eff = snap.last_reset_date === today ? snap.sends_today : 0;
        if (eff >= snap.daily_cap) return { data: null, error: null };
        row.sends_today = eff + 1;
        row.last_reset_date = today;
        return { data: today, error: null };
      }
      if (fn === "spam_release_send_slot") {
        const hit = row.sends_today > 0 && row.last_reset_date === args.p_day;
        if (hit) row.sends_today -= 1;
        return { data: hit, error: null };
      }
      throw new Error(`unexpected rpc ${fn}`);
    },
  };
}

/**
 * One send run, in the routes' order: claim → reserve → (token, recheck) →
 * Gmail → on refusal give the slot back. `gmail` decides per pitch.
 */
async function sendRun(db: SlotClient, pitches: string[], gmail: (id: string) => boolean): Promise<string[]> {
  const sent: string[] = [];
  for (const id of pitches) {
    const slot = await reserveSendSlot(db, INBOX);
    if (!slot.ok) {
      if (slot.capReached) break;
      continue;
    }
    await yieldNow(); // token + recheck
    if (!gmail(id)) {
      await releaseSendSlot(db, INBOX, slot.day);
      continue;
    }
    sent.push(id);
  }
  return sent;
}

const range = (p: string, n: number) => Array.from({ length: n }, (_, i) => `${p}${i}`);

// ── 1. Overlapping runs never exceed the cap and count every send once ───────

test("two overlapping send runs never exceed the cap and count every send once", async () => {
  for (const [cap, start] of [[6, 0], [6, 4], [3, 0], [20, 5], [1, 0]] as const) {
    const row: InboxRow = { sends_today: start, last_reset_date: utcToday(), daily_cap: cap };
    const db = slotDb(row, { atomic: true });
    const [a, b] = await Promise.all([sendRun(db, range("a", 6), () => true), sendRun(db, range("b", 6), () => true)]);
    const sent = a.length + b.length;
    assert.ok(start + sent <= cap, `cap ${cap} from ${start}: ${start + sent} sends`);
    assert.equal(row.sends_today, start + sent, `cap ${cap} from ${start}: counter = sends`);
    assert.equal(sent, Math.min(12, cap - start), `cap ${cap} from ${start}: every free slot used`);
  }
});

test("the overlap test sees the race: the old read-then-write under-counts and over-sends", async () => {
  const row: InboxRow = { sends_today: 0, last_reset_date: utcToday(), daily_cap: 6 };
  const db = slotDb(row, { atomic: false });
  const [a, b] = await Promise.all([sendRun(db, range("a", 6), () => true), sendRun(db, range("b", 6), () => true)]);
  const sent = a.length + b.length;
  assert.ok(sent > row.daily_cap || row.sends_today < sent, `non-atomic: ${sent} sends, counter ${row.sends_today}`);
});

test("yesterday's full count resets: the first send today takes slot 1", async () => {
  const row: InboxRow = { sends_today: 6, last_reset_date: "2026-10-18", daily_cap: 6 };
  const db = slotDb(row, { atomic: true, today: "2026-10-19" });
  assert.deepEqual(await reserveSendSlot(db, INBOX), { ok: true, day: "2026-10-19" });
  assert.deepEqual(row, { sends_today: 1, last_reset_date: "2026-10-19", daily_cap: 6 });
});

test("a full inbox refuses a slot with capReached; an RPC error fails closed, not as cap", async () => {
  const full = slotDb({ sends_today: 6, last_reset_date: utcToday(), daily_cap: 6 }, { atomic: true });
  assert.deepEqual(await reserveSendSlot(full, INBOX), { ok: false, capReached: true, reason: "Daily cap reached" });
  for (const message of ["connection reset", ""]) {
    const broken = slotDb({ sends_today: 0, last_reset_date: utcToday(), daily_cap: 6 }, { atomic: true, failReserve: message });
    const r = await reserveSendSlot(broken, INBOX);
    assert.equal(r.ok, false, `error "${message}" must not grant a slot`);
    assert.equal(r.ok ? null : r.capReached, false);
  }
  // null, or anything that isn't a date, is no slot.
  for (const data of [null, true, false, "", "soon"]) {
    const odd: SlotClient = { rpc: async () => ({ data, error: null }) };
    assert.equal((await reserveSendSlot(odd, INBOX)).ok, false, JSON.stringify(data));
  }
});

// ── 2. A failed Gmail send releases its slot; an accepted one keeps it ───────

test("a failed Gmail send releases its slot; accepted sends keep theirs", async () => {
  const row: InboxRow = { sends_today: 2, last_reset_date: utcToday(), daily_cap: 10 };
  const db = slotDb(row, { atomic: true });
  const sent = await sendRun(db, ["ok1", "fail1", "ok2", "fail2"], (id) => id.startsWith("ok"));
  assert.deepEqual(sent, ["ok1", "ok2"]);
  assert.equal(row.sends_today, 4, "2 before + 2 accepted; the 2 refused gave their slots back");
});

test("a failed send at the cap frees the slot for the next pitch", async () => {
  const row: InboxRow = { sends_today: 5, last_reset_date: utcToday(), daily_cap: 6 };
  const db = slotDb(row, { atomic: true });
  const sent = await sendRun(db, ["fail", "ok"], (id) => id === "ok");
  assert.deepEqual(sent, ["ok"]);
  assert.equal(row.sends_today, 6);
});

test("release never goes below 0 and only touches the reserve's day", async () => {
  const zero: InboxRow = { sends_today: 0, last_reset_date: utcToday(), daily_cap: 6 };
  await releaseSendSlot(slotDb(zero, { atomic: true }), INBOX, utcToday());
  assert.equal(zero.sends_today, 0);
  const stale: InboxRow = { sends_today: 3, last_reset_date: "2026-10-18", daily_cap: 6 };
  await releaseSendSlot(slotDb(stale, { atomic: true, today: "2026-10-19" }), INBOX, "2026-10-19");
  assert.equal(stale.sends_today, 3);
});

test("releaseSendSlot hands the RPC exactly the reserve's day, whatever the clock says", async () => {
  const seen: Array<Record<string, unknown>> = [];
  const db: SlotClient = {
    rpc: async (_fn, args) => {
      seen.push(args);
      return { data: true, error: null };
    },
  };
  await releaseSendSlot(db, INBOX, "2001-02-03");
  assert.deepEqual(seen, [{ p_inbox: INBOX, p_day: "2001-02-03" }]);
});

test("a release after UTC midnight never takes a slot from the new day", async () => {
  const row: InboxRow = { sends_today: 4, last_reset_date: "2026-10-19", daily_cap: 6 };
  const db = slotDb(row, { atomic: true, today: "2026-10-19" });
  const late = await reserveSendSlot(db, INBOX); // 23:59:58, slot 5 of the 19th
  assert.deepEqual(late, { ok: true, day: "2026-10-19" });
  db.setToday("2026-10-20");
  const early = await reserveSendSlot(db, INBOX); // 00:00:01, another run: slot 1 of the 20th
  assert.deepEqual(early, { ok: true, day: "2026-10-20" });
  // the 23:59 send's Gmail call fails after midnight: its release names the 19th
  await releaseSendSlot(db, INBOX, late.ok ? late.day : "");
  assert.deepEqual(row, { sends_today: 1, last_reset_date: "2026-10-20", daily_cap: 6 }, "the 20th keeps its one send");
});

// ── Call sites, from source ──────────────────────────────────────────────────

const PATHS = {
  sendQueue: { file: "app/api/pitches/send-queue/route.ts", claim: 'update({ status: "sending" })', release: /releaseClaim\(/g },
  sendAction: { file: "lib/pitches/send-action.ts", claim: 'update({ status: "sending" })', release: /releaseClaim\(/g },
  followUp: { file: "app/api/pitches/follow-up/route.ts", claim: ".update({ sequence_step: nextStep", release: /await release\((false|pause)\)/g },
} as const;
const stripComments = (code: string) => code.replace(/\/\/[^\n]*/g, "").replace(/\/\*[\s\S]*?\*\//g, "");

/** The `{ … }` block that opens at or after `from`, braces balanced. */
function blockAt(s: string, from: number): string {
  const open = s.indexOf("{", from);
  let depth = 0;
  for (let i = open; i < s.length; i++) {
    if (s[i] === "{") depth++;
    else if (s[i] === "}" && --depth === 0) return s.slice(open, i + 1);
  }
  throw new Error("unbalanced braces");
}

for (const [name, p] of Object.entries(PATHS)) {
  test(`${name}: no read-then-write of sends_today; the slot is reserved after the claim and before Gmail`, () => {
    const s = stripComments(src(p.file));
    assert.ok(!/from\("sender_inboxes"\)\s*\.update\(/.test(s), "no direct sender_inboxes update");
    assert.ok(!s.includes("bumpSendsTodayPayload"), "no client-side bump");
    assert.ok(!/sends_today\s*(\+\+|\+=|:\s*[a-z.]+\s*\+)/.test(s), "no counter arithmetic");
    const claim = s.indexOf(p.claim);
    const reserve = s.indexOf("await reserveSendSlot(");
    const gmail = s.indexOf("await sendGmailMessage(");
    assert.ok(claim > 0 && reserve > claim && gmail > reserve, `claim ${claim} < reserve ${reserve} < Gmail ${gmail}`);
  });

  test(`${name}: every claim release after the reservation also releases the slot; none after Gmail accepted`, () => {
    const s = stripComments(src(p.file));
    const reserve = s.indexOf("await reserveSendSlot(");
    const slotBranch = s.indexOf("if (!slot.ok) {", reserve);
    const reserveBranchEnd = s.indexOf("{", slotBranch) + blockAt(s, slotBranch).length;
    const gmail = s.indexOf("await sendGmailMessage(");
    const failBranch = s.indexOf("if (!sendResult.ok) {", gmail);
    const failEnd = s.indexOf("{", failBranch) + blockAt(s, failBranch).length;
    const releases = [...s.matchAll(p.release)].map((m) => m.index).filter((i) => i > reserveBranchEnd && i < failEnd);
    assert.ok(releases.length >= 2, `${name}: recheck and Gmail failures release (found ${releases.length})`);
    for (const i of releases) {
      const before = s.slice(Math.max(0, i - 120), i);
      assert.ok(before.includes("await releaseSendSlot("), `${name}: claim release without slot release near ${s.slice(i, i + 60)}`);
    }
    assert.ok(!s.slice(failEnd).includes("releaseSendSlot("), "a slot is never released after Gmail accepted the message");
  });
}

test("nudge: reserves a slot right before Gmail, gives it back on a refusal, never bumps the counter itself", () => {
  const s = stripComments(src("app/api/replies/nudge/route.ts"));
  assert.ok(!/from\("sender_inboxes"\)\s*\.update\(/.test(s), "no direct sender_inboxes update");
  assert.ok(!s.includes("bumpSendsTodayPayload"), "no client-side bump");
  const thread = s.indexOf("await threadBlocksSend(");
  const reserve = s.indexOf("await reserveSendSlot(slots, inbox.id)");
  const gmail = s.indexOf("await sendGmailMessage(");
  assert.ok(thread > 0 && reserve > thread && gmail > reserve, `thread ${thread} < reserve ${reserve} < Gmail ${gmail}`);
  const noSlot = blockAt(s, s.indexOf("if (!slot.ok) {", reserve));
  assert.match(noSlot, /continue;/, "no slot, no send");
  const fail = blockAt(s, s.indexOf("if (!sendResult.ok) {", gmail));
  assert.match(fail, /await releaseSendSlot\(slots, inbox\.id, slot\.day\)/);
  const afterFail = s.indexOf("if (!sendResult.ok) {", gmail) + fail.length;
  assert.ok(!s.slice(afterFail).includes("releaseSendSlot("), "an accepted nudge keeps its slot");
});

test("daily-cap.ts imports nothing (pure)", () => {
  assert.ok(!/^\s*import\s/m.test(src("lib/pitches/daily-cap.ts")));
});

test("the shape check catches a release that forgets the slot", () => {
  const s = src(PATHS.sendQueue.file);
  const broken = s.replace(/await releaseSendSlot\(slots, inboxId, slot\.day\);\s*(\n\s*await releaseClaim\(releaser, \{ pitchId: pitch\.id, \.\.\.queueReleaseFor)/, "$1");
  assert.notEqual(broken, s);
  const strip = stripComments(broken);
  const i = strip.indexOf("...queueReleaseFor(");
  assert.ok(!strip.slice(i - 200, i).includes("await releaseSendSlot("));
});

// ── 3. The send-queue time budget ────────────────────────────────────────────

test("time budget: claims stop when less than 25s of the 120s remain", () => {
  assert.equal(SEND_ROUTE_MAX_MS, 120_000);
  assert.equal(CLAIM_RESERVE_MS, 25_000);
  const t0 = 1_000_000;
  assert.equal(hasTimeToClaim(t0, t0), true);
  assert.equal(hasTimeToClaim(t0, t0 + 94_999), true);
  assert.equal(hasTimeToClaim(t0, t0 + 95_000), false);
  assert.equal(hasTimeToClaim(t0, t0 + 200_000), false);
  // worst case after a claim: token 10s + jitter 8s + Gmail + writes fits the reserve
  assert.ok(10_000 + 8_000 < CLAIM_RESERVE_MS);
});

test("send-queue: the budget is checked at the top of the loop and right before the claim, and stops the loop", () => {
  const s = stripComments(src(PATHS.sendQueue.file));
  assert.match(s, /const startMs = Date\.now\(\);/);
  const loop = s.indexOf("for (const pitch of duePitches)");
  const first = s.indexOf("if (!hasTimeToClaim(startMs))", loop);
  const claim = s.indexOf('update({ status: "sending" })');
  const last = s.lastIndexOf("if (!hasTimeToClaim(startMs))", claim);
  assert.ok(first > loop && last > first && last < claim, "two checks, the last one before the claim");
  const gate = s.lastIndexOf("checkPitchGate(", claim);
  assert.ok(last > gate, "the claim-side check comes after the slow checks (verify, gate)");
  for (const at of [first, last]) {
    const branch = blockAt(s, at);
    assert.match(branch, /break;/, "a spent budget ends the run (no more claims)");
  }
});

// ── 4. Doubtful address after an automatic approval ──────────────────────────

test("sendTimeVerdictAction: drop never sends; review sends for a person, goes back otherwise", () => {
  for (const a of ["autopilot", "person", "none", "unreadable", null] as const) {
    assert.equal(sendTimeVerdictAction("drop", a), "drop", `drop/${a}`);
  }
  assert.equal(sendTimeVerdictAction("send", null), "send");
  assert.equal(sendTimeVerdictAction("review", "person"), "send", "a person's approval is their call");
  assert.equal(sendTimeVerdictAction("review", "autopilot"), "hold");
  assert.equal(sendTimeVerdictAction("review", "none"), "hold", "no approval on record fails closed: back to a person");
  assert.equal(sendTimeVerdictAction("review", "unreadable"), "skip", "unreadable approval: not sent, stays queued");
  assert.equal(sendTimeVerdictAction("review", null), "skip");
});

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

/** Tables whose columns the fake checks, like PostgREST does (42703 on an unknown column). */
const SCHEMA: Record<string, string[]> = { pitch_events: columnsOf("pitch_events") };

/** Minimal chainable postgrest fake: eq/in/not/gt/gte/order/limit, select(count/head), update…select, insert. */
function fakeDb(tables: Record<string, Row[]>, opts: { fail?: Record<string, string> } = {}) {
  return {
    tables,
    from(table: string) {
      const unknown: string[] = [];
      const use = (col: string) => {
        if (SCHEMA[table] && !SCHEMA[table]!.includes(col)) unknown.push(col);
      };
      const rows = (tables[table] ??= []);
      const filters: Array<(r: Row) => boolean> = [];
      let op: "select" | "update" | "insert" = "select";
      let patch: Row = {};
      let inserted: Row[] = [];
      let count = false;
      let head = false;
      let returning = false;
      let order: { col: string; asc: boolean } | null = null;
      let lim: number | null = null;
      const val = (r: Row, k: string) => r[k] ?? null;
      const run = () => {
        if (unknown.length) return { data: null, count: null, error: { message: `column ${table}.${unknown[0]} does not exist`, code: "42703" } };
        const f = opts.fail?.[`${table}.${op}`];
        if (f !== undefined) return { data: null, count: null, error: { message: f } };
        if (op === "insert") {
          rows.push(...inserted);
          return { data: null, count: null, error: null };
        }
        let hit = rows.filter((r) => filters.every((fn) => fn(r)));
        if (op === "update") {
          for (const r of hit) Object.assign(r, patch);
          return { data: returning ? hit.map((r) => ({ id: r.id })) : null, count: null, error: null };
        }
        if (order) {
          const { col, asc } = order;
          hit = [...hit].sort((a, b) => (asc ? 1 : -1) * (String(a[col]) < String(b[col]) ? -1 : String(a[col]) > String(b[col]) ? 1 : 0));
        }
        if (lim !== null) hit = hit.slice(0, lim);
        return { data: head ? null : hit.map((r) => ({ ...r })), count: count ? hit.length : null, error: null };
      };
      const b = {
        select(c?: string, o?: { count?: string; head?: boolean }) {
          if (op === "update") returning = true;
          else for (const col of (c ?? "").split(",").map((x) => x.trim()).filter((x) => x && x !== "*")) use(col);
          if (o?.count) count = true;
          if (o?.head) head = true;
          return b;
        },
        update(v: Row) {
          op = "update";
          patch = v;
          return b;
        },
        insert(v: Row | Row[]) {
          op = "insert";
          inserted = Array.isArray(v) ? v : [v];
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
        is(k: string, _v: null) {
          use(k);
          filters.push((r) => val(r, k) === null);
          return b;
        },
        not(k: string, _op: string, _v: null) {
          filters.push((r) => val(r, k) !== null);
          return b;
        },
        gt(k: string, v: string) {
          use(k);
          filters.push((r) => Date.parse(String(val(r, k))) > Date.parse(v));
          return b;
        },
        gte(k: string, v: string) {
          use(k);
          filters.push((r) => Date.parse(String(val(r, k))) >= Date.parse(v));
          return b;
        },
        order(col: string, o?: { ascending?: boolean }) {
          use(col);
          order = { col, asc: o?.ascending !== false };
          return b;
        },
        limit(n: number) {
          lim = n;
          return b;
        },
        maybeSingle: async () => {
          const r = run();
          return { ...r, data: Array.isArray(r.data) ? (r.data[0] ?? null) : r.data };
        },
        then<T>(ok: (v: ReturnType<typeof run>) => T, ko?: (e: unknown) => T) {
          return Promise.resolve(run()).then(ok, ko);
        },
      };
      return b;
    },
  };
}

const approval = (pitch: string, at: string, autopilot: boolean | string | undefined) => ({
  id: `ev-${pitch}-${at}`,
  tenant_id: TENANT,
  pitch_id: pitch,
  event_type: "approved",
  event_at: at,
  payload: autopilot === undefined ? { by: "u1", bulk: true } : { by: "u1", autopilot },
});

test("every column latestApprovals selects, filters or orders by exists on pitch_events in 0001", () => {
  const cols = columnsOf("pitch_events");
  assert.ok(cols.includes("event_at") && !cols.includes("created_at"), JSON.stringify(cols));
  for (const c of APPROVAL_EVENT_COLUMNS) assert.ok(cols.includes(c), `pitch_events.${c} is not in 0001`);
  // And the helper uses no column outside that list.
  const s = stripComments(src("lib/pitches/send-time-hold.ts"));
  const body = blockAt(s, s.indexOf("export async function latestApprovals("));
  const used = [...body.matchAll(/\.(?:select|eq|order|in|gt|gte|lt|lte|is|not)\("([^"]+)"/g)].flatMap((m) => m[1]!.split(",").map((x) => x.trim()));
  assert.ok(used.length >= 5, used.join(","));
  for (const c of used) assert.ok((APPROVAL_EVENT_COLUMNS as readonly string[]).includes(c), `latestApprovals uses ${c}, not in APPROVAL_EVENT_COLUMNS`);
});

test("the fake rejects an unknown pitch_events column the way PostgREST does", async () => {
  const db = fakeDb({ pitch_events: [] });
  const r = await db.from("pitch_events").select("payload, created_at").eq("pitch_id", "x");
  assert.match(r.error?.message ?? "", /created_at does not exist/);
});

test("latestApproval reads the LATEST approval event; none and unreadable are told apart", async () => {
  const db = fakeDb({
    pitch_events: [
      approval("p-auto", "2026-10-19T10:00:00Z", true),
      approval("p-auto-str", "2026-10-19T10:00:00Z", "true"),
      approval("p-person", "2026-10-19T09:00:00Z", false),
      approval("p-bulk", "2026-10-19T09:00:00Z", undefined),
      // autopilot approved, a person held it, then a person re-approved: theirs counts
      approval("p-reapproved", "2026-10-18T10:00:00Z", true),
      approval("p-reapproved", "2026-10-19T11:00:00Z", false),
      // and the other way round: the autopilot's later approval counts
      approval("p-auto-later", "2026-10-18T10:00:00Z", false),
      approval("p-auto-later", "2026-10-19T11:00:00Z", true),
      { ...approval("p-other-type", "2026-10-19T12:00:00Z", true), event_type: "sent" },
    ],
  });
  assert.equal(await latestApproval(db, TENANT, "p-auto"), "autopilot");
  assert.equal(await latestApproval(db, TENANT, "p-auto-str"), "autopilot", 'payload->>autopilot = "true" counts');
  assert.equal(await latestApproval(db, TENANT, "p-person"), "person");
  assert.equal(await latestApproval(db, TENANT, "p-bulk"), "person");
  assert.equal(await latestApproval(db, TENANT, "p-reapproved"), "person");
  assert.equal(await latestApproval(db, TENANT, "p-auto-later"), "autopilot");
  assert.equal(await latestApproval(db, TENANT, "p-other-type"), "none");
  assert.equal(await latestApproval(db, TENANT, "p-none"), "none");
  const broken = fakeDb({ pitch_events: [] }, { fail: { "pitch_events.select": "" } });
  assert.equal(await latestApproval(broken, TENANT, "p-auto"), "unreadable", "an empty-message error still reads as unreadable");
});

test("an autopilot approval with a review verdict goes back to draft in the review lane, audited, and heldAction leaves it alone", async () => {
  const db = fakeDb({
    pitch_events: [approval("p1", "2026-10-19T10:00:00Z", true)],
    pitches: [{ id: "p1", tenant_id: TENANT, status: "approved", scheduled_send_at: "2026-10-19T15:00:00Z", autopilot_lane: "auto", autopilot_reasons: null }],
    audit_log: [],
  });
  const action = sendTimeVerdictAction("review", await latestApproval(db, TENANT, "p1"));
  assert.equal(action, "hold");
  assert.equal(await holdDoubtfulAutoApproval(db, { tenantId: TENANT, pitchId: "p1", why: "SPAM Verify review: catch-all domain" }), true);
  const row = db.tables.pitches![0]!;
  assert.equal(row.status, "draft");
  assert.equal(row.scheduled_send_at, null);
  assert.equal(row.autopilot_lane, "review");
  const reasons = row.autopilot_reasons as string[];
  assert.ok(reasons[0]!.startsWith(HELD_BY_AUTOPILOT), reasons[0]);
  assert.ok(reasons[0]!.startsWith(DOUBTFUL_ADDRESS_HOLD));
  assert.deepEqual(
    db.tables.audit_log!.map((a) => [a.action, a.entity_id, (a.metadata as { source: string }).source]),
    [["pitch.held", "p1", "send_time_review"]],
  );
  // The tick's §4 resolveHeld must not rewrite or drop it: a person decides.
  for (const isRewrite of [false, true]) {
    assert.equal(heldAction({ lane: "review", reasons, isRewrite, editedByPerson: false }, new Set()).action, "leave");
  }
});

test("no approval event on record + review verdict → back to a person (fails closed)", async () => {
  const db = fakeDb({ pitch_events: [], pitches: [{ id: "p4", tenant_id: TENANT, status: "approved" }], audit_log: [] });
  assert.equal(sendTimeVerdictAction("review", await latestApproval(db, TENANT, "p4")), "hold");
});

test("a person approval with a review verdict sends (negative set)", async () => {
  const db = fakeDb({
    pitch_events: [approval("p2", "2026-10-19T10:00:00Z", false)],
    pitches: [{ id: "p2", tenant_id: TENANT, status: "approved" }],
  });
  assert.equal(sendTimeVerdictAction("review", await latestApproval(db, TENANT, "p2")), "send");
  assert.equal(db.tables.pitches![0]!.status, "approved");
});

test("the hold never flips a pitch that is no longer approved, and writes no audit row then", async () => {
  for (const status of ["sending", "sent", "draft", "auto_rejected"]) {
    const db = fakeDb({ pitches: [{ id: "p3", tenant_id: TENANT, status }], audit_log: [] });
    assert.equal(await holdDoubtfulAutoApproval(db, { tenantId: TENANT, pitchId: "p3", why: "x" }), false, status);
    assert.equal(db.tables.pitches![0]!.status, status);
    assert.equal(db.tables.audit_log!.length, 0, status);
  }
});

test("send-queue: the verdict goes through sendTimeVerdictAction before the claim, hold and skip never send", () => {
  const s = stripComments(src(PATHS.sendQueue.file));
  const claim = s.indexOf('update({ status: "sending" })');
  const decide = s.indexOf("sendTimeVerdictAction(verify.verdict, approval)");
  assert.ok(decide > 0 && decide < claim);
  assert.ok(!/verify\.verdict === "drop"/.test(s), "one predicate: the route doesn't branch on the verdict itself");
  for (const k of ['"hold"', '"skip"', '"drop"']) {
    const at = s.indexOf(`if (verdictAction === ${k}) {`);
    assert.ok(at > decide && at < claim, k);
    assert.match(blockAt(s, at), /continue;/, `${k} must not fall through to the send`);
  }
  // Only a review verdict pays for the event read.
  assert.match(s, /verify\.verdict === "review" \? await latestApproval\(/);
  // "Back to review" only when the guarded update moved the row.
  const hold = blockAt(s, s.indexOf('if (verdictAction === "hold") {'));
  assert.match(hold, /const moved = await holdDoubtfulAutoApproval\(/);
  assert.match(hold, /moved \? `Back to review/);
});

// ── 5. Follow-ups obey the bounce stop ───────────────────────────────────────

function bounceDb(sends: number, bounces: number) {
  const pitches = Array.from({ length: sends }, (_, i) => ({
    id: `s${i}`,
    tenant_id: TENANT,
    sender_inbox_id: INBOX,
    sent_at: new Date(Date.UTC(2026, 9, 19, 14, 0, i)).toISOString(),
  }));
  const pitch_events = Array.from({ length: bounces }, (_, i) => ({
    id: `b${i}`,
    tenant_id: TENANT,
    pitch_id: `s${i}`,
    event_type: "bounce",
    event_at: "2026-10-19T15:05:00Z",
  }));
  return fakeDb({ pitches, pitch_events, audit_log: [] });
}

test("follow-up: 2 fresh bounces in the inbox's last sends block it with the breaker's reason; 1 does not", async () => {
  assert.deepEqual(await inboxBounceBlock(bounceDb(25, 1), TENANT, INBOX), { blocked: false });
  const r = await inboxBounceBlock(bounceDb(25, 2), TENANT, INBOX);
  assert.equal(r.blocked, true);
  assert.ok(r.blocked && r.reason.startsWith(BOUNCE_BREAKER), JSON.stringify(r));
});

test("follow-up route: bounce check once per inbox per run, before the compose and the claim, skip only", () => {
  const s = stripComments(src(PATHS.followUp.file));
  const check = s.indexOf("await inboxBounceBlock(supabase, pitch.tenant_id, inbox.id)");
  assert.ok(check > 0, "the follow-up asks the shared helper");
  assert.ok(check < s.indexOf("composeFollowupWithClaude("), "before any AI spend");
  assert.ok(check < s.indexOf(PATHS.followUp.claim), "before the claim");
  assert.ok(check < s.indexOf("await sendGmailMessage("), "before any send");
  // cached: guarded by has(), stored by set(), map made once per run outside the loop
  assert.ok(s.lastIndexOf("if (!bounceBlocks.has(inbox.id)) {", check) > 0);
  assert.match(s, /bounceBlocks\.set\(inbox\.id, block\.blocked \? block\.reason : null\)/);
  const map = s.indexOf("const bounceBlocks: BounceBlocks = new Map();");
  const loop = s.indexOf("for (const pitch of pitches)");
  assert.ok(map > 0 && map < loop, "one map per run");
  assert.match(s, /processFollowup\(pitch, bounceBlocks, startTime\)/);
  const branch = blockAt(s, s.indexOf("if (bounceBlock) {"));
  assert.match(branch, /status: "skipped", reason: bounceBlock/);
  assert.ok(!/paused:\s*true/.test(s), "the follow-up never pauses an inbox");
  assert.ok(!/sequence_paused_at[^\n]*\n?[^\n]*bounceBlock/.test(s), "a bounce skip doesn't pause the sequence");
  assert.ok(!/inboxBouncesTrip|recentHardBounces\s*>=/.test(s), "no private copy of the rule");
});

// ── Pure helpers stay as they were ───────────────────────────────────────────

test("effectiveSendsToday unchanged", () => {
  const now = new Date("2026-10-19T15:00:00Z");
  assert.equal(effectiveSendsToday(4, "2026-10-19", now), 4);
  assert.equal(effectiveSendsToday(4, "2026-10-18", now), 0);
});

// ── Migration 0049 ───────────────────────────────────────────────────────────

test("migration 0049: atomic, cap in the WHERE, UTC reset, definer with a tenant guard, idempotent, grants, no DROP", () => {
  const sql = src("supabase/migrations/0049_reserve_send_slot.sql");
  const body = sql.replace(/--[^\n]*/g, "");
  assert.ok(!/\bdrop\b/i.test(body), "no DROP");
  assert.match(body, /create or replace function public\.spam_reserve_send_slot\(p_inbox uuid\)\s*returns date/);
  assert.match(body, /create or replace function public\.spam_release_send_slot\(p_inbox uuid, p_day date\)\s*returns boolean/);
  assert.match(body, /returning last_reset_date\s*\)\s*select \(select last_reset_date from taken\);/, "reserve returns the day it counted on, null when no slot");
  assert.match(body, /and last_reset_date = p_day/, "release only touches the reserve's day");
  assert.equal((body.match(/security definer/g) ?? []).length, 2);
  assert.equal((body.match(/set search_path = public/g) ?? []).length, 2);
  assert.equal((body.match(/\(auth\.uid\(\) is null or tenant_id = public\.current_tenant_id\(\)\)/g) ?? []).length, 2);
  assert.match(body, /else 0\s*end\) < daily_cap/, "the cap check is in the UPDATE's WHERE");
  assert.match(body, /\(now\(\) at time zone 'utc'\)::date/);
  assert.match(body, /sends_today > 0/);
  for (const sig of ["spam_reserve_send_slot\\(uuid\\)", "spam_release_send_slot\\(uuid, date\\)"]) {
    assert.match(body, new RegExp(`revoke all on function public\\.${sig} from public, anon;`));
    assert.match(body, new RegExp(`grant execute on function public\\.${sig} to service_role, authenticated;`));
  }
  assert.ok(!/\bcron\.schedule\b/.test(body));
});
