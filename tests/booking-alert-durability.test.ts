/**
 * Durable booking alerts (lib/opportunities/calendar-sync.ts, migration 0047):
 * invariants D1–D6 and the brief's acceptance checks (a)–(g), against an
 * in-memory opportunities table with an injected clock and notify.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import type { Actor } from "../lib/actor.ts";
import {
  CANCELLED_LOSS_REASON,
  CALENDAR_SYNC_MAX_DURATION_MS,
  alertDue,
  bookingAlertReserveMs,
  sendDueBookingAlerts,
  supabaseSyncStore,
  syncCalendarWith,
  type AlertRow,
  type ContactMatch,
  type ProspectSummary,
  type SyncDeps,
  type SyncStore,
} from "../lib/opportunities/calendar-sync.ts";
import type { CalendarEvent } from "../lib/opportunities/google-calendar.ts";
import type { NotificationMessage, NotificationResult } from "../lib/notify/send.ts";
import { notifyRecipients } from "../lib/notify/recipients.ts";

const INBOX = "henry@runna.ca";
const T0 = Date.parse("2026-10-18T12:05:00Z");
const HOUR = 3_600_000;
const ANA: ContactMatch = { contactId: "c-ana", prospectId: "p-ana", email: "ana@bakery.ca" };

function booking(id: string, over: Partial<CalendarEvent> = {}): CalendarEvent {
  return {
    id,
    status: "confirmed",
    start: { dateTime: "2026-10-20T15:00:00-06:00", timeZone: "America/Mexico_City" } as CalendarEvent["start"],
    organizer: { email: INBOX, self: true },
    attendees: [
      { email: INBOX, self: true, organizer: true, responseStatus: "accepted" },
      { email: "ana@bakery.ca", responseStatus: "accepted" },
    ],
    ...over,
  };
}

/** updatedAt mimics the 0001 trigger; nothing may key a window on it. */
type Row = AlertRow & { eventId: string | null; updatedAt?: string };

/** opportunities as Postgres keeps them: created_at on insert, updated_at bumped on every update (0001 trigger). */
function memoryDb(now: () => number) {
  const rows: Row[] = [];
  const iso = () => new Date(now()).toISOString();
  const touch = (r: Row) => {
    r.updatedAt = iso();
  };
  let dueReads = 0;
  const store: SyncStore = {
    async findContact(email) {
      return email === ANA.email ? ANA : null;
    },
    async findCalendarOpportunity(eventId) {
      const r = rows.find((x) => x.source === "calendar" && x.eventId === eventId);
      return r ? { id: r.id, stage: r.stage, prospectId: r.prospectId } : null;
    },
    async markProspectBooked() {},
    async createOpportunity({ eventId, match, meetingStart, meetingTimeZone }) {
      if (rows.some((x) => x.eventId === eventId)) return null;
      const id = `opp-${rows.length + 1}`;
      rows.push({
        id, eventId, source: "calendar", prospectId: match.prospectId, contactId: match.contactId,
        stage: "meeting_booked", lossReason: null, meetingStart, meetingTimeZone,
        bookedAlertSentAt: null, cancelledAlertSentAt: null, cancelledAt: null, createdAt: iso(), updatedAt: iso(),
      });
      return { id };
    },
    async markCancelled(id) {
      const r = rows.find((x) => x.id === id && x.source === "calendar" && x.stage === "meeting_booked");
      if (!r) return false;
      r.stage = "lost";
      r.lossReason = CANCELLED_LOSS_REASON;
      r.cancelledAt = iso();
      touch(r);
      return true;
    },
    async rootSentPitchId() {
      return null;
    },
    async recordEvent() {},
    async prospectSummaries(ids) {
      const s: Record<string, ProspectSummary> = { "p-ana": { company: "Bakery Co", market: "MX" } };
      return new Map(ids.filter((id) => s[id]).map((id) => [id, s[id] as ProspectSummary]));
    },
    async contactEmails(ids) {
      return new Map(ids.filter((id) => id === ANA.contactId).map((id) => [id, ANA.email]));
    },
    async dueAlerts() {
      dueReads++;
      // The query's snapshot is taken first, then it yields like a real round
      // trip: overlapping runs both read the row as due and race to the claim.
      const snap = rows.map((r) => ({ ...r }));
      await new Promise((r) => setTimeout(r, 1));
      return snap;
    },
    async claimAlert(row, kind, nowIso) {
      // Check-and-set with no await in between: one UPDATE … WHERE marker IS NULL.
      const r = rows.find((x) => x.id === row.id && x.source === "calendar");
      if (!r) return false;
      if (kind === "booked") {
        if (r.bookedAlertSentAt !== null) return false;
        r.bookedAlertSentAt = nowIso;
      } else {
        if (r.cancelledAlertSentAt !== null || r.stage !== "lost" || r.lossReason !== CANCELLED_LOSS_REASON) return false;
        r.cancelledAlertSentAt = nowIso;
        if (row.bookedAlertSentAt === null) r.bookedAlertSentAt = nowIso;
      }
      touch(r);
      return true;
    },
    async releaseAlert(id, kind, claimedIso) {
      const r = rows.find((x) => x.id === id);
      if (!r) return;
      if (kind === "booked" && r.bookedAlertSentAt === claimedIso) r.bookedAlertSentAt = null;
      if (kind === "cancelled" && r.cancelledAlertSentAt === claimedIso) r.cancelledAlertSentAt = null;
      touch(r);
    },
  };
  return { store, rows, dueReads: () => dueReads };
}

/** sender_inboxes lookups: always the one connected inbox. */
function inboxClient() {
  const builder: Record<string, unknown> = {};
  for (const m of ["select", "eq", "not", "ilike", "order", "limit"]) builder[m] = () => builder;
  builder.maybeSingle = async () => ({ data: { email: INBOX, gmail_refresh_token_encrypted: "enc" }, error: null });
  return { from: () => builder };
}

function actor(): Actor {
  return {
    user: { id: "u1", email: "a@runna.ca", fullName: "Autopilot", avatarUrl: null, role: "admin", tenantId: "t1", tenantDisplayName: "Rünna" },
    supabase: inboxClient() as unknown as Actor["supabase"],
    system: true,
  };
}

type Sent = NotificationMessage & { fromEmail: string };

/** A scripted world: a clock, a calendar, a notify that answers from a queue. */
function world() {
  let clockMs = T0;
  const clock = () => clockMs;
  const db = memoryDb(clock);
  const sent: Sent[] = [];
  const log: string[] = [];
  let answers: Array<NotificationResult | Error> = [];
  let events: CalendarEvent[] = [];
  let listDelayMs = 0;
  const run = (over: Partial<SyncDeps> = {}) =>
    syncCalendarWith(actor(), {
      getAccessToken: async () => ({ ok: true, accessToken: "tok" }),
      listEvents: async () => {
        log.push("list");
        clockMs += listDelayMs;
        return { ok: true, events, truncated: false };
      },
      writeAuditLog: async () => {},
      bookingInboxEmail: "",
      store: db.store,
      notify: async (m) => {
        log.push(`notify:${m.subject.split(":")[0]}`);
        const a = answers.shift() ?? { sent: 3, failed: [] };
        if (a instanceof Error) throw a;
        if (a.sent > 0) sent.push(m); // `sent` = alerts that reached someone
        return a;
      },
      startedAt: clockMs,
      clock,
      ...over,
    });
  return {
    db, sent, log, clock, run,
    setEvents: (e: CalendarEvent[]) => void (events = e),
    answer: (...a: Array<NotificationResult | Error>) => void (answers = a),
    advance: (ms: number) => void (clockMs += ms),
    setListDelay: (ms: number) => void (listDelayMs = ms),
  };
}

const DOWN: NotificationResult = { sent: 0, failed: ["a@runna.ca: Gmail send failed: 503", "b@runna.ca: 503", "c@runna.ca: 503"] };

// ── D1 ───────────────────────────────────────────────────────────────────────

function row(over: Partial<AlertRow> = {}): AlertRow {
  return {
    id: "o1", source: "calendar", prospectId: "p-ana", contactId: "c-ana", stage: "meeting_booked", lossReason: null,
    meetingStart: null, meetingTimeZone: null, bookedAlertSentAt: null, cancelledAlertSentAt: null,
    cancelledAt: null, createdAt: new Date(T0 - HOUR).toISOString(), ...over,
  };
}

test("D1 alertDue: booked while unmarked + created in 48h; cancelled while unmarked + sync-cancelled (cancelled_at) in 48h; manual never", () => {
  assert.equal(alertDue(row(), T0), "booked");
  assert.equal(alertDue(row({ bookedAlertSentAt: "x" }), T0), null);
  assert.equal(alertDue(row({ createdAt: new Date(T0 - 49 * HOUR).toISOString() }), T0), null);
  const cancelled = row({ stage: "lost", lossReason: CANCELLED_LOSS_REASON, bookedAlertSentAt: "x", cancelledAt: new Date(T0 - HOUR).toISOString() });
  assert.equal(alertDue(cancelled, T0), "cancelled");
  assert.equal(alertDue({ ...cancelled, cancelledAlertSentAt: "y" }, T0), null);
  assert.equal(alertDue({ ...cancelled, cancelledAt: new Date(T0 - 49 * HOUR).toISOString() }, T0), null);
  // Not cancelled by the sync (a person's "booking cancelled", or pre-0047 code): never, and no booking alert either.
  assert.equal(alertDue({ ...cancelled, cancelledAt: null }, T0), null);
  assert.equal(alertDue({ ...cancelled, cancelledAt: null, bookedAlertSentAt: null }, T0), null);
  // Lost for another reason is not a cancellation; the booking alert still stands on its own marker.
  assert.equal(alertDue(row({ stage: "lost", lossReason: "price", bookedAlertSentAt: "x" }), T0), null);
  assert.equal(alertDue(row({ source: "manual" }), T0), null);
  assert.equal(alertDue(row({ source: "manual", stage: "lost", lossReason: CANCELLED_LOSS_REASON, cancelledAt: new Date(T0).toISOString() }), T0), null);
});

test("D1: rows marked alerted by 0047 and manual rows never alert", async () => {
  const w = world();
  w.db.rows.push(
    { ...row({ id: "old", bookedAlertSentAt: new Date(T0 - HOUR).toISOString() }), eventId: "e-old" },
    { ...row({ id: "oldc", stage: "lost", lossReason: CANCELLED_LOSS_REASON,
      bookedAlertSentAt: new Date(T0 - HOUR).toISOString(), cancelledAlertSentAt: new Date(T0 - HOUR).toISOString() }), eventId: "e-oldc" },
    { ...row({ id: "man", source: "manual" }), eventId: null },
  );
  const report = await w.run();
  assert.equal(w.sent.length, 0);
  assert.deepEqual(report.alerts, { sent: 0, failed: [] });
});

// ── Acceptance (a), (b): a send that reached nobody is retried at the next start ──

test("(a) notify {sent:0} on the booking run → marker null; next run's start sweep sends once; third run sends nothing", async () => {
  const w = world();
  w.setEvents([booking("e1")]);
  w.answer(DOWN);
  const r1 = await w.run();
  assert.equal(r1.counts?.created, 1);
  assert.equal(r1.alerts.sent, 0);
  assert.equal(w.db.rows[0]?.bookedAlertSentAt, null);
  assert.deepEqual(r1.errors, []);

  w.advance(HOUR);
  w.log.length = 0;
  const r2 = await w.run();
  assert.equal(w.sent.length, 1);
  assert.deepEqual(w.log, ["notify:Meeting booked", "list"], "sent by the start sweep, before listing events");
  assert.equal(r2.counts?.duplicate, 1);
  assert.equal(r2.alerts.sent, 3);
  assert.ok(w.db.rows[0]?.bookedAlertSentAt);

  w.advance(HOUR);
  await w.run();
  assert.equal(w.sent.length, 1);
});

test("(b) notify throws on the booking run → same as (a), the sync still reports ok", async () => {
  const w = world();
  w.setEvents([booking("e1")]);
  w.answer(new Error("token exchange failed"));
  const r1 = await w.run();
  assert.equal(r1.counts?.created, 1);
  assert.equal(w.db.rows[0]?.bookedAlertSentAt, null);
  assert.deepEqual(r1.errors, [], "D6: an alert failure never fails the sync");

  w.advance(HOUR);
  await w.run();
  assert.equal(w.sent.length, 1);
  w.advance(HOUR);
  await w.run();
  assert.equal(w.sent.length, 1);
  assert.deepEqual(r1.alerts.failed, ["opportunity opp-1: token exchange failed"]);
});

// ── (c) kill safety ─────────────────────────────────────────────────────────

test("(c) the end step with <60s left claims nothing; the next run sends it", async () => {
  const w = world();
  w.setEvents([booking("e1")]);
  w.setListDelay(61_000); // 120s maxDuration − 61s = 59s left at the end step
  const r1 = await w.run();
  assert.equal(r1.counts?.created, 1);
  assert.equal(w.sent.length, 0);
  assert.equal(w.db.rows[0]?.bookedAlertSentAt, null, "nothing claimed, so nothing can be stranded by a kill");

  w.setListDelay(0);
  w.advance(HOUR);
  await w.run();
  assert.equal(w.sent.length, 1);
});

test("(c') with exactly 60s left the end step still sends", async () => {
  const w = world();
  w.setEvents([booking("e1")]);
  w.setListDelay(60_000);
  await w.run();
  assert.equal(w.sent.length, 1);
});

test("D5: the start sweep stops claiming with under 60s + 40s (the sync's own time) left; the rest wait", async () => {
  const w = world();
  for (const id of ["o1", "o2", "o3"]) w.db.rows.push({ ...row({ id }), eventId: id });
  let listedAt: number | null = null;
  const report = await syncCalendarWith(actor(), {
    getAccessToken: async () => ({ ok: true, accessToken: "tok" }),
    listEvents: async () => ((listedAt = w.clock()), { ok: true, events: [], truncated: false }),
    writeAuditLog: async () => {},
    bookingInboxEmail: "",
    store: w.db.store,
    // Each alert takes 10s here.
    notify: async () => (w.advance(10_000), { sent: 3, failed: [] }),
    startedAt: T0 - 5_000,
    clock: w.clock,
  });
  // Start-sweep claims at +5s and +15s; +25s is past 120 − 60 − 40 = +20s.
  assert.equal(report.alerts.sent, 6);
  assert.deepEqual(w.db.rows.map((r) => r.bookedAlertSentAt !== null), [true, true, false]);
  assert.equal(listedAt, T0 + 20_000, "listed right after the second alert");
  // The next run's start sweep sends the third.
  w.advance(HOUR);
  const next = await w.run();
  assert.equal(next.alerts.sent, 3);
  assert.ok(w.db.rows[2]?.bookedAlertSentAt);
});

// ── (d) overlap ─────────────────────────────────────────────────────────────

test("(d) two overlapping runs over one due row → exactly one notify call", async () => {
  const w = world();
  w.setEvents([booking("e1")]);
  w.answer(DOWN);
  await w.run();
  assert.equal(w.db.rows[0]?.bookedAlertSentAt, null);

  w.advance(HOUR);
  const calls: string[] = [];
  const notify = async (m: Sent) => (calls.push(m.subject), { sent: 3, failed: [] });
  await Promise.all([w.run({ notify }), w.run({ notify })]);
  assert.equal(calls.length, 1);
});

test("(d') the claim decides: two concurrent sweeps of one row send once", async () => {
  const w = world();
  w.db.rows.push({ ...row(), eventId: "e1" });
  let calls = 0;
  const notify = async () => (calls++, { sent: 3, failed: [] });
  const opts = { deadline: T0 + 60_000, clock: w.clock };
  const [a, b] = await Promise.all([
    sendDueBookingAlerts(w.db.store, notify, opts),
    sendDueBookingAlerts(w.db.store, notify, opts),
  ]);
  assert.equal(calls, 1);
  assert.equal(a.alerts.sent + b.alerts.sent, 3);
});

// ── (e) newest state wins ───────────────────────────────────────────────────

test("(e) booked then cancelled before any alert → one cancellation alert, both markers set", async () => {
  const w = world();
  w.db.rows.push({ ...row({ stage: "lost", lossReason: CANCELLED_LOSS_REASON, cancelledAt: new Date(T0 - HOUR).toISOString(), meetingStart: "2026-10-20T15:00:00-06:00",
    meetingTimeZone: "America/Mexico_City" }), eventId: "e1" });
  const msgs: NotificationMessage[] = [];
  await sendDueBookingAlerts(w.db.store, async (m) => (msgs.push(m), { sent: 3, failed: [] }), { deadline: T0 + 60_000, clock: w.clock });
  assert.deepEqual(msgs.map((m) => m.subject), ["Booking cancelled: Bakery Co"]);
  assert.ok(w.db.rows[0]?.bookedAlertSentAt);
  assert.ok(w.db.rows[0]?.cancelledAlertSentAt);
  // D4: the stored start, not the (start-less) cancelled event.
  assert.match(msgs[0]?.body ?? "", /When: Tue, Oct 20, 2026, 3:00 PM \(America\/Mexico_City\)/);
  assert.match(msgs[0]?.body ?? "", /Who: ana@bakery\.ca/);
  await sendDueBookingAlerts(w.db.store, async (m) => (msgs.push(m), { sent: 3, failed: [] }), { deadline: T0 + 60_000, clock: w.clock });
  assert.equal(msgs.length, 1);
});

test("(e) through the sync: Gmail down for the booking, cancellation seen later → only the cancellation alert", async () => {
  const w = world();
  w.setEvents([booking("e1")]);
  w.answer(DOWN);
  await w.run();
  w.advance(HOUR);
  // Run 2: its start sweep still hits Gmail down, then Google reports the cancellation.
  w.setEvents([{ id: "e1", status: "cancelled" }]);
  w.answer(DOWN);
  const r2 = await w.run();
  assert.equal(r2.counts?.cancelled, 1);
  assert.deepEqual(w.sent.map((m) => m.subject), ["Booking cancelled: Bakery Co"]);
  assert.ok(w.db.rows[0]?.bookedAlertSentAt);
  assert.ok(w.db.rows[0]?.cancelledAlertSentAt);
  w.advance(HOUR);
  await w.run();
  assert.equal(w.sent.length, 1);
});

test("a released cancellation keeps the booked marker: the retry is the cancellation, never the booking", async () => {
  const w = world();
  w.db.rows.push({ ...row({ stage: "lost", lossReason: CANCELLED_LOSS_REASON, cancelledAt: new Date(T0 - HOUR).toISOString() }), eventId: "e1" });
  const opts = { deadline: T0 + 60_000, clock: w.clock };
  await sendDueBookingAlerts(w.db.store, async () => DOWN, opts);
  assert.ok(w.db.rows[0]?.bookedAlertSentAt);
  assert.equal(w.db.rows[0]?.cancelledAlertSentAt, null);
  const msgs: NotificationMessage[] = [];
  await sendDueBookingAlerts(w.db.store, async (m) => (msgs.push(m), { sent: 3, failed: [] }), opts);
  assert.deepEqual(msgs.map((m) => m.subject), ["Booking cancelled: Bakery Co"]);
});

test("a booking alerted, then cancelled → one booking alert and one cancellation alert", async () => {
  const w = world();
  w.setEvents([booking("e1")]);
  await w.run();
  w.advance(HOUR);
  w.setEvents([{ id: "e1", status: "cancelled" }]);
  await w.run();
  assert.deepEqual(w.sent.map((m) => m.subject.split(":")[0]), ["Meeting booked", "Booking cancelled"]);
});

// ── (f) window ──────────────────────────────────────────────────────────────

test("(f) a row older than 48h with a null marker → not sent", async () => {
  const w = world();
  w.db.rows.push(
    { ...row({ id: "old", createdAt: new Date(T0 - 49 * HOUR).toISOString() }), eventId: "e-old" },
    // updated_at is recent (a claim/release bumped it), cancelled_at is not: still closed.
    { ...row({ id: "oldc", stage: "lost", lossReason: CANCELLED_LOSS_REASON, bookedAlertSentAt: "x",
      createdAt: new Date(T0 - 60 * HOUR).toISOString(), cancelledAt: new Date(T0 - 49 * HOUR).toISOString() }),
      eventId: "e-oldc", updatedAt: new Date(T0 - HOUR).toISOString() },
  );
  await w.run();
  assert.equal(w.sent.length, 0);
  assert.equal(w.db.rows[0]?.bookedAlertSentAt, null);
});

// ── (g) partial delivery ────────────────────────────────────────────────────

test("(g) partial delivery (sent:1, failed:[…]) → marker kept, not re-sent", async () => {
  const w = world();
  w.setEvents([booking("e1")]);
  w.answer({ sent: 1, failed: ["b@runna.ca: 503", "c@runna.ca: 503"] });
  const r1 = await w.run();
  assert.deepEqual(r1.alerts, { sent: 1, failed: ["b@runna.ca: 503", "c@runna.ca: 503"] });
  assert.ok(w.db.rows[0]?.bookedAlertSentAt);
  w.advance(HOUR);
  await w.run();
  assert.equal(w.sent.length, 1);
});

// ── D4: rebuilt from the row ────────────────────────────────────────────────

test("D4: the booking alert comes from the stored row (start, zone, company, market, contact email)", async () => {
  const w = world();
  w.setEvents([booking("e1")]);
  const r = await w.run();
  assert.equal(w.db.rows[0]?.meetingStart, "2026-10-20T15:00:00-06:00");
  assert.equal(w.db.rows[0]?.meetingTimeZone, "America/Mexico_City");
  assert.equal(w.sent.length, 1);
  assert.equal(w.sent[0]?.fromEmail, INBOX);
  assert.equal(w.sent[0]?.fromName, "S.P.A.M Bookings");
  assert.equal(w.sent[0]?.kind, "lead");
  assert.equal(w.sent[0]?.subject, "Meeting booked: Bakery Co (Tue, Oct 20, 2026, 3:00 PM (America/Mexico_City))");
  assert.match(w.sent[0]?.body ?? "", /Who: ana@bakery\.ca\nMarket: MX/);
  assert.equal(r.bookings[0]?.company, "Bakery Co");
  assert.equal(r.bookings[0]?.market, "MX");
});

// ── No token, no sweep; lookup failures never fail the sync ─────────────────

test("no working token → no sweep attempted, the report says what it observed", async () => {
  const w = world();
  w.db.rows.push({ ...row(), eventId: "e1" });
  const r = await w.run({ getAccessToken: async () => ({ ok: false, error: "invalid_grant" }) });
  assert.equal(w.db.dueReads(), 0);
  assert.equal(w.sent.length, 0);
  assert.deepEqual(r.errors, [`Google auth failed for ${INBOX}: invalid_grant`]);
});

test("needsReconnect: the start sweep still sends leftovers (the token works), the report says needsReconnect", async () => {
  const w = world();
  w.db.rows.push({ ...row(), eventId: "e1" });
  const r = await w.run({ listEvents: async () => ({ ok: false, needsReconnect: true, error: "scope" }) });
  assert.equal(r.needsReconnect, true);
  assert.equal(w.sent.length, 1);
});

test("D6: a failing due-row lookup is an alert failure, not a sync error", async () => {
  const w = world();
  w.setEvents([booking("e1")]);
  const store: SyncStore = { ...w.db.store, dueAlerts: async () => { throw new Error("booking alert lookup failed: timeout"); } };
  const r = await w.run({ store });
  assert.equal(r.counts?.created, 1);
  assert.deepEqual(r.errors, []);
  assert.deepEqual(r.alerts.failed, ["booking alert lookup failed: timeout", "booking alert lookup failed: timeout"]);
});

// ── supabaseSyncStore: the claim is one conditional UPDATE … RETURNING ──────

type Call = { table: string; ops: Array<[string, unknown[]]> };

function recordingClient(answer: (c: Call) => { data: unknown; error: { message: string } | null }) {
  const calls: Call[] = [];
  return {
    calls,
    client: {
      from(table: string) {
        const call: Call = { table, ops: [] };
        calls.push(call);
        const b: Record<string, unknown> = {};
        for (const m of ["select", "eq", "in", "is", "gte", "order", "limit", "insert", "update"]) {
          b[m] = (...args: unknown[]) => (call.ops.push([m, args]), b);
        }
        b.single = async () => answer(call);
        b.then = (res: (v: unknown) => unknown, rej: (e: unknown) => unknown) => Promise.resolve(answer(call)).then(res, rej);
        return b;
      },
    },
  };
}

const has = (c: Call, op: string, ...args: unknown[]) =>
  c.ops.some(([o, a]) => o === op && JSON.stringify(a) === JSON.stringify(args));

test("store.claimAlert(booked): only where the marker is null, tenant + calendar scoped, RETURNING id", async () => {
  const fake = recordingClient(() => ({ data: [{ id: "o1" }], error: null }));
  const won = await supabaseSyncStore(fake.client, "t1").claimAlert(row(), "booked", "2026-10-18T12:05:00.000Z");
  assert.equal(won, true);
  const c = fake.calls[0]!;
  assert.equal(c.table, "opportunities");
  assert.ok(has(c, "update", { booked_alert_sent_at: "2026-10-18T12:05:00.000Z" }));
  assert.ok(has(c, "is", "booked_alert_sent_at", null));
  assert.ok(has(c, "eq", "id", "o1"));
  assert.ok(has(c, "eq", "tenant_id", "t1"));
  assert.ok(has(c, "eq", "source", "calendar"));
  assert.ok(has(c, "select", "id"));
  const lost = recordingClient(() => ({ data: [], error: null }));
  assert.equal(await supabaseSyncStore(lost.client, "t1").claimAlert(row(), "booked", "x"), false);
});

test("store.claimAlert(cancelled): still cancelled, marker null, also sets an unset booked marker (D3)", async () => {
  const fake = recordingClient(() => ({ data: [{ id: "o1" }], error: null }));
  const store = supabaseSyncStore(fake.client, "t1");
  await store.claimAlert(row({ stage: "lost", lossReason: CANCELLED_LOSS_REASON }), "cancelled", "now");
  const c = fake.calls[0]!;
  assert.ok(has(c, "update", { cancelled_alert_sent_at: "now", booked_alert_sent_at: "now" }));
  assert.ok(has(c, "is", "cancelled_alert_sent_at", null));
  assert.ok(has(c, "eq", "stage", "lost"));
  assert.ok(has(c, "eq", "loss_reason", CANCELLED_LOSS_REASON));
  // Already booked-alerted: its marker is left as it is.
  await store.claimAlert(row({ stage: "lost", lossReason: CANCELLED_LOSS_REASON, bookedAlertSentAt: "then" }), "cancelled", "now");
  assert.ok(has(fake.calls[1]!, "update", { cancelled_alert_sent_at: "now" }));
});

test("store.claimAlert / releaseAlert throw on a DB error; release clears only its own marker", async () => {
  const bad = recordingClient(() => ({ data: null, error: { message: "timeout" } }));
  await assert.rejects(supabaseSyncStore(bad.client, "t1").claimAlert(row(), "booked", "x"), /booking alert claim failed: timeout/);
  await assert.rejects(supabaseSyncStore(bad.client, "t1").releaseAlert("o1", "booked", "x"), /booking alert release failed/);
  const ok = recordingClient(() => ({ data: null, error: null }));
  await supabaseSyncStore(ok.client, "t1").releaseAlert("o1", "cancelled", "2026-10-18T12:05:00.000Z");
  assert.ok(has(ok.calls[0]!, "update", { cancelled_alert_sent_at: null }));
  assert.ok(has(ok.calls[0]!, "eq", "tenant_id", "t1"));
  // Only this claim's own marker: a newer claim by another run is left alone.
  assert.ok(has(ok.calls[0]!, "eq", "cancelled_alert_sent_at", "2026-10-18T12:05:00.000Z"));
});

test("store.dueAlerts: two calendar-scoped queries (booked by created_at, cancelled by cancelled_at), merged by id", async () => {
  const dbRow = {
    id: "o1", source: "calendar", prospect_id: "p", contact_id: "c", stage: "lost", loss_reason: CANCELLED_LOSS_REASON,
    meeting_start: "2026-10-20", meeting_time_zone: null, booked_alert_sent_at: null, cancelled_alert_sent_at: null,
    cancelled_at: "b", created_at: "a",
  };
  const fake = recordingClient(() => ({ data: [dbRow], error: null }));
  const rows = await supabaseSyncStore(fake.client, "t1").dueAlerts("since");
  assert.equal(rows.length, 1);
  assert.equal(rows[0]?.meetingStart, "2026-10-20");
  assert.equal(rows[0]?.lossReason, CANCELLED_LOSS_REASON);
  const [booked, cancelled] = fake.calls;
  for (const c of [booked!, cancelled!]) {
    assert.ok(has(c, "eq", "tenant_id", "t1"));
    assert.ok(has(c, "eq", "source", "calendar"));
  }
  assert.ok(has(booked!, "is", "booked_alert_sent_at", null));
  assert.ok(has(booked!, "gte", "created_at", "since"));
  assert.ok(has(cancelled!, "is", "cancelled_alert_sent_at", null));
  assert.ok(has(cancelled!, "eq", "loss_reason", CANCELLED_LOSS_REASON));
  assert.ok(has(cancelled!, "gte", "cancelled_at", "since"));
  assert.ok(!cancelled!.ops.some(([, a]) => (a as unknown[])[0] === "updated_at"), "never keyed on updated_at");
  assert.equal(rows[0]?.cancelledAt, "b");
});

test("store.createOpportunity stores meeting_start and meeting_time_zone", async () => {
  const fake = recordingClient(() => ({ data: { id: "o1" }, error: null }));
  await supabaseSyncStore(fake.client, "t1").createOpportunity({
    eventId: "e1", match: ANA, notes: "n", meetingStart: "2026-10-20T15:00:00-06:00", meetingTimeZone: "America/Mexico_City",
  });
  const insert = fake.calls[0]!.ops.find(([o]) => o === "insert")?.[1][0] as Record<string, unknown>;
  assert.equal(insert.meeting_start, "2026-10-20T15:00:00-06:00");
  assert.equal(insert.meeting_time_zone, "America/Mexico_City");
  assert.equal(insert.source, "calendar");
});

// ── Review round 1: cancelled_at, release guard, reserve, maxDuration ───────

test("a person closing a calendar row as Lost with free-text \"booking cancelled\" never emails the lead list", async () => {
  const w = world();
  // closeOpportunity (lib/opportunities/actions.ts) writes stage + loss_reason, not cancelled_at.
  w.db.rows.push({ ...row({ stage: "lost", lossReason: CANCELLED_LOSS_REASON, bookedAlertSentAt: new Date(T0 - HOUR).toISOString() }),
    eventId: "e1", updatedAt: new Date(T0).toISOString() });
  await w.run();
  assert.equal(w.sent.length, 0);
});

test("a cancellation applied by the old code (cancelled_at null, alert markers null) is never alerted by the new code", async () => {
  const w = world();
  w.db.rows.push({ ...row({ stage: "lost", lossReason: CANCELLED_LOSS_REASON }), eventId: "e1", updatedAt: new Date(T0).toISOString() });
  await w.run();
  assert.equal(w.sent.length, 0);
  assert.equal(w.db.rows[0]?.cancelledAlertSentAt, null);
});

test("markCancelled sets cancelled_at (the cancellation window), the store writes it", async () => {
  const fake = recordingClient(() => ({ data: [{ id: "o1" }], error: null }));
  assert.equal(await supabaseSyncStore(fake.client, "t1").markCancelled("o1"), true);
  const update = fake.calls[0]!.ops.find(([o]) => o === "update")?.[1][0] as Record<string, unknown>;
  assert.equal(update.stage, "lost");
  assert.equal(update.loss_reason, CANCELLED_LOSS_REASON);
  assert.ok(typeof update.cancelled_at === "string" && !Number.isNaN(Date.parse(update.cancelled_at)));
  assert.equal("updated_at" in update, false);
});

test("a release only clears this claim's own timestamp: a repeated late release can't wipe a newer claim", async () => {
  const w = world();
  w.db.rows.push({ ...row(), eventId: "e1" });
  const r = w.db.rows[0]!;
  assert.equal(await w.db.store.claimAlert(r, "booked", "claim-A"), true);
  await w.db.store.releaseAlert(r.id, "booked", "claim-A");
  assert.equal(await w.db.store.claimAlert(r, "booked", "claim-B"), true);
  await w.db.store.releaseAlert(r.id, "booked", "claim-A"); // A's duplicate release
  assert.equal(r.bookedAlertSentAt, "claim-B");
});

test("bookingAlertReserveMs: 10s token + 15s per lead recipient + 5s; 60s for the default three", () => {
  assert.equal(bookingAlertReserveMs(3), 60_000);
  assert.equal(bookingAlertReserveMs(4), 75_000);
  assert.equal(bookingAlertReserveMs(), 10_000 + 15_000 * notifyRecipients("lead").length + 5_000);
});

test("CALENDAR_SYNC_MAX_DURATION_MS matches vercel.json's maxDuration for the calendar-sync route", () => {
  const cfg = JSON.parse(readFileSync(new URL("../vercel.json", import.meta.url), "utf8")) as {
    functions: Record<string, { maxDuration?: number }>;
  };
  // Vercel uses the FIRST matching pattern.
  const route = "app/api/opportunities/calendar-sync/route.ts";
  const first = Object.entries(cfg.functions).find(([pattern]) => pattern === route || new RegExp(
    "^" + pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*\*/g, "§").replace(/\*/g, "[^/]*").replace(/§/g, ".*") + "$",
  ).test(route));
  assert.equal(first?.[0], route);
  assert.equal((first?.[1].maxDuration ?? 0) * 1000, CALENDAR_SYNC_MAX_DURATION_MS);
});
