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
 * Pure module — no imports — safe to use anywhere.
 */

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
