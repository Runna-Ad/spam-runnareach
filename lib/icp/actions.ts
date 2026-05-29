"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { requireUser } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";

const marketEnum = z.enum(["CA", "MX", "US", "LATAM"]);
const languageEnum = z.enum(["en", "es"]);

const nullableInt = z
  .number()
  .int()
  .min(0)
  .max(1_000_000_000)
  .nullable();

const nullableRevenue = z
  .number()
  .min(0)
  .max(1_000_000_000_000)
  .nullable();

const stringArray = z.array(z.string().trim().min(1).max(80)).max(30);

const icpBaseSchema = z.object({
  name: z.string().trim().min(1).max(120),
  market: marketEnum,
  language: languageEnum,
  industry_tags: stringArray,
  geo_regions: stringArray,
  employee_size_min: nullableInt,
  employee_size_max: nullableInt,
  revenue_min_usd: nullableRevenue,
  revenue_max_usd: nullableRevenue,
  business_types: stringArray,
  google_places_types: stringArray,
  search_keywords: stringArray,
  excluded_keywords: stringArray,
  is_active: z.boolean(),
});

const createSchema = icpBaseSchema;
const updateSchema = icpBaseSchema.extend({ id: z.string().uuid() });

export type CreateIcpInput = z.input<typeof createSchema>;
export type UpdateIcpInput = z.input<typeof updateSchema>;

export type IcpActionResult =
  | { ok: true; id: string }
  | { ok: false; error: string };

/**
 * Create a new ICP for the tenant. Admins + reviewers only.
 */
export async function createIcp(input: CreateIcpInput): Promise<IcpActionResult> {
  const user = await requireUser();
  if (user.role === "viewer") return { ok: false, error: "Viewers cannot create ICPs." };

  const parsed = createSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? "Invalid input." };
  }

  const rangeError = validateRanges(parsed.data);
  if (rangeError) return { ok: false, error: rangeError };

  const supabase = await createClient();

  const payload = {
    tenant_id: user.tenantId,
    name: parsed.data.name,
    market: parsed.data.market,
    language: parsed.data.language,
    industry_tags: parsed.data.industry_tags,
    geo_regions: parsed.data.geo_regions,
    employee_size_min: parsed.data.employee_size_min,
    employee_size_max: parsed.data.employee_size_max,
    revenue_min_usd: parsed.data.revenue_min_usd,
    revenue_max_usd: parsed.data.revenue_max_usd,
    business_types: parsed.data.business_types,
    google_places_types: parsed.data.google_places_types,
    search_keywords: parsed.data.search_keywords,
    excluded_keywords: parsed.data.excluded_keywords,
    is_active: parsed.data.is_active,
  };

  // supabase-js 2.47 typing quirk — see tasks/lessons.md "supabase-js 2.47 types `.update()` / `.insert()` payload as `never`".
  const { data, error } = await supabase
    .from("icps")
    .insert(payload)
    .select("id")
    .single<{ id: string }>();

  if (error) return { ok: false, error: `Could not create ICP: ${error.message}` };
  if (!data) return { ok: false, error: "Insert returned no row." };

  revalidatePath("/icp");
  return { ok: true, id: data.id };
}

/**
 * Update an existing ICP. Soft delete is done via updateIcp with is_active=false
 * (or via softDeleteIcp for a dedicated call).
 */
export async function updateIcp(input: UpdateIcpInput): Promise<IcpActionResult> {
  const user = await requireUser();
  if (user.role === "viewer") return { ok: false, error: "Viewers cannot edit ICPs." };

  const parsed = updateSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? "Invalid input." };
  }

  const rangeError = validateRanges(parsed.data);
  if (rangeError) return { ok: false, error: rangeError };

  const supabase = await createClient();

  const payload = {
    name: parsed.data.name,
    market: parsed.data.market,
    language: parsed.data.language,
    industry_tags: parsed.data.industry_tags,
    geo_regions: parsed.data.geo_regions,
    employee_size_min: parsed.data.employee_size_min,
    employee_size_max: parsed.data.employee_size_max,
    revenue_min_usd: parsed.data.revenue_min_usd,
    revenue_max_usd: parsed.data.revenue_max_usd,
    business_types: parsed.data.business_types,
    google_places_types: parsed.data.google_places_types,
    search_keywords: parsed.data.search_keywords,
    excluded_keywords: parsed.data.excluded_keywords,
    is_active: parsed.data.is_active,
    updated_at: new Date().toISOString(),
  };

  const { error } = await supabase
    .from("icps")
    .update(payload)
    .eq("id", parsed.data.id)
    .eq("tenant_id", user.tenantId);

  if (error) return { ok: false, error: `Could not save ICP: ${error.message}` };

  revalidatePath("/icp");
  return { ok: true, id: parsed.data.id };
}

/**
 * Soft delete — sets is_active = false. Past pitches / opportunities that
 * reference this ICP stay referentially intact.
 */
export async function softDeleteIcp(id: string): Promise<IcpActionResult> {
  const user = await requireUser();
  if (user.role === "viewer") return { ok: false, error: "Viewers cannot delete ICPs." };

  const parsed = z.string().uuid().safeParse(id);
  if (!parsed.success) return { ok: false, error: "Invalid ICP id." };

  const supabase = await createClient();

  const { error } = await supabase
    .from("icps")
    .update({ is_active: false, updated_at: new Date().toISOString() })
    .eq("id", parsed.data)
    .eq("tenant_id", user.tenantId);

  if (error) return { ok: false, error: `Could not archive ICP: ${error.message}` };

  revalidatePath("/icp");
  return { ok: true, id: parsed.data };
}

/**
 * Cross-field validation — min ≤ max for employee + revenue ranges.
 * Zod can't express this inside the base schema without chaining refine()
 * per pair, so we do it once here for readability.
 */
function validateRanges(data: {
  employee_size_min: number | null;
  employee_size_max: number | null;
  revenue_min_usd: number | null;
  revenue_max_usd: number | null;
}): string | null {
  if (
    data.employee_size_min !== null &&
    data.employee_size_max !== null &&
    data.employee_size_min > data.employee_size_max
  ) {
    return "Employee size min must be ≤ max.";
  }
  if (
    data.revenue_min_usd !== null &&
    data.revenue_max_usd !== null &&
    data.revenue_min_usd > data.revenue_max_usd
  ) {
    return "Revenue min must be ≤ max.";
  }
  return null;
}
