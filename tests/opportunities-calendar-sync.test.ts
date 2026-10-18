/**
 * Google Calendar booking sync: matcher, idempotency, cancellation, prospect
 * status + audit, root-pitch attachment, route auth, the 403-scope path, and
 * migration 0044.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import type { Actor } from "../lib/actor.ts";
import type { AuditPayload } from "../lib/audit/log.ts";
import {
  CANCELLED_LOSS_REASON,
  applyCalendarEvents,
  bookingCandidates,
  handleCalendarSync,
  organizedByInbox,
  planEvent,
  sendBookingAlerts,
  supabaseSyncStore,
  syncCalendarWith,
  type BookedAudit,
  type CalendarOpportunity,
  type CalendarSyncReport,
  type ContactMatch,
  type ProspectSummary,
  type SyncStore,
} from "../lib/opportunities/calendar-sync.ts";
import { listRecentEvents, type CalendarAttendee, type CalendarEvent } from "../lib/opportunities/google-calendar.ts";
import type { PitchEventType } from "../lib/pitches/events.ts";
import type { NotificationMessage } from "../lib/notify/send.ts";
import { formatBookingAlert, formatStart } from "../lib/opportunities/booking-alert.ts";

const INBOX = "henry@runna.ca";

/** An appointment-schedule booking: our inbox organizes, the booker attends. */
function booking(id: string, attendees: Array<string | CalendarAttendee>, over: Partial<CalendarEvent> = {}): CalendarEvent {
  return {
    id,
    status: "confirmed",
    summary: "Rünna intro call",
    start: { dateTime: "2026-10-20T15:00:00-06:00" },
    organizer: { email: INBOX, self: true },
    attendees: [
      { email: INBOX, self: true, organizer: true, responseStatus: "accepted" },
      ...attendees.map((a) => (typeof a === "string" ? { email: a, responseStatus: "accepted" } : a)),
    ],
    ...over,
  };
}

type Opp = { id: string; eventId: string | null; source: "manual" | "calendar"; stage: string; prospectId: string; lossReason: string | null };

/** In-memory store with the same constraints as the tables. */
function memoryStore(
  contacts: Record<string, ContactMatch>,
  rootPitch: Record<string, string> = {},
  prospectStatus: Record<string, string> = {},
  summaries: Record<string, ProspectSummary> = {},
) {
  const opps: Opp[] = [];
  const pitchEvents: Array<{ pitchId: string; type: PitchEventType; payload: Record<string, unknown> }> = [];
  const store: SyncStore = {
    async findContact(email) {
      return contacts[email] ?? null;
    },
    async findCalendarOpportunity(eventId) {
      const o = opps.find((x) => x.source === "calendar" && x.eventId === eventId);
      return o ? { id: o.id, stage: o.stage, prospectId: o.prospectId } : null;
    },
    async markProspectBooked(prospectId) {
      const s = prospectStatus[prospectId];
      if (s !== "won" && s !== "lost") prospectStatus[prospectId] = "booked";
    },
    async createOpportunity({ eventId, match }) {
      if (opps.some((x) => x.eventId === eventId)) return null;
      const id = `opp-${opps.length + 1}`;
      opps.push({ id, eventId, source: "calendar", stage: "meeting_booked", prospectId: match.prospectId, lossReason: null });
      return { id };
    },
    async markCancelled(id) {
      const o = opps.find((x) => x.id === id && x.source === "calendar" && x.stage === "meeting_booked");
      if (!o) return false;
      o.stage = "lost";
      o.lossReason = CANCELLED_LOSS_REASON;
      return true;
    },
    async rootSentPitchId(prospectId) {
      return rootPitch[prospectId] ?? null;
    },
    async recordEvent(pitchId, type, payload) {
      pitchEvents.push({ pitchId, type, payload });
    },
    async prospectSummaries(ids) {
      return new Map(ids.filter((id) => summaries[id]).map((id) => [id, summaries[id] as ProspectSummary]));
    },
  };
  return { store, opps, pitchEvents, prospectStatus };
}

function recordingAudit() {
  const calls: Array<{ opportunityId: string; metadata: Record<string, unknown> }> = [];
  const audit: BookedAudit = async (opportunityId, metadata) => {
    calls.push({ opportunityId, metadata });
  };
  return { audit, calls };
}

const noAudit: BookedAudit = async () => {};

function apply(events: CalendarEvent[], store: SyncStore, audit: BookedAudit = noAudit) {
  return applyCalendarEvents(events, INBOX, store, audit);
}

const ANA: ContactMatch = { contactId: "c-ana", prospectId: "p-ana", email: "ana@bakery.ca" };

// ── Pure matcher ─────────────────────────────────────────────────────────────

test("bookingCandidates drops the inbox itself, test addresses, declined, duplicates; lower-cases", () => {
  const ev = booking("e1", ["Ana@Bakery.ca", "pedro.jr22+demo@gmail.com", "ana@bakery.ca", "henry@RUNNA.ca"]);
  ev.attendees?.push({ email: "bob@x.ca", responseStatus: "declined" });
  assert.deepEqual(bookingCandidates(ev, INBOX), ["ana@bakery.ca"]);
});

test("organizedByInbox: organizer.self, organizer email (normalized), otherwise not ours", () => {
  assert.equal(organizedByInbox(booking("e", []), INBOX), true);
  assert.equal(organizedByInbox(booking("e", [], { organizer: { email: "Henry@Runna.ca" } }), INBOX), true);
  assert.equal(organizedByInbox(booking("e", [], { organizer: { email: "sales@vendor.com" } }), INBOX), false);
  assert.equal(organizedByInbox(booking("e", [], { organizer: undefined }), INBOX), false);
});

test("planEvent: create / duplicate / not ours / unmatched / cancel / cancelled untracked / cancelled closed", () => {
  const ev = booking("e1", ["ana@bakery.ca"]);
  const open: CalendarOpportunity = { id: "o1", stage: "meeting_booked", prospectId: "p-ana" };
  assert.deepEqual(planEvent(ev, null, ANA, true), { kind: "create", match: ANA });
  assert.deepEqual(planEvent(ev, open, ANA, true), { kind: "skip", reason: "duplicate" });
  assert.deepEqual(planEvent(ev, null, ANA, false), { kind: "skip", reason: "not_ours" });
  assert.deepEqual(planEvent(ev, null, null, true), { kind: "skip", reason: "unmatched" });
  const cancelled = { ...ev, status: "cancelled" };
  assert.deepEqual(planEvent(cancelled, open, null, false), { kind: "cancel", opportunity: open });
  assert.deepEqual(planEvent(cancelled, null, null, true), { kind: "skip", reason: "cancelled_untracked" });
  assert.deepEqual(planEvent(cancelled, { ...open, stage: "won" }, null, true), { kind: "skip", reason: "cancelled_closed" });
});

// ── Acceptance check 1 ───────────────────────────────────────────────────────

test("an attendee matching a contact → one opportunity, prospect booked, audit, meeting_booked on the root pitch", async () => {
  const m = memoryStore({ "ana@bakery.ca": ANA }, { "p-ana": "pitch-root" }, { "p-ana": "contacted" });
  const a = recordingAudit();
  const { counts, errors } = await apply([booking("e1", ["ana@bakery.ca"])], m.store, a.audit);
  assert.deepEqual(errors, []);
  assert.equal(counts.created, 1);
  assert.equal(m.opps.length, 1);
  assert.equal(m.opps[0]?.stage, "meeting_booked");
  assert.equal(m.prospectStatus["p-ana"], "booked");
  assert.equal(a.calls.length, 1);
  assert.equal(a.calls[0]?.opportunityId, "opp-1");
  assert.equal(a.calls[0]?.metadata.calendar_event_id, "e1");
  assert.equal(m.pitchEvents.length, 1);
  assert.equal(m.pitchEvents[0]?.pitchId, "pitch-root");
  assert.equal(m.pitchEvents[0]?.type, "meeting_booked");
});

test("a won or lost prospect keeps its status when they book", async () => {
  const BOB: ContactMatch = { contactId: "c-bob", prospectId: "p-bob", email: "bob@gym.ca" };
  const m = memoryStore({ "ana@bakery.ca": ANA, "bob@gym.ca": BOB }, {}, { "p-ana": "won", "p-bob": "lost" });
  await apply([booking("e1", ["ana@bakery.ca"]), booking("e2", ["bob@gym.ca"])], m.store);
  assert.equal(m.prospectStatus["p-ana"], "won");
  assert.equal(m.prospectStatus["p-bob"], "lost");
  assert.equal(m.opps.length, 2);
});

test("no sent pitch → opportunity still created, pitch event skipped", async () => {
  const m = memoryStore({ "ana@bakery.ca": ANA });
  const { counts } = await apply([booking("e1", ["ana@bakery.ca"])], m.store);
  assert.equal(counts.created, 1);
  assert.equal(m.pitchEvents.length, 0);
});

test("the inbox's own address and a test address never match, even if stored as contacts", async () => {
  const m = memoryStore({
    [INBOX]: { contactId: "c-own", prospectId: "p-own", email: INBOX },
    "pedrojr22@gmail.com": { contactId: "c-test", prospectId: "p-test", email: "pedrojr22@gmail.com" },
  });
  const { counts } = await apply([booking("e1", ["pedrojr22@gmail.com"])], m.store);
  assert.equal(counts.created, 0);
  assert.equal(counts.unmatched, 1);
  assert.equal(m.opps.length, 0);
});

test("first matching attendee wins", async () => {
  const BOB: ContactMatch = { contactId: "c-bob", prospectId: "p-bob", email: "bob@gym.ca" };
  const m = memoryStore({ "ana@bakery.ca": ANA, "bob@gym.ca": BOB });
  await apply([booking("e1", ["stranger@nowhere.ca", "bob@gym.ca", "ana@bakery.ca"])], m.store);
  assert.equal(m.opps.length, 1);
  assert.equal(m.opps[0]?.prospectId, "p-bob");
});

test("the same event id twice (same run and next run) → one opportunity", async () => {
  const m = memoryStore({ "ana@bakery.ca": ANA }, { "p-ana": "pitch-root" });
  const a = recordingAudit();
  const ev = booking("e1", ["ana@bakery.ca"]);
  const first = await apply([ev, ev], m.store, a.audit);
  const second = await apply([ev], m.store, a.audit);
  assert.equal(m.opps.length, 1);
  assert.equal(m.pitchEvents.length, 1);
  assert.equal(a.calls.length, 1);
  assert.equal(first.counts.duplicate, 1);
  assert.equal(second.counts.duplicate, 1);
});

test("a lost insert race (unique index) counts as duplicate, no audit, no pitch event", async () => {
  const m = memoryStore({ "ana@bakery.ca": ANA }, { "p-ana": "pitch-root" });
  const a = recordingAudit();
  const racing: SyncStore = { ...m.store, findCalendarOpportunity: async () => null, createOpportunity: async () => null };
  const { counts } = await apply([booking("e1", ["ana@bakery.ca"])], racing, a.audit);
  assert.equal(counts.created, 0);
  assert.equal(counts.duplicate, 1);
  assert.equal(a.calls.length, 0);
  assert.equal(m.pitchEvents.length, 0);
});

test("a cancelled event for an existing meeting_booked opportunity → lost, 'booking cancelled'; prospect status untouched", async () => {
  const m = memoryStore({ "ana@bakery.ca": ANA }, { "p-ana": "pitch-root" });
  await apply([booking("e1", ["ana@bakery.ca"])], m.store);
  // Google sends a cancelled booking with little more than its id.
  const { counts } = await apply([{ id: "e1", status: "cancelled" }], m.store);
  assert.equal(counts.cancelled, 1);
  assert.equal(m.opps[0]?.stage, "lost");
  assert.equal(m.opps[0]?.lossReason, "booking cancelled");
  assert.equal(m.prospectStatus["p-ana"], "booked");
  assert.deepEqual(m.pitchEvents.map((e) => e.type), ["meeting_booked", "lost"]);
  // Seeing the cancellation again changes nothing.
  await apply([{ id: "e1", status: "cancelled" }], m.store);
  assert.equal(m.pitchEvents.length, 2);
});

test("a cancelled event with no opportunity → nothing", async () => {
  const m = memoryStore({ "ana@bakery.ca": ANA }, { "p-ana": "pitch-root" });
  const { counts } = await apply([{ ...booking("e9", ["ana@bakery.ca"]), status: "cancelled" }], m.store);
  assert.equal(counts.created + counts.cancelled, 0);
  assert.equal(m.opps.length, 0);
  assert.equal(m.pitchEvents.length, 0);
});

test("manual opportunities are never touched, even with a matching event id", async () => {
  const m = memoryStore({ "ana@bakery.ca": ANA });
  m.opps.push({ id: "manual-1", eventId: "e1", source: "manual", stage: "meeting_booked", prospectId: "p-ana", lossReason: null });
  await apply([{ id: "e1", status: "cancelled" }], m.store);
  assert.equal(m.opps[0]?.stage, "meeting_booked");
});

// ── Reviewer probes: whose event is it? ──────────────────────────────────────

test("probe: an invite we sent, prospect still needsAction → booking", async () => {
  const m = memoryStore({ "ana@bakery.ca": ANA });
  const { counts } = await apply([booking("e1", [{ email: "ana@bakery.ca", responseStatus: "needsAction" }])], m.store);
  assert.equal(counts.created, 1);
});

test("probe: a vendor invite where the prospect organizes → skipped_not_ours, no lookups", async () => {
  const m = memoryStore({ "ana@bakery.ca": ANA });
  let lookups = 0;
  const counting: SyncStore = { ...m.store, findContact: async (e) => (lookups++, m.store.findContact(e)) };
  const ev: CalendarEvent = {
    id: "v1",
    status: "confirmed",
    organizer: { email: "ana@bakery.ca" },
    attendees: [
      { email: "ana@bakery.ca", organizer: true, responseStatus: "accepted" },
      { email: INBOX, self: true, responseStatus: "needsAction" },
    ],
  };
  const { counts } = await apply([ev], counting);
  assert.equal(counts.skippedNotOurs, 1);
  assert.equal(counts.created, 0);
  assert.equal(lookups, 0);
});

test("probe: an optional attendee is still matched unless declined", async () => {
  const m = memoryStore({ "ana@bakery.ca": ANA });
  const { counts } = await apply([booking("e1", [{ email: "ana@bakery.ca", optional: true, responseStatus: "tentative" }])], m.store);
  assert.equal(counts.created, 1);
  const m2 = memoryStore({ "ana@bakery.ca": ANA });
  const declined = await apply([booking("e2", [{ email: "ana@bakery.ca", optional: true, responseStatus: "declined" }])], m2.store);
  assert.equal(declined.counts.created, 0);
  assert.equal(declined.counts.unmatched, 1);
});

// ── Errors are errors, not "unmatched" ───────────────────────────────────────

test("one failing event is reported and the rest still sync", async () => {
  const m = memoryStore({ "ana@bakery.ca": ANA });
  const flaky: SyncStore = {
    ...m.store,
    findCalendarOpportunity: async (id) => {
      if (id === "bad") throw new Error("boom");
      return m.store.findCalendarOpportunity(id);
    },
  };
  const { counts, errors } = await apply([booking("bad", []), booking("e1", ["ana@bakery.ca"])], flaky);
  assert.equal(counts.created, 1);
  assert.deepEqual(errors, ["event bad: boom"]);
});

test("a prospect status failure creates nothing, so the next run retries", async () => {
  const m = memoryStore({ "ana@bakery.ca": ANA });
  const failing: SyncStore = { ...m.store, markProspectBooked: async () => { throw new Error("prospect status update failed: x"); } };
  const { counts, errors } = await apply([booking("e1", ["ana@bakery.ca"])], failing);
  assert.equal(counts.created, 0);
  assert.equal(m.opps.length, 0);
  assert.equal(errors.length, 1);
  const retry = await apply([booking("e1", ["ana@bakery.ca"])], m.store);
  assert.equal(retry.counts.created, 1);
});

// ── supabaseSyncStore against a recording fake client ───────────────────────

type Call = { table: string; ops: Array<[string, unknown[]]> };

/** A Supabase stand-in that records every builder call and answers with `result`. */
function recordingSupabase(result: (call: Call) => { data: unknown; error: { message: string; code?: string } | null }) {
  const calls: Call[] = [];
  const client = {
    from(table: string) {
      const call: Call = { table, ops: [] };
      calls.push(call);
      const builder: Record<string, unknown> = {};
      for (const m of ["select", "eq", "in", "ilike", "not", "is", "order", "limit", "insert", "update"]) {
        builder[m] = (...args: unknown[]) => {
          call.ops.push([m, args]);
          return builder;
        };
      }
      for (const m of ["maybeSingle", "single"]) {
        builder[m] = async () => {
          call.ops.push([m, []]);
          return result(call);
        };
      }
      builder.then = (resolve: (v: unknown) => unknown, reject: (e: unknown) => unknown) =>
        Promise.resolve(result(call)).then(resolve, reject);
      return builder;
    },
  };
  return { client, calls };
}

const has = (c: Call, op: string, ...args: unknown[]) =>
  c.ops.some(([o, a]) => o === op && JSON.stringify(a) === JSON.stringify(args));

test("store.rootSentPitchId delegates to latestRootSentPitchId (root rows only, status sent)", async () => {
  const fake = recordingSupabase(() => ({ data: { id: "pitch-root" }, error: null }));
  const id = await supabaseSyncStore(fake.client, "t1").rootSentPitchId("p-ana");
  assert.equal(id, "pitch-root");
  const call = fake.calls[0]!;
  assert.equal(call.table, "pitches");
  assert.ok(has(call, "is", "parent_pitch_id", null), "must exclude follow-up (child) pitches");
  assert.ok(has(call, "eq", "status", "sent"));
  assert.ok(has(call, "eq", "prospect_id", "p-ana"));
  assert.ok(has(call, "eq", "tenant_id", "t1"));
});

test("store.markProspectBooked never overwrites won / lost", async () => {
  const fake = recordingSupabase(() => ({ data: null, error: null }));
  await supabaseSyncStore(fake.client, "t1").markProspectBooked("p-ana");
  const call = fake.calls[0]!;
  assert.equal(call.table, "prospects");
  assert.ok(has(call, "update", { status: "booked" }));
  assert.ok(has(call, "not", "status", "in", "(won,lost)"));
  assert.ok(has(call, "eq", "tenant_id", "t1"));
});

test("store lookups throw on a DB error instead of answering 'no match'", async () => {
  const fake = recordingSupabase(() => ({ data: null, error: { message: "timeout" } }));
  const store = supabaseSyncStore(fake.client, "t1");
  await assert.rejects(store.findContact("ana@bakery.ca"), /contact lookup failed: timeout/);
  await assert.rejects(store.findCalendarOpportunity("e1"), /opportunity lookup failed: timeout/);
  const { counts, errors } = await apply([booking("e1", ["ana@bakery.ca"])], store);
  assert.equal(counts.unmatched, 0);
  assert.equal(errors.length, 1);
});

test("store.findContact escapes LIKE wildcards and only reads calendar opportunities", async () => {
  const fake = recordingSupabase(() => ({ data: null, error: null }));
  const store = supabaseSyncStore(fake.client, "t1");
  await store.findContact("a_b%c@x.ca");
  await store.findCalendarOpportunity("e1");
  assert.ok(has(fake.calls[0]!, "ilike", "email", "a\\_b\\%c@x.ca"));
  assert.ok(has(fake.calls[1]!, "eq", "source", "calendar"));
});

test("store.createOpportunity: unique violation → null (duplicate)", async () => {
  const fake = recordingSupabase(() => ({ data: null, error: { message: "dup", code: "23505" } }));
  const row = await supabaseSyncStore(fake.client, "t1").createOpportunity({ eventId: "e1", match: ANA, notes: "n" });
  assert.equal(row, null);
});

// ── Acceptance check 3: 403 → needsReconnect ─────────────────────────────────

const SCOPE_403 = JSON.stringify({
  error: { code: 403, message: "Request had insufficient authentication scopes.", errors: [{ reason: "insufficientPermissions" }] },
});

test("listRecentEvents: 403 insufficientPermissions → needsReconnect, no throw", async () => {
  const r = await listRecentEvents("tok", { fetchImpl: async () => new Response(SCOPE_403, { status: 403 }) });
  assert.deepEqual(r.ok, false);
  assert.equal(!r.ok && r.needsReconnect, true);
});

test("listRecentEvents: other 403 (quota) is an error, not a reconnect", async () => {
  const body = JSON.stringify({ error: { code: 403, errors: [{ reason: "rateLimitExceeded" }] } });
  const r = await listRecentEvents("tok", { fetchImpl: async () => new Response(body, { status: 403 }) });
  assert.equal(!r.ok && r.needsReconnect, false);
});

test("listRecentEvents: query window, flags and timeout signal", async () => {
  let seen: { url: string; init?: RequestInit } | null = null;
  const now = new Date("2026-10-17T12:00:00Z");
  const r = await listRecentEvents("tok", {
    now,
    fetchImpl: async (url, init) => {
      seen = { url: String(url), init };
      return Response.json({ items: [{ id: "e1", status: "confirmed" }, { nope: 1 }] });
    },
  });
  assert.ok(r.ok);
  assert.deepEqual(r.ok && r.events.map((e) => e.id), ["e1"]);
  assert.equal(r.ok && r.truncated, false);
  const u = new URL(seen!.url);
  assert.equal(u.searchParams.get("updatedMin"), "2026-10-15T12:00:00.000Z");
  assert.equal(u.searchParams.get("singleEvents"), "true");
  assert.equal(u.searchParams.get("showDeleted"), "true");
  assert.equal(u.searchParams.get("maxResults"), "100");
  assert.ok(seen!.init?.signal instanceof AbortSignal);
});

test("listRecentEvents: nextPageToken → truncated: true", async () => {
  const r = await listRecentEvents("tok", { fetchImpl: async () => Response.json({ items: [], nextPageToken: "abc" }) });
  assert.equal(r.ok && r.truncated, true);
});

test("listRecentEvents: network failure → error result, no throw", async () => {
  const r = await listRecentEvents("tok", { fetchImpl: async () => { throw new Error("timeout"); } });
  assert.equal(r.ok, false);
});

// ── syncCalendarWith ─────────────────────────────────────────────────────────

const INBOXES = [
  { email: INBOX, gmail_refresh_token_encrypted: "enc-henry", created_at: "2026-01-01" },
  { email: "Bookings@Runna.ca", gmail_refresh_token_encrypted: "enc-bookings", created_at: "2026-05-01" },
];

/** Answers sender_inboxes lookups like Postgres would: ilike filter, else oldest. */
function inboxSupabase(rows: typeof INBOXES) {
  return recordingSupabase((call) => {
    const ilike = call.ops.find(([o]) => o === "ilike");
    const want = ilike ? String(ilike[1][1]).replace(/\\/g, "").toLowerCase() : null;
    const hit = want ? rows.find((r) => r.email.toLowerCase() === want) : rows[0];
    return { data: hit ?? null, error: null };
  });
}

function fakeActor(supabase: unknown): Actor {
  return {
    user: { id: "u1", email: "a@runna.ca", fullName: "Autopilot", avatarUrl: null, role: "admin", tenantId: "t1", tenantDisplayName: "Rünna" },
    supabase: supabase as Actor["supabase"],
    system: true,
  };
}

function okDeps(over: Partial<Parameters<typeof syncCalendarWith>[1]> = {}) {
  const tokens: string[] = [];
  const audits: AuditPayload[] = [];
  const deps: Parameters<typeof syncCalendarWith>[1] = {
    getAccessToken: async (enc) => (tokens.push(enc), { ok: true, accessToken: "tok" }),
    listEvents: async () => ({ ok: true, events: [], truncated: false }),
    writeAuditLog: async (p) => {
      audits.push(p);
    },
    bookingInboxEmail: "",
    ...over,
  };
  return { deps, tokens, audits };
}

test("syncCalendarWith: scope 403 → needsReconnect report, no errors, store untouched", async () => {
  const m = memoryStore({ "ana@bakery.ca": ANA });
  const { deps } = okDeps({
    listEvents: (token) => listRecentEvents(token, { fetchImpl: async () => new Response(SCOPE_403, { status: 403 }) }),
    store: m.store,
  });
  const report = await syncCalendarWith(fakeActor(inboxSupabase(INBOXES).client), deps);
  assert.equal(report.needsReconnect, true);
  assert.deepEqual(report.errors, []);
  assert.equal(report.counts, null);
});

test("syncCalendarWith: no inbox with a token → empty report", async () => {
  const report = await syncCalendarWith(fakeActor(inboxSupabase([]).client), {
    getAccessToken: async () => assert.fail("no token without an inbox"),
    listEvents: async () => assert.fail("no list without an inbox"),
    writeAuditLog: async () => assert.fail("no audit without an inbox"),
  });
  assert.equal(report.inbox, null);
  assert.equal(report.counts, null);
});

test("syncCalendarWith: oldest inbox by default; paused is not filtered out", async () => {
  const fake = inboxSupabase(INBOXES);
  const { deps, tokens } = okDeps();
  const report = await syncCalendarWith(fakeActor(fake.client), deps);
  assert.equal(report.inbox, INBOX);
  assert.deepEqual(tokens, ["enc-henry"]);
  assert.ok(!fake.calls.some((c) => has(c, "eq", "paused", false)));
});

test("syncCalendarWith: CALENDAR_BOOKING_INBOX picks that inbox (case-insensitive); unknown falls back to oldest", async () => {
  const picked = okDeps({ bookingInboxEmail: "bookings@runna.ca" });
  const r1 = await syncCalendarWith(fakeActor(inboxSupabase(INBOXES).client), picked.deps);
  assert.equal(r1.inbox, "Bookings@Runna.ca");
  assert.deepEqual(picked.tokens, ["enc-bookings"]);

  const unknown = okDeps({ bookingInboxEmail: "nobody@runna.ca" });
  const r2 = await syncCalendarWith(fakeActor(inboxSupabase(INBOXES).client), unknown.deps);
  assert.equal(r2.inbox, INBOX);
});

test("syncCalendarWith: a booking writes the opportunity.booked audit as the actor; truncated is reported", async () => {
  const m = memoryStore({ "ana@bakery.ca": ANA });
  const { deps, audits } = okDeps({
    listEvents: async () => ({ ok: true, events: [booking("e1", ["ana@bakery.ca"])], truncated: true }),
    store: m.store,
  });
  const report = await syncCalendarWith(fakeActor(inboxSupabase(INBOXES).client), deps);
  assert.equal(report.counts?.created, 1);
  assert.equal(report.truncated, true);
  assert.equal(audits.length, 1);
  assert.equal(audits[0]?.action, "opportunity.booked");
  assert.equal(audits[0]?.entityType, "opportunity");
  assert.equal(audits[0]?.entityId, "opp-1");
  assert.equal(audits[0]?.actorId, "u1");
  assert.equal(audits[0]?.tenantId, "t1");
});

// ── Acceptance checks 2 + 3: the route handler ───────────────────────────────

const TOKEN = "scheduler-token-0123456789abcdef0123456789";

function routeDeps(report: Partial<CalendarSyncReport> = {}) {
  return {
    authorize: async (req: Request) => req.headers.get("authorization") === `Bearer ${TOKEN}`,
    tenantIds: async () => ["t1"],
    actorFor: async () => fakeActor({}),
    sync: async (): Promise<CalendarSyncReport> => ({
      tenantId: "t1",
      inbox: INBOX,
      needsReconnect: false,
      truncated: false,
      counts: null,
      errors: [],
      bookings: [],
      alerts: { sent: 0, failed: [] },
      ...report,
    }),
  };
}

const URL_ = "https://spam-runnareach.vercel.app/api/opportunities/calendar-sync";
const authed = () => new Request(URL_, { headers: { authorization: `Bearer ${TOKEN}` } });

test("route: 401 without the scheduler token", async () => {
  const res = await handleCalendarSync(new Request(URL_), routeDeps());
  assert.equal(res.status, 401);
  const wrong = await handleCalendarSync(new Request(URL_, { headers: { authorization: "Bearer nope" } }), routeDeps());
  assert.equal(wrong.status, 401);
});

test("route: 200 with the scheduler token, errors: [] convention", async () => {
  const res = await handleCalendarSync(authed(), routeDeps());
  assert.equal(res.status, 200);
  const body = (await res.json()) as { ok: boolean; errors: string[]; needsReconnect: boolean; truncated: number };
  assert.equal(body.ok, true);
  assert.deepEqual(body.errors, []);
  assert.equal(body.needsReconnect, false);
  assert.equal(body.truncated, 0);
});

test("route: a tenant needing reconnect → 200 with needsReconnect: true", async () => {
  const res = await handleCalendarSync(authed(), routeDeps({ needsReconnect: true }));
  assert.equal(res.status, 200);
  const body = (await res.json()) as { needsReconnect: boolean };
  assert.equal(body.needsReconnect, true);
});

test("route: truncated tenants are counted", async () => {
  const res = await handleCalendarSync(authed(), routeDeps({ truncated: true }));
  const body = (await res.json()) as { truncated: number };
  assert.equal(body.truncated, 1);
});

test("route: a throwing tenant sync is reported, not a 500", async () => {
  const deps = { ...routeDeps(), sync: async (): Promise<CalendarSyncReport> => { throw new Error("db down"); } };
  const res = await handleCalendarSync(authed(), deps);
  assert.equal(res.status, 200);
  const body = (await res.json()) as { errors: string[] };
  assert.deepEqual(body.errors, ["t1: db down"]);
});

// ── Acceptance check 4: migration 0044 ───────────────────────────────────────

test("migration 0044 has exactly one cron.schedule, for /api/opportunities/calendar-sync", () => {
  const sql = readFileSync(new URL("../supabase/migrations/0044_calendar_sync_cron.sql", import.meta.url), "utf8");
  const code = sql.split("\n").filter((l) => !l.trim().startsWith("--")).join("\n");
  const schedules = code.match(/cron\.schedule\(/g) ?? [];
  assert.equal(schedules.length, 1);
  assert.match(
    code,
    /select cron\.schedule\('spam-calendar-sync', '5 \* \* \* \*', \$job\$select public\.spam_cron_call\('\/api\/opportunities\/calendar-sync'\)\$job\$\);/,
  );
});

test("connect route appends calendar.readonly after the existing scopes", () => {
  const src = readFileSync(new URL("../app/api/auth/google/connect/route.ts", import.meta.url), "utf8");
  const scopes = [...src.matchAll(/"(https:\/\/www\.googleapis\.com\/auth\/[^"]+)"/g)].map((m) => m[1]);
  assert.deepEqual(scopes, [
    "https://www.googleapis.com/auth/gmail.send",
    "https://www.googleapis.com/auth/gmail.readonly",
    "https://www.googleapis.com/auth/gmail.modify",
    "https://www.googleapis.com/auth/postmaster.readonly",
    "https://www.googleapis.com/auth/calendar.readonly",
  ]);
});

// ── Booking alerts ───────────────────────────────────────────────────────────

test("applyCalendarEvents reports each booking and cancellation in `bookings`; duplicates add none", async () => {
  const m = memoryStore({ "ana@bakery.ca": ANA });
  const first = await apply([booking("e1", ["ana@bakery.ca"], { start: { dateTime: "2026-10-20T15:00:00-06:00", timeZone: "America/Mexico_City" } as CalendarEvent["start"] })], m.store);
  assert.deepEqual(first.bookings, [
    { kind: "booked", eventId: "e1", prospectId: "p-ana", attendee: "ana@bakery.ca", start: "2026-10-20T15:00:00-06:00", timeZone: "America/Mexico_City" },
  ]);
  const again = await apply([booking("e1", ["ana@bakery.ca"])], m.store);
  assert.deepEqual(again.bookings, []);
  assert.equal(again.counts.duplicate, 1);
  const cancel = await apply([booking("e1", ["ana@bakery.ca"], { status: "cancelled" })], m.store);
  assert.deepEqual(cancel.bookings, [
    { kind: "cancelled", eventId: "e1", prospectId: "p-ana", attendee: "ana@bakery.ca", start: "2026-10-20T15:00:00-06:00", timeZone: null },
  ]);
  const cancelAgain = await apply([booking("e1", ["ana@bakery.ca"], { status: "cancelled" })], m.store);
  assert.deepEqual(cancelAgain.bookings, []);
});

test("formatStart: event time zone when given, else UTC, always named; all-day dates", () => {
  assert.equal(formatStart("2026-10-20T15:00:00-06:00", "America/Mexico_City"), "Tue, Oct 20, 2026, 3:00 PM (America/Mexico_City)");
  assert.equal(formatStart("2026-10-20T15:00:00-06:00", null), "Tue, Oct 20, 2026, 9:00 PM (UTC)");
  assert.equal(formatStart("2026-10-20T15:00:00-06:00", "Not/AZone"), "Tue, Oct 20, 2026, 9:00 PM (UTC)");
  assert.equal(formatStart("2026-10-20", null), "2026-10-20 (all day)");
  assert.equal(formatStart(null, null), null);
});

test("formatBookingAlert: booked and cancelled subjects + body", () => {
  const booked = formatBookingAlert({
    kind: "booked", company: "Bakery Co", attendee: "ana@bakery.ca",
    start: "2026-10-20T15:00:00-06:00", timeZone: "America/Toronto", market: "CA",
  });
  assert.equal(booked.subject, "Meeting booked: Bakery Co (Tue, Oct 20, 2026, 5:00 PM (America/Toronto))");
  assert.match(booked.body, /Who: ana@bakery\.ca/);
  assert.match(booked.body, /Market: CA/);
  assert.match(booked.body, /\/opportunities$/);
  const cancelled = formatBookingAlert({ kind: "cancelled", company: null, attendee: "ana@bakery.ca", start: null, timeZone: null, market: null });
  assert.equal(cancelled.subject, "Booking cancelled: ana@bakery.ca");
  assert.match(cancelled.body, /marked lost/);
});

test("sendBookingAlerts: one lead email per change, company + market from one batch lookup", async () => {
  let lookups = 0;
  const m = memoryStore({}, {}, {}, { "p-ana": { company: "Bakery Co", market: "CA" } });
  const store: SyncStore = { ...m.store, prospectSummaries: async (ids) => (lookups++, m.store.prospectSummaries(ids)) };
  const sent: NotificationMessage[] = [];
  const res = await sendBookingAlerts(
    [
      { kind: "booked", eventId: "e1", prospectId: "p-ana", attendee: "ana@bakery.ca", start: "2026-10-20T15:00:00Z", timeZone: null },
      { kind: "cancelled", eventId: "e2", prospectId: "p-ana", attendee: null, start: null, timeZone: null },
    ],
    store,
    async (msg) => (sent.push(msg), { sent: 3, failed: [] }),
  );
  assert.equal(lookups, 1);
  assert.deepEqual(sent.map((s) => [s.kind, s.subject]), [
    ["lead", "Meeting booked: Bakery Co (Tue, Oct 20, 2026, 3:00 PM (UTC))"],
    ["lead", "Booking cancelled: Bakery Co"],
  ]);
  assert.deepEqual(res, { sent: 6, failed: [] });
});

test("sendBookingAlerts: lookup or send failures are reported, never thrown", async () => {
  const m = memoryStore({});
  const store: SyncStore = { ...m.store, prospectSummaries: async () => { throw new Error("prospect lookup failed: x"); } };
  const sent: NotificationMessage[] = [];
  const res = await sendBookingAlerts(
    [
      { kind: "booked", eventId: "e1", prospectId: "p1", attendee: "a@x.ca", start: null, timeZone: null },
      { kind: "booked", eventId: "e2", prospectId: "p2", attendee: "b@x.ca", start: null, timeZone: null },
    ],
    store,
    async (msg) => {
      if (msg.subject.includes("b@x.ca")) throw new Error("gmail down");
      sent.push(msg);
      return { sent: 3, failed: [] };
    },
  );
  assert.equal(sent.length, 1);
  assert.equal(sent[0]?.subject, "Meeting booked: a@x.ca (unknown time)");
  assert.deepEqual(res, { sent: 3, failed: ["prospect lookup failed: x", "event e2: gmail down"] });
});

test("syncCalendarWith: a booking sends one alert from the booking inbox; report carries bookings + alerts", async () => {
  const m = memoryStore({ "ana@bakery.ca": ANA }, {}, {}, { "p-ana": { company: "Bakery Co", market: "MX" } });
  const sent: Array<NotificationMessage & { fromEmail: string }> = [];
  const { deps } = okDeps({
    listEvents: async () => ({ ok: true, events: [booking("e1", ["ana@bakery.ca"])], truncated: false }),
    store: m.store,
    notify: async (msg) => (sent.push(msg), { sent: 3, failed: [] }),
  });
  const report = await syncCalendarWith(fakeActor(inboxSupabase(INBOXES).client), deps);
  assert.equal(sent.length, 1);
  assert.equal(sent[0]?.fromEmail, INBOX);
  assert.equal(sent[0]?.kind, "lead");
  assert.match(sent[0]?.body ?? "", /Market: MX/);
  assert.deepEqual(report.alerts, { sent: 3, failed: [] });
  assert.equal(report.bookings[0]?.company, "Bakery Co");
  assert.deepEqual(report.errors, []);

  // Next run: same event is a duplicate → no alert.
  const again = await syncCalendarWith(fakeActor(inboxSupabase(INBOXES).client), deps);
  assert.equal(sent.length, 1);
  assert.deepEqual(again.alerts, { sent: 0, failed: [] });
});

test("route: alerts are summed across tenants", async () => {
  const res = await handleCalendarSync(authed(), routeDeps({ alerts: { sent: 3, failed: ["x: nope"] } }));
  const body = (await res.json()) as { alerts: { sent: number; failed: string[] } };
  assert.deepEqual(body.alerts, { sent: 3, failed: ["x: nope"] });
});

test("store.prospectSummaries: one tenant-scoped query, empty input skips the query", async () => {
  const fake = recordingSupabase(() => ({ data: [{ id: "p1", company_name: "Bakery Co", market: "CA" }], error: null }));
  const store = supabaseSyncStore(fake.client, "t1");
  assert.equal((await store.prospectSummaries([])).size, 0);
  assert.equal(fake.calls.length, 0);
  const out = await store.prospectSummaries(["p1"]);
  assert.deepEqual(out.get("p1"), { company: "Bakery Co", market: "CA" });
  assert.equal(fake.calls.length, 1);
  assert.ok(has(fake.calls[0]!, "eq", "tenant_id", "t1"));
});
