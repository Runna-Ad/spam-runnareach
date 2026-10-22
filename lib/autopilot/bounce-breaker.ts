/**
 * The bounce breakers' numbers, read from the database. The rules themselves
 * stay pure in governor.ts (evaluateBreakers, inboxBouncesTrip); this file only
 * decides which bounces count:
 *
 *   inbox_bounces  hard bounces among an inbox's last 50 sends, counting only
 *                  bounces recorded after the inbox's latest resume
 *   bounces_today  hard bounces today (UTC), counting only after the latest
 *                  resume of any inbox today
 *
 * A resume is the audit_log row lib/autopilot/inbox-resume.ts writes. An inbox
 * that was never resumed counts exactly as before. On 2026-10-19 a resume was
 * undone by the next tick on the same two bounces; it can't be now.
 *
 * Two users, one rule: the autopilot tick pauses and emails on it, and the
 * send-queue skips the inbox for the run on it (inboxBounceBlock), so a drip
 * stops at the first fresh bounce the reply poll has recorded.
 *
 * The db is injected so this is tested with a fake (tests/bounce-incident.test.ts).
 */

import { inboxBouncesTrip } from "./governor.ts";
import { INBOX_RESUMED_ACTION } from "./inbox-resume.ts";

// Untyped like tick.ts: pitch_events and the autopilot columns aren't in every generated type.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Db = any;

/** The inbox_bounces rule looks at this many of an inbox's latest sends. */
export const RECENT_SENDS = 50;

/** Start of every send-queue skip reason this rule gives. */
export const BOUNCE_BREAKER = "Bounce breaker";

export type InboxBounceStats = {
  recentSends: number;
  recentHardBounces: number;
  /** The latest resume of this inbox (audit_log created_at), or null. */
  resumedAt: string | null;
  /** A read failed: the counts are what could be read (0 if nothing). */
  error: string | null;
};

const detail = (e: { message?: string } | null | undefined) => e?.message || "no detail";

/**
 * When the inbox (or, with inboxId null, any inbox of the tenant) was last
 * resumed. An unreadable audit log reads as "never resumed": every bounce
 * counts, so the breaker errs toward pausing.
 */
export async function latestResumeAt(db: Db, tenantId: string, inboxId: string | null): Promise<string | null> {
  let q = db.from("audit_log").select("created_at").eq("tenant_id", tenantId).eq("action", INBOX_RESUMED_ACTION);
  if (inboxId) q = q.eq("entity_id", inboxId);
  const { data, error } = await q.order("created_at", { ascending: false }).limit(1);
  if (error) return null;
  return ((data ?? []) as Array<{ created_at: string | null }>)[0]?.created_at ?? null;
}

/** The inbox_bounces numbers for one inbox. */
export async function inboxBounceStats(db: Db, tenantId: string, inboxId: string): Promise<InboxBounceStats> {
  const { data: sent, error: sentError } = await db
    .from("pitches")
    .select("id")
    .eq("tenant_id", tenantId)
    .eq("sender_inbox_id", inboxId)
    .not("sent_at", "is", null)
    .order("sent_at", { ascending: false })
    .limit(RECENT_SENDS);
  const ids = ((sent ?? []) as Array<{ id: string }>).map((r) => r.id);
  const resumedAt = await latestResumeAt(db, tenantId, inboxId);
  let error: string | null = sentError ? `recent sends: ${detail(sentError)}` : null;

  let bounces = 0;
  if (ids.length) {
    // A bounce is recorded on the conversation's ROOT pitch, with the follow-up it
    // answered in payload.answered_pitch_id (app/api/replies/poll). The root can be
    // outside this inbox's last sends while its follow-up is inside: match either
    // column and count each event once. Older events have no answered_pitch_id.
    const seen = new Set<string>();
    for (const col of ["pitch_id", "payload->>answered_pitch_id"]) {
      let q = db
        .from("pitch_events")
        .select("id")
        .eq("tenant_id", tenantId)
        .eq("event_type", "bounce")
        .in(col, ids);
      if (resumedAt) q = q.gt("event_at", resumedAt);
      const { data, error: bounceError } = await q;
      if (bounceError) error ??= `bounces: ${detail(bounceError)}`;
      for (const r of (data ?? []) as Array<{ id: string }>) seen.add(r.id);
    }
    bounces = seen.size;
  }
  return { recentSends: ids.length, recentHardBounces: bounces, resumedAt, error };
}

/** The bounces_today number: from the UTC day start, or the latest resume of any inbox if that is later. */
export async function bouncesTodayAfterResume(db: Db, tenantId: string, now: Date): Promise<number> {
  const dayStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())).toISOString();
  const resumedAt = await latestResumeAt(db, tenantId, null);
  const q = db
    .from("pitch_events")
    .select("id", { count: "exact", head: true })
    .eq("tenant_id", tenantId)
    .eq("event_type", "bounce");
  // Timestamps from Postgres and from JS differ in format: compare as times.
  const afterResume = resumedAt !== null && Date.parse(resumedAt) > Date.parse(dayStart);
  const { count } = await (afterResume ? q.gt("event_at", resumedAt) : q.gte("event_at", dayStart));
  return count ?? 0;
}

export type InboxBounceBlock = { blocked: false } | { blocked: true; reason: string };

/**
 * The send-queue's question before it sends from an inbox: would the
 * inbox_bounces breaker trip on it right now? Skip only, never pause (the next
 * tick pauses and emails). Fails closed: unreadable bounce history blocks the
 * inbox for this run.
 */
export async function inboxBounceBlock(db: Db, tenantId: string, inboxId: string): Promise<InboxBounceBlock> {
  const stats = await inboxBounceStats(db, tenantId, inboxId);
  if (stats.error) return { blocked: true, reason: `${BOUNCE_BREAKER}: bounce history unreadable (${stats.error}), not sending from this inbox this run` };
  const trip = inboxBouncesTrip({ id: inboxId, recentSends: stats.recentSends, recentHardBounces: stats.recentHardBounces });
  return trip ? { blocked: true, reason: `${BOUNCE_BREAKER}: ${trip.reason}` } : { blocked: false };
}
