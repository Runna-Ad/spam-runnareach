/**
 * Google Calendar booking sync: a booked meeting becomes an opportunity.
 *
 * Pedro puts a Google Calendar appointment-schedule link in front of
 * interested prospects. A booking is an event on the booking inbox's primary
 * calendar with the prospect as an attendee. Every hour (pg_cron, migration
 * 0044) this reads the last 48 hours of event changes and:
 *
 *   confirmed event, attendee is a known contact, no opportunity yet
 *       → opportunities row (source 'calendar', stage meeting_booked)
 *         + a meeting_booked pitch event on the prospect's latest sent pitch
 *   cancelled event whose calendar opportunity is still meeting_booked
 *       → stage lost, loss_reason "booking cancelled" + a lost pitch event
 *
 * Idempotent: one opportunity per (tenant, calendar_event_id), enforced by the
 * unique index from 0043; a race that loses the insert counts as a duplicate.
 * Our own inbox and test addresses are never matched. Manual opportunities
 * (source 'manual') are never read or written here.
 *
 * Booking inbox: there is no "primary inbox" flag, so it is the tenant's
 * oldest unpaused inbox with a Google refresh token.
 *
 * No server imports: the Google calls and the store come in as deps, so
 * tests/opportunities-calendar-sync.test.ts runs it in memory.
 */

import type { Actor } from "../actor.ts";
import type { AccessTokenResult } from "../gmail/client.ts";
import { isTestAddress, normalizeMailbox } from "../compliance/test-addresses.ts";
import { recordPitchEvent, type PitchEventType } from "../pitches/events.ts";
import type { CalendarEvent, ListEventsResult } from "./google-calendar.ts";

export const CANCELLED_LOSS_REASON = "booking cancelled";

// opportunities (source / calendar_event_id from 0043) and pitch_events aren't
// in the hand-written types.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnySupabase = any;

// ── Pure matching ─────────────────────────────────────────────────────────────

/**
 * Attendee addresses that could be the prospect, lower-cased, in attendee
 * order: not the booking inbox itself, not a test address, not a declined
 * attendee, no duplicates.
 */
export function bookingCandidates(event: CalendarEvent, inboxEmail: string): string[] {
  const own = normalizeMailbox(inboxEmail);
  const out: string[] = [];
  for (const a of event.attendees ?? []) {
    const email = a.email?.trim().toLowerCase();
    if (!email || !email.includes("@")) continue;
    if (a.self || normalizeMailbox(email) === own) continue;
    if (a.responseStatus === "declined") continue;
    if (isTestAddress(email)) continue;
    if (!out.includes(email)) out.push(email);
  }
  return out;
}

export type ContactMatch = { contactId: string; prospectId: string; email: string };

export type CalendarOpportunity = { id: string; stage: string; prospectId: string };

export type EventPlan =
  | { kind: "create"; match: ContactMatch }
  | { kind: "cancel"; opportunity: CalendarOpportunity }
  | { kind: "skip"; reason: "duplicate" | "unmatched" | "cancelled_untracked" | "cancelled_closed" };

/** What to do with one event, given what the database already holds. */
export function planEvent(
  event: CalendarEvent,
  existing: CalendarOpportunity | null,
  match: ContactMatch | null,
): EventPlan {
  if (event.status === "cancelled") {
    if (!existing) return { kind: "skip", reason: "cancelled_untracked" };
    if (existing.stage !== "meeting_booked") return { kind: "skip", reason: "cancelled_closed" };
    return { kind: "cancel", opportunity: existing };
  }
  if (existing) return { kind: "skip", reason: "duplicate" };
  if (!match) return { kind: "skip", reason: "unmatched" };
  return { kind: "create", match };
}

function eventStart(event: CalendarEvent): string | null {
  return event.start?.dateTime ?? event.start?.date ?? null;
}

// ── Store (Supabase, swappable in tests) ──────────────────────────────────────

export type SyncStore = {
  findContact(email: string): Promise<ContactMatch | null>;
  findCalendarOpportunity(eventId: string): Promise<CalendarOpportunity | null>;
  /** null when the (tenant, event id) row already exists (lost a race). */
  createOpportunity(input: {
    eventId: string;
    match: ContactMatch;
    notes: string;
  }): Promise<{ id: string } | null>;
  /** Only flips a calendar opportunity still at meeting_booked. */
  markCancelled(opportunityId: string): Promise<boolean>;
  latestSentPitchId(prospectId: string): Promise<string | null>;
  recordEvent(pitchId: string, type: PitchEventType, payload: Record<string, unknown>): Promise<void>;
};

function escapeLike(s: string): string {
  return s.replace(/[\\%_]/g, (c) => `\\${c}`);
}

export function supabaseSyncStore(supabase: AnySupabase, tenantId: string): SyncStore {
  return {
    async findContact(email) {
      const { data } = await supabase
        .from("prospect_contacts")
        .select("id, prospect_id, email")
        .eq("tenant_id", tenantId)
        .ilike("email", escapeLike(email))
        .order("priority_rank", { ascending: true })
        .limit(1)
        .maybeSingle();
      return data ? { contactId: data.id, prospectId: data.prospect_id, email } : null;
    },
    async findCalendarOpportunity(eventId) {
      const { data } = await supabase
        .from("opportunities")
        .select("id, stage, prospect_id")
        .eq("tenant_id", tenantId)
        .eq("source", "calendar")
        .eq("calendar_event_id", eventId)
        .maybeSingle();
      return data ? { id: data.id, stage: data.stage, prospectId: data.prospect_id } : null;
    },
    async createOpportunity({ eventId, match, notes }) {
      const { data, error } = await supabase
        .from("opportunities")
        .insert({
          tenant_id: tenantId,
          prospect_id: match.prospectId,
          contact_id: match.contactId,
          stage: "meeting_booked",
          source: "calendar",
          calendar_event_id: eventId,
          notes,
        })
        .select("id")
        .single();
      if (error) {
        if (error.code === "23505") return null;
        throw new Error(`opportunity insert failed: ${error.message}`);
      }
      return { id: data.id };
    },
    async markCancelled(opportunityId) {
      const { data, error } = await supabase
        .from("opportunities")
        .update({ stage: "lost", loss_reason: CANCELLED_LOSS_REASON, updated_at: new Date().toISOString() })
        .eq("id", opportunityId)
        .eq("tenant_id", tenantId)
        .eq("source", "calendar")
        .eq("stage", "meeting_booked")
        .select("id");
      if (error) throw new Error(`opportunity cancel failed: ${error.message}`);
      return Array.isArray(data) && data.length > 0;
    },
    async latestSentPitchId(prospectId) {
      const { data } = await supabase
        .from("pitches")
        .select("id")
        .eq("tenant_id", tenantId)
        .eq("prospect_id", prospectId)
        .not("sent_at", "is", null)
        .order("sent_at", { ascending: false })
        .limit(1)
        .maybeSingle();
      return data?.id ?? null;
    },
    async recordEvent(pitchId, type, payload) {
      await recordPitchEvent(supabase, { tenantId, pitchId, type, payload });
    },
  };
}

// ── Apply a batch of events ───────────────────────────────────────────────────

export type SyncCounts = {
  events: number;
  created: number;
  cancelled: number;
  duplicate: number;
  unmatched: number;
  pitchEvents: number;
};

export async function applyCalendarEvents(
  events: CalendarEvent[],
  inboxEmail: string,
  store: SyncStore,
): Promise<{ counts: SyncCounts; errors: string[] }> {
  const counts: SyncCounts = { events: events.length, created: 0, cancelled: 0, duplicate: 0, unmatched: 0, pitchEvents: 0 };
  const errors: string[] = [];
  const contactCache = new Map<string, ContactMatch | null>();

  for (const event of events) {
    try {
      const existing = await store.findCalendarOpportunity(event.id);

      // First candidate that is a known contact wins.
      let match: ContactMatch | null = null;
      if (event.status !== "cancelled" && !existing) {
        for (const email of bookingCandidates(event, inboxEmail)) {
          if (!contactCache.has(email)) contactCache.set(email, await store.findContact(email));
          match = contactCache.get(email) ?? null;
          if (match) break;
        }
      }

      const plan = planEvent(event, existing, match);
      if (plan.kind === "skip") {
        if (plan.reason === "duplicate") counts.duplicate++;
        if (plan.reason === "unmatched") counts.unmatched++;
        continue;
      }

      if (plan.kind === "create") {
        const start = eventStart(event);
        const notes = `Booked via Google Calendar${start ? ` for ${start}` : ""} by ${plan.match.email}.`;
        const row = await store.createOpportunity({ eventId: event.id, match: plan.match, notes });
        if (!row) {
          counts.duplicate++;
          continue;
        }
        counts.created++;
        const pitchId = await store.latestSentPitchId(plan.match.prospectId);
        if (pitchId) {
          await store.recordEvent(pitchId, "meeting_booked", {
            opportunity_id: row.id,
            calendar_event_id: event.id,
            attendee: plan.match.email,
            start,
          });
          counts.pitchEvents++;
        }
        continue;
      }

      // cancel
      if (!(await store.markCancelled(plan.opportunity.id))) continue;
      counts.cancelled++;
      const pitchId = await store.latestSentPitchId(plan.opportunity.prospectId);
      if (pitchId) {
        await store.recordEvent(pitchId, "lost", {
          opportunity_id: plan.opportunity.id,
          calendar_event_id: event.id,
          loss_reason: CANCELLED_LOSS_REASON,
        });
        counts.pitchEvents++;
      }
    } catch (err) {
      errors.push(`event ${event.id}: ${(err as Error).message}`);
    }
  }
  return { counts, errors };
}

// ── One tenant ────────────────────────────────────────────────────────────────

export type SyncDeps = {
  getAccessToken: (encryptedRefreshToken: string) => Promise<AccessTokenResult>;
  listEvents: (accessToken: string) => Promise<ListEventsResult>;
  /** Defaults to the Supabase store on actor.supabase. */
  store?: SyncStore;
};

export type CalendarSyncReport = {
  tenantId: string;
  inbox: string | null;
  needsReconnect: boolean;
  counts: SyncCounts | null;
  errors: string[];
};

export async function syncCalendarWith(actor: Actor, deps: SyncDeps): Promise<CalendarSyncReport> {
  const tenantId = actor.user.tenantId;
  const supabase = actor.supabase as AnySupabase;
  const report: CalendarSyncReport = { tenantId, inbox: null, needsReconnect: false, counts: null, errors: [] };

  const { data: inbox, error } = await supabase
    .from("sender_inboxes")
    .select("email, gmail_refresh_token_encrypted")
    .eq("tenant_id", tenantId)
    .eq("paused", false)
    .not("gmail_refresh_token_encrypted", "is", null)
    .order("created_at", { ascending: true })
    .limit(1)
    .maybeSingle();
  if (error) {
    report.errors.push(`inbox lookup failed: ${error.message}`);
    return report;
  }
  if (!inbox) return report;
  report.inbox = inbox.email;

  const token = await deps.getAccessToken(inbox.gmail_refresh_token_encrypted);
  if (!token.ok) {
    report.errors.push(`Google auth failed for ${inbox.email}: ${token.error}`);
    return report;
  }

  const listed = await deps.listEvents(token.accessToken);
  if (!listed.ok) {
    if (listed.needsReconnect) {
      report.needsReconnect = true;
      console.warn(`[calendar-sync] ${inbox.email}: calendar.readonly not granted; reconnect Google for this inbox.`);
    } else {
      report.errors.push(listed.error);
    }
    return report;
  }

  const store = deps.store ?? supabaseSyncStore(supabase, tenantId);
  const { counts, errors } = await applyCalendarEvents(listed.events, inbox.email, store);
  report.counts = counts;
  report.errors.push(...errors);
  return report;
}

// ── Route handler (wired in app/api/opportunities/calendar-sync/route.ts) ────

export type CalendarSyncRouteDeps = {
  authorize: (req: Request) => Promise<boolean>;
  /** Tenants that have a connected, unpaused inbox. */
  tenantIds: () => Promise<string[]>;
  actorFor: (tenantId: string) => Promise<Actor | null>;
  sync: (actor: Actor) => Promise<CalendarSyncReport>;
};

export async function handleCalendarSync(req: Request, deps: CalendarSyncRouteDeps): Promise<Response> {
  if (!(await deps.authorize(req))) {
    return Response.json({ ok: false, error: "Unauthorized" }, { status: 401 });
  }

  const reports: CalendarSyncReport[] = [];
  const errors: string[] = [];
  let tenants: string[];
  try {
    tenants = await deps.tenantIds();
  } catch (err) {
    return Response.json({ ok: false, error: (err as Error).message }, { status: 500 });
  }

  for (const tenantId of tenants) {
    try {
      const actor = await deps.actorFor(tenantId);
      if (!actor) continue;
      const report = await deps.sync(actor);
      reports.push(report);
      errors.push(...report.errors.map((e) => `${tenantId}: ${e}`));
    } catch (err) {
      errors.push(`${tenantId}: ${(err as Error).message}`);
    }
  }

  return Response.json({
    ok: true,
    needsReconnect: reports.some((r) => r.needsReconnect),
    reports,
    errors,
  });
}
