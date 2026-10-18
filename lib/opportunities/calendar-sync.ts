/**
 * Google Calendar booking sync: a booked meeting becomes an opportunity.
 *
 * Pedro puts a Google Calendar appointment-schedule link in front of
 * interested prospects. A booking is an event on the booking inbox's primary
 * calendar with the prospect as an attendee. Every hour (pg_cron, migration
 * 0044) this reads the last 48 hours of event changes and:
 *
 *   confirmed event WE organize, a non-declined attendee is a known contact,
 *   no opportunity yet
 *       → prospects.status 'booked' (unless already won / lost), so the
 *         follow-up route stops; opportunities row (source 'calendar', stage
 *         meeting_booked); audit "opportunity.booked"; a meeting_booked pitch
 *         event on the prospect's ROOT sent pitch
 *   cancelled event whose calendar opportunity is still meeting_booked
 *       → stage lost, loss_reason "booking cancelled" + a lost pitch event
 *         (prospects.status is left as it is)
 *
 * Every booking and cancellation applied in a run sends one lead alert
 * (lib/opportunities/booking-alert.ts) after the batch; idempotency above
 * means an event alerts once. An alert failure never fails the sync.
 *
 * Events someone else organizes (a vendor invite, a prospect's own meeting)
 * are skipped: only our own calendar's bookings count.
 *
 * Idempotent: one opportunity per (tenant, calendar_event_id), enforced by the
 * unique index from 0043; a race that loses the insert counts as a duplicate.
 * Our own inbox and test addresses are never matched. Manual opportunities
 * (source 'manual') are never read or written here.
 *
 * Booking inbox: env CALENDAR_BOOKING_INBOX if it names one of the tenant's
 * inboxes, else the tenant's oldest inbox with a Google refresh token. Paused
 * or not: pausing is a sending state, the calendar still belongs to the inbox.
 *
 * No server imports: the Google calls, the audit writer and the store come in
 * as deps, so tests/opportunities-calendar-sync.test.ts runs it in memory.
 */

import type { Actor } from "../actor.ts";
import type { AuditPayload } from "../audit/log.ts";
import type { AccessTokenResult } from "../gmail/client.ts";
import type { NotificationMessage, NotificationResult } from "../notify/send.ts";
import { isTestAddress, normalizeMailbox } from "../compliance/test-addresses.ts";
import { recordPitchEvent, type PitchEventType } from "../pitches/events.ts";
import { latestRootSentPitchId } from "../pitches/root-pitch.ts";
import { formatBookingAlert } from "./booking-alert.ts";
import type { CalendarEvent, ListEventsResult } from "./google-calendar.ts";

export const CANCELLED_LOSS_REASON = "booking cancelled";

// opportunities (source / calendar_event_id from 0043) and pitch_events aren't
// in the hand-written types.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnySupabase = any;

// ── Pure matching ─────────────────────────────────────────────────────────────

/** Did the booking inbox organize this event (appointment schedules: always)? */
export function organizedByInbox(event: CalendarEvent, inboxEmail: string): boolean {
  const org = event.organizer;
  if (!org) return false;
  if (org.self === true) return true;
  return !!org.email && normalizeMailbox(org.email) === normalizeMailbox(inboxEmail);
}

/**
 * Attendee addresses that could be the prospect, lower-cased, in attendee
 * order: not the booking inbox itself, not a test address, not a declined
 * attendee (accepted, tentative, needsAction and optional attendees count),
 * no duplicates.
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
  | { kind: "skip"; reason: "duplicate" | "unmatched" | "not_ours" | "cancelled_untracked" | "cancelled_closed" };

/** What to do with one event, given what the database already holds. */
export function planEvent(
  event: CalendarEvent,
  existing: CalendarOpportunity | null,
  match: ContactMatch | null,
  ours: boolean,
): EventPlan {
  if (event.status === "cancelled") {
    if (!existing) return { kind: "skip", reason: "cancelled_untracked" };
    if (existing.stage !== "meeting_booked") return { kind: "skip", reason: "cancelled_closed" };
    return { kind: "cancel", opportunity: existing };
  }
  if (existing) return { kind: "skip", reason: "duplicate" };
  if (!ours) return { kind: "skip", reason: "not_ours" };
  if (!match) return { kind: "skip", reason: "unmatched" };
  return { kind: "create", match };
}

function eventStart(event: CalendarEvent): string | null {
  return event.start?.dateTime ?? event.start?.date ?? null;
}

/** Google sends start.timeZone on events; the shared type does not declare it. */
function eventTimeZone(event: CalendarEvent): string | null {
  const tz = (event.start as { timeZone?: unknown } | undefined)?.timeZone;
  return typeof tz === "string" && tz.trim() ? tz.trim() : null;
}

// ── Store (Supabase, swappable in tests) ──────────────────────────────────────

export type SyncStore = {
  findContact(email: string): Promise<ContactMatch | null>;
  findCalendarOpportunity(eventId: string): Promise<CalendarOpportunity | null>;
  /** prospects.status → 'booked' unless it is already won or lost. */
  markProspectBooked(prospectId: string): Promise<void>;
  /** null when the (tenant, event id) row already exists (lost a race). */
  createOpportunity(input: {
    eventId: string;
    match: ContactMatch;
    notes: string;
  }): Promise<{ id: string } | null>;
  /** Only flips a calendar opportunity still at meeting_booked. */
  markCancelled(opportunityId: string): Promise<boolean>;
  /** The prospect's ROOT sent pitch (lib/pitches/root-pitch.ts). */
  rootSentPitchId(prospectId: string): Promise<string | null>;
  recordEvent(pitchId: string, type: PitchEventType, payload: Record<string, unknown>): Promise<void>;
  /** Company name + market per prospect id, one query for the batch. */
  prospectSummaries(prospectIds: string[]): Promise<Map<string, ProspectSummary>>;
};

export type ProspectSummary = { company: string | null; market: string | null };

export function escapeLike(s: string): string {
  return s.replace(/[\\%_]/g, (c) => `\\${c}`);
}

export function supabaseSyncStore(supabase: AnySupabase, tenantId: string): SyncStore {
  return {
    async findContact(email) {
      const { data, error } = await supabase
        .from("prospect_contacts")
        .select("id, prospect_id, email")
        .eq("tenant_id", tenantId)
        .ilike("email", escapeLike(email))
        .order("priority_rank", { ascending: true })
        .limit(1)
        .maybeSingle();
      if (error) throw new Error(`contact lookup failed: ${error.message}`);
      return data ? { contactId: data.id, prospectId: data.prospect_id, email } : null;
    },
    async findCalendarOpportunity(eventId) {
      const { data, error } = await supabase
        .from("opportunities")
        .select("id, stage, prospect_id")
        .eq("tenant_id", tenantId)
        .eq("source", "calendar")
        .eq("calendar_event_id", eventId)
        .maybeSingle();
      if (error) throw new Error(`opportunity lookup failed: ${error.message}`);
      return data ? { id: data.id, stage: data.stage, prospectId: data.prospect_id } : null;
    },
    async markProspectBooked(prospectId) {
      const { error } = await supabase
        .from("prospects")
        .update({ status: "booked" })
        .eq("id", prospectId)
        .eq("tenant_id", tenantId)
        .not("status", "in", "(won,lost)");
      if (error) throw new Error(`prospect status update failed: ${error.message}`);
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
    rootSentPitchId(prospectId) {
      return latestRootSentPitchId(supabase, { tenantId, prospectId });
    },
    async recordEvent(pitchId, type, payload) {
      await recordPitchEvent(supabase, { tenantId, pitchId, type, payload });
    },
    async prospectSummaries(prospectIds) {
      const out = new Map<string, ProspectSummary>();
      if (prospectIds.length === 0) return out;
      const { data, error } = await supabase
        .from("prospects")
        .select("id, company_name, market")
        .eq("tenant_id", tenantId)
        .in("id", prospectIds);
      if (error) throw new Error(`prospect lookup failed: ${error.message}`);
      for (const r of (data ?? []) as Array<{ id: string; company_name: string | null; market: string | null }>) {
        out.set(r.id, { company: r.company_name, market: r.market });
      }
      return out;
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
  /** Confirmed events the booking inbox does not organize (skipped_not_ours). */
  skippedNotOurs: number;
  pitchEvents: number;
};

/** A booking or cancellation the sync applied (one lead alert each). */
export type BookingChange = {
  kind: "booked" | "cancelled";
  eventId: string;
  prospectId: string;
  attendee: string | null;
  start: string | null;
  timeZone: string | null;
  company?: string | null;
  market?: string | null;
};

/** Called once per opportunity the sync creates. */
export type BookedAudit = (opportunityId: string, metadata: Record<string, unknown>) => Promise<void>;

export async function applyCalendarEvents(
  events: CalendarEvent[],
  inboxEmail: string,
  store: SyncStore,
  audit: BookedAudit,
): Promise<{ counts: SyncCounts; errors: string[]; bookings: BookingChange[] }> {
  const counts: SyncCounts = {
    events: events.length, created: 0, cancelled: 0, duplicate: 0, unmatched: 0, skippedNotOurs: 0, pitchEvents: 0,
  };
  const errors: string[] = [];
  const bookings: BookingChange[] = [];
  const contactCache = new Map<string, ContactMatch | null>();

  for (const event of events) {
    try {
      const existing = await store.findCalendarOpportunity(event.id);
      const ours = organizedByInbox(event, inboxEmail);

      // First candidate that is a known contact wins.
      let match: ContactMatch | null = null;
      if (event.status !== "cancelled" && !existing && ours) {
        for (const email of bookingCandidates(event, inboxEmail)) {
          if (!contactCache.has(email)) contactCache.set(email, await store.findContact(email));
          match = contactCache.get(email) ?? null;
          if (match) break;
        }
      }

      const plan = planEvent(event, existing, match, ours);
      if (plan.kind === "skip") {
        if (plan.reason === "duplicate") counts.duplicate++;
        if (plan.reason === "unmatched") counts.unmatched++;
        if (plan.reason === "not_ours") counts.skippedNotOurs++;
        continue;
      }

      if (plan.kind === "create") {
        const start = eventStart(event);
        // Status first: idempotent, and if it fails no opportunity exists yet,
        // so the next run retries both (the follow-up route stops on 'booked').
        await store.markProspectBooked(plan.match.prospectId);
        const notes = `Booked via Google Calendar${start ? ` for ${start}` : ""} by ${plan.match.email}.`;
        const row = await store.createOpportunity({ eventId: event.id, match: plan.match, notes });
        if (!row) {
          counts.duplicate++;
          continue;
        }
        counts.created++;
        bookings.push({
          kind: "booked", eventId: event.id, prospectId: plan.match.prospectId,
          attendee: plan.match.email, start, timeZone: eventTimeZone(event),
        });
        await audit(row.id, { calendar_event_id: event.id, prospect_id: plan.match.prospectId, attendee: plan.match.email, start });
        const pitchId = await store.rootSentPitchId(plan.match.prospectId);
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
      bookings.push({
        kind: "cancelled", eventId: event.id, prospectId: plan.opportunity.prospectId,
        attendee: bookingCandidates(event, inboxEmail)[0] ?? null, start: eventStart(event), timeZone: eventTimeZone(event),
      });
      const pitchId = await store.rootSentPitchId(plan.opportunity.prospectId);
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
  return { counts, errors, bookings };
}

/**
 * One lead alert per booking change, company + market from one prospect
 * query. Fills company/market into `bookings`. Never throws.
 */
export async function sendBookingAlerts(
  bookings: BookingChange[],
  store: SyncStore,
  notify: (message: NotificationMessage) => Promise<NotificationResult>,
): Promise<NotificationResult> {
  const result: NotificationResult = { sent: 0, failed: [] };
  if (bookings.length === 0) return result;
  let summaries = new Map<string, ProspectSummary>();
  try {
    summaries = await store.prospectSummaries([...new Set(bookings.map((b) => b.prospectId))]);
  } catch (err) {
    // Still alert, without the company name.
    result.failed.push((err as Error).message);
  }
  for (const b of bookings) {
    const s = summaries.get(b.prospectId);
    b.company = s?.company ?? null;
    b.market = s?.market ?? null;
    try {
      const alert = formatBookingAlert({ ...b, company: b.company, market: b.market });
      const res = await notify({ kind: "lead", fromName: "S.P.A.M Bookings", ...alert });
      result.sent += res.sent;
      result.failed.push(...res.failed);
    } catch (err) {
      result.failed.push(`event ${b.eventId}: ${(err as Error).message}`);
    }
  }
  return result;
}

// ── One tenant ────────────────────────────────────────────────────────────────

export type SyncDeps = {
  getAccessToken: (encryptedRefreshToken: string) => Promise<AccessTokenResult>;
  listEvents: (accessToken: string) => Promise<ListEventsResult>;
  writeAuditLog: (p: AuditPayload) => Promise<void>;
  /** Defaults to env CALENDAR_BOOKING_INBOX. */
  bookingInboxEmail?: string;
  /** Defaults to the Supabase store on actor.supabase. */
  store?: SyncStore;
  /** Sends a lead alert from the booking inbox; no alerts when absent. */
  notify?: (message: NotificationMessage & { fromEmail: string }) => Promise<NotificationResult>;
};

export type CalendarSyncReport = {
  tenantId: string;
  inbox: string | null;
  needsReconnect: boolean;
  /** Google had more than one page of changes; only the first was read. */
  truncated: boolean;
  counts: SyncCounts | null;
  errors: string[];
  bookings: BookingChange[];
  alerts: NotificationResult;
};

type InboxRow = { email: string; gmail_refresh_token_encrypted: string };

async function bookingInbox(
  supabase: AnySupabase,
  tenantId: string,
  preferred: string | undefined,
): Promise<{ inbox: InboxRow | null; error: string | null }> {
  const base = () =>
    supabase
      .from("sender_inboxes")
      .select("email, gmail_refresh_token_encrypted")
      .eq("tenant_id", tenantId)
      .not("gmail_refresh_token_encrypted", "is", null);
  if (preferred) {
    const { data, error } = await base().ilike("email", escapeLike(preferred)).limit(1).maybeSingle();
    if (error) return { inbox: null, error: `inbox lookup failed: ${error.message}` };
    if (data) return { inbox: data as InboxRow, error: null };
  }
  const { data, error } = await base().order("created_at", { ascending: true }).limit(1).maybeSingle();
  if (error) return { inbox: null, error: `inbox lookup failed: ${error.message}` };
  return { inbox: (data as InboxRow | null) ?? null, error: null };
}

export async function syncCalendarWith(actor: Actor, deps: SyncDeps): Promise<CalendarSyncReport> {
  const tenantId = actor.user.tenantId;
  const supabase = actor.supabase as AnySupabase;
  const report: CalendarSyncReport = { tenantId, inbox: null, needsReconnect: false, truncated: false, counts: null, errors: [],
    bookings: [], alerts: { sent: 0, failed: [] },
  };

  const preferred = (deps.bookingInboxEmail ?? process.env.CALENDAR_BOOKING_INBOX)?.trim() || undefined;
  const { inbox, error } = await bookingInbox(supabase, tenantId, preferred);
  if (error) {
    report.errors.push(error);
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
  report.truncated = listed.truncated;

  const store = deps.store ?? supabaseSyncStore(supabase, tenantId);
  const audit: BookedAudit = (opportunityId, metadata) =>
    deps.writeAuditLog({
      tenantId,
      actorId: actor.user.id,
      action: "opportunity.booked",
      entityType: "opportunity",
      entityId: opportunityId,
      metadata,
    });
  const { counts, errors, bookings } = await applyCalendarEvents(listed.events, inbox.email, store, audit);
  report.counts = counts;
  report.errors.push(...errors);
  report.bookings = bookings;
  const notify = deps.notify;
  if (notify) {
    const fromEmail = inbox.email;
    report.alerts = await sendBookingAlerts(bookings, store, (m) => notify({ ...m, fromEmail }));
  }
  return report;
}

// ── Route handler (wired in app/api/opportunities/calendar-sync/route.ts) ────

export type CalendarSyncRouteDeps = {
  authorize: (req: Request) => Promise<boolean>;
  /** Tenants that have an inbox with a Google refresh token. */
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
    alerts: {
      sent: reports.reduce((n, r) => n + (r.alerts.sent), 0),
      failed: reports.flatMap((r) => r.alerts.failed),
    },
    needsReconnect: reports.some((r) => r.needsReconnect),
    truncated: reports.filter((r) => r.truncated).length,
    reports,
    errors,
  });
}
