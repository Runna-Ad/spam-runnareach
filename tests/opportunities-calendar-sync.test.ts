/**
 * Google Calendar booking sync: matcher, idempotency, cancellation, route auth,
 * the 403-scope path, and migration 0044.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import type { Actor } from "../lib/actor.ts";
import {
  CANCELLED_LOSS_REASON,
  applyCalendarEvents,
  bookingCandidates,
  handleCalendarSync,
  planEvent,
  syncCalendarWith,
  type CalendarOpportunity,
  type CalendarSyncReport,
  type ContactMatch,
  type SyncStore,
} from "../lib/opportunities/calendar-sync.ts";
import { listRecentEvents, type CalendarEvent } from "../lib/opportunities/google-calendar.ts";
import type { PitchEventType } from "../lib/pitches/events.ts";

const INBOX = "henry@runna.ca";

function booking(id: string, attendees: string[], over: Partial<CalendarEvent> = {}): CalendarEvent {
  return {
    id,
    status: "confirmed",
    summary: "Rünna intro call",
    start: { dateTime: "2026-10-20T15:00:00-06:00" },
    attendees: [{ email: INBOX, self: true, organizer: true }, ...attendees.map((email) => ({ email }))],
    ...over,
  };
}

type Opp = { id: string; eventId: string | null; source: "manual" | "calendar"; stage: string; prospectId: string; lossReason: string | null };

/** In-memory store with the same constraints as the table (unique event id per tenant). */
function memoryStore(contacts: Record<string, ContactMatch>, sentPitch: Record<string, string> = {}) {
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
    async latestSentPitchId(prospectId) {
      return sentPitch[prospectId] ?? null;
    },
    async recordEvent(pitchId, type, payload) {
      pitchEvents.push({ pitchId, type, payload });
    },
  };
  return { store, opps, pitchEvents };
}

const ANA: ContactMatch = { contactId: "c-ana", prospectId: "p-ana", email: "ana@bakery.ca" };

// ── Pure matcher ─────────────────────────────────────────────────────────────

test("bookingCandidates drops the inbox itself, test addresses, declined, duplicates; lower-cases", () => {
  const ev = booking("e1", ["Ana@Bakery.ca", "pedro.jr22+demo@gmail.com", "ana@bakery.ca", "henry@RUNNA.ca"]);
  ev.attendees?.push({ email: "bob@x.ca", responseStatus: "declined" });
  assert.deepEqual(bookingCandidates(ev, INBOX), ["ana@bakery.ca"]);
});

test("planEvent: create / duplicate / unmatched / cancel / cancelled untracked / cancelled closed", () => {
  const ev = booking("e1", ["ana@bakery.ca"]);
  const open: CalendarOpportunity = { id: "o1", stage: "meeting_booked", prospectId: "p-ana" };
  assert.deepEqual(planEvent(ev, null, ANA), { kind: "create", match: ANA });
  assert.deepEqual(planEvent(ev, open, ANA), { kind: "skip", reason: "duplicate" });
  assert.deepEqual(planEvent(ev, null, null), { kind: "skip", reason: "unmatched" });
  const cancelled = { ...ev, status: "cancelled" };
  assert.deepEqual(planEvent(cancelled, open, null), { kind: "cancel", opportunity: open });
  assert.deepEqual(planEvent(cancelled, null, null), { kind: "skip", reason: "cancelled_untracked" });
  assert.deepEqual(planEvent(cancelled, { ...open, stage: "won" }, null), { kind: "skip", reason: "cancelled_closed" });
});

// ── Acceptance check 1 ───────────────────────────────────────────────────────

test("an attendee matching a contact → one opportunity + meeting_booked on the latest sent pitch", async () => {
  const m = memoryStore({ "ana@bakery.ca": ANA }, { "p-ana": "pitch-9" });
  const { counts, errors } = await applyCalendarEvents([booking("e1", ["ana@bakery.ca"])], INBOX, m.store);
  assert.deepEqual(errors, []);
  assert.equal(counts.created, 1);
  assert.equal(m.opps.length, 1);
  assert.equal(m.opps[0]?.stage, "meeting_booked");
  assert.equal(m.pitchEvents.length, 1);
  assert.equal(m.pitchEvents[0]?.pitchId, "pitch-9");
  assert.equal(m.pitchEvents[0]?.type, "meeting_booked");
});

test("no sent pitch → opportunity still created, pitch event skipped", async () => {
  const m = memoryStore({ "ana@bakery.ca": ANA });
  const { counts } = await applyCalendarEvents([booking("e1", ["ana@bakery.ca"])], INBOX, m.store);
  assert.equal(counts.created, 1);
  assert.equal(m.pitchEvents.length, 0);
});

test("the inbox's own address and a test address never match, even if stored as contacts", async () => {
  const m = memoryStore({
    [INBOX]: { contactId: "c-own", prospectId: "p-own", email: INBOX },
    "pedrojr22@gmail.com": { contactId: "c-test", prospectId: "p-test", email: "pedrojr22@gmail.com" },
  });
  const { counts } = await applyCalendarEvents([booking("e1", ["pedrojr22@gmail.com"])], INBOX, m.store);
  assert.equal(counts.created, 0);
  assert.equal(counts.unmatched, 1);
  assert.equal(m.opps.length, 0);
});

test("first matching attendee wins", async () => {
  const BOB: ContactMatch = { contactId: "c-bob", prospectId: "p-bob", email: "bob@gym.ca" };
  const m = memoryStore({ "ana@bakery.ca": ANA, "bob@gym.ca": BOB });
  await applyCalendarEvents([booking("e1", ["stranger@nowhere.ca", "bob@gym.ca", "ana@bakery.ca"])], INBOX, m.store);
  assert.equal(m.opps.length, 1);
  assert.equal(m.opps[0]?.prospectId, "p-bob");
});

test("the same event id twice (same run and next run) → one opportunity", async () => {
  const m = memoryStore({ "ana@bakery.ca": ANA }, { "p-ana": "pitch-9" });
  const ev = booking("e1", ["ana@bakery.ca"]);
  const first = await applyCalendarEvents([ev, ev], INBOX, m.store);
  const second = await applyCalendarEvents([ev], INBOX, m.store);
  assert.equal(m.opps.length, 1);
  assert.equal(m.pitchEvents.length, 1);
  assert.equal(first.counts.duplicate, 1);
  assert.equal(second.counts.duplicate, 1);
});

test("a lost insert race (unique index) counts as duplicate, no pitch event", async () => {
  const m = memoryStore({ "ana@bakery.ca": ANA }, { "p-ana": "pitch-9" });
  const racing: SyncStore = { ...m.store, findCalendarOpportunity: async () => null, createOpportunity: async () => null };
  const { counts } = await applyCalendarEvents([booking("e1", ["ana@bakery.ca"])], INBOX, racing);
  assert.equal(counts.created, 0);
  assert.equal(counts.duplicate, 1);
  assert.equal(m.pitchEvents.length, 0);
});

test("a cancelled event for an existing meeting_booked opportunity → lost, 'booking cancelled'", async () => {
  const m = memoryStore({ "ana@bakery.ca": ANA }, { "p-ana": "pitch-9" });
  await applyCalendarEvents([booking("e1", ["ana@bakery.ca"])], INBOX, m.store);
  // Google sends a cancelled booking with little more than its id.
  const { counts } = await applyCalendarEvents([{ id: "e1", status: "cancelled" }], INBOX, m.store);
  assert.equal(counts.cancelled, 1);
  assert.equal(m.opps[0]?.stage, "lost");
  assert.equal(m.opps[0]?.lossReason, "booking cancelled");
  assert.deepEqual(m.pitchEvents.map((e) => e.type), ["meeting_booked", "lost"]);
  // Seeing the cancellation again changes nothing.
  await applyCalendarEvents([{ id: "e1", status: "cancelled" }], INBOX, m.store);
  assert.equal(m.pitchEvents.length, 2);
});

test("a cancelled event with no opportunity → nothing", async () => {
  const m = memoryStore({ "ana@bakery.ca": ANA }, { "p-ana": "pitch-9" });
  const { counts } = await applyCalendarEvents([{ ...booking("e9", ["ana@bakery.ca"]), status: "cancelled" }], INBOX, m.store);
  assert.equal(counts.created + counts.cancelled, 0);
  assert.equal(m.opps.length, 0);
  assert.equal(m.pitchEvents.length, 0);
});

test("manual opportunities are never touched, even with a matching event id", async () => {
  const m = memoryStore({ "ana@bakery.ca": ANA });
  m.opps.push({ id: "manual-1", eventId: "e1", source: "manual", stage: "meeting_booked", prospectId: "p-ana", lossReason: null });
  await applyCalendarEvents([{ id: "e1", status: "cancelled" }], INBOX, m.store);
  assert.equal(m.opps[0]?.stage, "meeting_booked");
});

test("one failing event is reported and the rest still sync", async () => {
  const m = memoryStore({ "ana@bakery.ca": ANA });
  const flaky: SyncStore = {
    ...m.store,
    findCalendarOpportunity: async (id) => {
      if (id === "bad") throw new Error("boom");
      return m.store.findCalendarOpportunity(id);
    },
  };
  const { counts, errors } = await applyCalendarEvents([booking("bad", []), booking("e1", ["ana@bakery.ca"])], INBOX, flaky);
  assert.equal(counts.created, 1);
  assert.deepEqual(errors, ["event bad: boom"]);
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
  const u = new URL(seen!.url);
  assert.equal(u.searchParams.get("updatedMin"), "2026-10-15T12:00:00.000Z");
  assert.equal(u.searchParams.get("singleEvents"), "true");
  assert.equal(u.searchParams.get("showDeleted"), "true");
  assert.equal(u.searchParams.get("maxResults"), "100");
  assert.ok(seen!.init?.signal instanceof AbortSignal);
});

test("listRecentEvents: network failure → error result, no throw", async () => {
  const r = await listRecentEvents("tok", { fetchImpl: async () => { throw new Error("timeout"); } });
  assert.equal(r.ok, false);
});

/** Minimal fake Supabase for the inbox lookup in syncCalendarWith. */
function inboxSupabase(row: { email: string; gmail_refresh_token_encrypted: string } | null) {
  const chain = {
    select: () => chain,
    eq: () => chain,
    not: () => chain,
    order: () => chain,
    limit: () => chain,
    maybeSingle: async () => ({ data: row, error: null }),
  };
  return { from: () => chain };
}

function fakeActor(supabase: unknown): Actor {
  return {
    user: { id: "u1", email: "a@runna.ca", fullName: "Autopilot", avatarUrl: null, role: "admin", tenantId: "t1", tenantDisplayName: "Rünna" },
    supabase: supabase as Actor["supabase"],
    system: true,
  };
}

test("syncCalendarWith: scope 403 → needsReconnect report, no errors, store untouched", async () => {
  const m = memoryStore({ "ana@bakery.ca": ANA });
  const actor = fakeActor(inboxSupabase({ email: INBOX, gmail_refresh_token_encrypted: "enc" }));
  const report = await syncCalendarWith(actor, {
    getAccessToken: async () => ({ ok: true, accessToken: "tok" }),
    listEvents: (token) => listRecentEvents(token, { fetchImpl: async () => new Response(SCOPE_403, { status: 403 }) }),
    store: m.store,
  });
  assert.equal(report.needsReconnect, true);
  assert.deepEqual(report.errors, []);
  assert.equal(report.counts, null);
});

test("syncCalendarWith: no connected inbox → empty report", async () => {
  const report = await syncCalendarWith(fakeActor(inboxSupabase(null)), {
    getAccessToken: async () => assert.fail("no token without an inbox"),
    listEvents: async () => assert.fail("no list without an inbox"),
  });
  assert.equal(report.inbox, null);
  assert.equal(report.counts, null);
});

test("syncCalendarWith: happy path applies events on the booking inbox", async () => {
  const m = memoryStore({ "ana@bakery.ca": ANA });
  const report = await syncCalendarWith(fakeActor(inboxSupabase({ email: INBOX, gmail_refresh_token_encrypted: "enc" })), {
    getAccessToken: async () => ({ ok: true, accessToken: "tok" }),
    listEvents: async () => ({ ok: true, events: [booking("e1", ["ana@bakery.ca"])] }),
    store: m.store,
  });
  assert.equal(report.inbox, INBOX);
  assert.equal(report.counts?.created, 1);
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
      counts: null,
      errors: [],
      ...report,
    }),
  };
}

const URL_ = "https://spam-runnareach.vercel.app/api/opportunities/calendar-sync";

test("route: 401 without the scheduler token", async () => {
  const res = await handleCalendarSync(new Request(URL_), routeDeps());
  assert.equal(res.status, 401);
  const wrong = await handleCalendarSync(new Request(URL_, { headers: { authorization: "Bearer nope" } }), routeDeps());
  assert.equal(wrong.status, 401);
});

test("route: 200 with the scheduler token, errors: [] convention", async () => {
  const res = await handleCalendarSync(new Request(URL_, { headers: { authorization: `Bearer ${TOKEN}` } }), routeDeps());
  assert.equal(res.status, 200);
  const body = (await res.json()) as { ok: boolean; errors: string[]; needsReconnect: boolean };
  assert.equal(body.ok, true);
  assert.deepEqual(body.errors, []);
  assert.equal(body.needsReconnect, false);
});

test("route: a tenant needing reconnect → 200 with needsReconnect: true", async () => {
  const res = await handleCalendarSync(
    new Request(URL_, { headers: { authorization: `Bearer ${TOKEN}` } }),
    routeDeps({ needsReconnect: true }),
  );
  assert.equal(res.status, 200);
  const body = (await res.json()) as { needsReconnect: boolean };
  assert.equal(body.needsReconnect, true);
});

test("route: a throwing tenant sync is reported, not a 500", async () => {
  const deps = { ...routeDeps(), sync: async (): Promise<CalendarSyncReport> => { throw new Error("db down"); } };
  const res = await handleCalendarSync(new Request(URL_, { headers: { authorization: `Bearer ${TOKEN}` } }), deps);
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
