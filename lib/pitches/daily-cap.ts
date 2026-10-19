/**
 * Daily send-cap reset logic for sender inboxes.
 *
 * `sender_inboxes.sends_today` is a running counter incremented on every send
 * (manual, drip cron, follow-up cron). It must reset each day — but there was no
 * reset, so yesterday's count carried over forever. The table has always had a
 * `last_reset_date` column (migration 0001) intended for exactly this; it just
 * was never wired up.
 *
 * Rather than a reset cron (which can misfire and is timezone-crude), this is
 * self-healing: the stored counter only "counts" if it was last stamped TODAY
 * (UTC, matching the send crons in vercel.json). On a new day the effective
 * count is 0, and the next send re-stamps `last_reset_date`. Mirrors the
 * warmup engine's "log-derived source of truth" fix (commit eca25d7).
 *
 * Sends never write the counter from here: they take a slot with one SQL
 * statement before the Gmail call (reserveSendSlot, migration 0049) and give
 * it back if Gmail did not accept the message. Two overlapping send runs used
 * to read, add one and write back, and clobber each other's count.
 *
 * Also here, because every cron send path asks them: the send-queue's time
 * budget, and what to do with a doubtful address on an automatic approval.
 * The db is injected so all of it is tested with fakes
 * (tests/send-path-hardening.test.ts).
 */

import { HELD_BY_AUTOPILOT } from "../autopilot/governor.ts";

/** UTC calendar day as YYYY-MM-DD. */
export function utcToday(now: Date = new Date()): string {
  return now.toISOString().slice(0, 10);
}

/**
 * The count that actually applies today. If the inbox's counter was last reset
 * on a previous day, the day has rolled over → effective count is 0.
 * `lastResetDate` is a Postgres `date` (comes back as "YYYY-MM-DD", possibly
 * with a time suffix — we compare the date portion only).
 */
export function effectiveSendsToday(
  sendsToday: number,
  lastResetDate: string | null | undefined,
  now: Date = new Date(),
): number {
  if (!lastResetDate) return 0;
  return lastResetDate.slice(0, 10) === utcToday(now) ? sendsToday : 0;
}

/**
 * The `sender_inboxes` update payload for recording one more send: bump the
 * effective count by one and stamp today so the counter is anchored to this day.
 *
 * Read-then-write: two writers at once lose a count. The pitch send paths use
 * reserveSendSlot instead; app/api/replies/nudge still uses this.
 */
export function bumpSendsTodayPayload(
  sendsToday: number,
  lastResetDate: string | null | undefined,
  now: Date = new Date(),
): { sends_today: number; last_reset_date: string; last_send_at: string } {
  return {
    sends_today: effectiveSendsToday(sendsToday, lastResetDate, now) + 1,
    last_reset_date: utcToday(now),
    last_send_at: now.toISOString(),
  };
}

// ── Send slots (migration 0049) ──────────────────────────────────────────────

/** The one call the slot helpers make; the service-role and cookie clients both fit. */
export type SlotClient = {
  rpc: (fn: string, args: Record<string, unknown>) => PromiseLike<{ data: unknown; error: { message?: string } | null }>;
};

export type SlotResult = { ok: true } | { ok: false; capReached: boolean; reason: string };

/**
 * Take one of the inbox's daily slots, atomically, before the Gmail call.
 * Fails closed: an RPC error is "no slot", so nothing is sent uncounted.
 */
export async function reserveSendSlot(db: SlotClient, inboxId: string): Promise<SlotResult> {
  const { data, error } = await db.rpc("spam_reserve_send_slot", { p_inbox: inboxId });
  if (error) return { ok: false, capReached: false, reason: `Couldn't reserve a send slot: ${error.message || "no detail"}` };
  if (data !== true) return { ok: false, capReached: true, reason: "Daily cap reached" };
  return { ok: true };
}

/**
 * Give the slot back: only when Gmail did not accept the message. If Gmail
 * accepted it and a later DB write failed, the slot stays (it was sent).
 * Returns the error text, or null.
 */
export async function releaseSendSlot(db: SlotClient, inboxId: string): Promise<string | null> {
  const { error } = await db.rpc("spam_release_send_slot", { p_inbox: inboxId });
  return error ? `Couldn't release the send slot: ${error.message || "no detail"}` : null;
}

// ── Send-queue time budget ───────────────────────────────────────────────────

/** vercel.json maxDuration for the send routes. */
export const SEND_ROUTE_MAX_MS = 120_000;
/**
 * Time a claimed pitch may still need: token refresh (10s timeout), jitter
 * (up to 8s), the last-moment recheck, the Gmail call, the writes.
 */
export const CLAIM_RESERVE_MS = 25_000;

/** May the run still claim a pitch? Never closer than CLAIM_RESERVE_MS to the kill. */
export function hasTimeToClaim(startMs: number, nowMs: number = Date.now()): boolean {
  return nowMs - startMs < SEND_ROUTE_MAX_MS - CLAIM_RESERVE_MS;
}

// ── Doubtful address on an automatic approval ────────────────────────────────

/** Start of the hold reason; begins with HELD_BY_AUTOPILOT so heldAction leaves the draft alone. */
export const DOUBTFUL_ADDRESS_HOLD = `${HELD_BY_AUTOPILOT}: address doubtful at send time`;

// Untyped like lib/autopilot/hold.ts: pitch_events and the autopilot columns aren't in every generated type.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Db = any;

/**
 * Did the autopilot give the pitch's latest approval? Read from the approval
 * event (payload.autopilot). null = couldn't read: the caller must not send.
 */
export async function latestApprovalByAutopilot(db: Db, tenantId: string, pitchId: string): Promise<boolean | null> {
  const { data, error } = await db
    .from("pitch_events")
    .select("payload, created_at")
    .eq("tenant_id", tenantId)
    .eq("pitch_id", pitchId)
    .eq("event_type", "approved")
    .order("created_at", { ascending: false })
    .limit(1);
  if (error) return null;
  const row = ((data ?? []) as Array<{ payload: { autopilot?: unknown } | null }>)[0];
  return row?.payload?.autopilot === true;
}

/**
 * Send-time SPAM Verify verdict → what the send-queue does. "drop" never
 * sends; "review" sends only when a person approved it (their call), and goes
 * back to a person when the autopilot did. null approval = unreadable: skip.
 */
export function sendTimeVerdictAction(
  verdict: "send" | "review" | "drop",
  approvedByAutopilot: boolean | null,
): "send" | "drop" | "hold" | "skip" {
  if (verdict === "drop") return "drop";
  if (verdict === "send") return "send";
  if (approvedByAutopilot === null) return "skip";
  return approvedByAutopilot ? "hold" : "send";
}

/**
 * Back to draft in the review lane, schedule cleared, guarded on 'approved'
 * (the same fields as lib/autopilot/hold.ts). Returns whether the row moved.
 */
export async function holdDoubtfulAutoApproval(
  db: Db,
  args: { tenantId: string; pitchId: string; why: string },
): Promise<boolean> {
  const { data, error } = await db
    .from("pitches")
    .update({
      status: "draft",
      scheduled_send_at: null,
      queued_at: null,
      approved_at: null,
      sender_inbox_id: null,
      autopilot_lane: "review",
      autopilot_reasons: [`${DOUBTFUL_ADDRESS_HOLD} (${args.why})`.slice(0, 300)],
    })
    .eq("id", args.pitchId)
    .eq("tenant_id", args.tenantId)
    .eq("status", "approved")
    .select("id");
  if (error) return false;
  return Array.isArray(data) && data.length > 0;
}
