/**
 * The 2026-10-19 bounce incident (tasks/briefs/bounce-hotfix.md):
 *
 *   1. a resume sticks: the breaker counts bounces only after the latest resume
 *   2. the send-queue stops a drip on a fresh bounce (same rule as the tick)
 *   4. a demotion to shadow/off pulls back the automatic approvals still waiting
 *   5. (autopilot-trust-split) delivery trips pause but never move the stage;
 *      the breakers and the pull-back run with the autopilot off; a resume is
 *      audited before the unpause and needs a form that showed "paused"
 *
 * (3, finder addresses, lives in tests/verify-recipient.test.ts.)
 *
 * The db layer runs against a small fake of the Supabase query builder that
 * applies every filter the way Postgres would (eq, in, is, not-is-null, gt,
 * gte, order, limit, count), so "which bounces count" is tested on the filters,
 * not on a mock that returns what we told it to.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  BOUNCE_BREAKER,
  bouncesTodayAfterResume,
  inboxBounceBlock,
  inboxBounceStats,
  RECENT_SENDS,
} from "../lib/autopilot/bounce-breaker.ts";
import {
  evaluateBreakers,
  heldAction,
  HELD_BY_AUTOPILOT,
  HELD_BY_PERSON,
  nextStage,
  type BreakerMetrics,
  type BreakerTrip,
  type StageMetrics,
} from "../lib/autopilot/governor.ts";
import {
  demotionHoldReason,
  holdAutoApprovals,
  holdPitch,
  HOLD_REASON,
  pullbackSentence,
  pullsBackApprovals,
  relabelFinderDrafts,
  stageQualityTrips,
} from "../lib/autopilot/hold.ts";
import { holdExpiry } from "../lib/autopilot/hold-token.ts";
import { INBOX_RESUMED_ACTION, saveSenderInbox, type SenderInboxPatch } from "../lib/autopilot/inbox-resume.ts";

const TENANT = "11111111-1111-1111-1111-111111111111";
const OTHER_TENANT = "99999999-9999-9999-9999-999999999999";
const INBOX = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
const INBOX_2 = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";
const ADMIN = "cccccccc-cccc-cccc-cccc-cccccccccccc";

// ── Fake Supabase ────────────────────────────────────────────────────────────

type Row = Record<string, unknown>;
type Op = "select" | "update" | "insert";

/** Postgres timestamps ("…+00:00") and JS ones ("…Z") compare as times. */
const cmp = (a: unknown, b: unknown): number => {
  const ta = Date.parse(String(a));
  const tb = Date.parse(String(b));
  if (!Number.isNaN(ta) && !Number.isNaN(tb)) return ta - tb;
  return String(a) < String(b) ? -1 : String(a) > String(b) ? 1 : 0;
};

function fakeDb(
  tables: Record<string, Row[]>,
  opts: {
    fail?: Partial<Record<`${string}.${Op}`, string>>;
    forbidWrites?: string[];
    /** Runs just before an update applies: another writer (the send-queue) acting between our read and our write. */
    beforeUpdate?: (table: string) => void;
  } = {},
) {
  let seq = 0;
  const db = {
    tables,
    /** created_at of rows this fake inserts (audit_log), in Postgres's format. */
    clock: "2026-10-19T15:00:00.000000+00:00",
    writes: [] as string[],
    from(table: string) {
      const rows = (tables[table] ??= []);
      const filters: Array<(r: Row) => boolean> = [];
      let op: Op = "select";
      let patch: Row = {};
      let inserted: Row[] = [];
      let returning = false;
      let count = false;
      let head = false;
      let orderBy: { col: string; asc: boolean } | null = null;
      let lim: number | null = null;
      const get = (r: Row, k: string): unknown => {
        const [col, key] = k.split("->>") as [string, string | undefined];
        if (key === undefined) return r[col] ?? null;
        const v = (r[col] as Row | null)?.[key];
        return v === undefined || v === null ? null : String(v);
      };
      const run = () => {
        const failure = opts.fail?.[`${table}.${op}`];
        if (failure !== undefined) return { data: null, count: null, error: { message: failure } };
        if (op === "insert") {
          rows.push(...inserted);
          return { data: null, count: null, error: null };
        }
        if (op === "update") opts.beforeUpdate?.(table);
        let hit = rows.filter((r) => filters.every((f) => f(r)));
        if (op === "update") {
          for (const r of hit) Object.assign(r, patch);
          return { data: returning ? hit.map((r) => ({ id: r.id })) : null, count: null, error: null };
        }
        if (orderBy) {
          const { col, asc } = orderBy;
          hit = [...hit].sort((a, b) => (asc ? 1 : -1) * cmp(a[col], b[col]));
        }
        if (lim !== null) hit = hit.slice(0, lim);
        return { data: head ? null : hit.map((r) => ({ ...r })), count: count ? hit.length : null, error: null };
      };
      const write = (kind: Op) => {
        if (opts.forbidWrites?.includes(table)) throw new Error(`${kind} to ${table} on a read-only path`);
        db.writes.push(`${table}.${kind}`);
      };
      const b = {
        select(_cols?: string, o?: { count?: string; head?: boolean }) {
          if (op !== "select") returning = true;
          if (o?.count) count = true;
          if (o?.head) head = true;
          return b;
        },
        update(values: Row) {
          write("update");
          op = "update";
          patch = values;
          return b;
        },
        insert(values: Row | Row[]) {
          write("insert");
          op = "insert";
          inserted = (Array.isArray(values) ? values : [values]).map((r) => ({ id: `${table}-${++seq}`, created_at: db.clock, ...r }));
          return b;
        },
        eq(k: string, v: unknown) {
          filters.push((r) => get(r, k) === v);
          return b;
        },
        in(k: string, vs: unknown[]) {
          filters.push((r) => vs.includes(get(r, k)));
          return b;
        },
        is(k: string, v: null) {
          filters.push((r) => get(r, k) === v);
          return b;
        },
        not(k: string, operator: string, v: null) {
          assert.equal(operator, "is");
          filters.push((r) => get(r, k) !== v);
          return b;
        },
        gt(k: string, v: string) {
          filters.push((r) => get(r, k) !== null && cmp(get(r, k), v) > 0);
          return b;
        },
        gte(k: string, v: string) {
          filters.push((r) => get(r, k) !== null && cmp(get(r, k), v) >= 0);
          return b;
        },
        order(col: string, o?: { ascending?: boolean }) {
          orderBy = { col, asc: o?.ascending !== false };
          return b;
        },
        limit(n: number) {
          lim = n;
          return b;
        },
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

// ── The 2026-10-19 inbox, as prod had it ─────────────────────────────────────

const at = (hhmm: string, day = "2026-10-19") => `${day}T${hhmm}:00.000Z`;
/** pitch_events.event_at and audit_log.created_at come back from Postgres like this. */
const pg = (hhmm: string, day = "2026-10-19") => `${day}T${hhmm}:00.123456+00:00`;

/** `n` cold sends from `inbox`, one a minute ending at `last`. Returns their ids, newest first. */
function addSends(db: Db, n: number, opts: { inbox?: string; last?: string; tenant?: string; prefix?: string } = {}): string[] {
  const end = Date.parse(opts.last ?? at("15:30"));
  const ids: string[] = [];
  for (let i = 0; i < n; i++) {
    const id = `${opts.prefix ?? "p"}-${(opts.inbox ?? INBOX).slice(0, 4)}-${i}`;
    (db.tables.pitches ??= []).push({
      id,
      tenant_id: opts.tenant ?? TENANT,
      sender_inbox_id: opts.inbox ?? INBOX,
      status: "sent",
      sent_at: new Date(end - i * 60_000).toISOString(),
    });
    ids.push(id);
  }
  return ids;
}

function addBounce(db: Db, pitchId: string, eventAt: string, tenant = TENANT) {
  (db.tables.pitch_events ??= []).push({ id: `ev-${pitchId}-${eventAt}`, tenant_id: tenant, pitch_id: pitchId, event_type: "bounce", event_at: eventAt });
}

/** What runBreakers hands evaluateBreakers for the bounce rules (the rest quiet). */
async function metrics(db: Db, now: Date, inboxes = [INBOX]): Promise<BreakerMetrics> {
  const stats = [];
  for (const id of inboxes) {
    const s = await inboxBounceStats(db, TENANT, id);
    stats.push({ id, recentSends: s.recentSends, recentHardBounces: s.recentHardBounces, apiErrorsToday: 0 });
  }
  return {
    inboxes: stats,
    hardBouncesToday: await bouncesTodayAfterResume(db, TENANT, now),
    optOutsThisWeek: 0,
    optOutWeeklyBaseline: 0.5,
    dmarcPassRate: 0.99,
    blocklisted: false,
    warmupInboxRate: 0.95,
  };
}

const codes = (m: BreakerMetrics) => evaluateBreakers(m).map((t) => t.code);

const PATCH: SenderInboxPatch = {
  display_name: "Pedro",
  linkedin_url: null,
  daily_cap: 30,
  paused: false,
  paused_reason: null,
  updated_at: "2026-10-19T15:50:00.000Z",
};

function pausedInbox(): Row {
  return {
    id: INBOX,
    tenant_id: TENANT,
    email: "pedro@runnareach.com",
    paused: true,
    paused_reason: "Autopilot breaker (inbox_bounces): 2 hard bounces in the last 48 sends",
  };
}

/** The incident: 48 sends (19 AUTO that day), 2 bounces recorded by the 15:30 poll. */
function incident(): { db: Db; sends: string[] } {
  const db = fakeDb({ sender_inboxes: [pausedInbox()], audit_log: [], pitch_events: [], pitches: [] });
  const sends = addSends(db, 48);
  addBounce(db, sends[40]!, pg("15:30"));
  addBounce(db, sends[41]!, pg("15:30"));
  return { db, sends };
}

async function resume(db: Db, when: string) {
  db.clock = when;
  return saveSenderInbox(db, { tenantId: TENANT, inboxId: INBOX, actorId: ADMIN, patch: PATCH, loadedPaused: true });
}

// ── 1. A resume sticks, and is audited ───────────────────────────────────────

test("incident: 2 hard bounces in the last 48 sends trip inbox_bounces (as before the fix)", async () => {
  const { db } = incident();
  assert.deepEqual(codes(await metrics(db, new Date(at("15:45")))), ["inbox_bounces"]);
});

test("trip → resume → the next tick does NOT re-pause on the same bounces", async () => {
  const { db } = incident();
  const saved = await resume(db, pg("15:50"));
  assert.deepEqual(saved, { ok: true, resumed: true });
  const m = await metrics(db, new Date(at("16:00")));
  assert.equal(m.inboxes[0]!.recentSends, 48, "the sends window is still the last 50");
  assert.equal(m.inboxes[0]!.recentHardBounces, 0);
  assert.equal(m.hardBouncesToday, 0);
  assert.deepEqual(codes(m), []);
});

test("trip → resume → 2 new bounces in >= 20 sends → re-pause", async () => {
  const { db, sends } = incident();
  await resume(db, pg("15:50"));
  addBounce(db, sends[0]!, pg("16:05"));
  assert.deepEqual(codes(await metrics(db, new Date(at("16:15")))), [], "one new bounce is not enough");
  addBounce(db, sends[1]!, pg("16:15"));
  const m = await metrics(db, new Date(at("16:30")));
  assert.equal(m.inboxes[0]!.recentHardBounces, 2);
  assert.deepEqual(codes(m), ["inbox_bounces"]);
});

test("after a resume the >= 20 sends floor still applies", async () => {
  const db = fakeDb({ sender_inboxes: [pausedInbox()], audit_log: [], pitch_events: [], pitches: [] });
  const sends = addSends(db, 12);
  await resume(db, pg("15:50"));
  addBounce(db, sends[0]!, pg("16:05"));
  addBounce(db, sends[1]!, pg("16:05"));
  const m = await metrics(db, new Date(at("16:15")));
  assert.deepEqual([m.inboxes[0]!.recentSends, m.inboxes[0]!.recentHardBounces], [12, 2]);
  assert.ok(!codes(m).includes("inbox_bounces"));
});

test("an inbox never resumed counts exactly as before: every bounce on its last 50 sends", async () => {
  const db = fakeDb({ pitches: [], pitch_events: [], audit_log: [] });
  const sends = addSends(db, 60);
  addBounce(db, sends[3]!, pg("09:00", "2026-10-10"));
  addBounce(db, sends[49]!, pg("10:00", "2026-10-12"));
  addBounce(db, sends[55]!, pg("10:00", "2026-10-12")); // outside the last 50: not counted
  const s = await inboxBounceStats(db, TENANT, INBOX);
  assert.deepEqual(s, { recentSends: RECENT_SENDS, recentHardBounces: 2, resumedAt: null, error: null });
});

test("a resume of another inbox, or in another tenant, does not reset this inbox's count", async () => {
  const { db } = incident();
  db.tables.audit_log!.push(
    { tenant_id: TENANT, action: INBOX_RESUMED_ACTION, entity_type: "sender_inbox", entity_id: INBOX_2, created_at: pg("15:50") },
    { tenant_id: OTHER_TENANT, action: INBOX_RESUMED_ACTION, entity_type: "sender_inbox", entity_id: INBOX, created_at: pg("15:50") },
    { tenant_id: TENANT, action: "pitch.held", entity_type: "pitch", entity_id: INBOX, created_at: pg("15:55") },
  );
  const s = await inboxBounceStats(db, TENANT, INBOX);
  assert.equal(s.resumedAt, null);
  assert.equal(s.recentHardBounces, 2);
});

test("the latest of several resumes is the cut-off", async () => {
  const { db, sends } = incident();
  await resume(db, pg("15:50"));
  addBounce(db, sends[0]!, pg("16:05"));
  addBounce(db, sends[1]!, pg("16:05"));
  db.tables.sender_inboxes![0]!.paused = true; // the tick paused it again
  await resume(db, pg("16:20"));
  const s = await inboxBounceStats(db, TENANT, INBOX);
  assert.equal(s.resumedAt, pg("16:20"));
  assert.equal(s.recentHardBounces, 0);
});

test("bounces_today: from the UTC day start, or the latest resume of ANY inbox today if later", async () => {
  const db = fakeDb({ pitches: [], pitch_events: [], audit_log: [] });
  const a = addSends(db, 30, { inbox: INBOX });
  const b = addSends(db, 30, { inbox: INBOX_2 });
  addBounce(db, a[0]!, pg("23:30", "2026-10-18")); // yesterday: never counted today
  addBounce(db, a[1]!, pg("15:00"));
  addBounce(db, b[1]!, pg("15:05"));
  addBounce(db, b[2]!, pg("15:10"));
  const now = new Date(at("16:00"));
  assert.equal(await bouncesTodayAfterResume(db, TENANT, now), 3);
  assert.ok(codes(await metrics(db, now, [INBOX, INBOX_2])).includes("bounces_today"));

  // A resume yesterday doesn't move today's start.
  db.tables.audit_log!.push({ tenant_id: TENANT, action: INBOX_RESUMED_ACTION, entity_id: INBOX, created_at: pg("23:45", "2026-10-18") });
  assert.equal(await bouncesTodayAfterResume(db, TENANT, now), 3);

  // A resume of the OTHER inbox today: only bounces after it count.
  db.tables.audit_log!.push({ tenant_id: TENANT, action: INBOX_RESUMED_ACTION, entity_id: INBOX_2, created_at: pg("15:07") });
  assert.equal(await bouncesTodayAfterResume(db, TENANT, now), 1);
});

test("bounces_today with no resume counts the whole UTC day, as before", async () => {
  const db = fakeDb({ pitches: [], pitch_events: [], audit_log: [] });
  const a = addSends(db, 5);
  addBounce(db, a[0]!, pg("00:00"));
  addBounce(db, a[1]!, pg("23:59", "2026-10-18"));
  assert.equal(await bouncesTodayAfterResume(db, TENANT, new Date(at("12:00"))), 1);
});

// reply-on-root: the poll records a bounce on the conversation's root pitch, with the
// follow-up it answered in payload.answered_pitch_id.
function addRootBounce(db: Db, rootId: string, answeredId: string, eventAt: string) {
  (db.tables.pitch_events ??= []).push({
    id: `ev-${rootId}-${eventAt}`,
    tenant_id: TENANT,
    pitch_id: rootId,
    event_type: "bounce",
    event_at: eventAt,
    payload: { reply_id: "r1", answered_pitch_id: answeredId },
  });
}

test("a bounce on a root outside the last 50 sends counts when the follow-up it answered is inside", async () => {
  const db = fakeDb({ pitches: [], pitch_events: [], audit_log: [] });
  const sends = addSends(db, 60);
  const followUp = sends[2]!;
  const root = sends[57]!; // sent days earlier: out of the window
  addRootBounce(db, root, followUp, pg("16:00"));
  const s = await inboxBounceStats(db, TENANT, INBOX);
  assert.equal(s.recentHardBounces, 1);
  assert.equal(s.error, null);
});

test("a bounce on a root inside the window that answered the root itself counts once, not twice", async () => {
  const db = fakeDb({ pitches: [], pitch_events: [], audit_log: [] });
  const sends = addSends(db, 60);
  addRootBounce(db, sends[4]!, sends[4]!, pg("16:00"));
  addRootBounce(db, sends[5]!, sends[1]!, pg("16:01")); // root and follow-up both inside
  const s = await inboxBounceStats(db, TENANT, INBOX);
  assert.equal(s.recentHardBounces, 2);
});

test("old-shape bounces (on the follow-up, no answered_pitch_id) still count; the resume filter applies to both", async () => {
  const db = fakeDb({ sender_inboxes: [pausedInbox()], pitches: [], pitch_events: [], audit_log: [] });
  const sends = addSends(db, 60);
  addBounce(db, sends[0]!, pg("15:40"));
  addRootBounce(db, sends[58]!, sends[3]!, pg("15:45")); // before the resume: not counted
  assert.deepEqual(await resume(db, pg("15:50")), { ok: true, resumed: true });
  addRootBounce(db, sends[59]!, sends[6]!, pg("16:00"));
  addBounce(db, sends[7]!, pg("16:05"));
  const s = await inboxBounceStats(db, TENANT, INBOX);
  assert.equal(s.recentHardBounces, 2);
});

test("a bounce read error is still reported", async () => {
  const db = fakeDb({ pitches: [], pitch_events: [], audit_log: [] }, { fail: { "pitch_events.select": "timeout" } });
  addSends(db, 5);
  const s = await inboxBounceStats(db, TENANT, INBOX);
  assert.equal(s.recentHardBounces, 0);
  assert.equal(s.error, "bounces: timeout");
});

test("an unreadable audit log reads as never resumed: the breaker errs toward pausing", async () => {
  const { db } = incident();
  await resume(db, pg("15:50"));
  const broken = fakeDb(db.tables, { fail: { "audit_log.select": "" } });
  assert.equal((await inboxBounceStats(broken, TENANT, INBOX)).recentHardBounces, 2);
});

// The resume itself (lib/settings/sending-actions.ts → saveSenderInbox).

test("resume: saving a paused inbox unpaused writes one sender_inbox.resumed audit row", async () => {
  const { db } = incident();
  const result = await resume(db, pg("15:50"));
  assert.deepEqual(result, { ok: true, resumed: true });
  const inbox = db.tables.sender_inboxes![0]!;
  assert.equal(inbox.paused, false);
  assert.equal(inbox.paused_reason, null);
  assert.equal(inbox.daily_cap, 30);
  const rows = db.tables.audit_log!;
  assert.equal(rows.length, 1);
  const { id: _id, created_at: _at, ...row } = rows[0]!;
  assert.deepEqual(row, {
    tenant_id: TENANT,
    actor_id: ADMIN,
    action: "sender_inbox.resumed",
    entity_type: "sender_inbox",
    entity_id: INBOX,
    metadata: { previous_reason: "Autopilot breaker (inbox_bounces): 2 hard bounces in the last 48 sends" },
  });
});

test("resume: any other save writes no audit row", async () => {
  for (const [wasPaused, nowPaused] of [
    [false, false],
    [false, true],
    [true, true],
  ] as const) {
    const db = fakeDb({ sender_inboxes: [{ ...pausedInbox(), paused: wasPaused }], audit_log: [] });
    const result = await saveSenderInbox(db, {
      tenantId: TENANT,
      inboxId: INBOX,
      actorId: ADMIN,
      loadedPaused: wasPaused,
      patch: { ...PATCH, paused: nowPaused, paused_reason: nowPaused ? "by hand" : null },
    });
    assert.deepEqual(result, { ok: true, resumed: false }, `${wasPaused} → ${nowPaused}`);
    assert.equal(db.tables.audit_log!.length, 0, `${wasPaused} → ${nowPaused}`);
    assert.equal(db.tables.sender_inboxes![0]!.paused, nowPaused);
  }
});

test("resume: if the audit row can't be written the inbox goes back to paused and the person is told", async () => {
  const db = fakeDb({ sender_inboxes: [pausedInbox()], audit_log: [] }, { fail: { "audit_log.insert": "" } });
  const result = await saveSenderInbox(db, { tenantId: TENANT, inboxId: INBOX, actorId: ADMIN, patch: { ...PATCH, daily_cap: 25 }, loadedPaused: true });
  assert.equal(result.ok, false);
  assert.match(result.ok ? "" : result.error, /could not be recorded \(no detail\), so the inbox stays paused/);
  const inbox = db.tables.sender_inboxes![0]!;
  assert.equal(inbox.paused, true);
  assert.equal(inbox.paused_reason, pausedInbox().paused_reason);
  assert.equal(inbox.daily_cap, 25, "the other edits are kept");
});

test("resume: another tenant's inbox, or an unreadable one, is never written", async () => {
  const other = fakeDb({ sender_inboxes: [{ ...pausedInbox(), tenant_id: OTHER_TENANT }], audit_log: [] });
  assert.deepEqual(await saveSenderInbox(other, { tenantId: TENANT, inboxId: INBOX, actorId: ADMIN, patch: PATCH, loadedPaused: true }), {
    ok: false,
    error: "Sender inbox not found.",
  });
  assert.equal(other.tables.sender_inboxes![0]!.paused, true);
  const unreadable = fakeDb({ sender_inboxes: [pausedInbox()] }, { fail: { "sender_inboxes.select": "" }, forbidWrites: ["sender_inboxes", "audit_log"] });
  const r = await saveSenderInbox(unreadable, { tenantId: TENANT, inboxId: INBOX, actorId: ADMIN, patch: PATCH, loadedPaused: true });
  assert.equal(r.ok, false);
});

test("the Settings action saves through saveSenderInbox (so a resume is always recorded)", () => {
  const s = readFileSync(new URL("../lib/settings/sending-actions.ts", import.meta.url), "utf8");
  const body = s.slice(s.indexOf("export async function updateSenderInbox"), s.indexOf("export async function deleteSenderInbox"));
  assert.match(body, /await saveSenderInbox\(supabase, \{/);
  assert.match(body, /actorId: user\.id/);
  assert.ok(!body.includes('.from("sender_inboxes")'), "updateSenderInbox must not write sender_inboxes itself");
});

test("the tick's breakers read bounces through the shared helpers, not their own query", () => {
  const s = readFileSync(new URL("../lib/autopilot/tick.ts", import.meta.url), "utf8");
  const body = s.slice(s.indexOf("async function runBreakers"), s.indexOf("// ── 2. Watchdog"));
  assert.match(body, /await inboxBounceStats\(db, tenantId, inbox\.id\)/);
  assert.match(body, /bouncesTodayAfterResume\(db, tenantId, now\)/);
  assert.ok(!body.includes('"bounce"'), "runBreakers must not count bounces itself");
});

// ── 2. The send-queue stops a drip on a fresh bounce ─────────────────────────

test("send-queue: 2 fresh bounces in >= 20 sends block the inbox, with the breaker's reason, and write nothing", async () => {
  const db = fakeDb({ pitches: [], pitch_events: [], audit_log: [] }, { forbidWrites: ["sender_inboxes", "pitches", "audit_log"] });
  const sends = addSends(db, 25);
  addBounce(db, sends[3]!, pg("15:05"));
  assert.deepEqual(await inboxBounceBlock(db, TENANT, INBOX), { blocked: false }, "one bounce: keep sending");
  addBounce(db, sends[4]!, pg("15:05"));
  assert.deepEqual(await inboxBounceBlock(db, TENANT, INBOX), {
    blocked: true,
    reason: `${BOUNCE_BREAKER}: 2 hard bounces in the last 25 sends`,
  });
});

test("send-queue: the same bounces don't block after a resume; new ones do", async () => {
  const { db, sends } = incident();
  assert.equal((await inboxBounceBlock(db, TENANT, INBOX)).blocked, true);
  await resume(db, pg("15:50"));
  assert.deepEqual(await inboxBounceBlock(db, TENANT, INBOX), { blocked: false });
  addBounce(db, sends[0]!, pg("16:05"));
  addBounce(db, sends[1]!, pg("16:05"));
  assert.equal((await inboxBounceBlock(db, TENANT, INBOX)).blocked, true);
});

test("send-queue: unreadable bounce history blocks the inbox for the run (fails closed)", async () => {
  for (const fail of ["pitches.select", "pitch_events.select"] as const) {
    const db = fakeDb({ pitches: [], pitch_events: [], audit_log: [] }, { fail: { [fail]: "" } });
    addSends(db, 25);
    const r = await inboxBounceBlock(db, TENANT, INBOX);
    assert.equal(r.blocked, true, fail);
    assert.match(r.blocked ? r.reason : "", /^Bounce breaker: bounce history unreadable/);
  }
});

test("send-queue and tick trip on exactly the same numbers (one rule)", async () => {
  for (const [sendsN, bouncesN] of [[19, 2], [20, 2], [50, 2], [50, 1], [48, 2], [30, 3], [25, 0]] as const) {
    const db = fakeDb({ pitches: [], pitch_events: [], audit_log: [] });
    const sends = addSends(db, sendsN);
    for (let i = 0; i < bouncesN; i++) addBounce(db, sends[i]!, pg("15:05"));
    const tick = codes(await metrics(db, new Date(at("23:00", "2026-10-20")))).includes("inbox_bounces");
    assert.equal((await inboxBounceBlock(db, TENANT, INBOX)).blocked, tick, `${bouncesN} of ${sendsN}`);
  }
});

test("send-queue route: bounce check per inbox before the claim, skip only (never pauses)", () => {
  const s = readFileSync(new URL("../app/api/pitches/send-queue/route.ts", import.meta.url), "utf8");
  const check = s.indexOf("await inboxBounceBlock(supabase, pitch.tenant_id, pitch.sender_inbox_id)");
  assert.ok(check > 0, "the send-queue asks the shared helper");
  assert.ok(check < s.indexOf('update({ status: "sending" })'), "before the claim");
  assert.ok(check < s.indexOf("await sendGmailMessage("), "before any send");
  const open = s.indexOf("{", s.indexOf("if (inbox.bounceBlock) {"));
  let close = open;
  for (let depth = 0; close < s.length; close++) {
    if (s[close] === "{") depth++;
    else if (s[close] === "}" && --depth === 0) break;
  }
  const branch = s.slice(open, close + 1);
  assert.match(branch, /status: "skipped", reason: inbox\.bounceBlock/);
  assert.match(branch, /continue/);
  assert.ok(!/paused:\s*true/.test(s), "the send-queue never pauses an inbox");
  assert.ok(!/inboxBouncesTrip|recentHardBounces\s*>=/.test(s), "no private copy of the rule");
});

test("migration 0048: the reply poll every 10 minutes at :05, idempotent, drops nothing", () => {
  const sql = readFileSync(new URL("../supabase/migrations/0048_replies_poll_every_10min.sql", import.meta.url), "utf8");
  const code = sql.replace(/--[^\n]*/g, "");
  assert.match(code, /from cron\.job where jobname = 'spam-replies-poll'/);
  assert.match(code, /cron\.alter_job\(job_id := v_job, schedule := '5-59\/10 \* \* \* \*'\)/);
  assert.match(code, /cron\.schedule\('spam-replies-poll', '5-59\/10 \* \* \* \*', \$job\$select public\.spam_cron_call\('\/api\/replies\/poll'\)\$job\$\)/);
  assert.ok(!/\b(drop|unschedule|delete|truncate)\b/i.test(code), "no destructive statement");
  // The poll lands 5 minutes after each send run (0041: */10 15-22 * * 1-5).
  const minutes = Array.from({ length: 60 }, (_, m) => m).filter((m) => m >= 5 && (m - 5) % 10 === 0);
  assert.deepEqual(minutes, [5, 15, 25, 35, 45, 55]);
});

// ── 4. A demotion pulls back automatic approvals ─────────────────────────────

/** An approved, scheduled pitch and its approval events (oldest first). */
function approved(id: string, events: Array<boolean>, over: Row = {}): { pitch: Row; events: Row[] } {
  return {
    pitch: {
      id,
      tenant_id: TENANT,
      status: "approved",
      autopilot_lane: "auto",
      autopilot_reasons: [],
      sent_at: null,
      scheduled_send_at: "2026-10-20T09:00:00.000Z",
      queued_at: "2026-10-19T15:00:00.000Z",
      sender_inbox_id: INBOX,
      ...over,
    },
    events: events.map((autopilot, i) => ({
      id: `appr-${id}-${i}`,
      tenant_id: TENANT,
      pitch_id: id,
      event_type: "approved",
      event_at: pg(`1${i}:00`),
      payload: { by: ADMIN, autopilot },
    })),
  };
}

function demotionFixture() {
  const parts = {
    auto1: approved("auto-1", [true]),
    auto2: approved("auto-2", [true]),
    byPerson: approved("person-1", [false]), // a person approved an AUTO-lane draft by hand
    reapproved: approved("person-2", [true, false]), // autopilot, then a person: the person's call
    noEvent: approved("legacy-1", []),
    sending: approved("auto-sending", [true], { status: "sending" }),
    sent: approved("auto-sent", [true], { status: "sent", sent_at: "2026-10-19T15:00:00.000Z" }),
    reviewLane: approved("auto-review", [true], { autopilot_lane: "review" }),
    otherTenant: approved("auto-other", [true], { tenant_id: OTHER_TENANT }),
  };
  const db = fakeDb({
    pitches: Object.values(parts).map((p) => p.pitch),
    pitch_events: Object.values(parts).flatMap((p) => p.events),
    audit_log: [],
  });
  return { db, parts };
}

test("veto → shadow holds only the autopilot's approvals still waiting to send", async () => {
  const { db, parts } = demotionFixture();
  const before = Object.fromEntries(Object.entries(parts).map(([k, p]) => [k, { ...p.pitch }]));
  const result = await holdAutoApprovals(db, TENANT, "shadow");
  assert.deepEqual(result, { held: 2, error: null });
  for (const key of ["auto1", "auto2"] as const) {
    const p = parts[key].pitch;
    assert.equal(p.status, "draft", key);
    assert.equal(p.scheduled_send_at, null);
    assert.equal(p.queued_at, null);
    assert.equal(p.sender_inbox_id, null);
    assert.equal(p.autopilot_lane, "review");
    assert.deepEqual(p.autopilot_reasons, ["held by the autopilot: stage dropped to shadow"]);
  }
  for (const key of ["byPerson", "reapproved", "noEvent", "sending", "sent", "reviewLane", "otherTenant"] as const) {
    assert.deepEqual(parts[key].pitch, before[key], `${key} must not be touched`);
  }
  const audit = db.tables.audit_log!.map(({ id: _id, created_at: _c, ...r }) => r);
  assert.deepEqual(audit, ["auto-1", "auto-2"].map((id) => ({
    tenant_id: TENANT,
    actor_id: null,
    action: "pitch.held",
    entity_type: "pitch",
    entity_id: id,
    metadata: { source: "demotion", stage: "shadow" },
  })));
});

test("demotion hold never flips a pitch the send-queue claimed between the read and the hold", async () => {
  const { db: base, parts } = demotionFixture();
  // The send-queue claims auto-1 (approved → sending) after our read, before our update.
  const db = fakeDb(base.tables, {
    beforeUpdate: (table) => {
      if (table === "pitches" && parts.auto1.pitch.status === "approved") parts.auto1.pitch.status = "sending";
    },
  });
  const result = await holdAutoApprovals(db, TENANT, "shadow");
  assert.deepEqual(result, { held: 1, error: null });
  assert.equal(parts.auto1.pitch.status, "sending", "the claimed row keeps its claim");
  assert.equal(parts.auto1.pitch.sender_inbox_id, INBOX);
  assert.equal(parts.auto2.pitch.status, "draft");
  assert.deepEqual(db.tables.audit_log!.map((r) => r.entity_id), ["auto-2"], "audited only what was held");
});

test("demotion hold is idempotent: a second run (the next tick's sweep) holds nothing", async () => {
  const { db } = demotionFixture();
  await holdAutoApprovals(db, TENANT, "shadow");
  assert.deepEqual(await holdAutoApprovals(db, TENANT, "shadow"), { held: 0, error: null });
  assert.equal(db.tables.audit_log!.length, 2);
});

test("demotion hold reports a read or write failure instead of claiming success", async () => {
  for (const fail of ["pitches.select", "pitch_events.select", "pitches.update"] as const) {
    const { db: base } = demotionFixture();
    const db = fakeDb(base.tables, { fail: { [fail]: "" } });
    const r = await holdAutoApprovals(db, TENANT, "shadow");
    assert.equal(r.held, 0, fail);
    assert.ok(r.error, fail);
    assert.match(pullbackSentence(r), /Could not pull back the automatic emails waiting to send \(.*\): any still approved will send/);
  }
});

test("a pulled-back pitch is left for a person by the resolve step, and is not a person's hold", () => {
  const reason = demotionHoldReason("shadow");
  assert.ok(reason.startsWith(HELD_BY_AUTOPILOT));
  assert.ok(!reason.startsWith(HELD_BY_PERSON));
  assert.ok(!HELD_BY_AUTOPILOT.startsWith(HELD_BY_PERSON) && !HELD_BY_PERSON.startsWith(HELD_BY_AUTOPILOT));
  for (const isRewrite of [false, true]) {
    const r = heldAction({ lane: "review", reasons: [reason], isRewrite, editedByPerson: false }, new Set());
    assert.deepEqual(r, { action: "leave", why: "the autopilot pulled it back when its stage dropped" });
  }
});

test("only shadow and off pull back; a quality breaker trip in veto restarts the veto clock (never shadow)", () => {
  assert.equal(pullsBackApprovals("shadow"), true);
  assert.equal(pullsBackApprovals("off"), true);
  assert.equal(pullsBackApprovals("veto"), false);
  assert.equal(pullsBackApprovals("auto"), false);
  const m0: StageMetrics = {
    daysInStage: 1, autoDecided: 0, autoApprovedUnedited: 0, autoFactualErrors: 0,
    autoScheduled: 19, autoVetoed: 0, autoBounceRate: 0.1, autoQualityTrips: 1,
  };
  assert.deepEqual(nextStage("veto", m0), { stage: "veto", reason: "a quality breaker tripped; veto clock restarted", restart: true });
  assert.equal(pullsBackApprovals(nextStage("veto", m0).stage), false, "the restart pulls back on its own (tick restartStageClock)");
  assert.equal(pullsBackApprovals(nextStage("auto", m0).stage), false);
});

test("the demotion email says how many were pulled back", () => {
  assert.equal(
    pullbackSentence({ held: 9, error: null }),
    "Pulled back 9 automatic emails that were approved and waiting to send: they are back in drafts (review lane) for a person to approve or drop.",
  );
  assert.match(pullbackSentence({ held: 1, error: null }), /^Pulled back 1 automatic email that was approved .* it is back in drafts/);
  assert.equal(pullbackSentence({ held: 0, error: null }), "No automatic emails were waiting to send.");
  assert.match(pullbackSentence({ held: 3, error: "hold: timeout" }), /^Pulled back 3 .* Could not pull back the rest \(hold: timeout\)/);
});

test("the tick's stage step pulls back on shadow/off and puts the count in the email", () => {
  const s = readFileSync(new URL("../lib/autopilot/tick.ts", import.meta.url), "utf8");
  const body = s.slice(s.indexOf("async function evaluateStage"));
  const stageWrite = body.indexOf("update({ stage: next.stage, stage_since:");
  const pull = body.indexOf("pullsBackApprovals(next.stage) ? await holdAutoApprovals(db, tenantId, next.stage)");
  assert.ok(stageWrite > 0 && pull > stageWrite, "pull back right after the stage write");
  assert.match(body.slice(pull), /notify\([\s\S]*pullbackSentence\(pullback\)/);
  // The sweep on later ticks in the same stage.
  assert.match(body, /if \(!pullsBackApprovals\(s\.stage\)\) return \{ change: null, pullback: null \};\s*const sweep = await holdAutoApprovals\(db, tenantId, s\.stage\)/);
});

test("holdPitch (the digest link) behaves as before: person's reason, digest_link audit", async () => {
  const row = approved("33333333-3333-3333-3333-333333333333", [true]).pitch;
  const db = fakeDb({ pitches: [row], audit_log: [] });
  const r = await holdPitch(db, { pitchId: row.id as string, tenantId: TENANT, exp: holdExpiry("2026-10-20T09:00:00Z") });
  assert.equal(r.state, "held");
  assert.deepEqual(row.autopilot_reasons, [HOLD_REASON]);
  assert.deepEqual((db.tables.audit_log![0] as Row).metadata, { source: "digest_link" });
});

// ── 5. Trust split: only pitch quality moves the stage ───────────────────────

const STAGE_SINCE = "2026-10-19T19:57:00.000Z";
const quietStage: StageMetrics = {
  daysInStage: 0.5, autoDecided: 0, autoApprovedUnedited: 0, autoFactualErrors: 0,
  autoScheduled: 19, autoVetoed: 0, autoBounceRate: 0, autoQualityTrips: 0,
};

/** The insight runBreakers writes for an applied trip (tick.ts §1). */
function breakerInsight(db: Db, trip: BreakerTrip, createdAt: string, tenant = TENANT) {
  (db.tables.learning_insights ??= []).push({
    id: `ins-${db.tables.learning_insights!.length}`,
    tenant_id: tenant,
    learner: "governor",
    kind: "breaker",
    title: `Paused sending: ${trip.reason}`,
    evidence: trip,
    created_at: createdAt,
  });
}

/** What the stage step computes: quality trips since the stage began, into nextStage. */
async function stageAfter(db: Db, m: Partial<StageMetrics> = {}) {
  const codes = await stageQualityTrips(db, TENANT, STAGE_SINCE);
  return nextStage("veto", { ...quietStage, ...m, autoQualityTrips: codes.length, autoQualityTripCodes: codes });
}

test("veto + inbox_bounces trip: the inbox pauses, the stage stays veto", async () => {
  // The 2026-10-19 evening: two dead mailboxes bounce on a fresh inbox in veto.
  const db = fakeDb({ sender_inboxes: [{ ...pausedInbox(), paused: false, paused_reason: null }], audit_log: [], pitch_events: [], pitches: [] });
  const sends = addSends(db, 24, { last: at("21:00") });
  addBounce(db, sends[0]!, pg("21:30"));
  addBounce(db, sends[1]!, pg("21:30"));
  const trips = evaluateBreakers(await metrics(db, new Date(at("21:45"))));
  assert.deepEqual(trips.map((t) => [t.code, t.scope, t.inboxId]), [["inbox_bounces", "inbox", INBOX]], "the breaker still trips (pauses the inbox)");
  breakerInsight(db, trips[0]!, pg("21:45"));
  // Also a bounces_today and a placement trip in the same stage: delivery, all of them.
  breakerInsight(db, { scope: "all", code: "bounces_today", reason: "3 hard bounces today" }, pg("21:50"));
  breakerInsight(db, { scope: "all", code: "placement", reason: "warmup inbox placement 70% (< 80%)" }, pg("21:55"));
  assert.deepEqual(await stageQualityTrips(db, TENANT, STAGE_SINCE), []);
  assert.deepEqual(await stageAfter(db), { stage: "veto", reason: "collecting veto data" });
});

test("veto + opt_out_spike trip: the stage stays veto and its clock restarts", async () => {
  const db = fakeDb({ learning_insights: [] });
  const trip = evaluateBreakers({ ...(await metrics(fakeDb({}), new Date(at("21:45")), [])), optOutsThisWeek: 4, optOutWeeklyBaseline: 1 });
  assert.deepEqual(trip.map((t) => t.code), ["opt_out_spike"]);
  breakerInsight(db, trip[0]!, pg("21:45"));
  breakerInsight(db, { scope: "inbox", inboxId: INBOX, code: "inbox_bounces", reason: "2 hard bounces in the last 24 sends" }, pg("21:46"));
  assert.deepEqual(await stageQualityTrips(db, TENANT, STAGE_SINCE), ["opt_out_spike"]);
  assert.deepEqual(await stageAfter(db), { stage: "veto", reason: "a quality breaker tripped: opt_out_spike; veto clock restarted", restart: true });
});

test("veto + a factual error on an automatic pitch: the veto clock restarts, with no breaker at all", async () => {
  const db = fakeDb({ learning_insights: [] });
  assert.deepEqual(await stageAfter(db, { autoFactualErrors: 1 }), {
    stage: "veto",
    reason: "an automatic pitch had a factual or recipient error; veto clock restarted",
    restart: true,
  });
});

test("stageQualityTrips counts this tenant's breaker insights since the stage began, by code", async () => {
  const db = fakeDb({ learning_insights: [] });
  const spike: BreakerTrip = { scope: "all", code: "opt_out_spike", reason: "4 opt-outs this week vs ~1.0 normally" };
  breakerInsight(db, spike, "2026-10-19T19:56:59.000000+00:00"); // before the stage began
  breakerInsight(db, spike, pg("21:00"), OTHER_TENANT);
  db.tables.learning_insights!.push({ id: "x", tenant_id: TENANT, kind: "stage", evidence: { code: "opt_out_spike" }, created_at: pg("21:00") });
  assert.deepEqual(await stageQualityTrips(db, TENANT, STAGE_SINCE), []);
  breakerInsight(db, spike, pg("21:00"));
  // An insight whose code this version doesn't know counts (fails toward a person).
  db.tables.learning_insights!.push({ id: "y", tenant_id: TENANT, kind: "breaker", evidence: {}, created_at: pg("21:05") });
  assert.deepEqual(await stageQualityTrips(db, TENANT, STAGE_SINCE), ["opt_out_spike", "unknown"]);
  const unreadable = fakeDb({ learning_insights: [] }, { fail: { "learning_insights.select": "" } });
  await assert.rejects(stageQualityTrips(unreadable, TENANT, STAGE_SINCE), /breaker insights: no detail/);
});

test("the tick's stage step reads quality trips through stageQualityTrips, not a count of every breaker", () => {
  const s = readFileSync(new URL("../lib/autopilot/tick.ts", import.meta.url), "utf8");
  const body = s.slice(s.indexOf("async function evaluateStage"));
  assert.match(body, /const qualityTrips = s\.stage === "shadow" \? \[\] : await stageQualityTrips\(db, tenantId, since\);/);
  assert.match(body, /autoQualityTrips: qualityTrips\.length,\s*autoQualityTripCodes: qualityTrips,/);
  assert.ok(!body.includes('.from("learning_insights")'), "no private count of breaker insights");
  // The veto count reads reasons, so a pull-back is not a veto (governor vetoedByPerson).
  assert.match(body, /\.select\("id, status, autopilot_reasons"\)/);
  assert.match(body, /const vetoed = countVetoes\(autopilotApproved, current\);/);
});

// With the autopilot off: breakers and the pull-back still run.

// The route → runTick path with the autopilot off runs for real in tests/autopilot-trust-split.test.ts.

test("enabled=false: 2 fresh bounces still trip the inbox breaker (what the off tick now applies)", async () => {
  const db = fakeDb({ sender_inboxes: [{ ...pausedInbox(), paused: false }], audit_log: [], pitch_events: [], pitches: [] });
  const sends = addSends(db, 30, { last: at("21:00") });
  addBounce(db, sends[0]!, pg("21:30"));
  addBounce(db, sends[1]!, pg("21:31"));
  assert.deepEqual(codes(await metrics(db, new Date(at("21:45")))), ["inbox_bounces"]);
});

test("kill switch: pending automatic approvals are held (reason: stage dropped to off), a person's are not", async () => {
  const { db, parts } = demotionFixture();
  const result = await holdAutoApprovals(db, TENANT, "off");
  assert.deepEqual(result, { held: 2, error: null });
  assert.deepEqual(parts.auto1.pitch.autopilot_reasons, ["held by the autopilot: stage dropped to off"]);
  assert.equal(parts.auto2.pitch.status, "draft");
  assert.equal(parts.byPerson.pitch.status, "approved");
  assert.equal(parts.reapproved.pitch.status, "approved");
  assert.deepEqual(db.tables.audit_log!.map((r) => (r.metadata as Row).stage), ["off", "off"]);
});

// The resume: audit row first, and only from a form that showed "paused".

test("resume order: the resumed audit row exists before the unpause is written", async () => {
  const { db: base } = incident();
  let auditAtUnpause = -1;
  const db = fakeDb(base.tables, {
    beforeUpdate: (table) => {
      if (table === "sender_inboxes") auditAtUnpause = base.tables.audit_log!.filter((r) => r.action === INBOX_RESUMED_ACTION).length;
    },
  });
  const result = await saveSenderInbox(db, { tenantId: TENANT, inboxId: INBOX, actorId: ADMIN, patch: PATCH, loadedPaused: true });
  assert.deepEqual(result, { ok: true, resumed: true });
  assert.equal(auditAtUnpause, 1, "the row was written before the unpause");
  assert.equal(db.tables.sender_inboxes![0]!.paused, false);
});

test("resume order: a tick between the audit row and the unpause applies nothing and counts no old bounce", async () => {
  // In the window a tick sees the inbox still paused (runBreakers pauses only
  // unpaused inboxes) and, from then on, counts bounces after the new row only.
  const { db: base } = incident();
  const seen: Array<{ paused: unknown; resumeRows: number }> = [];
  const db = fakeDb(base.tables, {
    beforeUpdate: (table) => {
      if (table !== "sender_inboxes") return;
      seen.push({
        paused: base.tables.sender_inboxes![0]!.paused,
        resumeRows: base.tables.audit_log!.filter((r) => r.action === INBOX_RESUMED_ACTION).length,
      });
    },
  });
  db.clock = pg("15:50");
  assert.deepEqual(await saveSenderInbox(db, { tenantId: TENANT, inboxId: INBOX, actorId: ADMIN, patch: PATCH, loadedPaused: true }), { ok: true, resumed: true });
  assert.deepEqual(seen, [{ paused: true, resumeRows: 1 }]);
  assert.deepEqual(codes(await metrics(db, new Date(at("15:51")))), [], "the old bounces predate the resume row");
});

test("resume: if the unpause fails after the audit row, the inbox stays paused and the person is told", async () => {
  const { db: base } = incident();
  const db = fakeDb(base.tables, { fail: { "sender_inboxes.update": "timeout" } });
  const result = await saveSenderInbox(db, { tenantId: TENANT, inboxId: INBOX, actorId: ADMIN, patch: PATCH, loadedPaused: true });
  assert.deepEqual(result, { ok: false, error: "Could not save sender inbox (it stays paused): timeout" });
  assert.equal(db.tables.sender_inboxes![0]!.paused, true);
  assert.equal(db.tables.audit_log!.length, 1, "a stray resume row on a paused inbox is harmless");
});

test("stale form: a page loaded before the breaker paused the inbox keeps the pause and asks for a reload", async () => {
  const { db } = incident();
  const result = await saveSenderInbox(db, {
    tenantId: TENANT, inboxId: INBOX, actorId: ADMIN, loadedPaused: false,
    patch: { ...PATCH, daily_cap: 40 },
  });
  assert.equal(result.ok, false);
  assert.match(result.ok ? "" : result.error, /paused after this page was loaded, so it stays paused\. Your other changes are saved\. Reload/);
  const inbox = db.tables.sender_inboxes![0]!;
  assert.equal(inbox.paused, true);
  assert.equal(inbox.paused_reason, pausedInbox().paused_reason);
  assert.equal(inbox.daily_cap, 40, "the other edits are kept");
  assert.equal(db.tables.audit_log!.length, 0, "no resume recorded");
});

test("stale form: a breaker pause landing between the read and an unpaused save is not overwritten", async () => {
  const inbox = { ...pausedInbox(), paused: false, paused_reason: null };
  const db = fakeDb({ sender_inboxes: [inbox], audit_log: [] }, {
    beforeUpdate: (table) => {
      if (table === "sender_inboxes" && !inbox.paused) Object.assign(inbox, { paused: true, paused_reason: "Autopilot breaker (inbox_bounces): 2 hard bounces" });
    },
  });
  const result = await saveSenderInbox(db, { tenantId: TENANT, inboxId: INBOX, actorId: ADMIN, loadedPaused: false, patch: { ...PATCH, daily_cap: 40 } });
  assert.equal(result.ok, false);
  assert.match(result.ok ? "" : result.error, /paused while you were saving/);
  assert.equal(inbox.paused, true);
  assert.equal(inbox.paused_reason, "Autopilot breaker (inbox_bounces): 2 hard bounces");
  assert.equal(db.tables.audit_log!.length, 0);
});

test("the drawer sends the paused value it loaded, and the action passes it on", () => {
  const drawer = readFileSync(new URL("../components/settings/sender-inbox-drawer.tsx", import.meta.url), "utf8");
  assert.match(drawer, /loaded_paused: mode\.inbox\.paused,/);
  const action = readFileSync(new URL("../lib/settings/sending-actions.ts", import.meta.url), "utf8");
  assert.match(action, /loaded_paused: z\.boolean\(\),/);
  assert.match(action, /loadedPaused: parsed\.data\.loaded_paused,/);
});

// The relabel loop (§5 scheduleAuto), against the fake.

test("relabel: a finder-address draft labelled AUTO before 2026-10-19 is relabelled, never approved", async () => {
  const draft = (id: string, contact: string | null, over: Row = {}): Row => ({
    id, tenant_id: TENANT, status: "draft", autopilot_lane: "auto", autopilot_reasons: [], contact_id: contact, ...over,
  });
  const pitches = [
    draft("p-anymail", "c-anymail"),
    draft("p-hunter", "c-hunter"),
    draft("p-scraper", "c-scraper"),
    draft("p-none", null),
    draft("p-claimed", "c-hunter2", { status: "approved" }), // approved meanwhile: the update is draft-only
  ];
  const db = fakeDb({
    pitches,
    prospect_contacts: [
      { id: "c-anymail", tenant_id: TENANT, selected_by: "anymail" },
      { id: "c-hunter", tenant_id: TENANT, selected_by: " Hunter " },
      { id: "c-scraper", tenant_id: TENANT, selected_by: "scraper" },
      { id: "c-hunter2", tenant_id: TENANT, selected_by: "hunter" },
    ],
  });
  const relabel = await relabelFinderDrafts(db, TENANT, pitches.map((p) => ({ id: p.id as string, contact_id: p.contact_id as string | null })));
  assert.deepEqual([...relabel].sort(), ["p-anymail", "p-claimed", "p-hunter"], "the caller skips all three this tick");
  const byId = Object.fromEntries(pitches.map((p) => [p.id, p]));
  for (const id of ["p-anymail", "p-hunter"]) {
    assert.equal(byId[id]!.autopilot_lane, null, id);
    assert.equal(byId[id]!.autopilot_reasons, null, id);
    assert.equal(byId[id]!.status, "draft", `${id} is never approved`);
  }
  assert.equal(byId["p-scraper"]!.autopilot_lane, "auto");
  assert.equal(byId["p-none"]!.autopilot_lane, "auto");
  assert.equal(byId["p-claimed"]!.autopilot_lane, "auto", "a non-draft row keeps its label");
  // Another tenant's contact with the same id never decides.
  const other = fakeDb({ pitches: [draft("q", "c-x")], prospect_contacts: [{ id: "c-x", tenant_id: OTHER_TENANT, selected_by: "anymail" }] });
  assert.equal((await relabelFinderDrafts(other, TENANT, [{ id: "q", contact_id: "c-x" }])).size, 0);
});

test("relabel: unreadable recipient sources throw (approve nothing this tick)", async () => {
  const db = fakeDb({ pitches: [] }, { fail: { "prospect_contacts.select": "" }, forbidWrites: ["pitches"] });
  await assert.rejects(relabelFinderDrafts(db, TENANT, [{ id: "p", contact_id: "c" }]), /recipient sources: no detail/);
  assert.equal((await relabelFinderDrafts(fakeDb({}, { forbidWrites: ["pitches"] }), TENANT, [{ id: "p", contact_id: null }])).size, 0);
});
