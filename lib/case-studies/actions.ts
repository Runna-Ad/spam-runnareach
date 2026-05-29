"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { requireUser } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import type { MeasurableResult } from "./queries";

const measurableResultSchema = z.object({
  metric: z.string().trim().min(1).max(120),
  label: z.string().trim().min(1).max(120),
});

const updateInputSchema = z.object({
  id: z.string().uuid(),
  client_name: z.string().trim().min(1).max(120),
  industry: z.string().trim().max(120).nullable(),
  logo_url: z.string().trim().max(500).nullable(),
  hero_metric_en: z.string().trim().max(200).nullable(),
  hero_metric_es: z.string().trim().max(200).nullable(),
  result_description_en: z.string().trim().max(4000).nullable(),
  result_description_es: z.string().trim().max(4000).nullable(),
  testimonial_quote_en: z.string().trim().max(2000).nullable(),
  testimonial_quote_es: z.string().trim().max(2000).nullable(),
  testimonial_author: z.string().trim().max(120).nullable(),
  testimonial_title: z.string().trim().max(120).nullable(),
  measurable_results: z.array(measurableResultSchema).max(10),
  pain_tag_ids: z.array(z.string().uuid()).max(15),
});

export type UpdateCaseStudyInput = z.input<typeof updateInputSchema>;

export type UpdateCaseStudyResult =
  | { ok: true; updatedAt: string }
  | { ok: false; error: string };

export async function updateCaseStudy(
  input: UpdateCaseStudyInput,
): Promise<UpdateCaseStudyResult> {
  const user = await requireUser();
  if (user.role === "viewer") {
    return { ok: false, error: "Viewers cannot edit case studies." };
  }

  const parsed = updateInputSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? "Invalid input." };
  }

  const data = parsed.data;
  const supabase = await createClient();

  const nowIso = new Date().toISOString();

  // supabase-js 2.47 has a typing quirk where `.update()` on tables whose
  // Update type is `Partial<Row>` narrows the payload argument to `never`.
  // We keep structural type safety on `caseStudyPayload` then cast once at the
  // call site. Remove the cast once generated types land.
  const caseStudyPayload = {
    client_name: data.client_name,
    industry: emptyToNull(data.industry),
    logo_url: emptyToNull(data.logo_url),
    hero_metric_en: emptyToNull(data.hero_metric_en),
    hero_metric_es: emptyToNull(data.hero_metric_es),
    result_description_en: emptyToNull(data.result_description_en),
    result_description_es: emptyToNull(data.result_description_es),
    testimonial_quote_en: emptyToNull(data.testimonial_quote_en),
    testimonial_quote_es: emptyToNull(data.testimonial_quote_es),
    testimonial_author: emptyToNull(data.testimonial_author),
    testimonial_title: emptyToNull(data.testimonial_title),
    measurable_results: data.measurable_results satisfies MeasurableResult[],
    updated_at: nowIso,
  };

  const { error: updateError } = await supabase
    .from("case_studies")
    .update(caseStudyPayload)
    .eq("id", data.id)
    .eq("tenant_id", user.tenantId);

  if (updateError) {
    return { ok: false, error: `Could not save case study: ${updateError.message}` };
  }

  const { error: deleteError } = await supabase
    .from("case_study_pain_tags")
    .delete()
    .eq("case_study_id", data.id);

  if (deleteError) {
    return { ok: false, error: `Could not clear pain tags: ${deleteError.message}` };
  }

  if (data.pain_tag_ids.length > 0) {
    const rows = data.pain_tag_ids.map((pain_id) => ({
      case_study_id: data.id,
      pain_id,
      strength: 1.0,
    }));

    // Same typing quirk as update above.
    const { error: insertError } = await supabase
      .from("case_study_pain_tags")
      .insert(rows);

    if (insertError) {
      return { ok: false, error: `Could not save pain tags: ${insertError.message}` };
    }
  }

  revalidatePath("/case-studies");
  return { ok: true, updatedAt: nowIso };
}

function emptyToNull(value: string | null | undefined): string | null {
  if (value === undefined || value === null) return null;
  const trimmed = value.trim();
  return trimmed.length === 0 ? null : trimmed;
}
