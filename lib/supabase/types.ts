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
          invited_by?: UUID | null;
          invited_at?: Timestamptz | null;
          last_seen_at?: Timestamptz | null;
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
          gmail_access_token_encrypted?: string | null;
          gmail_refresh_token_encrypted?: string | null;
          gmail_token_expires_at?: Timestamptz | null;
          warming_stage?: string;
          sends_today?: number;
          last_send_at?: Timestamptz | null;
          last_reset_date?: string;
          bounce_rate_7d?: number;
          spam_rate_7d?: number;
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
          site_name: string | null;
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
          site_name?: string | null;
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
          site_name?: string | null;
          tech_stack?: string[];
          pain_points?: unknown;
          notes?: string | null;
          research_method?: string;
          evidence_urls?: string[];
          raw_html_snapshot_url?: string | null;
          last_scraped_at?: Timestamptz | null;
          last_edited_by_user_id?: UUID | null;
          updated_at?: Timestamptz;
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
            | "manual_upload"
            | "yellowpages_ca"
            | "brave_search"
            | "denue"
            | "yelp"
            | "hunter";
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
            | "manual_upload"
            | "yellowpages_ca"
            | "brave_search"
            | "denue"
            | "yelp"
            | "hunter";
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
          icp_id?: UUID | null;
          discovery_run_id?: UUID | null;
          company_name?: string;
          domain?: string | null;
          website_url?: string | null;
          industry?: string | null;
          employee_size_estimate?: number | null;
          address_line?: string | null;
          city?: string | null;
          region?: string | null;
          country_code?: string | null;
          postal_code?: string | null;
          market?: "CA" | "MX" | "US" | "LATAM";
          language?: "en" | "es";
          status?: string;
          research_quality_score?: number | null;
          match_score?: number | null;
          red_flags?: string[];
          pitch_gate_passed?: boolean;
          consent_basis?: string;
          consent_evidence_url?: string | null;
          suppressed_at?: Timestamptz | null;
          suppressed_reason?: string | null;
          cooldown_until?: Timestamptz | null;
          cooldown_reason?: string | null;
          corrected_by_user_id?: UUID | null;
          corrected_at?: Timestamptz | null;
          updated_at?: Timestamptz;
        };
        Relationships: NoRels;
      };
      discovery_jobs: {
        Row: {
          id: UUID;
          tenant_id: UUID;
          icp_id: UUID | null;
          created_by: UUID | null;
          status: string;
          phase: string;
          cursor: number;
          prospect_ids: UUID[];
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          stats: any;
          error_message: string | null;
          heartbeat_at: Timestamptz;
          created_at: Timestamptz;
          completed_at: Timestamptz | null;
        };
        Insert: {
          id?: UUID;
          tenant_id: UUID;
          icp_id?: UUID | null;
          created_by?: UUID | null;
          status?: string;
          phase?: string;
          cursor?: number;
          prospect_ids?: UUID[];
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          stats?: any;
          error_message?: string | null;
          heartbeat_at?: Timestamptz;
          created_at?: Timestamptz;
          completed_at?: Timestamptz | null;
        };
        Update: {
          status?: string;
          phase?: string;
          cursor?: number;
          prospect_ids?: UUID[];
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          stats?: any;
          error_message?: string | null;
          heartbeat_at?: Timestamptz;
          completed_at?: Timestamptz | null;
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
            | "manual_upload"
            | "yellowpages_ca"
            | "brave_search"
            | "denue"
            | "yelp"
            | "hunter";
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
            | "manual_upload"
            | "yellowpages_ca"
            | "brave_search"
            | "denue"
            | "yelp"
            | "hunter";
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
      pitches: {
        Row: {
          id: UUID;
          tenant_id: UUID;
          prospect_id: UUID;
          contact_id: UUID | null;
          sender_inbox_id: UUID | null;
          prompt_variant_id: UUID | null;
          case_study_id: UUID | null;
          service_id: UUID | null;
          pain_id: UUID | null;
          measurable_result_included: boolean;
          subject: string;
          body_original: string;
          body_edited: string | null;
          body_sent: string | null;
          compliance_footer: string | null;
          variant_index: number;
          quality_self_score: number | null;
          quality_threshold: number;
          auto_rejected: boolean;
          auto_rejected_reason: string | null;
          status:
            | "draft"
            | "queued_for_approval"
            | "approved"
            | "auto_rejected"
            | "reviewer_rejected"
            | "sending"
            | "sent"
            | "bounced"
            | "failed";
          approved_by: UUID | null;
          approved_at: Timestamptz | null;
          rejected_by: UUID | null;
          rejected_at: Timestamptz | null;
          rejection_reason: string | null;
          queued_at: Timestamptz | null;
          sent_at: Timestamptz | null;
          scheduled_send_at: Timestamptz | null;
          cost_usd: number | null;
          token_count_in: number | null;
          token_count_out: number | null;
          gmail_thread_id: string | null;
          gmail_message_id: string | null;
          postmark_message_id: string | null;
          parent_pitch_id: UUID | null;
          sequence_step: number;
          next_followup_at: string | null;
          sequence_paused_at: string | null;
        };
        Insert: {
          id?: UUID;
          tenant_id: UUID;
          prospect_id: UUID;
          contact_id?: UUID | null;
          sender_inbox_id?: UUID | null;
          prompt_variant_id?: UUID | null;
          case_study_id?: UUID | null;
          service_id?: UUID | null;
          pain_id?: UUID | null;
          measurable_result_included?: boolean;
          subject: string;
          body_original: string;
          body_edited?: string | null;
          body_sent?: string | null;
          compliance_footer?: string | null;
          variant_index?: number;
          quality_self_score?: number | null;
          quality_threshold?: number;
          auto_rejected?: boolean;
          auto_rejected_reason?: string | null;
          status?:
            | "draft"
            | "queued_for_approval"
            | "approved"
            | "auto_rejected"
            | "reviewer_rejected"
            | "sending"
            | "sent"
            | "bounced"
            | "failed";
          parent_pitch_id?: UUID | null;
          cost_usd?: number | null;
          token_count_in?: number | null;
          token_count_out?: number | null;
          preview_text?: string | null;
        };
        Update: {
          subject?: string;
          body_original?: string;
          body_edited?: string | null;
          body_sent?: string | null;
          compliance_footer?: string | null;
          sender_inbox_id?: UUID | null;
          contact_id?: UUID | null;
          prompt_variant_id?: UUID | null;
          case_study_id?: UUID | null;
          service_id?: UUID | null;
          pain_id?: UUID | null;
          status?:
            | "draft"
            | "queued_for_approval"
            | "approved"
            | "auto_rejected"
            | "reviewer_rejected"
            | "sending"
            | "sent"
            | "bounced"
            | "failed";
          approved_by?: UUID | null;
          approved_at?: Timestamptz | null;
          rejected_by?: UUID | null;
          rejected_at?: Timestamptz | null;
          rejection_reason?: string | null;
          queued_at?: Timestamptz | null;
          sent_at?: Timestamptz | null;
          scheduled_send_at?: Timestamptz | null;
          quality_self_score?: number | null;
          auto_rejected?: boolean;
          auto_rejected_reason?: string | null;
          cost_usd?: number | null;
          token_count_in?: number | null;
          token_count_out?: number | null;
          gmail_thread_id?: string | null;
          gmail_message_id?: string | null;
          postmark_message_id?: string | null;
          sequence_step?: number | null;
          next_followup_at?: string | null;
          sequence_paused_at?: string | null;
        };
        Relationships: NoRels;
      };
      cost_tracking: {
        Row: {
          id: UUID;
          tenant_id: UUID;
          category: string;
          sub_category: string | null;
          entity_type: string | null;
          entity_id: UUID | null;
          cost_usd: number;
          metadata: Record<string, unknown>;
          incurred_at: Timestamptz;
        };
        Insert: {
          id?: UUID;
          tenant_id: UUID;
          category: string;
          sub_category?: string | null;
          entity_type?: string | null;
          entity_id?: UUID | null;
          cost_usd: number;
          metadata?: Record<string, unknown>;
          incurred_at?: Timestamptz;
        };
        Update: {
          metadata?: Record<string, unknown>;
        };
        Relationships: NoRels;
      };
      replies: {
        Row: {
          id: UUID;
          tenant_id: UUID;
          pitch_id: UUID | null;
          prospect_id: UUID;
          gmail_message_id: string | null;
          from_email: string;
          subject: string | null;
          body_text: string | null;
          body_html: string | null;
          received_at: Timestamptz;
          intent:
            | "wants_meeting"
            | "wants_info"
            | "hard_no"
            | "not_now"
            | "wrong_person"
            | "auto_reply"
            | "bounced"
            | "unclassified";
          urgency: "hot" | "warm" | "cold" | null;
          sentiment: "positive" | "neutral" | "negative" | null;
          classified_at: Timestamptz | null;
          classifier_variant_id: UUID | null;
          classification_cost_usd: number | null;
          hot_alert_sent_at: Timestamptz | null;
          handled_by: UUID | null;
          handled_at: Timestamptz | null;
          auto_draft_body: string | null;
          auto_draft_generated_at: Timestamptz | null;
        };
        Insert: {
          id?: UUID;
          tenant_id: UUID;
          pitch_id?: UUID | null;
          // Pre-Phase 4 we make this nullable in the DB (migration 0005)
          // but the production flow always populates one of these:
          prospect_id?: UUID | null;
          gmail_message_id?: string | null;
          from_email: string;
          subject?: string | null;
          body_text?: string | null;
          body_html?: string | null;
          received_at?: Timestamptz;
          intent?:
            | "wants_meeting"
            | "wants_info"
            | "hard_no"
            | "not_now"
            | "wrong_person"
            | "auto_reply"
            | "bounced"
            | "unclassified";
          urgency?: "hot" | "warm" | "cold" | null;
          sentiment?: "positive" | "neutral" | "negative" | null;
          classified_at?: Timestamptz | null;
          classifier_variant_id?: UUID | null;
          classification_cost_usd?: number | null;
          hot_alert_sent_at?: Timestamptz | null;
          handled_by?: UUID | null;
          handled_at?: Timestamptz | null;
          auto_draft_body?: string | null;
          auto_draft_generated_at?: Timestamptz | null;
        };
        Update: {
          intent?:
            | "wants_meeting"
            | "wants_info"
            | "hard_no"
            | "not_now"
            | "wrong_person"
            | "auto_reply"
            | "bounced"
            | "unclassified";
          urgency?: "hot" | "warm" | "cold" | null;
          sentiment?: "positive" | "neutral" | "negative" | null;
          classified_at?: Timestamptz | null;
          handled_by?: UUID | null;
          handled_at?: Timestamptz | null;
          auto_draft_body?: string | null;
          auto_draft_generated_at?: Timestamptz | null;
          hot_alert_sent_at?: Timestamptz | null;
        };
        Relationships: NoRels;
      };
      audit_log: {
        Row: {
          id: UUID;
          tenant_id: UUID | null;
          actor_id: UUID | null;
          action: string;
          entity_type: string | null;
          entity_id: UUID | null;
          metadata: Record<string, unknown>;
          ip_address: string | null;
          user_agent: string | null;
          created_at: Timestamptz;
        };
        Insert: {
          id?: UUID;
          tenant_id?: UUID | null;
          actor_id?: UUID | null;
          action: string;
          entity_type?: string | null;
          entity_id?: UUID | null;
          metadata?: Record<string, unknown>;
          ip_address?: string | null;
          user_agent?: string | null;
          created_at?: Timestamptz;
        };
        Update: {
          metadata?: Record<string, unknown>;
        };
        Relationships: NoRels;
      };
      scores: {
        Row: {
          id: UUID;
          tenant_id: UUID;
          prospect_id: UUID;
          prompt_variant_id: UUID | null;
          composite_score: number;
          industry_fit_pts: number;
          size_fit_pts: number;
          digital_maturity_pts: number;
          pain_signal_pts: number;
          service_match_pts: number;
          contact_discoverability_pts: number;
          red_flag_penalty: number;
          best_service_id: UUID | null;
          best_pain_id: UUID | null;
          best_case_study_id: UUID | null;
          confidence: number | null;
          reasoning: string | null;
          cost_usd: number | null;
          generated_at: Timestamptz;
          superseded_at: Timestamptz | null;
        };
        Insert: {
          id?: UUID;
          tenant_id: UUID;
          prospect_id: UUID;
          prompt_variant_id?: UUID | null;
          composite_score: number;
          industry_fit_pts?: number;
          size_fit_pts?: number;
          digital_maturity_pts?: number;
          pain_signal_pts?: number;
          service_match_pts?: number;
          contact_discoverability_pts?: number;
          red_flag_penalty?: number;
          best_service_id?: UUID | null;
          best_pain_id?: UUID | null;
          best_case_study_id?: UUID | null;
          confidence?: number | null;
          reasoning?: string | null;
          cost_usd?: number | null;
          generated_at?: Timestamptz;
          superseded_at?: Timestamptz | null;
        };
        Update: {
          superseded_at?: Timestamptz | null;
        };
        Relationships: NoRels;
      };
      prospect_contacts: {
        Row: {
          id: UUID;
          tenant_id: UUID;
          prospect_id: UUID;
          full_name: string | null;
          role_title: string | null;
          email: string | null;
          email_verified: boolean;
          email_is_role_based: boolean;
          linkedin_url: string | null;
          phone: string | null;
          priority_rank: number;
          selected_at: Timestamptz | null;
          selected_by: string | null;
          created_at: Timestamptz;
          updated_at: Timestamptz;
        };
        Insert: {
          id?: UUID;
          tenant_id: UUID;
          prospect_id: UUID;
          full_name?: string | null;
          role_title?: string | null;
          email?: string | null;
          email_verified?: boolean;
          email_is_role_based?: boolean;
          linkedin_url?: string | null;
          phone?: string | null;
          priority_rank?: number;
          selected_at?: Timestamptz | null;
          selected_by?: string | null;
        };
        Update: {
          full_name?: string | null;
          role_title?: string | null;
          email?: string | null;
          email_verified?: boolean;
          email_is_role_based?: boolean;
          linkedin_url?: string | null;
          phone?: string | null;
          priority_rank?: number;
          selected_at?: Timestamptz | null;
          selected_by?: string | null;
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
    // ── Prompts ───────────────────────────────────────────────────────────
    prompts: {
      Row: {
        id: UUID;
        tenant_id: UUID;
        purpose: "research" | "scoring" | "pain_classification" | "contact_selection" | "pitch_en" | "pitch_es" | "reply_classify" | "reply_auto_draft" | "learning_proposal" | "compliance_footer_ca" | "compliance_footer_mx";
        language: "en" | "es";
        description: string | null;
        is_active: boolean;
        created_at: Timestamptz;
        updated_at: Timestamptz;
      };
      Insert: {
        id?: UUID;
        tenant_id: UUID;
        purpose: "research" | "scoring" | "pain_classification" | "contact_selection" | "pitch_en" | "pitch_es" | "reply_classify" | "reply_auto_draft" | "learning_proposal" | "compliance_footer_ca" | "compliance_footer_mx";
        language: "en" | "es";
        description?: string | null;
        is_active?: boolean;
        created_at?: Timestamptz;
        updated_at?: Timestamptz;
      };
      Update: Partial<{
        purpose: "research" | "scoring" | "pain_classification" | "contact_selection" | "pitch_en" | "pitch_es" | "reply_classify" | "reply_auto_draft" | "learning_proposal" | "compliance_footer_ca" | "compliance_footer_mx";
        language: "en" | "es";
        description: string | null;
        is_active: boolean;
        updated_at: Timestamptz;
      }>;
      Relationships: NoRels;
    };
    prompt_variants: {
      Row: {
        id: UUID;
        prompt_id: UUID;
        version: string;
        status: "champion" | "challenger" | "candidate" | "retired";
        system_prompt: string;
        user_prompt_template: string;
        model: string;
        temperature: number | null;
        max_tokens: number | null;
        challenger_traffic_pct: number | null;
        hit_count: number;
        reply_count: number;
        booked_count: number;
        created_by: UUID | null;
        promoted_at: Timestamptz | null;
        retired_at: Timestamptz | null;
        created_at: Timestamptz;
      };
      Insert: {
        id?: UUID;
        prompt_id: UUID;
        version: string;
        status?: "champion" | "challenger" | "candidate" | "retired";
        system_prompt: string;
        user_prompt_template: string;
        model: string;
        temperature?: number | null;
        max_tokens?: number | null;
        challenger_traffic_pct?: number | null;
        hit_count?: number;
        reply_count?: number;
        booked_count?: number;
        created_by?: UUID | null;
        promoted_at?: Timestamptz | null;
        retired_at?: Timestamptz | null;
        created_at?: Timestamptz;
      };
      Update: Partial<{
        status: "champion" | "challenger" | "candidate" | "retired";
        system_prompt: string;
        user_prompt_template: string;
        model: string;
        temperature: number | null;
        max_tokens: number | null;
        challenger_traffic_pct: number | null;
        hit_count: number;
        reply_count: number;
        booked_count: number;
        promoted_at: Timestamptz | null;
        retired_at: Timestamptz | null;
      }>;
      Relationships: NoRels;
    };
    prompt_change_proposals: {
      Row: {
        id: UUID;
        tenant_id: UUID;
        prompt_id: UUID;
        current_variant_id: UUID | null;
        proposed_variant_id: UUID | null;
        status: "pending" | "approved" | "ab_testing" | "promoted" | "rejected";
        evidence: Record<string, unknown>;
        expected_impact: string | null;
        reasoning: string | null;
        reviewed_by: UUID | null;
        reviewed_at: Timestamptz | null;
        proposed_at: Timestamptz;
        expires_at: Timestamptz;
      };
      Insert: {
        id?: UUID;
        tenant_id: UUID;
        prompt_id: UUID;
        current_variant_id?: UUID | null;
        proposed_variant_id?: UUID | null;
        status?: "pending" | "approved" | "ab_testing" | "promoted" | "rejected";
        evidence?: Record<string, unknown>;
        expected_impact?: string | null;
        reasoning?: string | null;
        reviewed_by?: UUID | null;
        reviewed_at?: Timestamptz | null;
        proposed_at?: Timestamptz;
        expires_at?: Timestamptz;
      };
      Update: Partial<{
        status: "pending" | "approved" | "ab_testing" | "promoted" | "rejected";
        evidence: Record<string, unknown>;
        expected_impact: string | null;
        reasoning: string | null;
        reviewed_by: UUID | null;
        reviewed_at: Timestamptz | null;
      }>;
      Relationships: NoRels;
    };
    benchmarks: {
      Row: {
        id: UUID;
        tenant_id: UUID;
        statistic: string;
        figure: string;
        pain_codes: string[];
        industry_scope: string[];
        market: string | null;
        source_url: string;
        publisher: string;
        published_date: string | null;
        is_vendor_sourced: boolean;
        caveat: string | null;
        verified_by: UUID | null;
        verified_at: Timestamptz | null;
        is_active: boolean;
        created_at: Timestamptz;
        updated_at: Timestamptz;
      };
      Insert: {
        id?: UUID;
        tenant_id: UUID;
        statistic: string;
        figure: string;
        pain_codes?: string[];
        industry_scope?: string[];
        market?: string | null;
        source_url: string;
        publisher: string;
        published_date?: string | null;
        is_vendor_sourced?: boolean;
        caveat?: string | null;
        verified_by?: UUID | null;
        verified_at?: Timestamptz | null;
        is_active?: boolean;
      };
      Update: {
        statistic?: string;
        figure?: string;
        pain_codes?: string[];
        industry_scope?: string[];
        market?: string | null;
        source_url?: string;
        publisher?: string;
        published_date?: string | null;
        is_vendor_sourced?: boolean;
        caveat?: string | null;
        verified_by?: UUID | null;
        verified_at?: Timestamptz | null;
        is_active?: boolean;
      };
      Relationships: [];
    };
    notable_clients: {
      Row: {
        id: UUID;
        tenant_id: UUID;
        name: string;
        tier: "smb" | "mid_market" | "enterprise";
        industry_tags: string[];
        markets: string[];
        relationship_description: string | null;
        services_provided: string[];
        key_result: string | null;
        description_en: string | null;
        description_es: string | null;
        is_active: boolean;
        sort_order: number;
        created_at: Timestamptz;
        updated_at: Timestamptz;
      };
      Insert: {
        id?: UUID;
        tenant_id: UUID;
        name: string;
        tier?: "smb" | "mid_market" | "enterprise";
        industry_tags?: string[];
        markets?: string[];
        relationship_description?: string | null;
        services_provided?: string[];
        key_result?: string | null;
        description_en?: string | null;
        description_es?: string | null;
        is_active?: boolean;
        sort_order?: number;
        created_at?: Timestamptz;
        updated_at?: Timestamptz;
      };
      Update: Partial<{
        tenant_id: UUID;
        name: string;
        tier: "smb" | "mid_market" | "enterprise";
        industry_tags: string[];
        markets: string[];
        relationship_description: string | null;
        services_provided: string[];
        key_result: string | null;
        description_en: string | null;
        description_es: string | null;
        is_active: boolean;
        sort_order: number;
        updated_at: Timestamptz;
      }>;
      Relationships: NoRels;
    };
    };
    // ────────────────────────────────────────────────────────────────────────
    // Empty views/functions/enums need to be `{ [_ in never]: never }` —
    // `Record<string, never>` doesn't extend `Record<string, GenericView>`
    // and the whole Database falls back to `any`, which then collapses
    // every insert/update payload to `never`.
    Views: { [_ in never]: never };
    Functions: { [_ in never]: never };
    Enums: { [_ in never]: never };
    CompositeTypes: { [_ in never]: never };
  };
};
