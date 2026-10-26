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
 * Lead alerts (lib/opportunities/booking-alert.ts) are driven by the
 * opportunities table, not by memory (migration 0047), the same shape as the
 * reply alerts in lib/replies/lead-alert.ts. Invariants (tested in
 * tests/booking-alert-durability.test.ts):
 *   D1 Due: a source 'calendar' row is due a booking alert while
 *      booked_alert_sent_at is null and it was created in the last 48h; due a
 *      cancellation alert while it is lost / "booking cancelled",
 *      cancelled_alert_sent_at is null and the SYNC cancelled it (cancelled_at,
 *      set by markCancelled) in the last 48h (alertDue). Never keyed on
 *      updated_at: the 0001 trigger bumps it on every claim and release. So a
 *      person closing a row as lost with that reason, or a cancellation the
 *      pre-0047 code applied, never alerts. Manual opportunities never.
 *   D2 Claim before send: the marker is set only where it is still null and
 *      only the rows this run won are sent. A send that reached nobody
 *      (sent 0, or a throw) releases the claim (only while the marker still
 *      holds this run's timestamp); partial delivery keeps it.
 *      Overlapping runs can never both send one alert.
 *   D3 Newest state wins: a cancelled row is never due a booking alert; its
 *      cancellation claim also sets booked_alert_sent_at, so a booked-then-
 *      cancelled row gets only the cancellation alert and both markers.
 *   D4 The alert is rebuilt from the database: the row's meeting_start /
 *      meeting_time_zone (written by createOpportunity, kept on cancel), the
 *      prospect's company + market and the contact's email via contact_id.
 *   D5 Kill safety (maxDuration 120s; one alert = 10s token + 15s per lead
 *      recipient + 5s slack, 60s for the default 3): due rows are swept at the START of every run, right after the
 *      token check and before listing events, and again at the END for this
 *      run's changes. A row is claimed only while that much (60s) remains before
 *      maxDuration (counted from the route's start); otherwise it is left for
 *      the next run's start sweep (hourly in the send window, 0053). The start sweep stops 40s earlier
 *      still, so the sync's own writes keep their time.
 *   D6 An alert failure never fails the sync: it lands in report.alerts.failed.
 * Without a working Google token no sweep is attempted.
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
import { notifyRecipients } from "../notify/recipients.ts";
import { isTestAddress, normalizeMailbox } from "../compliance/test-addresses.ts";
import { recordPitchEvent, type PitchEventType } from "../pitches/events.ts";
import { latestRootSentPitchId } from "../pitches/root-pitch.ts";
import { protectedStatusFilter } from "../prospects/status.ts";
import { formatBookingAlert, type BookingAlertInput } from "./booking-alert.ts";
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
    /** What the alert shows (D4): Google start and the event's time zone. */
    meetingStart: string | null;
    meetingTimeZone: string | null;
  }): Promise<{ id: string } | null>;
  /** Only flips a calendar opportunity still at meeting_booked; sets cancelled_at (D1). */
  markCancelled(opportunityId: string): Promise<boolean>;
  /** The prospect's ROOT sent pitch (lib/pitches/root-pitch.ts). */
  rootSentPitchId(prospectId: string): Promise<string | null>;
  recordEvent(pitchId: string, type: PitchEventType, payload: Record<string, unknown>): Promise<void>;
  /** Company name + market per prospect id, one query for the batch. */
  prospectSummaries(prospectIds: string[]): Promise<Map<string, ProspectSummary>>;
  /** Contact email per contact id, one query for the batch. */
  contactEmails(contactIds: string[]): Promise<Map<string, string>>;
  /** Calendar rows that may be due an alert (D1), changed since `sinceIso`. */
  dueAlerts(sinceIso: string): Promise<AlertRow[]>;
  /**
   * Sets the kind's marker only where it is still null (and, for a
   * cancellation, only while the row is still cancelled; it also sets an
   * unset booked marker, D3). True when this caller won the row.
   */
  claimAlert(row: AlertRow, kind: AlertKind, nowIso: string): Promise<boolean>;
  /** Clears the kind's marker so the next run retries, only while it still holds this claim's `claimedIso`. */
  releaseAlert(opportunityId: string, kind: AlertKind, claimedIso: string): Promise<void>;
};

export type ProspectSummary = { company: string | null; market: string | null };

export type AlertKind = BookingAlertInput["kind"];

/** An opportunities row as the alert sweep reads it (0043 + 0047 columns). */
export type AlertRow = {
  id: string;
  source: string;
  prospectId: string;
  contactId: string | null;
  stage: string;
  lossReason: string | null;
  meetingStart: string | null;
  meetingTimeZone: string | null;
  bookedAlertSentAt: string | null;
  cancelledAlertSentAt: string | null;
  /** When the sync applied the cancellation (0047); null on rows cancelled any other way. */
  cancelledAt: string | null;
  createdAt: string;
};

/** Rows older than this are never alerted (same window as reply alerts). */
export const BOOKING_ALERT_WINDOW_HOURS = 48;
/** vercel.json maxDuration for app/api/opportunities/calendar-sync/route.ts. */
export const CALENDAR_SYNC_MAX_DURATION_MS = 120_000;
/**
 * Worst case for one lead alert (lib/notify/send.ts): 10s token exchange +
 * one 15s-capped Gmail send per recipient + 5s slack. Nothing is claimed with
 * less than this left before maxDuration. 60s for the default 3 recipients.
 */
export function bookingAlertReserveMs(recipients: number = notifyRecipients("lead").length): number {
  return 10_000 + 15_000 * recipients + 5_000;
}
/**
 * The start sweep also leaves this much for the sync itself (event list 10s
 * timeout + the batch's writes), so leftovers can't push the meeting_booked
 * pitch event and audit row past maxDuration.
 */
export const CALENDAR_SYNC_WORK_RESERVE_MS = 40_000;
const ALERT_BATCH = 20;

function isCancelledBooking(row: Pick<AlertRow, "stage" | "lossReason">): boolean {
  return row.stage === "lost" && row.lossReason === CANCELLED_LOSS_REASON;
}

/** D1 + D3: which alert this row is due now, if any. */
export function alertDue(row: AlertRow, nowMs: number): AlertKind | null {
  if (row.source !== "calendar") return null;
  const since = nowMs - BOOKING_ALERT_WINDOW_HOURS * 3_600_000;
  if (isCancelledBooking(row)) {
    const at = row.cancelledAt === null ? Number.NaN : Date.parse(row.cancelledAt);
    return row.cancelledAlertSentAt === null && at >= since ? "cancelled" : null;
  }
  return row.bookedAlertSentAt === null && Date.parse(row.createdAt) >= since ? "booked" : null;
}

type AlertRowDb = {
  id: string;
  source: string;
  prospect_id: string;
  contact_id: string | null;
  stage: string;
  loss_reason: string | null;
  meeting_start: string | null;
  meeting_time_zone: string | null;
  booked_alert_sent_at: string | null;
  cancelled_alert_sent_at: string | null;
  cancelled_at: string | null;
  created_at: string;
};

const ALERT_ROW_COLUMNS =
  "id, source, prospect_id, contact_id, stage, loss_reason, meeting_start, meeting_time_zone, " +
  "booked_alert_sent_at, cancelled_alert_sent_at, cancelled_at, created_at";

function alertRowFromDb(r: AlertRowDb): AlertRow {
  return {
    id: r.id, source: r.source, prospectId: r.prospect_id, contactId: r.contact_id, stage: r.stage,
    lossReason: r.loss_reason, meetingStart: r.meeting_start, meetingTimeZone: r.meeting_time_zone,
    bookedAlertSentAt: r.booked_alert_sent_at, cancelledAlertSentAt: r.cancelled_alert_sent_at,
    cancelledAt: r.cancelled_at, createdAt: r.created_at,
  };
}

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
        .not("status", "in", protectedStatusFilter("booked", "automation")!);
      if (error) throw new Error(`prospect status update failed: ${error.message}`);
    },
    async createOpportunity({ eventId, match, notes, meetingStart, meetingTimeZone }) {
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
          meeting_start: meetingStart,
          meeting_time_zone: meetingTimeZone,
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
        .update({ stage: "lost", loss_reason: CANCELLED_LOSS_REASON, cancelled_at: new Date().toISOString() })
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
    async contactEmails(contactIds) {
      const out = new Map<string, string>();
      if (contactIds.length === 0) return out;
      const { data, error } = await supabase
        .from("prospect_contacts")
        .select("id, email")
        .eq("tenant_id", tenantId)
        .in("id", contactIds);
      if (error) throw new Error(`contact email lookup failed: ${error.message}`);
      for (const r of (data ?? []) as Array<{ id: string; email: string | null }>) {
        if (r.email) out.set(r.id, r.email);
      }
      return out;
    },
    async dueAlerts(sinceIso) {
      const base = () =>
        supabase.from("opportunities").select(ALERT_ROW_COLUMNS).eq("tenant_id", tenantId).eq("source", "calendar");
      const [booked, cancelled] = await Promise.all([
        base()
          .is("booked_alert_sent_at", null)
          .gte("created_at", sinceIso)
          .order("created_at", { ascending: true })
          .limit(ALERT_BATCH),
        base()
          .eq("stage", "lost")
          .eq("loss_reason", CANCELLED_LOSS_REASON)
          .is("cancelled_alert_sent_at", null)
          .gte("cancelled_at", sinceIso)
          .order("cancelled_at", { ascending: true })
          .limit(ALERT_BATCH),
      ]);
      const error = booked.error ?? cancelled.error;
      if (error) throw new Error(`booking alert lookup failed: ${error.message}`);
      const out = new Map<string, AlertRow>();
      for (const r of [...(booked.data ?? []), ...(cancelled.data ?? [])] as AlertRowDb[]) {
        out.set(r.id, alertRowFromDb(r));
      }
      return [...out.values()];
    },
    async claimAlert(row, kind, nowIso) {
      const q =
        kind === "booked"
          ? supabase
              .from("opportunities")
              .update({ booked_alert_sent_at: nowIso })
              .is("booked_alert_sent_at", null)
          : supabase
              .from("opportunities")
              .update({
                cancelled_alert_sent_at: nowIso,
                ...(row.bookedAlertSentAt === null ? { booked_alert_sent_at: nowIso } : {}),
              })
              .is("cancelled_alert_sent_at", null)
              .eq("stage", "lost")
              .eq("loss_reason", CANCELLED_LOSS_REASON);
      const { data, error } = await q
        .eq("id", row.id)
        .eq("tenant_id", tenantId)
        .eq("source", "calendar")
        .select("id");
      if (error) throw new Error(`booking alert claim failed: ${error.message}`);
      return Array.isArray(data) && data.length > 0;
    },
    async releaseAlert(opportunityId, kind, claimedIso) {
      // A released cancellation keeps the booked marker it set (D3). The
      // timestamp guard keeps a late or repeated release off another run's claim.
      const column = kind === "booked" ? "booked_alert_sent_at" : "cancelled_alert_sent_at";
      const { error } = await supabase
        .from("opportunities")
        .update({ [column]: null })
        .eq("id", opportunityId)
        .eq("tenant_id", tenantId)
        .eq(column, claimedIso);
      if (error) throw new Error(`booking alert release failed: ${error.message}`);
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

/** A booking or cancellation the sync applied (reported; the alert comes from the row). */
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
        const row = await store.createOpportunity({
          eventId: event.id, match: plan.match, notes, meetingStart: start, meetingTimeZone: eventTimeZone(event),
        });
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

export type BookingAlertRunOptions = {
  /** Epoch ms after which nothing is claimed (rows stay for the next run). */
  deadline: number;
  clock?: () => number;
};

/**
 * One lead alert per due calendar row (D1–D4), oldest first, each claimed
 * right before its send and only before `deadline` (D5). Returns the prospect
 * summaries it read so the report can show company + market. Never throws.
 */
export async function sendDueBookingAlerts(
  store: SyncStore,
  notify: (message: NotificationMessage) => Promise<NotificationResult>,
  opts: BookingAlertRunOptions,
): Promise<{ alerts: NotificationResult; summaries: Map<string, ProspectSummary> }> {
  const clock = opts.clock ?? Date.now;
  const alerts: NotificationResult = { sent: 0, failed: [] };
  let summaries = new Map<string, ProspectSummary>();
  if (clock() > opts.deadline) return { alerts, summaries };

  let due: Array<{ row: AlertRow; kind: AlertKind }>;
  try {
    const now = clock();
    const rows = await store.dueAlerts(new Date(now - BOOKING_ALERT_WINDOW_HOURS * 3_600_000).toISOString());
    due = rows.flatMap((row) => {
      const kind = alertDue(row, now);
      return kind ? [{ row, kind }] : [];
    });
  } catch (err) {
    alerts.failed.push((err as Error).message);
    return { alerts, summaries };
  }
  if (due.length === 0) return { alerts, summaries };

  let emails = new Map<string, string>();
  try {
    summaries = await store.prospectSummaries([...new Set(due.map((d) => d.row.prospectId))]);
  } catch (err) {
    // Still alert, without the company name.
    alerts.failed.push((err as Error).message);
  }
  try {
    emails = await store.contactEmails([...new Set(due.flatMap((d) => (d.row.contactId ? [d.row.contactId] : [])))]);
  } catch (err) {
    alerts.failed.push((err as Error).message);
  }

  for (const { row, kind } of due) {
    // Never claim what this run may not have time to send.
    if (clock() > opts.deadline) break;
    let claimed = false;
    const claimedIso = new Date(clock()).toISOString();
    try {
      claimed = await store.claimAlert(row, kind, claimedIso);
      if (!claimed) continue;
      const s = summaries.get(row.prospectId);
      const alert = formatBookingAlert({
        kind,
        company: s?.company ?? null,
        market: s?.market ?? null,
        attendee: (row.contactId ? emails.get(row.contactId) : undefined) ?? null,
        start: row.meetingStart,
        timeZone: row.meetingTimeZone,
      });
      const res = await notify({ kind: "lead", fromName: "S.P.A.M Bookings", ...alert });
      alerts.sent += res.sent;
      alerts.failed.push(...res.failed);
      if (res.sent === 0) await store.releaseAlert(row.id, kind, claimedIso);
    } catch (err) {
      alerts.failed.push(`opportunity ${row.id}: ${(err as Error).message}`);
      if (claimed) await store.releaseAlert(row.id, kind, claimedIso).catch(() => {});
    }
  }
  return { alerts, summaries };
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
  /** Epoch ms the route started (the D5 deadline counts from it); defaults to now. */
  startedAt?: number;
  clock?: () => number;
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

  const store = deps.store ?? supabaseSyncStore(supabase, tenantId);
  const clock = deps.clock ?? Date.now;
  const deadline = (deps.startedAt ?? clock()) + CALENDAR_SYNC_MAX_DURATION_MS - bookingAlertReserveMs();
  const summaries = new Map<string, ProspectSummary>();
  const notify = deps.notify;
  const fromEmail = inbox.email;
  const sweep = async (until: number) => {
    if (!notify) return;
    const r = await sendDueBookingAlerts(store, (m) => notify({ ...m, fromEmail }), { deadline: until, clock });
    report.alerts.sent += r.alerts.sent;
    report.alerts.failed.push(...r.alerts.failed);
    for (const [id, s] of r.summaries) summaries.set(id, s);
  };
  // D5: leftovers of earlier runs first, before any Google listing.
  await sweep(deadline - CALENDAR_SYNC_WORK_RESERVE_MS);

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
  if (notify && bookings.length > 0) {
    // This run's changes, only while there is time to finish (D5).
    await sweep(deadline);
    for (const b of bookings) {
      const s = summaries.get(b.prospectId);
      b.company = s?.company ?? null;
      b.market = s?.market ?? null;
    }
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
