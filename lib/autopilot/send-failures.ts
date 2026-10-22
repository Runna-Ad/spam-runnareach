/**
 * Gmail send failures, recorded so the gmail_api breaker can count them
 * (governor.evaluateBreakers: ≥ 3 today on one inbox pauses that inbox).
 *
 * One writer per send path, in the branch where sendGmailMessage returned
 * { ok: false } (lib/gmail/client.ts: Gmail answered non-2xx, or the request
 * timed out), after the slot and claim are given back: the send-queue, the
 * follow-up route and the manual send. Those
 * are transport/API failures only. A DNC, gate, recheck, cap or claim refusal
 * never reaches sendGmailMessage, so it is never recorded here.
 *
 * The record is an audit_log row (action gmail.send_failed, entity the
 * sender inbox). Counting follows the bounce breaker (bounce-breaker.ts): the
 * UTC day, and only after the inbox's latest resume, so a person's resume
 * sticks.
 *
 * The db is injected so this is tested with a fake (tests/handsoff-autopilot.test.ts).
 * Writers pass a service-role client: audit_log has RLS and no policies.
 */

// Untyped like tick.ts.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Db = any;

export const GMAIL_SEND_FAILED_ACTION = "gmail.send_failed";

/** Longest error text kept in the row's metadata. */
export const SEND_FAILURE_ERROR_MAX = 300;

/** Record one failed Gmail send. Never throws: the send path's own handling comes first. */
export async function recordSendFailure(
  db: Db,
  f: { tenantId: string; inboxId: string; pitchId: string | null; error: string },
): Promise<void> {
  try {
    const { error } = await db.from("audit_log").insert({
      tenant_id: f.tenantId,
      actor_id: null,
      action: GMAIL_SEND_FAILED_ACTION,
      entity_type: "sender_inbox",
      entity_id: f.inboxId,
      metadata: { pitch_id: f.pitchId, error: String(f.error ?? "").slice(0, SEND_FAILURE_ERROR_MAX) },
    });
    if (error) console.warn("[send-failures] not recorded:", error.message || "no detail");
  } catch (err) {
    console.warn("[send-failures] record threw:", (err as Error)?.message ?? err);
  }
}

/**
 * gmail.send_failed rows for one inbox since the later of today's UTC midnight
 * and `resumedAt` (the inbox's latest resume, bounce-breaker.ts latestResumeAt).
 * A read failure returns the error with count 0: the caller reports it.
 */
export async function gmailFailuresToday(
  db: Db,
  tenantId: string,
  inboxId: string,
  now: Date,
  resumedAt: string | null,
): Promise<{ count: number; error: string | null }> {
  const dayStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())).toISOString();
  const q = db
    .from("audit_log")
    .select("id", { count: "exact", head: true })
    .eq("tenant_id", tenantId)
    .eq("action", GMAIL_SEND_FAILED_ACTION)
    .eq("entity_id", inboxId);
  // Same window as bounce-breaker.ts bouncesTodayAfterResume.
  const afterResume = resumedAt !== null && Date.parse(resumedAt) > Date.parse(dayStart);
  const { count, error } = await (afterResume ? q.gt("created_at", resumedAt) : q.gte("created_at", dayStart));
  if (error) return { count: 0, error: `gmail failures: ${error.message || "no detail"}` };
  return { count: count ?? 0, error: null };
}
