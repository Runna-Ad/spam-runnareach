"use server";

/**
 * sendPitch — server action
 *
 * Loads an approved pitch + the chosen sender inbox, verifies ownership,
 * checks the daily cap, decrypts the refresh token, exchanges it for an
 * access token, sends via Gmail, then marks the pitch `sent` and
 * increments `sends_today` on the inbox — all in a single atomic-ish
 * operation (best-effort: the DB write happens after a successful send).
 */

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { writeAuditLog } from "@/lib/audit/log";
import { bumpSendsTodayPayload, effectiveSendsToday } from "@/lib/pitches/daily-cap";
import { fetchTopUsableContact } from "@/lib/pitches/contacts";
import { hasUsableEmail } from "@/lib/research/email-utils";
import { isEmailOnDncList, type DncClient } from "@/lib/discover/dnc-check";
import { requireUser } from "@/lib/auth";
import { getAccessToken, sendGmailMessage } from "@/lib/gmail/client";
import { createClient } from "@/lib/supabase/server";

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
    prospect_contacts: { email: string | null; full_name: string | null } | null;
    prospects: { language: "en" | "es" } | null;
  };

  const { data: pitch, error: pitchErr } = await supabase
    .from("pitches")
    .select(
      `id, status, subject, body_original, body_edited, preview_text,
       prospect_id, contact_id,
       prospect_contacts:contact_id(email, full_name),
       prospects:prospect_id(language)`,
    )
    .eq("id", pitch_id)
    .eq("tenant_id", user.tenantId)
    .maybeSingle<PitchRow>();

  if (pitchErr || !pitch) return { ok: false, error: "Pitch not found." };
  if (pitch.status !== "approved") {
    return { ok: false, error: `Pitch must be approved before sending (status: ${pitch.status}).` };
  }

  // Resolve the recipient from the pitch's contact FK if it's usable; otherwise
  // fall back to the prospect's CURRENT top usable contact (the FK goes stale —
  // a contact may have been found after generation). Re-link contact_id so the
  // row reflects who we actually sent to.
  let toEmail: string | null = hasUsableEmail(pitch.prospect_contacts?.email)
    ? pitch.prospect_contacts!.email
    : null;
  let toName: string | null = toEmail ? pitch.prospect_contacts?.full_name ?? null : null;
  let resolvedContactId: string | null = null;
  if (!toEmail) {
    const top = await fetchTopUsableContact(supabase, user.tenantId, pitch.prospect_id);
    if (top) {
      toEmail = top.email;
      toName = top.full_name;
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
  // yesterday's count no longer applies.
  const sentToday = effectiveSendsToday(inbox.sends_today, inbox.last_reset_date);
  if (sentToday >= inbox.daily_cap) {
    return {
      ok: false,
      error: `Daily cap reached (${sentToday}/${inbox.daily_cap}). Try another inbox or wait until tomorrow.`,
    };
  }

  // ── 3. Mark pitch as "sending" (optimistic lock) ───────────────────────────
  const { error: lockErr } = await supabase
    .from("pitches")
    .update({ status: "sending" })
    .eq("id", pitch_id)
    .eq("tenant_id", user.tenantId)
    .eq("status", "approved"); // only move if still approved (idempotency guard)

  if (lockErr) return { ok: false, error: "Could not lock pitch for sending." };

  // ── 4. Exchange refresh token → access token ───────────────────────────────
  const tokenResult = await getAccessToken(inbox.gmail_refresh_token_encrypted);
  if (!tokenResult.ok) {
    // Rollback status so user can retry after fixing creds
    await supabase
      .from("pitches")
      .update({ status: "approved" })
      .eq("id", pitch_id)
      .eq("tenant_id", user.tenantId);
    return { ok: false, error: `Gmail auth failed: ${tokenResult.error}` };
  }

  // ── 5. Send via Gmail ──────────────────────────────────────────────────────
  const sendResult = await sendGmailMessage({
    accessToken: tokenResult.accessToken,
    fromEmail: inbox.email,
    fromName: inbox.display_name,
    to: toName ? `"${toName.replace(/"/g, "")}" <${toEmail}>` : toEmail,
    subject: pitch.subject,
    body,
    // Drives the CTA button label. Without it a Spanish email ships an English
    // button whenever the CTA line has no prose to infer the language from.
    lang: pitch.prospects?.language ?? undefined,
  });

  if (!sendResult.ok) {
    // Rollback so user can retry
    await supabase
      .from("pitches")
      .update({ status: "approved" })
      .eq("id", pitch_id)
      .eq("tenant_id", user.tenantId);
    return { ok: false, error: `Send failed: ${sendResult.error}` };
  }

  // ── 6. Persist success ─────────────────────────────────────────────────────
  const now = new Date().toISOString();

  await supabase
    .from("pitches")
    .update({
      status: "sent",
      sent_at: now,
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

  await supabase
    .from("sender_inboxes")
    .update(bumpSendsTodayPayload(inbox.sends_today, inbox.last_reset_date))
    .eq("id", inbox_id)
    .eq("tenant_id", user.tenantId);

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
