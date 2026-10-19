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
 * Without the row the breaker would count the old bounces and pause the inbox
 * again, so a resume whose row can't be written is put back to paused and the
 * person is told: what Settings shows stays what is true.
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

export async function saveSenderInbox(
  db: Db,
  args: { tenantId: string; inboxId: string; actorId: string; patch: SenderInboxPatch },
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
  const resuming = previous.paused === true && args.patch.paused === false;

  const { error } = await db
    .from("sender_inboxes")
    .update(args.patch)
    .eq("id", args.inboxId)
    .eq("tenant_id", args.tenantId);
  if (error) return { ok: false, error: `Could not save sender inbox: ${detail(error)}` };
  if (!resuming) return { ok: true, resumed: false };

  const { error: auditError } = await db.from("audit_log").insert({
    tenant_id: args.tenantId,
    actor_id: args.actorId,
    action: INBOX_RESUMED_ACTION,
    entity_type: "sender_inbox",
    entity_id: args.inboxId,
    metadata: { previous_reason: previous.paused_reason },
  });
  if (!auditError) return { ok: true, resumed: true };

  // No resume row: the breaker still counts the old bounces. Put the pause back
  // (only if nothing else changed it meanwhile) and say so.
  const { error: undoError } = await db
    .from("sender_inboxes")
    .update({ paused: true, paused_reason: previous.paused_reason })
    .eq("id", args.inboxId)
    .eq("tenant_id", args.tenantId)
    .eq("paused", false);
  return {
    ok: false,
    error: undoError
      ? `Saved, but the resume could not be recorded (${detail(auditError)}): the bounce breaker still counts the bounces from before it and may pause this inbox again. Try resuming again.`
      : `The resume could not be recorded (${detail(auditError)}), so the inbox stays paused. Your other changes are saved. Try resuming again.`,
  };
}
