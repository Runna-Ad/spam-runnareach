"use server";

import { revalidatePath } from "next/cache";
import { writeAuditLog } from "@/lib/audit/log";
import { requireUser } from "@/lib/auth";
import { createServiceRoleClient } from "@/lib/supabase/service-role";
import { recordOptOut } from "@/lib/compliance/opt-out";
import { protectedStatusFilter } from "@/lib/prospects/status";

type ReplyIntent =
  | "wants_meeting"
  | "wants_info"
  | "hard_no"
  | "not_now"
  | "wrong_person"
  | "auto_reply"
  | "bounced"
  | "unclassified";

export type HandleIntentResult =
  | { ok: true; action: string }
  | { ok: false; error: string };

/**
 * Dispatches the appropriate CRM side-effects for a classified reply intent.
 * Uses the service-role client because prospect + pitch updates require
 * elevated access beyond what the anon/user RLS policies allow.
 */
export async function handleReplyIntent(
  replyId: string,
  prospectId: string,
  intent: ReplyIntent,
): Promise<HandleIntentResult> {
  const user = await requireUser().catch(() => null);
  if (!user) return { ok: false, error: "Not authenticated." };
  if (user.role === "viewer") return { ok: false, error: "Not authorised." };

  const supabase = createServiceRoleClient();
  const now = new Date().toISOString();

  // ── helpers ────────────────────────────────────────────────────────────────

  async function markReplyHandled(): Promise<void> {
    await supabase
      .from("replies")
      .update({ handled_by: user!.id, handled_at: now })
      .eq("id", replyId)
      .eq("tenant_id", user!.tenantId);
  }

  async function pauseSequence(): Promise<void> {
    await supabase
      .from("pitches")
      .update({ sequence_paused_at: now })
      .eq("prospect_id", prospectId)
      .eq("tenant_id", user!.tenantId)
      .eq("status", "sent")
      .is("sequence_paused_at", null);
  }

  async function revalidateAll(): Promise<void> {
    revalidatePath("/inbox");
    revalidatePath(`/companies/${prospectId}`);
  }

  // ── intent dispatch ────────────────────────────────────────────────────────

  switch (intent) {
    case "wants_meeting": {
      // A won/lost client asking for a meeting keeps its outcome.
      let bookQuery = supabase
        .from("prospects")
        .update({ status: "booked" })
        .eq("id", prospectId)
        .eq("tenant_id", user.tenantId);
      const bookGuard = protectedStatusFilter("booked", "person");
      if (bookGuard) bookQuery = bookQuery.not("status", "in", bookGuard);
      await bookQuery;

      await pauseSequence();
      await markReplyHandled();

      await writeAuditLog({
        tenantId: user.tenantId,
        actorId: user.id,
        action: "reply.intent_handled",
        entityType: "prospect",
        entityId: prospectId,
        metadata: { reply_id: replyId, intent, outcome: "booked" },
      });

      await revalidateAll();
      return { ok: true, action: "booked" };
    }

    case "hard_no": {
      // Same routine as the unsubscribe link: the ADDRESS goes on the
      // do-not-contact list (a 180-day prospect cooldown alone let a duplicate
      // prospect row or a re-discovery email them again), prospect suppressed,
      // every sequence stopped.
      const { data: replyRow } = await supabase
        .from("replies")
        .select("from_email")
        .eq("id", replyId)
        .eq("tenant_id", user.tenantId)
        .maybeSingle();
      if (!replyRow?.from_email) return { ok: false, error: "Reply not found." };

      const optOut = await recordOptOut(supabase, {
        tenantId: user.tenantId,
        prospectId,
        email: replyRow.from_email,
        source: "reply",
        note: `Marked hard no in /inbox by ${user.id}.`,
      });
      if (!optOut.ok) return { ok: false, error: optOut.error };
      await markReplyHandled();

      await writeAuditLog({
        tenantId: user.tenantId,
        actorId: user.id,
        action: "reply.intent_handled",
        entityType: "prospect",
        entityId: prospectId,
        metadata: { reply_id: replyId, intent, outcome: "suppressed" },
      });

      await revalidateAll();
      return { ok: true, action: "suppressed" };
    }

    case "not_now": {
      const cooldownUntil = new Date(
        Date.now() + 60 * 24 * 60 * 60 * 1000,
      ).toISOString();

      await supabase
        .from("prospects")
        .update({ cooldown_until: cooldownUntil })
        .eq("id", prospectId)
        .eq("tenant_id", user.tenantId);

      await pauseSequence();
      await markReplyHandled();

      await writeAuditLog({
        tenantId: user.tenantId,
        actorId: user.id,
        action: "reply.intent_handled",
        entityType: "prospect",
        entityId: prospectId,
        metadata: { reply_id: replyId, intent, outcome: "snoozed_60d" },
      });

      await revalidateAll();
      return { ok: true, action: "snoozed" };
    }

    case "wrong_person": {
      // Log that the contact is wrong but do NOT suppress the prospect
      await writeAuditLog({
        tenantId: user.tenantId,
        actorId: user.id,
        action: "reply.intent_handled",
        entityType: "prospect",
        entityId: prospectId,
        metadata: {
          reply_id: replyId,
          intent,
          note: "Contact reported as wrong person — prospect not suppressed",
        },
      });

      await markReplyHandled();
      await revalidateAll();
      return { ok: true, action: "wrong_person_noted" };
    }

    case "auto_reply": {
      // Snooze active pitches' follow-up by 14 days
      const snoozeUntil = new Date(
        Date.now() + 14 * 24 * 60 * 60 * 1000,
      ).toISOString();

      // Only the ORIGINAL pitch row carries the sequence (next_followup_at,
      // sequence_step). Dating follow-up rows too made them eligible for a
      // follow-up of their own. And the poll used to pause the sequence on an
      // out-of-office, so a snooze that didn't un-pause it never resumed.
      await supabase
        .from("pitches")
        .update({ next_followup_at: snoozeUntil, sequence_paused_at: null })
        .eq("prospect_id", prospectId)
        .eq("tenant_id", user.tenantId)
        .eq("status", "sent")
        .is("parent_pitch_id", null)
        .lt("sequence_step", 3);

      await markReplyHandled();

      await writeAuditLog({
        tenantId: user.tenantId,
        actorId: user.id,
        action: "reply.intent_handled",
        entityType: "prospect",
        entityId: prospectId,
        metadata: { reply_id: replyId, intent, outcome: "followup_snoozed_14d" },
      });

      await revalidateAll();
      return { ok: true, action: "snoozed_14d" };
    }

    case "bounced": {
      // The address is dead — suppress so we never email it again, and stop the
      // sequence. A long cooldown (1y) doubles as a "don't resurrect" guard.
      const cooldownUntil = new Date(
        Date.now() + 365 * 24 * 60 * 60 * 1000,
      ).toISOString();

      // A bounce on a booked/won/lost client's address keeps the outcome visible;
      // the paused sequence below still stops sending.
      let suppressQuery = supabase
        .from("prospects")
        .update({
          status: "suppressed",
          suppressed_at: now,
          suppressed_reason: "Email bounced (undeliverable)",
          cooldown_until: cooldownUntil,
        })
        .eq("id", prospectId)
        .eq("tenant_id", user.tenantId);
      const suppressGuard = protectedStatusFilter("suppressed", "person");
      if (suppressGuard) suppressQuery = suppressQuery.not("status", "in", suppressGuard);
      await suppressQuery;

      await pauseSequence();
      await markReplyHandled();

      await writeAuditLog({
        tenantId: user.tenantId,
        actorId: user.id,
        action: "reply.intent_handled",
        entityType: "prospect",
        entityId: prospectId,
        metadata: { reply_id: replyId, intent, outcome: "suppressed_bounced" },
      });

      await revalidateAll();
      return { ok: true, action: "suppressed_bounced" };
    }

    case "wants_info":
    case "unclassified": {
      // Just flag as needing attention — no auto side-effects
      await writeAuditLog({
        tenantId: user.tenantId,
        actorId: user.id,
        action: "reply.intent_handled",
        entityType: "prospect",
        entityId: prospectId,
        metadata: { reply_id: replyId, intent, outcome: "needs_attention" },
      });

      await revalidateAll();
      return { ok: true, action: "needs_attention" };
    }

    default: {
      const _exhaustive: never = intent;
      return { ok: false, error: `Unknown intent: ${String(_exhaustive)}` };
    }
  }
}
