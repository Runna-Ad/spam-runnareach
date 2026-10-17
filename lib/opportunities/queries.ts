import { createClient } from "@/lib/supabase/server";
import type { OpportunityStage } from "./outcome";

// opportunities isn't in the hand-written Supabase types (same pattern as
// lib/pitches/events.ts).
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnySupabase = any;

export interface OpportunityRow {
  id: string;
  prospect_id: string;
  company_name: string;
  contact_email: string | null;
  stage: OpportunityStage;
  deal_value_cad: number | null;
  loss_reason: string | null;
  notes: string | null;
  source: string;
  actual_close_date: string | null;
  created_at: string;
}

interface RawRow {
  id: string;
  prospect_id: string;
  stage: OpportunityStage;
  deal_value_cad: number | string | null;
  loss_reason: string | null;
  notes: string | null;
  source: string | null;
  actual_close_date: string | null;
  created_at: string;
  prospects: { company_name: string } | null;
  prospect_contacts: { email: string } | null;
}

export async function listOpportunities(tenantId: string): Promise<OpportunityRow[]> {
  const supabase = (await createClient()) as AnySupabase;
  const { data, error } = await supabase
    .from("opportunities")
    .select(
      "id, prospect_id, stage, deal_value_cad, loss_reason, notes, source, actual_close_date, created_at, prospects(company_name), prospect_contacts(email)",
    )
    .eq("tenant_id", tenantId)
    .order("created_at", { ascending: false })
    .limit(200);

  if (error) {
    console.warn("[opportunities] list failed:", error.message);
    return [];
  }

  return ((data ?? []) as RawRow[]).map((r) => ({
    id: r.id,
    prospect_id: r.prospect_id,
    company_name: r.prospects?.company_name ?? "Unknown company",
    contact_email: r.prospect_contacts?.email ?? null,
    stage: r.stage,
    deal_value_cad: r.deal_value_cad == null ? null : Number(r.deal_value_cad),
    loss_reason: r.loss_reason,
    notes: r.notes,
    source: r.source ?? "manual",
    actual_close_date: r.actual_close_date,
    created_at: r.created_at,
  }));
}
