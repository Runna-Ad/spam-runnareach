"use server";

/**
 * sendPitch — server action
 *
 * Loads an approved pitch + the chosen sender inbox, verifies ownership,
 * takes one of the inbox's daily slots (atomic RPC, migration 0049),
 * decrypts the refresh token, exchanges it for an access token, sends via
 * Gmail, then marks the pitch `sent`. The slot goes back if Gmail did not
 * accept the message.
 */

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { writeAuditLog } from "@/lib/audit/log";
import { effectiveSendsToday, releaseSendSlot, reserveSendSlot, type SlotClient } from "@/lib/pitches/daily-cap";
import { fetchTopUsableContact } from "@/lib/pitches/contacts";
import { hasUsableEmail } from "@/lib/research/email-utils";
import { isEmailOnDncList, type DncClient } from "@/lib/discover/dnc-check";
import { requireUser } from "@/lib/auth";
import { getAccessToken, sendGmailMessage } from "@/lib/gmail/client";
import { createClient } from "@/lib/supabase/server";
import { createServiceRoleClient } from "@/lib/supabase/service-role";
import { recordSendFailure } from "@/lib/autopilot/send-failures";
import { bodyWithFooter, getOutboundCompliance } from "@/lib/compliance/outbound";
import { firstTouchConflict } from "@/lib/pitches/send-guards";
import { verifyRecipient } from "@/lib/research/verify-recipient";
import { reconcileSignOff, senderIdentity } from "@/lib/pitches/sender-identity";
import { checkPitchGate } from "@/lib/pitches/gate";
import { recordPitchEvent } from "@/lib/pitches/events";
import { editRatio } from "@/lib/pitches/decision";
import { describeFailures, gateAllows } from "@/lib/pitches/send-gate";
import {
  prospectSendBlock,
  recheckBeforeSend,
  releaseClaim,
  type ReleaseClient,
  type SendCheckClient,
} from "@/lib/pitches/status-transitions";

const sendSchema = z.object({
  pitch_id: z.string().uuid(),
  inbox_id: z.string().uuid(),
});

export type SendPitchResult =
  | { ok: true; gmailMessageId: string }
  | { ok: false; error: string };

export async function sendPitch(input: {
  pitch_id: string;
  inbox_id: string;
}): Promise<SendPitchResult> {
  const user = await requireUser().catch(() => null);
  if (!user) return { ok: false, error: "Not authenticated." };
  if (user.role === "viewer") return { ok: false, error: "Not authorised." };

  const parsed = sendSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: "Invalid input." };
  const { pitch_id, inbox_id } = parsed.data;

  const supabase = await createClient();

  // ── 1. Load pitch (must be approved, belong to tenant) ─────────────────────
  type PitchRow = {
    id: string;
    status: string;
    subject: string;
    body_original: string | null;
    body_edited: string | null;
    preview_text: string | null;
    prospect_id: string;
    contact_id: string | null;
    prospect_contacts: { email: string | null; full_name: string | null; selected_by: string | null } | null;
    prospects: { language: "en" | "es"; status: string; cooldown_until: string | null; domain: string | null } | null;
  };

  const { data: pitch, error: pitchErr } = await supabase
    .from("pitches")
    .select(
      `id, status, subject, body_original, body_edited, preview_text,
       prospect_id, contact_id,
       prospect_contacts:contact_id(email, full_name, selected_by),
       prospects:prospect_id(language, status, cooldown_until, domain)`,
    )
    .eq("id", pitch_id)
    .eq("tenant_id", user.tenantId)
    .maybeSingle<PitchRow>();

  if (pitchErr || !pitch) return { ok: false, error: "Pitch not found." };
  if (pitch.status !== "approved") {
    return { ok: false, error: `Pitch must be approved before sending (status: ${pitch.status}).` };
  }
  // The cron checks this; the manual button didn't — a prospect suppressed,
  // opted out or booked after approval must not be emailed by a click either.
  // A null join (prospect unreadable) does not send.
  const prospectBlock = prospectSendBlock(pitch.prospects, null, new Date().toISOString());
  if (prospectBlock) return { ok: false, error: `${prospectBlock.reason} — not sending.` };

  // Resolve the recipient from the pitch's contact FK if it's usable; otherwise
  // fall back to the prospect's CURRENT top usable contact (the FK goes stale —
  // a contact may have been found after generation). Re-link contact_id so the
  // row reflects who we actually sent to.
  let toEmail: string | null = hasUsableEmail(pitch.prospect_contacts?.email)
    ? pitch.prospect_contacts!.email
    : null;
  let toName: string | null = toEmail ? pitch.prospect_contacts?.full_name ?? null : null;
  let toSelectedBy: string | null = toEmail ? pitch.prospect_contacts?.selected_by ?? null : null;
  let resolvedContactId: string | null = null;
  if (!toEmail) {
    const top = await fetchTopUsableContact(supabase, user.tenantId, pitch.prospect_id);
    if (top) {
      toEmail = top.email;
      toName = top.full_name;
      toSelectedBy = top.selected_by;
      resolvedContactId = top.id;
    }
  }
  if (!toEmail) {
    return { ok: false, error: "No usable contact email — add or find one on the prospect page first." };
  }

  // Per-ADDRESS suppression (bounced mailbox, existing client, competitor).
  // Blocks even a manual send, and catches an address sitting on a duplicate
  // prospect row that the prospect-level status check can't see.
  const dnc = await isEmailOnDncList(supabase as unknown as DncClient, user.tenantId, toEmail);
  if (dnc.blocked) {
    return { ok: false, error: dnc.reason };
  }

  const body = pitch.body_edited ?? pitch.body_original ?? "";
  if (!body.trim()) return { ok: false, error: "Pitch body is empty." };

  // CASL footer + unsubscribe link. Fails closed: no mailing address, no send.
  const lang: "en" | "es" = pitch.prospects?.language === "es" ? "es" : "en";
  // A draft from before the Nils/Henry switch still ends "Pedro"; match the From line.
  const signedBody = reconcileSignOff(body, lang);
  const compliance = getOutboundCompliance({
    tenantId: user.tenantId,
    prospectId: pitch.prospect_id,
    email: toEmail,
    lang,
  });
  if (!compliance.ok) return { ok: false, error: compliance.error };

  // One first email per prospect and per address (duplicate prospect rows exist).
  const duplicate = await firstTouchConflict(supabase, {
    tenantId: user.tenantId,
    prospectId: pitch.prospect_id,
    pitchId: pitch.id,
    email: toEmail,
  });
  if (duplicate) return { ok: false, error: duplicate };

  // SPAM Verify: never send to an address that can only bounce or must never
  // be pitched. "review" passes here — a human is clicking Send.
  const verify = await verifyRecipient(supabase, {
    tenantId: user.tenantId,
    email: toEmail,
    selectedBy: toSelectedBy,
    prospectDomain: pitch.prospects?.domain ?? null,
  });
  if (verify.verdict === "drop") {
    return { ok: false, error: `Not sending to ${toEmail}: ${verify.reasons.join("; ")}` };
  }

  // Send gate v2, on the exact text and address going out (the contact may
  // have been re-resolved above, or the body edited since approval). Review-
  // level flags pass only if the person accepted them when approving.
  const gate = await checkPitchGate(supabase, user.tenantId, pitch.id, {
    body: signedBody,
    recipient: { email: toEmail, full_name: toName, selected_by: toSelectedBy },
  });
  if (!gate) return { ok: false, error: "Couldn't run the quality check. Not sent — try again." };
  const allowed = gateAllows(gate.result, gate.override?.codes);
  if (!allowed.ok) {
    return {
      ok: false,
      error: `Not sent — the quality check flagged it since approval. Fix it and approve again: ${describeFailures(allowed.outstanding)}`,
    };
  }

  // ── 2. Load inbox (must belong to tenant, not paused, Gmail connected) ─────
  type InboxRow = {
    id: string;
    email: string;
    display_name: string;
    daily_cap: number;
    sends_today: number;
    last_reset_date: string | null;
    paused: boolean;
    gmail_refresh_token_encrypted: string | null;
  };

  const { data: inbox, error: inboxErr } = await supabase
    .from("sender_inboxes")
    .select("id, email, display_name, daily_cap, sends_today, last_reset_date, paused, gmail_refresh_token_encrypted")
    .eq("id", inbox_id)
    .eq("tenant_id", user.tenantId)
    .maybeSingle<InboxRow>();

  if (inboxErr || !inbox) return { ok: false, error: "Inbox not found." };
  if (inbox.paused) return { ok: false, error: "Inbox is paused." };
  if (!inbox.gmail_refresh_token_encrypted) {
    return { ok: false, error: "Inbox is not connected to Gmail. Connect it first in Settings → Sending." };
  }
  // Daily cap resets at the UTC day boundary — a stale last_reset_date means
  // yesterday's count no longer applies. Early answer only: the slot RPC
  // below is what enforces the cap.
  const sentToday = effectiveSendsToday(inbox.sends_today, inbox.last_reset_date);
  if (sentToday >= inbox.daily_cap) {
    return {
      ok: false,
      error: `Daily cap reached (${sentToday}/${inbox.daily_cap}). Try another inbox or wait until tomorrow.`,
    };
  }

  // ── 3. Mark pitch as "sending" (optimistic lock) ───────────────────────────
  // .select() matters: without it a lost race (double-click, or the cron's
  // send-queue claiming the same row) returns no error and both sides send.
  const { data: locked, error: lockErr } = await supabase
    .from("pitches")
    .update({ status: "sending" })
    .eq("id", pitch_id)
    .eq("tenant_id", user.tenantId)
    .eq("status", "approved") // only move if still approved (idempotency guard)
    .select("id")
    .maybeSingle();

  if (lockErr) return { ok: false, error: "Could not lock pitch for sending." };
  if (!locked) return { ok: false, error: "This pitch is already being sent." };

  // Every release from 'sending' is guarded on status = 'sending': a pitch a
  // person rejected meanwhile must not be re-approved by this rollback.
  const releaser = supabase as unknown as ReleaseClient;

  // ── 3b. Take a daily slot (one SQL statement; a cron run at the same time
  // can't push the inbox past its cap). Untyped: the RPC isn't in types.ts yet.
  const slots = supabase as unknown as SlotClient;
  const slot = await reserveSendSlot(slots, inbox_id);
  if (!slot.ok) {
    await releaseClaim(releaser, { pitchId: pitch_id, tenantId: user.tenantId, to: "approved" });
    return {
      ok: false,
      error: slot.capReached
        ? `Daily cap reached (${inbox.daily_cap}/${inbox.daily_cap}). Try another inbox or wait until tomorrow.`
        : `${slot.reason}. Not sent — try again.`,
    };
  }
  // From here, every exit where Gmail did not take the message gives back the
  // slot AND the claim.

  // ── 4. Exchange refresh token → access token ───────────────────────────────
  const tokenResult = await getAccessToken(inbox.gmail_refresh_token_encrypted);
  if (!tokenResult.ok) {
    // Rollback status so user can retry after fixing creds
    await releaseSendSlot(slots, inbox_id, slot.day);
    await releaseClaim(releaser, { pitchId: pitch_id, tenantId: user.tenantId, to: "approved" });
    return { ok: false, error: `Gmail auth failed: ${tokenResult.error}` };
  }

  // ── 4b. Last moment: may this prospect still be emailed? ───────────────────
  // An opt-out or DNC entry recorded while the checks above ran stops the send.
  const lastCheck = await recheckBeforeSend(supabase as unknown as SendCheckClient, {
    tenantId: user.tenantId,
    prospectId: pitch.prospect_id,
    email: toEmail,
  });
  if (lastCheck) {
    await releaseSendSlot(slots, inbox_id, slot.day);
    await releaseClaim(releaser, { pitchId: pitch_id, tenantId: user.tenantId, to: "approved" });
    return { ok: false, error: `${lastCheck.reason} — not sending.` };
  }

  // ── 5. Send via Gmail ──────────────────────────────────────────────────────
  const sendResult = await sendGmailMessage({
    accessToken: tokenResult.accessToken,
    fromEmail: inbox.email,
    fromName: senderIdentity(lang).displayName,
    to: toName ? `"${toName.replace(/"/g, "")}" <${toEmail}>` : toEmail,
    subject: pitch.subject,
    body: signedBody,
    // Drives the CTA button label. Without it a Spanish email ships an English
    // button whenever the CTA line has no prose to infer the language from.
    lang,
    footer: compliance.value.footer,
    listUnsubscribe: compliance.value.listUnsubscribe,
  });

  if (!sendResult.ok) {
    // Rollback so user can retry
    await releaseSendSlot(slots, inbox_id, slot.day);
    await releaseClaim(releaser, { pitchId: pitch_id, tenantId: user.tenantId, to: "approved" });
    // audit_log has RLS and no policies: the session client can't write it.
    await recordSendFailure(createServiceRoleClient(), { tenantId: user.tenantId, inboxId: inbox_id, pitchId: pitch_id, error: sendResult.error });
    return { ok: false, error: `Send failed: ${sendResult.error}` };
  }

  // ── 6. Persist success ─────────────────────────────────────────────────────
  const now = new Date().toISOString();

  await supabase
    .from("pitches")
    .update({
      status: "sent",
      sent_at: now,
      body_sent: bodyWithFooter(signedBody, compliance.value.footer),
      sender_inbox_id: inbox_id,
      // Re-link to the contact we actually resolved/sent to, if it was a fallback.
      ...(resolvedContactId ? { contact_id: resolvedContactId } : {}),
      gmail_message_id: sendResult.gmailMessageId,
      gmail_thread_id: sendResult.threadId ?? null,
      sequence_step: 1,
      next_followup_at: new Date(Date.now() + 3 * 24 * 60 * 60 * 1000).toISOString(),
    })
    .eq("id", pitch_id)
    .eq("tenant_id", user.tenantId);

  // (The send was counted when its slot was reserved.)

  await recordPitchEvent(supabase, {
    tenantId: user.tenantId,
    pitchId: pitch_id,
    type: "sent",
    payload: {
      path: "manual",
      step: 1,
      lang,
      recipient_domain: toEmail.split("@")[1]?.toLowerCase() ?? null,
      recipient_source: toSelectedBy,
      verify_verdict: verify.verdict,
      gate_version: gate.verdict.version,
      gate_accepted: gate.override?.codes ?? [],
      edit_ratio: editRatio(pitch.body_original ?? "", signedBody),
    },
  });

  await writeAuditLog({
    tenantId: user.tenantId,
    actorId: user.id,
    action: "pitch.sent",
    entityType: "pitch",
    entityId: pitch_id,
    metadata: {
      inbox_id,
      inbox_email: inbox.email,
      to_email: toEmail,
      gmail_message_id: sendResult.gmailMessageId,
    },
  });

  revalidatePath("/pitches");

  return { ok: true, gmailMessageId: sendResult.gmailMessageId };
}

// ── Bulk queue for drip-send ────────────────────────────────────────────────

const queueSchema = z.object({ inbox_id: z.string().uuid() });

/**
 * Queue every approved pitch (with a contact) for drip-sending from `inbox_id`.
 * We set scheduled_send_at = now so the send-queue cron picks them up, then the
 * cron drips a few per tick respecting the inbox's daily cap — protecting the
 * warmed domain's reputation instead of bursting all at once. Status stays
 * "approved" until the cron actually sends each one.
 */
export async function queueApprovedForSend(input: {
  inbox_id: string;
}): Promise<{ ok: true; queued: number } | { ok: false; error: string }> {
  const user = await requireUser().catch(() => null);
  if (!user) return { ok: false, error: "Not authenticated." };
  if (user.role === "viewer") return { ok: false, error: "Not authorised." };

  const parsed = queueSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: "Invalid input." };
  const { inbox_id } = parsed.data;

  const supabase = await createClient();

  type InboxRow = { id: string; paused: boolean; gmail_refresh_token_encrypted: string | null };
  const { data: inbox } = await supabase
    .from("sender_inboxes")
    .select("id, paused, gmail_refresh_token_encrypted")
    .eq("id", inbox_id)
    .eq("tenant_id", user.tenantId)
    .maybeSingle<InboxRow>();
  if (!inbox) return { ok: false, error: "Inbox not found." };
  if (inbox.paused) return { ok: false, error: "Inbox is paused." };
  if (!inbox.gmail_refresh_token_encrypted) {
    return { ok: false, error: "Inbox is not connected to Gmail. Connect it in Settings → Sending." };
  }

  // Approved pitches that have a contact and aren't already queued.
  const { data: pitches } = await supabase
    .from("pitches")
    .select("id")
    .eq("tenant_id", user.tenantId)
    .eq("status", "approved")
    .is("scheduled_send_at", null)
    .not("contact_id", "is", null)
    .returns<{ id: string }[]>();

  const ids = (pitches ?? []).map((p) => p.id);
  if (ids.length === 0) return { ok: true, queued: 0 };

  const now = new Date().toISOString();
  const { error } = await supabase
    .from("pitches")
    .update({ scheduled_send_at: now, sender_inbox_id: inbox_id, queued_at: now })
    .in("id", ids)
    .eq("tenant_id", user.tenantId);
  if (error) return { ok: false, error: `Could not queue: ${error.message}` };

  revalidatePath("/pitches");
  revalidatePath("/companies");
  return { ok: true, queued: ids.length };
}
