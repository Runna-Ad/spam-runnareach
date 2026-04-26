/**
 * Pure helpers for the blackout subsystem. Split from blackout.ts so they
 * can be imported from edge runtimes / tests / other client code without
 * dragging next/headers into the bundle.
 *
 * blackout.ts re-exports these for backwards compatibility.
 */

export type Market = "CA" | "MX" | "US" | "LATAM";

export type BlackoutDate = {
  id: string;
  market: Market;
  blackout_date: string; // YYYY-MM-DD
  label: string;
};

/**
 * Pure helper used by the send queue (Phase 4) and the discovery cron
 * (Phase 1b) — given a list of blackout dates and a target Date, returns
 * the matching label or null. Matches by YYYY-MM-DD; time-of-day ignored.
 */
export function blackoutLabel(
  date: Date,
  blackouts: Pick<BlackoutDate, "blackout_date" | "label">[],
): string | null {
  const ymd = date.toISOString().slice(0, 10);
  const hit = blackouts.find((b) => b.blackout_date === ymd);
  return hit?.label ?? null;
}
