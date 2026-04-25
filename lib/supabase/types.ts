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
      invitations: {
        Row: {
          id: UUID;
          tenant_id: UUID;
          email: string;
          role: UserRole;
          token: string;
          invited_by: UUID;
          expires_at: Timestamptz;
          accepted_at: Timestamptz | null;
          created_at: Timestamptz;
        };
        Insert: {
          id?: UUID;
          tenant_id: UUID;
          email: string;
          role?: UserRole;
          token: string;
          invited_by: UUID;
          expires_at?: Timestamptz;
        };
        Update: {
          role?: UserRole;
          accepted_at?: Timestamptz | null;
          expires_at?: Timestamptz;
        };
        Relationships: NoRels;
      };
      sender_inboxes: {
        Row: {
          id: UUID;
          tenant_id: UUID;
          brand_instance_id: UUID;
          user_id: UUID | null;
          email: string;
          display_name: string;
          linkedin_url: string | null;
          warming_stage: string;
          daily_cap: number;
          sends_today: number;
          last_send_at: Timestamptz | null;
          last_reset_date: string;
          bounce_rate_7d: number;
          spam_rate_7d: number;
          paused: boolean;
          paused_reason: string | null;
          gmail_access_token_encrypted: string | null;
          gmail_refresh_token_encrypted: string | null;
          gmail_token_expires_at: Timestamptz | null;
          created_at: Timestamptz;
          updated_at: Timestamptz;
        };
        Insert: {
          id?: UUID;
          tenant_id: UUID;
          brand_instance_id: UUID;
          user_id?: UUID | null;
          email: string;
          display_name: string;
          linkedin_url?: string | null;
          warming_stage?: string;
          daily_cap?: number;
          paused?: boolean;
        };
        Update: {
          display_name?: string;
          linkedin_url?: string | null;
          daily_cap?: number;
          paused?: boolean;
          paused_reason?: string | null;
          user_id?: UUID | null;
          updated_at?: Timestamptz;
        };
        Relationships: NoRels;
      };
      prospect_research: {
        Row: {
          id: UUID;
          tenant_id: UUID;
          prospect_id: UUID;
          what_they_do: string | null;
          tech_stack: string[];
          pain_points: unknown;
          notes: string | null;
          research_method: string;
          evidence_urls: string[];
          raw_html_snapshot_url: string | null;
          last_scraped_at: Timestamptz | null;
          last_edited_by_user_id: UUID | null;
          created_at: Timestamptz;
          updated_at: Timestamptz;
        };
        Insert: {
          id?: UUID;
          tenant_id: UUID;
          prospect_id: UUID;
          what_they_do?: string | null;
          tech_stack?: string[];
          pain_points?: unknown;
          notes?: string | null;
          research_method?: string;
          evidence_urls?: string[];
          raw_html_snapshot_url?: string | null;
          last_scraped_at?: Timestamptz | null;
          last_edited_by_user_id?: UUID | null;
        };
        Update: {
          what_they_do?: string | null;
          tech_stack?: string[];
          pain_points?: unknown;
          notes?: string | null;
          research_method?: string;
          evidence_urls?: string[];
          raw_html_snapshot_url?: string | null;
          last_scraped_at?: Timestamptz | null;
          last_edited_by_user_id?: UUID | null;
        };
        Relationships: NoRels;
      };
      prospects: {
        Row: {
          id: UUID;
          tenant_id: UUID;
          icp_id: UUID | null;
          discovery_run_id: UUID | null;
          discovery_source:
            | "google_places"
            | "industry_directory"
            | "google_operator"
            | "competitor_mining"
            | "linkedin"
            | "manual_upload";
          company_name: string;
          domain: string | null;
          website_url: string | null;
          place_id: string | null;
          industry: string | null;
          employee_size_estimate: number | null;
          address_line: string | null;
          city: string | null;
          region: string | null;
          country_code: string | null;
          postal_code: string | null;
          timezone: string | null;
          market: "CA" | "MX" | "US" | "LATAM";
          language: "en" | "es";
          status: string;
          research_quality_score: number | null;
          match_score: number | null;
          red_flags: string[];
          pitch_gate_passed: boolean;
          consent_basis: string;
          consent_evidence_url: string | null;
          suppressed_at: Timestamptz | null;
          suppressed_reason: string | null;
          cooldown_until: Timestamptz | null;
          cooldown_reason: string | null;
          corrected_by_user_id: UUID | null;
          corrected_at: Timestamptz | null;
          created_at: Timestamptz;
          updated_at: Timestamptz;
        };
        Insert: {
          id?: UUID;
          tenant_id: UUID;
          icp_id?: UUID | null;
          discovery_run_id?: UUID | null;
          discovery_source:
            | "google_places"
            | "industry_directory"
            | "google_operator"
            | "competitor_mining"
            | "linkedin"
            | "manual_upload";
          company_name: string;
          domain?: string | null;
          website_url?: string | null;
          industry?: string | null;
          employee_size_estimate?: number | null;
          address_line?: string | null;
          city?: string | null;
          region?: string | null;
          country_code?: string | null;
          postal_code?: string | null;
          market: "CA" | "MX" | "US" | "LATAM";
          language?: "en" | "es";
          status?: string;
          red_flags?: string[];
        };
        Update: {
          status?: string;
          match_score?: number | null;
          red_flags?: string[];
          suppressed_at?: Timestamptz | null;
          suppressed_reason?: string | null;
          updated_at?: Timestamptz;
        };
        Relationships: NoRels;
      };
      discovery_runs: {
        Row: {
          id: UUID;
          tenant_id: UUID;
          icp_id: UUID | null;
          source:
            | "google_places"
            | "industry_directory"
            | "google_operator"
            | "competitor_mining"
            | "linkedin"
            | "manual_upload";
          triggered_by: UUID | null;
          status: string;
          candidates_found: number;
          candidates_new: number;
          candidates_duplicate: number;
          cost_usd: number;
          error_message: string | null;
          started_at: Timestamptz | null;
          completed_at: Timestamptz | null;
          created_at: Timestamptz;
        };
        Insert: {
          id?: UUID;
          tenant_id: UUID;
          icp_id?: UUID | null;
          source:
            | "google_places"
            | "industry_directory"
            | "google_operator"
            | "competitor_mining"
            | "linkedin"
            | "manual_upload";
          triggered_by?: UUID | null;
          status?: string;
          candidates_found?: number;
          candidates_new?: number;
          candidates_duplicate?: number;
          started_at?: Timestamptz | null;
          completed_at?: Timestamptz | null;
        };
        Update: {
          status?: string;
          candidates_found?: number;
          candidates_new?: number;
          candidates_duplicate?: number;
          cost_usd?: number;
          error_message?: string | null;
          started_at?: Timestamptz | null;
          completed_at?: Timestamptz | null;
        };
        Relationships: NoRels;
      };
      do_not_contact_list: {
        Row: {
          id: UUID;
          tenant_id: UUID;
          entry_type: string;
          email: string | null;
          domain: string | null;
          company_name: string | null;
          notes: string | null;
          added_by: UUID | null;
          created_at: Timestamptz;
        };
        Insert: {
          id?: UUID;
          tenant_id: UUID;
          entry_type: string;
          email?: string | null;
          domain?: string | null;
          company_name?: string | null;
          notes?: string | null;
          added_by?: UUID | null;
        };
        Update: {
          entry_type?: string;
          email?: string | null;
          domain?: string | null;
          company_name?: string | null;
          notes?: string | null;
        };
        Relationships: NoRels;
      };
      blackout_dates: {
        Row: {
          id: UUID;
          tenant_id: UUID;
          market: "CA" | "MX" | "US" | "LATAM";
          blackout_date: string;
          label: string;
          created_at: Timestamptz;
        };
        Insert: {
          id?: UUID;
          tenant_id: UUID;
          market: "CA" | "MX" | "US" | "LATAM";
          blackout_date: string;
          label: string;
        };
        Update: {
          label?: string;
          blackout_date?: string;
        };
        Relationships: NoRels;
      };
      brand_instances: {
        Row: {
          id: UUID;
          tenant_id: UUID;
          code: "RUNNA_CA" | "RUNNA";
          display_name: string;
          website_url: string | null;
          primary_market: "CA" | "MX" | "US" | "LATAM";
          languages: ("en" | "es")[];
          signature_html: string | null;
          logo_url: string | null;
          created_at: Timestamptz;
          updated_at: Timestamptz;
        };
        Insert: {
          id?: UUID;
          tenant_id: UUID;
          code: "RUNNA_CA" | "RUNNA";
          display_name: string;
          website_url?: string | null;
          primary_market: "CA" | "MX" | "US" | "LATAM";
          languages?: ("en" | "es")[];
        };
        Update: {
          display_name?: string;
          website_url?: string | null;
          signature_html?: string | null;
          logo_url?: string | null;
          updated_at?: Timestamptz;
        };
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
