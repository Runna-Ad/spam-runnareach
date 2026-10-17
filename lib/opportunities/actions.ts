"use server";

import { revalidatePath } from "next/cache";
import { writeAuditLog } from "@/lib/audit/log";
import { requireUser } from "@/lib/auth";
import { recordPitchEvent } from "@/lib/pitches/events";
import { latestRootSentPitchId } from "@/lib/pitches/root-pitch";
import { createClient } from "@/lib/supabase/server";
import {
  closeDateToday,
  lostSchema,
  wonSchema,
  type MarkLostInput,
  type MarkWonInput,
} from "./outcome";

// opportunities isn't in the hand-written Supabase types.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnySupabase = any;

export type OpportunityActionResult = { ok: true } | { ok: false; error: string };

interface CloseArgs {
  id: string;
  outcome: "won" | "lost";
  fields: Record<string, unknown>;
  payload: Record<string, unknown>;
}

async function closeOpportunity({
  id,
  outcome,
  fields,
  payload,
}: CloseArgs): Promise<OpportunityActionResult> {
  const user = await requireUser();
  if (user.role === "viewer") return { ok: false, error: "Viewers cannot change opportunities." };

  const supabase = (await createClient()) as AnySupabase;
  const closeDate = closeDateToday();

  // Only an open opportunity can be closed: a second click must not append a
  // second event. The row is never deleted.
  const { data: updated, error } = await supabase
    .from("opportunities")
    .update({
      stage: outcome,
      ...fields,
      actual_close_date: closeDate,
      updated_at: new Date().toISOString(),
    })
    .eq("id", id)
    .eq("tenant_id", user.tenantId)
    .not("stage", "in", "(won,lost)")
    .select("id, prospect_id")
    .maybeSingle();

  if (error) return { ok: false, error: `Could not save: ${error.message}` };
  if (!updated) return { ok: false, error: "Opportunity not found or already closed." };

  // Outcomes are recorded against the ROOT sent pitch (the only row the learners read).
  const pitchId = await latestRootSentPitchId(supabase, {
    tenantId: user.tenantId,
    prospectId: updated.prospect_id,
  });
  if (pitchId) {
    await recordPitchEvent(supabase, {
      tenantId: user.tenantId,
      pitchId,
      type: outcome,
      payload: { opportunity_id: id, close_date: closeDate, ...payload },
    });
  }

  // Analytics revenue/won counts read prospects.status, so the funnel only sees the
  // deal once the prospect carries the same outcome.
  const { error: prospectErr } = await supabase
    .from("prospects")
    .update({ status: outcome, updated_at: new Date().toISOString() })
    .eq("id", updated.prospect_id)
    .eq("tenant_id", user.tenantId);
  if (prospectErr) {
    console.warn(`[opportunities] prospect status not set to ${outcome}:`, prospectErr.message);
  }

  await writeAuditLog({
    tenantId: user.tenantId,
    actorId: user.id,
    action: outcome === "won" ? "opportunity.won" : "opportunity.lost",
    entityType: "opportunity",
    entityId: id,
    metadata: { prospect_id: updated.prospect_id, ...payload },
  });

  revalidatePath("/opportunities");
  return { ok: true };
}

export async function markOpportunityWon(input: MarkWonInput): Promise<OpportunityActionResult> {
  const parsed = wonSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? "Invalid input." };
  }
  return closeOpportunity({
    id: parsed.data.id,
    outcome: "won",
    fields: { deal_value_cad: parsed.data.deal_value_cad },
    payload: { deal_value_cad: parsed.data.deal_value_cad },
  });
}

export async function markOpportunityLost(input: MarkLostInput): Promise<OpportunityActionResult> {
  const parsed = lostSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? "Invalid input." };
  }
  return closeOpportunity({
    id: parsed.data.id,
    outcome: "lost",
    fields: { loss_reason: parsed.data.loss_reason },
    payload: { loss_reason: parsed.data.loss_reason },
  });
}
