/**
 * Minimal Database type covering Phase 0 queries.
 *
 * Replace with generated types after the schema stabilizes:
 *   supabase gen types typescript --project-id ybbrpqzbedaxsmotgtkh > lib/supabase/types.ts
 *
 * Tables seeded and queryable now:
 *   tenants, brand_instances, users, services, case_studies, icps,
 *   pain_taxonomy, prompts, prompt_variants, blackout_dates
 *
 * Tables typed loosely (unknown rows) can still be queried via the
 * service-role client for cron handlers — just with no type-level
 * guarantees until generated types land.
 */

type UUID = string;
type Timestamptz = string;

type UserRole = "admin" | "reviewer" | "viewer";

// Empty relationship list — we don't expose computed joins via PostgREST
// relationship syntax. We always join explicitly in select().
type NoRels = [];

export type Database = {
  public: {
    Tables: {
      tenants: {
        Row: {
          id: UUID;
          code: string;
          display_name: string;
          default_market: "CA" | "MX" | "US" | "LATAM";
          default_language: "en" | "es";
          timezone: string;
          monthly_budget_usd: number;
          hard_budget_cap_usd: number;
          created_at: Timestamptz;
          updated_at: Timestamptz;
        };
        Insert: Partial<Database["public"]["Tables"]["tenants"]["Row"]> & {
          code: string;
          display_name: string;
          default_market: "CA" | "MX" | "US" | "LATAM";
          default_language: "en" | "es";
        };
        Update: Partial<Database["public"]["Tables"]["tenants"]["Row"]>;
        Relationships: NoRels;
      };
      users: {
        Row: {
          id: UUID;
          tenant_id: UUID;
          email: string;
          full_name: string | null;
          avatar_url: string | null;
          role: UserRole;
          timezone: string;
          invited_by: UUID | null;
          invited_at: Timestamptz | null;
          last_seen_at: Timestamptz | null;
          created_at: Timestamptz;
          updated_at: Timestamptz;
        };
        Insert: {
          id: UUID;
          tenant_id: UUID;
          email: string;
          full_name?: string | null;
          avatar_url?: string | null;
          role?: UserRole;
          timezone?: string;
        };
        Update: Partial<Database["public"]["Tables"]["users"]["Row"]>;
        Relationships: NoRels;
      };
      case_studies: {
        Row: {
          id: UUID;
          tenant_id: UUID;
          brand_instance_id: UUID;
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
          measurable_results: unknown;
          featured_services_id: UUID[];
          tags: string[];
          is_active: boolean;
          sort_order: number;
          created_at: Timestamptz;
          updated_at: Timestamptz;
        };
        Insert: Partial<Database["public"]["Tables"]["case_studies"]["Row"]> & {
          tenant_id: UUID;
          brand_instance_id: UUID;
          client_name: string;
        };
        Update: Partial<Database["public"]["Tables"]["case_studies"]["Row"]>;
        Relationships: NoRels;
      };
      pain_taxonomy: {
        Row: {
          id: UUID;
          tenant_id: UUID;
          code: string;
          display_name_en: string;
          display_name_es: string | null;
          description_en: string | null;
          evidence_phrases_en: string[];
          evidence_phrases_es: string[];
          is_active: boolean;
          created_at: Timestamptz;
          updated_at: Timestamptz;
        };
        Insert: {
          id?: UUID;
          tenant_id: UUID;
          code: string;
          display_name_en: string;
          display_name_es?: string | null;
          description_en?: string | null;
          evidence_phrases_en?: string[];
          evidence_phrases_es?: string[];
          is_active?: boolean;
        };
        Update: {
          display_name_en?: string;
          display_name_es?: string | null;
          description_en?: string | null;
          evidence_phrases_en?: string[];
          evidence_phrases_es?: string[];
          is_active?: boolean;
        };
        Relationships: NoRels;
      };
      case_study_pain_tags: {
        Row: {
          case_study_id: UUID;
          pain_id: UUID;
          strength: number;
        };
        Insert: {
          case_study_id: UUID;
          pain_id: UUID;
          strength?: number;
        };
        Update: {
          strength?: number;
        };
        Relationships: NoRels;
      };
      services: {
        Row: {
          id: UUID;
          tenant_id: UUID;
          code: string;
          display_name_en: string;
          display_name_es: string | null;
          description_en: string | null;
          description_es: string | null;
          price_cad: number | null;
          price_mxn: number | null;
          price_usd: number | null;
          pricing_model: string | null;
          is_active: boolean;
          sort_order: number;
          created_at: Timestamptz;
          updated_at: Timestamptz;
        };
        Insert: Partial<Database["public"]["Tables"]["services"]["Row"]> & {
          tenant_id: UUID;
          code: string;
          display_name_en: string;
        };
        Update: Partial<Database["public"]["Tables"]["services"]["Row"]>;
        Relationships: NoRels;
      };
      icps: {
        Row: {
          id: UUID;
          tenant_id: UUID;
          name: string;
          market: "CA" | "MX" | "US" | "LATAM";
          language: "en" | "es";
          industry_tags: string[];
          geo_regions: string[];
          employee_size_min: number | null;
          employee_size_max: number | null;
          revenue_min_usd: number | null;
          revenue_max_usd: number | null;
          business_types: string[];
          google_places_types: string[];
          search_keywords: string[];
          excluded_keywords: string[];
          is_active: boolean;
          reachable_pool_count: number | null;
          reachable_pool_computed_at: Timestamptz | null;
          created_at: Timestamptz;
          updated_at: Timestamptz;
        };
        Insert: Partial<Database["public"]["Tables"]["icps"]["Row"]> & {
          tenant_id: UUID;
          name: string;
          market: "CA" | "MX" | "US" | "LATAM";
          language: "en" | "es";
        };
        Update: Partial<Database["public"]["Tables"]["icps"]["Row"]>;
        Relationships: NoRels;
      };
    };
    Views: Record<string, never>;
    Functions: Record<string, never>;
  };
};
