"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { ANTHROPIC_HAIKU_MODEL, claudeIsAvailable } from "@/lib/anthropic/client";
import { isUnderDailyCap, recordClaudeCall } from "@/lib/anthropic/cost-tracking";
import { writeAuditLog } from "@/lib/audit/log";
import { requireUser } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import type { Database } from "@/lib/supabase/types";
import { classifyReplyWithClaude } from "./claude-classifier";
import { classifyReplyHeuristic, type ClassifyResult } from "./classify";

const REPLY_INTENTS = [
  "wants_meeting",
  "wants_info",
  "hard_no",
  "not_now",
  "wrong_person",
  "auto_reply",
  "unclassified",
] as const;

const createReplySchema = z.object({
  prospect_id: z.string().uuid().nullable(),
  from_email: z.string().trim().email().max(200),
  subject: z.string().trim().max(500).nullable(),
  body_text: z.string().trim().max(50_000).nullable(),
  received_at: z.string().datetime().optional(),
});

const intentSchema = z.object({
  reply_id: z.string().uuid(),
  intent: z.enum(REPLY_INTENTS),
});

const handleSchema = z.object({
  reply_id: z.string().uuid(),
});

export type ReplyActionResult = { ok: true } | { ok: false; error: string };

function isMigrationMissing(err: { code?: string; message?: string }): boolean {
  return (
    err.code === "42P01" ||
    err.code === "PGRST205" ||
    Boolean(err.message?.includes("schema cache"))
  );
}

/**
 * Manual-entry reply creation. Pre-Phase 4 the team forwards / pastes
 * replies they receive in their personal inbox so the pipeline state
 * stays accurate. Auto-classifies via heuristic; human can override.
 *
 * Migration 0005 must be applied first (replies.pitch_id NOT NULL would
 * otherwise reject the manual insert).
 */
export async function createManualReply(
  input: z.input<typeof createReplySchema>,
): Promise<ReplyActionResult> {
  const user = await requireUser();
  if (user.role === "viewer") {
    return { ok: false, error: "Viewers cannot enter replies." };
  }

  const parsed = createReplySchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? "Invalid input." };
  }

  const supabase = await createClient();

  // ── PHASE 2: try Claude (Haiku) first, fall back to heuristic ───────
  // Same fallback contract as the pitch composer: Claude path requires
  // an API key AND headroom under the daily cap. Any failure (auth,
  // rate-limit, parse, timeout, empty input) drops to the deterministic
  // heuristic so the user always gets a classification.
  const classifierInput = {
    subject: parsed.data.subject,
    body_text: parsed.data.body_text,
    from_email: parsed.data.from_email,
  };

  let classification: ClassifyResult = classifyReplyHeuristic(classifierInput);
  let method: "heuristic" | "claude" = "heuristic";
  let claudeFallbackReason: string | null = null;
  let claudeCostUsd: number | null = null;

  if (claudeIsAvailable()) {
    const cap = await isUnderDailyCap(user.tenantId);
    if (!cap.under) {
      claudeFallbackReason = `daily cap hit (spent $${cap.spent_today_usd.toFixed(2)} of $${cap.cap_usd.toFixed(2)})`;
    } else {
      const claudeResult = await classifyReplyWithClaude(classifierInput);
      if (claudeResult.ok) {
        classification = claudeResult.result.classification;
        method = "claude";
        claudeCostUsd = claudeResult.result.usage.cost_usd;
        // Record the spend. entity_id stays null until we have the row id.
        await recordClaudeCall({
          tenantId: user.tenantId,
          model: ANTHROPIC_HAIKU_MODEL,
          entity_type: "reply_classify",
          entity_id: null,
          usage: claudeResult.result.usage,
          metadata: {
            from: parsed.data.from_email,
            intent: claudeResult.result.classification.intent,
            urgency: claudeResult.result.classification.urgency,
            sentiment: claudeResult.result.classification.sentiment,
          },
        });
      } else {
        claudeFallbackReason = `${claudeResult.reason}: ${claudeResult.error.slice(0, 200)}`;
        // Parse failures sometimes still cost tokens — record them so
        // the daily cap stays honest.
        if (claudeResult.usage) {
          await recordClaudeCall({
            tenantId: user.tenantId,
            model: ANTHROPIC_HAIKU_MODEL,
            entity_type: "reply_classify",
            entity_id: null,
            usage: claudeResult.usage,
            metadata: {
              from: parsed.data.from_email,
              fallback_reason: claudeResult.reason,
            },
          });
        }
      }
    }
  } else {
    claudeFallbackReason = "ANTHROPIC_API_KEY not set";
  }

  type ReplyInsert = Database["public"]["Tables"]["replies"]["Insert"];
  const payload: ReplyInsert = {
    tenant_id: user.tenantId,
    pitch_id: null, // manual entry — no pitch FK
    prospect_id: parsed.data.prospect_id,
    from_email: parsed.data.from_email.toLowerCase(),
    subject: parsed.data.subject,
    body_text: parsed.data.body_text,
    received_at: parsed.data.received_at ?? new Date().toISOString(),
    intent: classification.intent,
    urgency: classification.urgency,
    sentiment: classification.sentiment,
    classified_at: new Date().toISOString(),
  };

  const { data: created, error } = await supabase
    .from("replies")
    .insert(payload)
    .select("id")
    .single<{ id: string }>();

  if (error) {
    if (isMigrationMissing(error)) {
      return {
        ok: false,
        error:
          "Run migration 0005_replies_nullable_pitch.sql in the Supabase SQL editor first.",
      };
    }
    if (
      error.message?.includes("replies_has_provenance") ||
      error.message?.includes("replies_pitch_id_fkey")
    ) {
      return {
        ok: false,
        error:
          "Reply needs a prospect link (or pitch when Phase 4 lands). Pick a prospect from the dropdown.",
      };
    }
    if (error.code === "23502") {
      // not-null violation on pitch_id → migration not applied
      return {
        ok: false,
        error:
          "Migration 0005 not applied: replies.pitch_id is still NOT NULL. Apply 0005_replies_nullable_pitch.sql.",
      };
    }
    return { ok: false, error: `Could not save reply: ${error.message}` };
  }

  if (created) {
    await writeAuditLog({
      tenantId: user.tenantId,
      actorId: user.id,
      action: "prospect.scored", // closest existing canonical action; Phase 2 adds reply.created
      entityType: "prospect",
      entityId: parsed.data.prospect_id ?? created.id,
      metadata: {
        kind: "reply.created",
        from: parsed.data.from_email,
        intent: classification.intent,
        urgency: classification.urgency,
        method: "manual",
        classifier: method, // "claude" | "heuristic"
        classifier_fallback_reason: claudeFallbackReason,
        classifier_cost_usd: claudeCostUsd,
        classifier_reasoning: classification.reasoning?.slice(0, 200) ?? null,
      },
    });
  }

  revalidatePath("/inbox");
  if (parsed.data.prospect_id) revalidatePath(`/companies/${parsed.data.prospect_id}`);
  return { ok: true };
}

/**
 * Override the auto-classified intent. Reviewer caught a wrong call.
 * Updates classified_at so the activity feed reflects the human edit.
 */
export async function overrideReplyIntent(
  input: z.input<typeof intentSchema>,
): Promise<ReplyActionResult> {
  const user = await requireUser();
  if (user.role === "viewer") {
    return { ok: false, error: "Viewers cannot reclassify replies." };
  }

  const parsed = intentSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? "Invalid input." };
  }

  const supabase = await createClient();
  const { error } = await supabase
    .from("replies")
    .update({
      intent: parsed.data.intent,
      classified_at: new Date().toISOString(),
    })
    .eq("id", parsed.data.reply_id)
    .eq("tenant_id", user.tenantId);

  if (error) return { ok: false, error: `Could not save: ${error.message}` };

  revalidatePath("/inbox");
  return { ok: true };
}

/**
 * Mark a reply as handled (the user has actioned it — replied / booked /
 * suppressed / etc). Records who + when. The hot-leads-unhandled index
 * uses this column.
 */
export async function markReplyHandled(
  input: z.input<typeof handleSchema>,
): Promise<ReplyActionResult> {
  const user = await requireUser();
  if (user.role === "viewer") {
    return { ok: false, error: "Viewers cannot mark replies handled." };
  }

  const parsed = handleSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? "Invalid input." };
  }

  const supabase = await createClient();
  const { error } = await supabase
    .from("replies")
    .update({
      handled_by: user.id,
      handled_at: new Date().toISOString(),
    })
    .eq("id", parsed.data.reply_id)
    .eq("tenant_id", user.tenantId);

  if (error) return { ok: false, error: `Could not mark handled: ${error.message}` };

  revalidatePath("/inbox");
  return { ok: true };
}
