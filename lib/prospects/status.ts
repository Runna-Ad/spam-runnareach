// One rule for "may this writer set prospects.status to X over Y". Every writer
// used to carry its own `.not("status", "in", …)` list (or none), so a bounce on a
// won client's address erased the win and a "wants a meeting" reply turned a won
// client back into booked. Writers ask this module instead.
//
// Invariants (Pedro 2026-10-18, Q6: a real outcome wins over a later opt-out or
// bounce; DNC + paused sequences still block sending either way):
//   I1 An automated writer never moves a prospect out of won or lost.
//   I2 booked is overwritten only by won or lost.
//   I3 suppressed never overwrites booked, won, lost.
//   I4 replied never overwrites archived_no_meeting, suppressed, booked, won, lost.
//   I5 From a do-not-send status the next status is also do-not-send.
//   I6 A person may set won/lost over anything; every other rule applies to people too
//      when they act through a flow that writes a status as a side effect (inbox intent
//      actions, opportunity outcomes).
// Same-status writes are always allowed (they change nothing).
// Not covered: a person's direct status change (/companies bulk status, the prospect
// page) is a deliberate correction and may un-suppress (Pedro, 2026-10-19); the
// do-not-contact list still blocks any opted-out address. Every AUTOMATED writer
// (pipeline, scoring, research, replies, calendar) goes through this rule.
//
// Pure: no server imports, safe in tests and client code.

/** The prod `prospect_status` enum, in enum order (checked 2026-10-18). */
export const PROSPECT_STATUSES = [
  "raw", "enriched", "researched", "scored", "match", "no_match", "pitched", "queued",
  "approved", "sent", "bounced", "replied", "booked", "ghosted", "lost", "won",
  "suppressed", "archived_no_meeting", "b_list",
] as const;

export type ProspectStatusValue = (typeof PROSPECT_STATUSES)[number];

export type StatusWriter = "automation" | "person";

/** Statuses no send path may email. The ONLY copy: every send path imports it (tests/send-path-safety.test.ts pins that). */
export const DO_NOT_SEND_STATUSES: ReadonlySet<string> = new Set([
  "suppressed", "archived_no_meeting", "no_match", "lost", "won", "booked",
]);

const OUTCOMES: ReadonlySet<string> = new Set(["won", "lost"]);

export function mayOverwriteStatus(
  current: string | null | undefined,
  next: string,
  by: StatusWriter,
): boolean {
  if (current == null || current === next) return true;
  // I6: a person's explicit outcome (including correcting won <-> lost).
  if (by === "person" && OUTCOMES.has(next)) return true;
  // I1
  if (OUTCOMES.has(current)) return false;
  // I2 (and so I3, I4 for booked)
  if (current === "booked") return OUTCOMES.has(next);
  // I5 (and so I4 for archived_no_meeting, suppressed: replied is sendable)
  if (DO_NOT_SEND_STATUSES.has(current) && !DO_NOT_SEND_STATUSES.has(next)) return false;
  return true;
}

/**
 * For `.not("status", "in", f)`: "(booked,won,lost)", or null when nothing is protected.
 * Derived from mayOverwriteStatus over PROSPECT_STATUSES, in enum order.
 */
export function protectedStatusFilter(next: string, by: StatusWriter): string | null {
  const blocked = PROSPECT_STATUSES.filter((s) => !mayOverwriteStatus(s, next, by));
  return blocked.length ? `(${blocked.join(",")})` : null;
}
