/**
 * Send pacing: how many emails one cron run may send, so mail leaves the way a
 * person sends it (a few an hour per inbox, never a burst). On 2026-10-22, 9
 * follow-ups went out ~8 s apart from one inbox; a young domain bursting like
 * that is a spam-filter signal.
 *
 * Each run sends at most PER_INBOX_PER_RUN per inbox and PER_RUN_TOTAL in
 * total. The send-queue runs at :00/:10/…, the follow-up at :07/:17/…
 * (migrations 0041, 0052), so one inbox never sends two within ~3 minutes.
 * The inbox daily_cap (slot RPC, 0049) stays the hard ceiling per day.
 *
 * The routes ask `check` BEFORE any read or claim for a pitch, so a pitch over
 * the limit stays exactly as it was (approved / due) for the next run, and
 * call `recordSent` only once Gmail took the message (or a throw leaves it
 * unknown). `recordAttempt` uses up the inbox for the run without counting a
 * send: a follow-up that failed after its compose. Tested in
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
  /** This inbox is done for the run, but nothing was sent (the run total is unchanged). */
  recordAttempt(inboxId: string): void;
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
    recordAttempt(inboxId) {
      byInbox.set(inboxId, Math.max(byInbox.get(inboxId) ?? 0, limits.perInbox));
    },
    get sent() {
      return sent;
    },
  };
}

// ── Follow-up retry back-off ────────────────────────────────────────────────

/**
 * A follow-up that fails after its compose (gate unavailable, out of time at
 * the claim, no daily slot, a recheck skip, a Gmail failure) stays due. With a
 * run every 10 minutes it would be composed again, a Claude call against the
 * daily cap, up to 48 times a day: it waits this long instead.
 */
export const FOLLOWUP_RETRY_MS = 60 * 60 * 1000;

export function followupRetryAt(nowMs: number = Date.now()): string {
  return new Date(nowMs + FOLLOWUP_RETRY_MS).toISOString();
}

type Filterable = {
  eq(column: string, value: unknown): Filterable;
  is(column: string, value: null): Filterable;
  lte(column: string, value: string): Filterable;
  select(columns: string): PromiseLike<{ data: unknown; error: { message: string } | null }>;
};
export type BackoffClient = { from(table: string): { update(values: Record<string, unknown>): Filterable } };

/**
 * Moves an unclaimed, still-due follow-up to `retryAt`, only if nobody moved
 * it since the run read it (same step, not paused, date not postponed): an
 * OOO postpone or a snooze written meanwhile is never pulled back. Never
 * throws; true when the row moved.
 */
export async function backOffFollowup(
  db: BackoffClient,
  args: { pitchId: string; priorStep: number; priorFollowupAt: string; retryAt: string },
): Promise<boolean> {
  try {
    const { data, error } = await db
      .from("pitches")
      .update({ next_followup_at: args.retryAt })
      .eq("id", args.pitchId)
      .eq("sequence_step", args.priorStep)
      .is("sequence_paused_at", null)
      .lte("next_followup_at", args.priorFollowupAt)
      .select("id");
    if (error) {
      console.error(`[follow-up] back-off of ${args.pitchId} failed:`, error);
      return false;
    }
    return Array.isArray(data) && data.length > 0;
  } catch (err) {
    console.error(`[follow-up] back-off of ${args.pitchId} failed:`, err);
    return false;
  }
}
