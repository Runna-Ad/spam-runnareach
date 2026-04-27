"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { claudeIsAvailable } from "@/lib/anthropic/client";
import { isUnderDailyCap, recordClaudeCall } from "@/lib/anthropic/cost-tracking";
import { writeAuditLog } from "@/lib/audit/log";
import { requireUser } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import type { Database } from "@/lib/supabase/types";
import { composePitchWithClaude } from "./claude-composer";
import {
  composePitchHeuristic,
  type ComposedPitch,
  type GeneratorInputContact,
  type GeneratorInputCaseStudy,
  type GeneratorInputResearchPain,
  type GeneratorInputs,
} from "./generator";

const generateSchema = z.object({
  prospect_id: z.string().uuid(),
});
const editSchema = z.object({
  pitch_id: z.string().uuid(),
  subject: z.string().trim().min(1).max(300),
  body_edited: z.string().trim().min(1).max(20_000),
});
const transitionSchema = z.object({
  pitch_id: z.string().uuid(),
  next_status: z.enum([
    "draft",
    "queued_for_approval",
    "approved",
    "reviewer_rejected",
  ]),
  rejection_reason: z.string().trim().max(500).nullable().optional(),
});

export type GeneratePitchResult =
  | {
      ok: true;
      pitch_id: string;
      method: "heuristic" | "claude";
      quality_self_score: number;
      reasoning: string;
    }
  | { ok: false; error: string };

export type PitchActionResult = { ok: true } | { ok: false; error: string };

/**
 * Generate a draft pitch for a prospect. Reads research + contacts +
 * case_studies, runs the heuristic composer, persists to pitches.
 *
 * Phase-2 swap: replace composePitchHeuristic with a Claude call
 * returning the same ComposedPitch shape.
 */
export async function generatePitch(
  prospectId: string,
): Promise<GeneratePitchResult> {
  const user = await requireUser();
  if (user.role === "viewer") {
    return { ok: false, error: "Viewers cannot generate pitches." };
  }

  const parsed = generateSchema.safeParse({ prospect_id: prospectId });
  if (!parsed.success) return { ok: false, error: "Invalid prospect id." };

  const supabase = await createClient();

  // Load prospect.
  type ProspectRow = {
    id: string;
    company_name: string;
    industry: string | null;
    language: "en" | "es";
  };
  const { data: prospect, error: prospectErr } = await supabase
    .from("prospects")
    .select("id, company_name, industry, language")
    .eq("id", parsed.data.prospect_id)
    .eq("tenant_id", user.tenantId)
    .maybeSingle<ProspectRow>();
  if (prospectErr) return { ok: false, error: `Lookup failed: ${prospectErr.message}` };
  if (!prospect) return { ok: false, error: "Prospect not found." };

  // Load research.pain_points.
  type ResearchRow = { pain_points: unknown };
  const { data: research } = await supabase
    .from("prospect_research")
    .select("pain_points")
    .eq("tenant_id", user.tenantId)
    .eq("prospect_id", parsed.data.prospect_id)
    .maybeSingle<ResearchRow>();
  const pains: GeneratorInputResearchPain[] = normalizePains(research?.pain_points ?? null);

  // Load contacts.
  type ContactRow = {
    full_name: string | null;
    email: string | null;
    email_is_role_based: boolean;
    priority_rank: number;
  };
  const { data: contactRows } = await supabase
    .from("prospect_contacts")
    .select("full_name, email, email_is_role_based, priority_rank")
    .eq("tenant_id", user.tenantId)
    .eq("prospect_id", parsed.data.prospect_id)
    .order("priority_rank", { ascending: true })
    .limit(5)
    .returns<ContactRow[]>();
  const contacts: GeneratorInputContact[] = (contactRows ?? []).map((c) => ({
    full_name: c.full_name,
    email: c.email,
    email_is_role_based: c.email_is_role_based,
  }));

  // Load case studies + their pain_tags. We pull all active case studies
  // and their tags, then attach the strength for the pain we'll choose.
  type CaseRow = {
    id: string;
    client_name: string;
    industry: string | null;
    hero_metric_en: string | null;
    hero_metric_es: string | null;
    case_study_pain_tags: { pain_id: string; strength: number }[];
  };
  const { data: caseRows, error: caseErr } = await supabase
    .from("case_studies")
    .select(
      `
      id, client_name, industry, hero_metric_en, hero_metric_es,
      case_study_pain_tags(pain_id, strength)
    `,
    )
    .eq("tenant_id", user.tenantId)
    .eq("is_active", true)
    .returns<CaseRow[]>();
  if (caseErr) return { ok: false, error: `Lookup failed: ${caseErr.message}` };
  if (!caseRows || caseRows.length === 0) {
    return {
      ok: false,
      error: "No active case studies — pitch generator needs at least one.",
    };
  }

  // Determine the chosen pain for case-study scoring (must mirror the
  // generator's pick: first evidenced pain, fallback to first labeled).
  const evidencedPain = pains.find((p) => p.pain_id && p.evidence_quote) ?? null;
  const labelOnlyPain =
    !evidencedPain ? pains.find((p) => p.pain_label && p.pain_id) ?? null : null;
  const chosenPainId = (evidencedPain ?? labelOnlyPain)?.pain_id ?? null;

  const case_studies: GeneratorInputCaseStudy[] = caseRows.map((cs) => ({
    id: cs.id,
    client_name: cs.client_name,
    industry: cs.industry,
    hero_metric_en: cs.hero_metric_en,
    hero_metric_es: cs.hero_metric_es,
    pain_strength: chosenPainId
      ? cs.case_study_pain_tags.find((t) => t.pain_id === chosenPainId)?.strength ?? null
      : null,
  }));

  const generatorInputs: GeneratorInputs = {
    prospect,
    pains,
    contacts,
    case_studies,
    sender: {
      full_name: user.fullName,
      tenant_display_name: user.tenantDisplayName,
    },
    deep_pitch_url: null, // Plumbing-ready: when runna-website API exists, set here.
  };

  // ── PHASE 2: try Claude first, fall back to heuristic ─────────────────
  // Claude path requires both an API key AND headroom under the daily
  // spend cap. Any failure (network, parse, schema, cap) drops through
  // to the deterministic heuristic so the user still gets a draft.
  let composed: ComposedPitch | null = null;
  let method: "heuristic" | "claude" = "heuristic";
  let claudeUsage: { input_tokens: number; output_tokens: number; cost_usd: number } | null = null;
  let claudeModel: string | null = null;
  let claudeFallbackReason: string | null = null;

  if (claudeIsAvailable()) {
    const cap = await isUnderDailyCap(user.tenantId);
    if (!cap.under) {
      claudeFallbackReason = `daily cap hit (spent $${cap.spent_today_usd.toFixed(2)} of $${cap.cap_usd.toFixed(2)})`;
    } else {
      const claudeResult = await composePitchWithClaude(generatorInputs);
      if (claudeResult.ok) {
        composed = claudeResult.result.composed;
        method = "claude";
        claudeUsage = claudeResult.result.usage;
        claudeModel = claudeResult.result.model;
      } else {
        claudeFallbackReason = `${claudeResult.reason}: ${claudeResult.error.slice(0, 200)}`;
        // We still got a usage object (sometimes parse failures cost
        // tokens) — record it so the daily cap stays honest.
        if (claudeResult.usage) {
          await recordClaudeCall({
            tenantId: user.tenantId,
            model: "claude-sonnet-4-5-20250929",
            entity_type: "pitch",
            entity_id: parsed.data.prospect_id,
            usage: claudeResult.usage,
            metadata: { fallback: true, reason: claudeResult.reason, error: claudeResult.error.slice(0, 500) },
          });
        }
      }
    }
  }

  if (!composed) {
    composed = composePitchHeuristic(generatorInputs);
    method = "heuristic";
  }

  if (!composed) {
    return {
      ok: false,
      error: "Generator returned no pitch (no usable case study).",
    };
  }

  // Find the existing top contact_id for the FK (we passed it as contact)
  const { data: contactIdRow } = await supabase
    .from("prospect_contacts")
    .select("id, email")
    .eq("tenant_id", user.tenantId)
    .eq("prospect_id", parsed.data.prospect_id)
    .order("priority_rank", { ascending: true })
    .limit(1)
    .maybeSingle<{ id: string; email: string | null }>();

  type PitchInsert = Database["public"]["Tables"]["pitches"]["Insert"];
  const insert: PitchInsert = {
    tenant_id: user.tenantId,
    prospect_id: parsed.data.prospect_id,
    contact_id: contactIdRow?.id ?? null,
    case_study_id: composed.case_study_id,
    pain_id: composed.pain_id,
    subject: composed.subject,
    body_original: composed.body,
    measurable_result_included: composed.measurable_result_included,
    quality_self_score: composed.quality_self_score,
    status: "draft",
    cost_usd: claudeUsage?.cost_usd ?? 0,
    token_count_in: claudeUsage?.input_tokens ?? null,
    token_count_out: claudeUsage?.output_tokens ?? null,
    variant_index: 1,
  };

  const { data: created, error: insertErr } = await supabase
    .from("pitches")
    .insert(insert)
    .select("id")
    .single<{ id: string }>();

  if (insertErr) return { ok: false, error: `Could not save pitch: ${insertErr.message}` };
  if (!created) return { ok: false, error: "Insert returned no row." };

  // Record successful Claude call cost (failures recorded earlier
  // in the fallback branch).
  if (method === "claude" && claudeUsage && claudeModel) {
    await recordClaudeCall({
      tenantId: user.tenantId,
      model: claudeModel,
      entity_type: "pitch",
      entity_id: created.id,
      usage: { ...claudeUsage, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
      metadata: { pitch_id: created.id, prospect_id: parsed.data.prospect_id },
    });
  }

  await writeAuditLog({
    tenantId: user.tenantId,
    actorId: user.id,
    action: "prospect.scored", // closest existing canonical; Phase 2 adds pitch.generated
    entityType: "prospect",
    entityId: parsed.data.prospect_id,
    metadata: {
      kind: "pitch.generated",
      pitch_id: created.id,
      method,
      quality_self_score: composed.quality_self_score,
      case_study_id: composed.case_study_id,
      pain_id: composed.pain_id,
      cost_usd: claudeUsage?.cost_usd ?? 0,
      fallback_reason: claudeFallbackReason,
    },
  });

  revalidatePath("/pitches");
  revalidatePath(`/companies/${parsed.data.prospect_id}`);

  return {
    ok: true,
    pitch_id: created.id,
    method,
    quality_self_score: composed.quality_self_score,
    reasoning:
      method === "heuristic" && claudeFallbackReason
        ? `${composed.reasoning} (Claude fallback — ${claudeFallbackReason})`
        : composed.reasoning,
  };
}

/**
 * Save edits to subject/body. Marks body_edited (preserves body_original
 * for audit + rerun comparison).
 */
export async function savePitchEdit(
  input: z.input<typeof editSchema>,
): Promise<PitchActionResult> {
  const user = await requireUser();
  if (user.role === "viewer") return { ok: false, error: "Viewers cannot edit pitches." };

  const parsed = editSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? "Invalid input." };
  }

  const supabase = await createClient();
  const { error } = await supabase
    .from("pitches")
    .update({
      subject: parsed.data.subject,
      body_edited: parsed.data.body_edited,
    })
    .eq("id", parsed.data.pitch_id)
    .eq("tenant_id", user.tenantId);

  if (error) return { ok: false, error: `Could not save: ${error.message}` };
  revalidatePath("/pitches");
  return { ok: true };
}

/**
 * Status transition. Captures who+when on approval/rejection.
 */
export async function transitionPitchStatus(
  input: z.input<typeof transitionSchema>,
): Promise<PitchActionResult> {
  const user = await requireUser();
  if (user.role === "viewer") {
    return { ok: false, error: "Viewers cannot change pitch status." };
  }

  const parsed = transitionSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? "Invalid input." };
  }

  const supabase = await createClient();
  const nowIso = new Date().toISOString();
  type PitchUpdate = Database["public"]["Tables"]["pitches"]["Update"];
  const payload: PitchUpdate = { status: parsed.data.next_status };

  if (parsed.data.next_status === "queued_for_approval") {
    payload.queued_at = nowIso;
  }
  if (parsed.data.next_status === "approved") {
    payload.approved_by = user.id;
    payload.approved_at = nowIso;
  }
  if (parsed.data.next_status === "reviewer_rejected") {
    payload.rejected_by = user.id;
    payload.rejected_at = nowIso;
    payload.rejection_reason = parsed.data.rejection_reason ?? "no reason given";
  }

  const { error } = await supabase
    .from("pitches")
    .update(payload)
    .eq("id", parsed.data.pitch_id)
    .eq("tenant_id", user.tenantId);

  if (error) return { ok: false, error: `Could not transition: ${error.message}` };

  revalidatePath("/pitches");
  return { ok: true };
}

function normalizePains(raw: unknown): GeneratorInputResearchPain[] {
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((entry) => {
    if (!entry || typeof entry !== "object") return [];
    const e = entry as Record<string, unknown>;
    const pain_id = typeof e.pain_id === "string" ? e.pain_id : null;
    const pain_label = typeof e.pain_label === "string" ? e.pain_label : null;
    const evidence_quote =
      typeof e.evidence_quote === "string" ? e.evidence_quote : null;
    if (!pain_id && !pain_label) return [];
    return [{ pain_id, pain_label, evidence_quote }];
  });
}
