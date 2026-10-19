/**
 * Saving a sender inbox from Settings → Sending, and recording a resume.
 *
 * A resume is an audit_log row (INBOX_RESUMED_ACTION) written when a paused
 * inbox is saved unpaused. The bounce breaker (lib/autopilot/bounce-breaker.ts)
 * counts an inbox's hard bounces only after that row, so a person's resume
 * sticks: on 2026-10-19 a resume was undone 15 minutes later by the same two
 * bounces, still among the inbox's last 50 sends. (Never sender_inboxes.updated_at:
 * every save bumps it.)
 *
 * The resume row is written BEFORE the unpause: a tick between the two writes
 * then sees a paused inbox (nothing to do) and, on the next tick, counts only
 * bounces after the row. The other order left a window where the tick saw an
 * unpaused inbox, counted the old bounces and paused it again. A row whose
 * unpause then fails is harmless: the inbox is still paused, and the next real
 * resume writes a newer row. Without a row there is no resume: the inbox stays
 * paused, the other edits are saved, and the person is told.
 *
 * A resume needs the person to have SEEN "paused": the form sends the paused
 * value it loaded. A form that loaded "not paused" (a page opened before a
 * breaker paused the inbox) saving "not paused" keeps the pause and asks the
 * person to reload, so a stale page can't undo a pause nobody looked at.
 *
 * The db is injected so this is tested with a fake (tests/bounce-incident.test.ts);
 * lib/settings/sending-actions.ts passes the signed-in admin's client.
 */

// Untyped like tick.ts: the cookie and service-role clients have different generated types.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Db = any;

/** audit_log.action of a resume; the bounce breaker reads it. */
export const INBOX_RESUMED_ACTION = "sender_inbox.resumed";

export type SenderInboxPatch = {
  display_name: string;
  linkedin_url: string | null;
  daily_cap: number;
  paused: boolean;
  paused_reason: string | null;
  updated_at: string;
};

export type SaveSenderInboxResult = { ok: true; resumed: boolean } | { ok: false; error: string };

const detail = (e: { message?: string } | null | undefined) => e?.message || "no detail";

const STALE_FORM =
  "This inbox was paused after this page was loaded, so it stays paused. Your other changes are saved. Reload the page to see why it was paused, then resume it if you still want to.";

export async function saveSenderInbox(
  db: Db,
  args: {
    tenantId: string;
    inboxId: string;
    actorId: string;
    patch: SenderInboxPatch;
    /** The paused value the form loaded (what the person saw before saving). */
    loadedPaused: boolean;
  },
): Promise<SaveSenderInboxResult> {
  const { data: before, error: readError } = await db
    .from("sender_inboxes")
    .select("paused, paused_reason")
    .eq("id", args.inboxId)
    .eq("tenant_id", args.tenantId)
    .maybeSingle();
  if (readError) return { ok: false, error: `Could not read the sender inbox: ${detail(readError)}` };
  if (!before) return { ok: false, error: "Sender inbox not found." };
  const previous = before as { paused: boolean | null; paused_reason: string | null };
  const unpausing = previous.paused === true && args.patch.paused === false;

  /** Save the other edits, the pause and its reason as they are in the db. */
  const keepPause = async (message: string): Promise<SaveSenderInboxResult> => {
    const { error } = await db
      .from("sender_inboxes")
      .update({ ...args.patch, paused: true, paused_reason: previous.paused_reason })
      .eq("id", args.inboxId)
      .eq("tenant_id", args.tenantId);
    if (error) return { ok: false, error: `Could not save sender inbox: ${detail(error)}` };
    return { ok: false, error: message };
  };

  if (unpausing && !args.loadedPaused) return keepPause(STALE_FORM);

  if (!unpausing) {
    // An unpaused save is guarded on the row still being unpaused, so a breaker
    // pause landing between our read and this write is never overwritten.
    let q = db.from("sender_inboxes").update(args.patch).eq("id", args.inboxId).eq("tenant_id", args.tenantId);
    if (!args.patch.paused) q = q.eq("paused", false);
    const { data: saved, error } = await q.select("id");
    if (error) return { ok: false, error: `Could not save sender inbox: ${detail(error)}` };
    if (!args.patch.paused && (!Array.isArray(saved) || saved.length === 0)) {
      return { ok: false, error: "This inbox was paused while you were saving, so nothing was saved. Reload the page to see why." };
    }
    return { ok: true, resumed: false };
  }

  // The resume: its audit row first, then the unpause.
  const { error: auditError } = await db.from("audit_log").insert({
    tenant_id: args.tenantId,
    actor_id: args.actorId,
    action: INBOX_RESUMED_ACTION,
    entity_type: "sender_inbox",
    entity_id: args.inboxId,
    metadata: { previous_reason: previous.paused_reason },
  });
  if (auditError) {
    return keepPause(`The resume could not be recorded (${detail(auditError)}), so the inbox stays paused. Your other changes are saved. Try resuming again.`);
  }

  const { error } = await db
    .from("sender_inboxes")
    .update(args.patch)
    .eq("id", args.inboxId)
    .eq("tenant_id", args.tenantId);
  if (error) return { ok: false, error: `Could not save sender inbox (it stays paused): ${detail(error)}` };
  return { ok: true, resumed: true };
}
