import { createClient } from "@/lib/supabase/server";

export type MeasurableResult = {
  metric: string;
  label: string;
};

export type CaseStudyPainTagJoin = {
  pain_id: string;
  strength: number;
};

export type CaseStudyWithRelations = {
  id: string;
  tenant_id: string;
  brand_instance_id: string;
  client_name: string;
  industry: string | null;
  logo_url: string | null;
  hero_metric_en: string | null;
  hero_metric_es: string | null;
  result_description_en: string | null;
  result_description_es: string | null;
  testimonial_quote_en: string | null;
  testimonial_quote_es: string | null;
  testimonial_author: string | null;
  testimonial_title: string | null;
  measurable_results: MeasurableResult[];
  featured_services_id: string[];
  tags: string[];
  is_active: boolean;
  sort_order: number;
  pain_tags: CaseStudyPainTagJoin[];
};

export type PainTaxonomy = {
  id: string;
  code: string;
  display_name_en: string;
  display_name_es: string | null;
};

export type ServiceLite = {
  id: string;
  code: string;
  display_name_en: string;
  display_name_es: string | null;
};

/**
 * List all active case studies for the tenant with joined pain-tag rows.
 * Ordered by sort_order ascending.
 */
export async function listCaseStudies(tenantId: string): Promise<CaseStudyWithRelations[]> {
  const supabase = await createClient();

  const { data, error } = await supabase
    .from("case_studies")
    .select(
      `
      id, tenant_id, brand_instance_id, client_name, industry, logo_url,
      hero_metric_en, hero_metric_es,
      result_description_en, result_description_es,
      testimonial_quote_en, testimonial_quote_es,
      testimonial_author, testimonial_title,
      measurable_results, featured_services_id, tags,
      is_active, sort_order,
      case_study_pain_tags(pain_id, strength)
    `,
    )
    .eq("tenant_id", tenantId)
    .eq("is_active", true)
    .order("sort_order", { ascending: true })
    .returns<
      Array<
        Omit<CaseStudyWithRelations, "measurable_results" | "pain_tags"> & {
          measurable_results: unknown;
          case_study_pain_tags: CaseStudyPainTagJoin[] | null;
        }
      >
    >();

  if (error) throw new Error(`Failed to load case studies: ${error.message}`);
  if (!data) return [];

  return data.map((row) => ({
    ...row,
    measurable_results: normalizeMeasurableResults(row.measurable_results),
    pain_tags: row.case_study_pain_tags ?? [],
  }));
}

export async function listPainTaxonomy(tenantId: string): Promise<PainTaxonomy[]> {
  const supabase = await createClient();

  const { data, error } = await supabase
    .from("pain_taxonomy")
    .select("id, code, display_name_en, display_name_es")
    .eq("tenant_id", tenantId)
    .eq("is_active", true)
    .order("code", { ascending: true });

  if (error) throw new Error(`Failed to load pain taxonomy: ${error.message}`);
  return data ?? [];
}

export async function listServices(tenantId: string): Promise<ServiceLite[]> {
  const supabase = await createClient();

  const { data, error } = await supabase
    .from("services")
    .select("id, code, display_name_en, display_name_es")
    .eq("tenant_id", tenantId)
    .eq("is_active", true)
    .order("sort_order", { ascending: true });

  if (error) throw new Error(`Failed to load services: ${error.message}`);
  return data ?? [];
}

function normalizeMeasurableResults(raw: unknown): MeasurableResult[] {
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((entry) => {
    if (!entry || typeof entry !== "object") return [];
    const metric = (entry as Record<string, unknown>).metric;
    const label = (entry as Record<string, unknown>).label;
    if (typeof metric !== "string" || typeof label !== "string") return [];
    return [{ metric, label }];
  });
}
