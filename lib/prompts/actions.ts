"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { requireUser } from "@/lib/auth";
import { getPromptDetail } from "./queries";
import type { PromptDetail, PromptProposal } from "./types";

export async function fetchPromptDetail(promptId: string): Promise<PromptDetail | null> {
  return getPromptDetail(promptId);
}

type ReviewAction = "approve" | "reject" | "start_ab";

export async function reviewProposal(proposalId: string, action: ReviewAction) {
  const user = await requireUser();
  const supabase = await createClient();

  const { data: rawProposal } = await supabase
    .from("prompt_change_proposals")
    .select("*")
    .eq("id", proposalId)
    .eq("tenant_id", user.tenantId)
    .single();

  const proposal = rawProposal as PromptProposal | null;
  if (!proposal) return { ok: false, error: "Proposal not found" };

  const now = new Date().toISOString();

  if (action === "approve" || action === "start_ab") {
    // Promote proposed_variant to challenger (for A/B) or champion (for approve)
    if (proposal.proposed_variant_id) {
      const newStatus = action === "approve" ? "champion" : "challenger";
      const trafficPct = action === "start_ab" ? 20 : 0; // 20% challenger traffic for A/B

      await supabase
        .from("prompt_variants")
        .update({ status: newStatus, challenger_traffic_pct: trafficPct, promoted_at: now })
        .eq("id", proposal.proposed_variant_id);

      // Retire current champion only on full approve
      if (action === "approve" && proposal.current_variant_id) {
        await supabase
          .from("prompt_variants")
          .update({ status: "retired", retired_at: now })
          .eq("id", proposal.current_variant_id);
      }
    }

    const proposalStatus = action === "approve" ? "approved" : "ab_testing";
    await supabase
      .from("prompt_change_proposals")
      .update({
        status: proposalStatus,
        reviewed_by: user.id,
        reviewed_at: now,
      })
      .eq("id", proposalId);
  }

  if (action === "reject") {
    // Retire the proposed variant
    if (proposal.proposed_variant_id) {
      await supabase
        .from("prompt_variants")
        .update({ status: "retired", retired_at: now })
        .eq("id", proposal.proposed_variant_id);
    }

    await supabase
      .from("prompt_change_proposals")
      .update({
        status: "rejected",
        reviewed_by: user.id,
        reviewed_at: now,
      })
      .eq("id", proposalId);
  }

  revalidatePath("/learning");
  return { ok: true };
}

export async function rollbackVariant(variantId: string, promptId: string) {
  const _user = await requireUser();
  const supabase = await createClient();

  const now = new Date().toISOString();

  // Retire current champion
  await supabase
    .from("prompt_variants")
    .update({ status: "retired", retired_at: now })
    .eq("prompt_id", promptId)
    .eq("status", "champion");

  // Promote selected variant to champion
  await supabase
    .from("prompt_variants")
    .update({ status: "champion", promoted_at: now, retired_at: null })
    .eq("id", variantId);

  revalidatePath("/learning");
  return { ok: true };
}

export async function runWeeklyAnalysis(promptId: string) {
  // Stub — in Phase 5 this will call Claude with the learning_proposal prompt,
  // passing 4-week rolling window data, and insert a prompt_change_proposal.
  // For now, surface a toast so Pedro knows it's coming.
  void promptId;
  return {
    ok: false,
    error: "Weekly analysis runs automatically every Sunday. Manual trigger coming in Phase 5.",
  };
}
