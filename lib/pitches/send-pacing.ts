/**
 * Send pacing: how many emails one cron run may send, so mail leaves the way a
 * person sends it (a few an hour per inbox, never a burst). On 2026-10-22, 9
 * follow-ups went out ~8 s apart from one inbox; a young domain bursting like
 * that is a spam-filter signal.
 *
 * Each run sends at most PER_INBOX_PER_RUN per inbox and PER_RUN_TOTAL in
 * total. The send-queue runs at :00/:10/…, the follow-up 5 minutes later
 * (migrations 0041, 0052), so one inbox sends at most one email per ~5 min.
 * The inbox daily_cap (slot RPC, 0049) stays the hard ceiling per day.
 *
 * The routes ask `check` BEFORE any read or claim for a pitch, so a pitch over
 * the limit stays exactly as it was (approved / due) for the next run, and
 * call `recordSent` only once Gmail took the message. Tested in
 * tests/send-pacing.test.ts.
 */

export const PER_INBOX_PER_RUN = 1;
export const PER_RUN_TOTAL = 2;

export const RUN_LIMIT_REASON = "Run limit reached — next run";
export const INBOX_LIMIT_REASON = "Inbox already sent this run — next run";

/** ok, or why not: `stop` = the run is full (nothing else may send), else only this inbox is. */
export type PaceVerdict = { ok: true } | { ok: false; stop: boolean; reason: string };

export type RunPacer = {
  check(inboxId: string | null): PaceVerdict;
  recordSent(inboxId: string): void;
  readonly sent: number;
};

export function createRunPacer(limits: { perInbox: number; total: number } = { perInbox: PER_INBOX_PER_RUN, total: PER_RUN_TOTAL }): RunPacer {
  const byInbox = new Map<string, number>();
  let sent = 0;
  return {
    check(inboxId) {
      if (sent >= limits.total) return { ok: false, stop: true, reason: RUN_LIMIT_REASON };
      // No inbox: the route's own "no sender inbox" skip answers it.
      if (inboxId && (byInbox.get(inboxId) ?? 0) >= limits.perInbox) {
        return { ok: false, stop: false, reason: INBOX_LIMIT_REASON };
      }
      return { ok: true };
    },
    recordSent(inboxId) {
      sent += 1;
      byInbox.set(inboxId, (byInbox.get(inboxId) ?? 0) + 1);
    },
    get sent() {
      return sent;
    },
  };
}
