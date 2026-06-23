"use server";

/**
 * Reply-funnel send + archive server actions (human-in-the-loop).
 *
 * approveAndSendReply — Pedro reviews the auto-drafted response, optionally
 *   edits it, then approves. We send it in the SAME Gmail thread, bump the
 *   prospect's reply_attempts counter, and mark the reply handled. Mirrors
 *   the pitch approval flow (lib/pitches/send-action.ts).
 *
 * archiveNoMeeting — manual archive of a prospect that won't book. Captures a
 *   Claude-summarised learning (why it didn't work) for the future learning
 *   loop. Falls back to a deterministic reason if Claude is unavailable.
 *
 * The 3-reply cap (book-a-meeting budget) is enforced on prospects.reply_attempts.
 */

import { revalidatePath } from "next/cache";
import { z } from "zod";
import {
  ANTHROPIC_HAIKU_MODEL,
  claudeIsAvailable,
  structuredCall,
} from "@/lib/anthropic/client";
import { recordClaudeCall } from "@/lib/anthropic/cost-tracking";
import { writeAuditLog } from "@/lib/audit/log";
import { requireUser } from "@/lib/auth";
import { getAccessToken, sendGmailMessage } from "@/lib/gmail/client";
import { createServiceRoleClient } from "@/lib/supabase/service-role";

const MAX_REPLY_ATTEMPTS = 3;

const sendSchema = z.object({
  reply_id: z.string().uuid(),
  // Optional edited body — if absent, send the stored auto_draft_body.
  edited_body: z.string().trim().min(1).max(5000).optional(),
  edited_subject: z.string().trim().min(1).max(300).optional(),
});

const archiveSchema = z.object({
  prospect_id: z.string().uuid(),
  reply_id: z.string().uuid().optional(),
});

export type ReplyFunnelResult = { ok: true; action: string } | { ok: false; error: string };

// ── Approve + send a drafted reply ─────────────────────────────────────────────

export async function approveAndSendReply(
  input: z.input<typeof sendSchema>,
): Promise<ReplyFunnelResult> {
  const user = await requireUser().catch(() => null);
  if (!user) return { ok: false, error: "Not authenticated." };
  if (user.role === "viewer") return { ok: false, error: "Viewers cannot send replies." };

  const parsed = sendSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? "Invalid input." };
  }
  const { reply_id, edited_body, edited_subject } = parsed.data;

  // New columns (reply_attempts, draft_*, archived_no_meeting status) aren't in
  // the generated types yet — cast to any, matching the follow-up/send-queue crons.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const supabase = createServiceRoleClient() as any;

  // ── Load reply + its thread context ────────────────────────────────────────
  type ReplyRow = {
    id: string;
    tenant_id: string;
    prospect_id: string | null;
    pitch_id: string | null;
    from_email: string;
    subject: string | null;
    gmail_rfc_message_id: string | null;
    draft_thread_id: string | null;
    auto_draft_body: string | null;
    draft_subject: string | null;
    draft_status: string | null;
    handled_at: string | null;
  };

  const { data: replyData } = await supabase
    .from("replies")
    .select(
      "id, tenant_id, prospect_id, pitch_id, from_email, subject, gmail_rfc_message_id, draft_thread_id, auto_draft_body, draft_subject, draft_status, handled_at",
    )
    .eq("id", reply_id)
    .eq("tenant_id", user.tenantId)
    .maybeSingle();
  const reply = replyData as ReplyRow | null;

  if (!reply) return { ok: false, error: "Reply not found." };
  if (!reply.prospect_id) return { ok: false, error: "Reply has no linked prospect." };
  if (reply.draft_status === "sent") return { ok: false, error: "This reply has already been sent." };

  const body = (edited_body ?? reply.auto_draft_body ?? "").trim();
  if (!body) return { ok: false, error: "Draft body is empty. Edit the draft before sending." };
  const subject = (edited_subject ?? reply.draft_subject ?? reply.subject ?? "Re:").trim();

  // ── Resolve sender inbox + contact from the original pitch ──────────────────
  type PitchRow = {
    sender_inbox_id: string | null;
    gmail_thread_id: string | null;
    gmail_message_id: string | null;
    contact_id: string | null;
  };
  let pitch: PitchRow | null = null;
  if (reply.pitch_id) {
    const { data } = await supabase
      .from("pitches")
      .select("sender_inbox_id, gmail_thread_id, gmail_message_id, contact_id")
      .eq("id", reply.pitch_id)
      .maybeSingle();
    pitch = data as PitchRow | null;
  }
  if (!pitch?.sender_inbox_id) {
    return { ok: false, error: "Could not find the sender inbox for this thread." };
  }

  // ── Enforce the 3-reply cap ────────────────────────────────────────────────
  const { data: prospectData } = await supabase
    .from("prospects")
    .select("id, company_name, status, reply_attempts")
    .eq("id", reply.prospect_id)
    .maybeSingle();
  const prospect = prospectData as { id: string; company_name: string; status: string; reply_attempts: number | null } | null;
  if (!prospect) return { ok: false, error: "Prospect not found." };

  const attempts = prospect.reply_attempts ?? 0;
  if (attempts >= MAX_REPLY_ATTEMPTS) {
    return {
      ok: false,
      error: `Reply cap reached (${attempts}/${MAX_REPLY_ATTEMPTS}). Book the meeting or archive this prospect.`,
    };
  }

  // ── Load inbox + token ──────────────────────────────────────────────────────
  const { data: inboxData } = await supabase
    .from("sender_inboxes")
    .select("id, email, display_name, paused, gmail_refresh_token_encrypted")
    .eq("id", pitch.sender_inbox_id)
    .eq("tenant_id", user.tenantId)
    .maybeSingle();
  const inbox = inboxData as {
    id: string;
    email: string;
    display_name: string;
    paused: boolean;
    gmail_refresh_token_encrypted: string | null;
  } | null;
  if (!inbox) return { ok: false, error: "Sender inbox not found." };
  if (inbox.paused) return { ok: false, error: "Sender inbox is paused." };
  if (!inbox.gmail_refresh_token_encrypted) {
    return { ok: false, error: "Sender inbox is not connected to Gmail." };
  }

  const tokenResult = await getAccessToken(inbox.gmail_refresh_token_encrypted);
  if (!tokenResult.ok) return { ok: false, error: `Gmail auth failed: ${tokenResult.error}` };

  // ── Send in-thread ──────────────────────────────────────────────────────────
  const threadId = reply.draft_thread_id ?? pitch.gmail_thread_id ?? undefined;
  // Reply TO their message: prefer their RFC Message-ID for In-Reply-To.
  const originalMessageId = reply.gmail_rfc_message_id ?? pitch.gmail_message_id ?? undefined;

  const sendResult = await sendGmailMessage({
    accessToken: tokenResult.accessToken,
    fromEmail: inbox.email,
    fromName: inbox.display_name,
    to: reply.from_email,
    subject: /^re:/i.test(subject) ? subject : `Re: ${subject}`,
    body,
    threadId,
    originalMessageId,
  });

  if (!sendResult.ok) return { ok: false, error: `Send failed: ${sendResult.error}` };

  const now = new Date().toISOString();

  // ── Persist: mark reply sent + handled, bump counter ────────────────────────
  await supabase
    .from("replies")
    .update({
      draft_status: "sent",
      draft_sent_at: now,
      draft_gmail_message_id: sendResult.gmailMessageId,
      auto_draft_body: body, // persist the final (possibly edited) text
      draft_subject: subject,
      handled_by: user.id,
      handled_at: now,
    })
    .eq("id", reply_id)
    .eq("tenant_id", user.tenantId);

  const newAttempts = attempts + 1;
  await supabase
    .from("prospects")
    .update({ reply_attempts: newAttempts })
    .eq("id", reply.prospect_id)
    .eq("tenant_id", user.tenantId);

  await writeAuditLog({
    tenantId: user.tenantId,
    actorId: user.id,
    action: "reply.sent",
    entityType: "reply",
    entityId: reply_id,
    metadata: {
      prospect_id: reply.prospect_id,
      to_email: reply.from_email,
      gmail_message_id: sendResult.gmailMessageId,
      reply_attempt: newAttempts,
      edited: Boolean(edited_body),
    },
  });

  revalidatePath("/inbox");
  revalidatePath(`/companies/${reply.prospect_id}`);
  return { ok: true, action: `sent (attempt ${newAttempts}/${MAX_REPLY_ATTEMPTS})` };
}

// ── Archive a prospect that won't book (with a captured learning) ───────────────

export async function archiveNoMeeting(
  input: z.input<typeof archiveSchema>,
): Promise<ReplyFunnelResult> {
  const user = await requireUser().catch(() => null);
  if (!user) return { ok: false, error: "Not authenticated." };
  if (user.role === "viewer") return { ok: false, error: "Viewers cannot archive prospects." };

  const parsed = archiveSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? "Invalid input." };
  }
  const { prospect_id, reply_id } = parsed.data;

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const supabase = createServiceRoleClient() as any;

  // Pull the recent reply thread for this prospect to summarise WHY.
  const { data: repliesData } = await supabase
    .from("replies")
    .select("intent, body_text, received_at")
    .eq("prospect_id", prospect_id)
    .eq("tenant_id", user.tenantId)
    .order("received_at", { ascending: true })
    .limit(10);
  const replies = (repliesData ?? []) as Array<{ intent: string; body_text: string | null; received_at: string }>;

  const reason = await summariseNoMeetingReason(user.tenantId, replies);

  const now = new Date().toISOString();
  const { error } = await supabase
    .from("prospects")
    .update({
      status: "archived_no_meeting",
      no_meeting_reason: reason,
      archived_at: now,
    })
    .eq("id", prospect_id)
    .eq("tenant_id", user.tenantId);
  if (error) return { ok: false, error: `Could not archive: ${error.message}` };

  // Stop any remaining follow-ups.
  await supabase
    .from("pitches")
    .update({ sequence_paused_at: now })
    .eq("prospect_id", prospect_id)
    .eq("tenant_id", user.tenantId)
    .eq("status", "sent")
    .is("sequence_paused_at", null);

  if (reply_id) {
    await supabase
      .from("replies")
      .update({ handled_by: user.id, handled_at: now })
      .eq("id", reply_id)
      .eq("tenant_id", user.tenantId);
  }

  await writeAuditLog({
    tenantId: user.tenantId,
    actorId: user.id,
    action: "prospect.archived_no_meeting",
    entityType: "prospect",
    entityId: prospect_id,
    metadata: { reason, reply_id: reply_id ?? null },
  });

  revalidatePath("/inbox");
  revalidatePath(`/companies/${prospect_id}`);
  return { ok: true, action: "archived" };
}

// ── Claude-summarised learning (heuristic fallback) ─────────────────────────────

async function summariseNoMeetingReason(
  tenantId: string,
  replies: Array<{ intent: string; body_text: string | null; received_at: string }>,
): Promise<string> {
  const transcript = replies
    .map((r) => `[${r.intent}] ${(r.body_text ?? "").slice(0, 300).replace(/\s+/g, " ").trim()}`)
    .join("\n");

  const heuristic = () => {
    const last = replies[replies.length - 1];
    return (
      `No meeting booked after the reply funnel. ` +
      `Last intent: ${last?.intent ?? "unknown"}. ` +
      (transcript ? `Signals: ${transcript.slice(0, 200)}` : "No reply content captured.")
    );
  };

  if (!claudeIsAvailable() || replies.length === 0) return heuristic();

  const schema = z.object({ reason: z.string().trim().min(10).max(300) });
  const call = await structuredCall({
    model: ANTHROPIC_HAIKU_MODEL,
    system:
      "You analyse a stalled B2B sales conversation. In ONE sentence, state the most likely " +
      "reason no meeting was booked (e.g. price objection, bad timing, wrong person, no budget, " +
      "lost interest, competitor). Be specific and useful for improving future targeting. " +
      'Output JSON: {"reason": string}',
    user: `Conversation (prospect replies, oldest first):\n${transcript || "(none)"}`,
    max_tokens: 120,
    schema,
  });

  if (call.ok) {
    await recordClaudeCall({
      tenantId,
      model: ANTHROPIC_HAIKU_MODEL,
      entity_type: "reply_draft",
      entity_id: null,
      usage: call.usage,
      metadata: { purpose: "no_meeting_reason" },
    }).catch(() => {});
    return call.data.reason;
  }
  return heuristic();
}
