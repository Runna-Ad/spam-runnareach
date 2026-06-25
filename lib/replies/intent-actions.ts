"use server";

import { revalidatePath } from "next/cache";
import { writeAuditLog } from "@/lib/audit/log";
import { requireUser } from "@/lib/auth";
import { createServiceRoleClient } from "@/lib/supabase/service-role";

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
      await supabase
        .from("prospects")
        .update({ status: "booked" })
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
        metadata: { reply_id: replyId, intent, outcome: "booked" },
      });

      await revalidateAll();
      return { ok: true, action: "booked" };
    }

    case "hard_no": {
      const cooldownUntil = new Date(
        Date.now() + 180 * 24 * 60 * 60 * 1000,
      ).toISOString();

      await supabase
        .from("prospects")
        .update({
          status: "suppressed",
          suppressed_at: now,
          suppressed_reason: "Hard no reply",
          cooldown_until: cooldownUntil,
        })
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

      await supabase
        .from("pitches")
        .update({ next_followup_at: snoozeUntil })
        .eq("prospect_id", prospectId)
        .eq("tenant_id", user.tenantId)
        .eq("status", "sent");

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

      await supabase
        .from("prospects")
        .update({
          status: "suppressed",
          suppressed_at: now,
          suppressed_reason: "Email bounced (undeliverable)",
          cooldown_until: cooldownUntil,
        })
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
