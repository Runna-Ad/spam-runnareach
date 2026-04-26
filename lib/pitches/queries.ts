import { createClient } from "@/lib/supabase/server";

export type PitchStatus =
  | "draft"
  | "queued_for_approval"
  | "approved"
  | "auto_rejected"
  | "reviewer_rejected"
  | "sending"
  | "sent"
  | "bounced"
  | "failed";

export type PitchListRow = {
  id: string;
  prospect_id: string;
  prospect_name: string | null;
  prospect_market: "CA" | "MX" | "US" | "LATAM" | null;
  prospect_language: "en" | "es" | null;
  case_study_id: string;
  case_study_client: string | null;
  status: PitchStatus;
  subject: string;
  variant_index: number;
  quality_self_score: number | null;
  contact_email: string | null;
  contact_name: string | null;
  pain_label: string | null;
  approved_at: string | null;
  sent_at: string | null;
  created_at: string;
  updated_at: string;
};

/**
 * Newest-first list of pitches for the tenant. Caps at 200 — beyond that
 * we'll add filters/pagination (Phase 4 sending throughput question).
 */
export async function listPitches(tenantId: string): Promise<PitchListRow[]> {
  const supabase = await createClient();

  type Row = {
    id: string;
    prospect_id: string;
    case_study_id: string;
    status: PitchStatus;
    subject: string;
    variant_index: number;
    quality_self_score: number | null;
    pain_id: string | null;
    approved_at: string | null;
    sent_at: string | null;
    created_at?: string;
    updated_at?: string;
    prospects: {
      company_name: string;
      market: "CA" | "MX" | "US" | "LATAM";
      language: "en" | "es";
    } | null;
    case_studies: { client_name: string } | null;
    prospect_contacts: { full_name: string | null; email: string | null } | null;
    pain_taxonomy: { display_name_en: string } | null;
  };

  const { data, error } = await supabase
    .from("pitches")
    .select(
      `
      id, prospect_id, case_study_id, status, subject, variant_index,
      quality_self_score, pain_id, approved_at, sent_at,
      prospects(company_name, market, language),
      case_studies(client_name),
      prospect_contacts:contact_id(full_name, email),
      pain_taxonomy:pain_id(display_name_en)
    `,
    )
    .eq("tenant_id", tenantId)
    .order("queued_at", { ascending: false, nullsFirst: false })
    .limit(200)
    .returns<Row[]>();

  if (error) throw new Error(`Failed to load pitches: ${error.message}`);

  return (data ?? []).map((r) => ({
    id: r.id,
    prospect_id: r.prospect_id,
    prospect_name: r.prospects?.company_name ?? null,
    prospect_market: r.prospects?.market ?? null,
    prospect_language: r.prospects?.language ?? null,
    case_study_id: r.case_study_id,
    case_study_client: r.case_studies?.client_name ?? null,
    status: r.status,
    subject: r.subject,
    variant_index: r.variant_index,
    quality_self_score: r.quality_self_score,
    contact_email: r.prospect_contacts?.email ?? null,
    contact_name: r.prospect_contacts?.full_name ?? null,
    pain_label: r.pain_taxonomy?.display_name_en ?? null,
    approved_at: r.approved_at,
    sent_at: r.sent_at,
    created_at: r.created_at ?? new Date().toISOString(),
    updated_at: r.updated_at ?? r.created_at ?? new Date().toISOString(),
  }));
}

export type PitchDetail = PitchListRow & {
  body_original: string;
  body_edited: string | null;
  body_sent: string | null;
  measurable_result_included: boolean;
  auto_rejected: boolean;
  auto_rejected_reason: string | null;
  rejection_reason: string | null;
};

export async function getPitch(
  tenantId: string,
  pitchId: string,
): Promise<PitchDetail | null> {
  const supabase = await createClient();
  const { data, error } = await supabase
    .from("pitches")
    .select(
      `
      id, prospect_id, case_study_id, status, subject, variant_index,
      quality_self_score, pain_id, approved_at, sent_at,
      body_original, body_edited, body_sent,
      measurable_result_included, auto_rejected, auto_rejected_reason,
      rejection_reason,
      prospects(company_name, market, language),
      case_studies(client_name),
      prospect_contacts:contact_id(full_name, email),
      pain_taxonomy:pain_id(display_name_en)
    `,
    )
    .eq("tenant_id", tenantId)
    .eq("id", pitchId)
    .maybeSingle();

  if (error) throw new Error(`Failed to load pitch: ${error.message}`);
  if (!data) return null;

  type Row = NonNullable<typeof data>;
  const r = data as Row & {
    prospects: { company_name: string; market: "CA" | "MX" | "US" | "LATAM"; language: "en" | "es" } | null;
    case_studies: { client_name: string } | null;
    prospect_contacts: { full_name: string | null; email: string | null } | null;
    pain_taxonomy: { display_name_en: string } | null;
  };

  return {
    id: r.id,
    prospect_id: r.prospect_id,
    prospect_name: r.prospects?.company_name ?? null,
    prospect_market: r.prospects?.market ?? null,
    prospect_language: r.prospects?.language ?? null,
    case_study_id: r.case_study_id,
    case_study_client: r.case_studies?.client_name ?? null,
    status: r.status,
    subject: r.subject,
    variant_index: r.variant_index,
    quality_self_score: r.quality_self_score,
    contact_email: r.prospect_contacts?.email ?? null,
    contact_name: r.prospect_contacts?.full_name ?? null,
    pain_label: r.pain_taxonomy?.display_name_en ?? null,
    approved_at: r.approved_at,
    sent_at: r.sent_at,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    body_original: r.body_original,
    body_edited: r.body_edited,
    body_sent: r.body_sent,
    measurable_result_included: r.measurable_result_included,
    auto_rejected: r.auto_rejected,
    auto_rejected_reason: r.auto_rejected_reason,
    rejection_reason: r.rejection_reason,
  };
}

export async function getPitchCounts(
  tenantId: string,
): Promise<{ total: number; draft: number; queued: number; approved: number; sent: number }> {
  const supabase = await createClient();
  type Row = { status: PitchStatus };
  const { data, error } = await supabase
    .from("pitches")
    .select("status")
    .eq("tenant_id", tenantId)
    .returns<Row[]>();

  if (error) throw new Error(`Failed to count pitches: ${error.message}`);
  const rows = data ?? [];
  return {
    total: rows.length,
    draft: rows.filter((r) => r.status === "draft").length,
    queued: rows.filter((r) => r.status === "queued_for_approval").length,
    approved: rows.filter((r) => r.status === "approved").length,
    sent: rows.filter((r) => r.status === "sent").length,
  };
}
