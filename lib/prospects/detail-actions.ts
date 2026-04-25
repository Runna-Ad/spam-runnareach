"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { requireUser } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";

const updateProspectSchema = z.object({
  id: z.string().uuid(),
  company_name: z.string().trim().min(1).max(200),
  domain: z.string().trim().max(200).nullable(),
  website_url: z.string().trim().max(500).nullable(),
  industry: z.string().trim().max(120).nullable(),
  employee_size_estimate: z.number().int().min(0).max(1_000_000).nullable(),
  city: z.string().trim().max(120).nullable(),
  region: z.string().trim().max(120).nullable(),
  match_score: z.number().int().min(0).max(100).nullable(),
});

export type UpdateProspectInput = z.input<typeof updateProspectSchema>;

const painPointSchema = z.object({
  pain_id: z.string().uuid().optional(),
  pain_label: z.string().trim().max(120).optional(),
  evidence_quote: z.string().trim().max(500).optional(),
  evidence_url: z.string().trim().max(500).optional(),
  confidence: z.number().min(0).max(1).optional(),
});

const upsertResearchSchema = z.object({
  prospect_id: z.string().uuid(),
  what_they_do: z.string().trim().max(2000).nullable(),
  tech_stack: z.array(z.string().trim().min(1).max(80)).max(40),
  pain_points: z.array(painPointSchema).max(10),
  notes: z.string().trim().max(5000).nullable(),
  evidence_urls: z.array(z.string().trim().max(500)).max(20),
});

export type UpsertResearchInput = z.input<typeof upsertResearchSchema>;

const transitionSchema = z.object({
  id: z.string().uuid(),
  next_status: z.enum([
    "raw",
    "researched",
    "pitched",
    "replied",
    "meeting_booked",
    "won",
    "lost",
    "suppressed",
  ]),
  suppressed_reason: z.string().trim().max(200).nullable().optional(),
});

export type TransitionStatusInput = z.input<typeof transitionSchema>;

export type DetailActionResult =
  | { ok: true }
  | { ok: false; error: string };

export async function updateProspect(input: UpdateProspectInput): Promise<DetailActionResult> {
  const user = await requireUser();
  if (user.role === "viewer") return { ok: false, error: "Viewers cannot edit prospects." };

  const parsed = updateProspectSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? "Invalid input." };
  }

  const supabase = await createClient();

  const payload = {
    company_name: parsed.data.company_name,
    domain: parsed.data.domain?.trim() || null,
    website_url: parsed.data.website_url?.trim() || null,
    industry: parsed.data.industry?.trim() || null,
    employee_size_estimate: parsed.data.employee_size_estimate,
    city: parsed.data.city?.trim() || null,
    region: parsed.data.region?.trim() || null,
    match_score: parsed.data.match_score,
    updated_at: new Date().toISOString(),
  };

  const { error } = await supabase
    .from("prospects")
    .update(payload as never)
    .eq("id", parsed.data.id)
    .eq("tenant_id", user.tenantId);

  if (error) return { ok: false, error: `Could not save: ${error.message}` };

  revalidatePath(`/companies/${parsed.data.id}`);
  revalidatePath("/companies");
  return { ok: true };
}

export async function upsertResearch(input: UpsertResearchInput): Promise<DetailActionResult> {
  const user = await requireUser();
  if (user.role === "viewer") return { ok: false, error: "Viewers cannot edit research." };

  const parsed = upsertResearchSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? "Invalid input." };
  }

  const supabase = await createClient();

  // Check existing.
  const { data: existing, error: existingErr } = await supabase
    .from("prospect_research")
    .select("id")
    .eq("tenant_id", user.tenantId)
    .eq("prospect_id", parsed.data.prospect_id)
    .maybeSingle<{ id: string }>();

  if (existingErr) {
    if (
      existingErr.code === "42P01" ||
      existingErr.code === "PGRST205" ||
      existingErr.message?.includes("schema cache")
    ) {
      return {
        ok: false,
        error:
          "Research table not found. Run migration 0004_prospect_research.sql in the Supabase SQL editor first.",
      };
    }
    return { ok: false, error: `Lookup failed: ${existingErr.message}` };
  }

  // Drop empty rows. New entries must have either a canonical pain_id (from
  // the picker) OR a legacy pain_label; rows with only evidence and no pain
  // selected are dropped to avoid orphan evidence in the jsonb.
  const cleanedPainPoints = parsed.data.pain_points.filter(
    (p) => p.pain_id || p.pain_label,
  );

  if (existing) {
    const { error } = await supabase
      .from("prospect_research")
      .update({
        what_they_do: parsed.data.what_they_do,
        tech_stack: parsed.data.tech_stack,
        pain_points: cleanedPainPoints as unknown,
        notes: parsed.data.notes,
        evidence_urls: parsed.data.evidence_urls,
        last_edited_by_user_id: user.id,
      } as never)
      .eq("id", existing.id);
    if (error) return { ok: false, error: `Could not save research: ${error.message}` };
  } else {
    const { error } = await supabase.from("prospect_research").insert({
      tenant_id: user.tenantId,
      prospect_id: parsed.data.prospect_id,
      what_they_do: parsed.data.what_they_do,
      tech_stack: parsed.data.tech_stack,
      pain_points: cleanedPainPoints as unknown,
      notes: parsed.data.notes,
      evidence_urls: parsed.data.evidence_urls,
      research_method: "manual",
      last_edited_by_user_id: user.id,
    } as never);
    if (error) return { ok: false, error: `Could not create research: ${error.message}` };
  }

  // Bump prospect status raw → researched if currently raw.
  const { data: prospectRow } = await supabase
    .from("prospects")
    .select("status")
    .eq("id", parsed.data.prospect_id)
    .eq("tenant_id", user.tenantId)
    .maybeSingle<{ status: string }>();
  if (prospectRow?.status === "raw") {
    await supabase
      .from("prospects")
      .update({ status: "researched", updated_at: new Date().toISOString() } as never)
      .eq("id", parsed.data.prospect_id)
      .eq("tenant_id", user.tenantId);
  }

  revalidatePath(`/companies/${parsed.data.prospect_id}`);
  revalidatePath("/companies");
  return { ok: true };
}

export async function transitionStatus(
  input: TransitionStatusInput,
): Promise<DetailActionResult> {
  const user = await requireUser();
  if (user.role === "viewer") return { ok: false, error: "Viewers cannot change status." };

  const parsed = transitionSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? "Invalid input." };
  }

  const supabase = await createClient();
  const nowIso = new Date().toISOString();

  const payload: Record<string, unknown> = {
    status: parsed.data.next_status,
    updated_at: nowIso,
  };
  if (parsed.data.next_status === "suppressed") {
    payload.suppressed_at = nowIso;
    payload.suppressed_reason = parsed.data.suppressed_reason ?? "manual suppression";
  } else {
    payload.suppressed_at = null;
    payload.suppressed_reason = null;
  }

  const { error } = await supabase
    .from("prospects")
    .update(payload as never)
    .eq("id", parsed.data.id)
    .eq("tenant_id", user.tenantId);

  if (error) return { ok: false, error: `Could not change status: ${error.message}` };

  revalidatePath(`/companies/${parsed.data.id}`);
  revalidatePath("/companies");
  return { ok: true };
}

/**
 * Stub for the "Scrape website" button. Real Cheerio scraper lands in the
 * next slice. For now this just returns a "not implemented" result so the
 * UI can show a friendly message instead of throwing.
 */
export async function scrapeWebsiteStub(_prospectId: string): Promise<DetailActionResult> {
  void _prospectId;
  return {
    ok: false,
    error: "Scraper lands in the next slice. Until then, fill research notes manually.",
  };
}
