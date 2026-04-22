-- ============================================================================
-- S.P.A.M. — Runna CA Opportunity Engine
-- Migration 0001 — Initial schema
--
-- Tables: 30. Every table has tenant_id + RLS.
-- Extensions: pgvector, pgcrypto, uuid-ossp.
-- Tenancy: multi-tenant-capable, launch single-tenant (RUNNA_CA).
-- ============================================================================

-- ============================================================================
-- SECTION 1 — Extensions
-- ============================================================================

create extension if not exists "pgcrypto";
create extension if not exists "uuid-ossp";
create extension if not exists "vector";

-- ============================================================================
-- SECTION 2 — Enums
-- ============================================================================

create type market as enum ('CA', 'MX', 'US', 'LATAM');
create type language as enum ('en', 'es');
create type brand_code as enum ('RUNNA_CA', 'RUNNA');

create type user_role as enum ('admin', 'reviewer', 'viewer');

create type consent_basis as enum (
  'conspicuous_publication',       -- email published publicly with business context (CASL)
  'existing_business_relationship',-- prior transaction, inquiry, or relationship (CASL)
  'express_consent',               -- explicit opt-in
  'none'                           -- no legal basis — must not send
);

create type prospect_status as enum (
  'raw',                -- fresh from discovery
  'enriched',           -- deduped + contact-validated
  'researched',         -- brief generated
  'scored',             -- scoring complete
  'match',              -- passed scoring gate
  'no_match',           -- below threshold, archived
  'pitched',            -- pitch generated
  'queued',             -- in approval queue
  'approved',           -- reviewer approved
  'sent',               -- email shipped
  'bounced',            -- hard bounce
  'replied',            -- received reply
  'booked',             -- meeting scheduled
  'ghosted',            -- no reply after follow-ups
  'lost',               -- declined
  'won',                -- converted to retainer
  'suppressed'          -- unsubscribed, do-not-contact
);

create type reply_intent as enum (
  'wants_meeting',
  'wants_info',
  'hard_no',
  'not_now',
  'wrong_person',
  'auto_reply',
  'unclassified'
);

create type reply_urgency as enum ('hot', 'warm', 'cold');
create type reply_sentiment as enum ('positive', 'neutral', 'negative');

create type opportunity_stage as enum (
  'meeting_booked',
  'discovery_done',
  'proposal_sent',
  'negotiation',
  'won',
  'lost'
);

create type warming_stage as enum (
  'not_started',
  'week_1',
  'week_2',
  'week_3',
  'ramp_30',
  'ramp_50',
  'ramp_100',
  'ramp_200',
  'ramp_300',
  'full'
);

create type prompt_purpose as enum (
  'research',
  'scoring',
  'pain_classification',
  'contact_selection',
  'pitch_en',
  'pitch_es',
  'reply_classify',
  'reply_auto_draft',
  'learning_proposal',
  'compliance_footer_ca',
  'compliance_footer_mx'
);

create type prompt_variant_status as enum ('champion', 'challenger', 'candidate', 'retired');

create type prompt_change_status as enum ('pending', 'approved', 'ab_testing', 'promoted', 'rejected');

create type cooldown_reason as enum (
  'hard_no',
  'not_now',
  'wrong_person',
  'ghosted_after_followup',
  'suppressed'
);

create type discovery_source as enum (
  'google_places',
  'industry_directory',
  'google_operator',
  'competitor_mining',
  'linkedin',
  'manual_upload'
);

create type pitch_send_status as enum (
  'draft',
  'queued_for_approval',
  'approved',
  'auto_rejected',
  'reviewer_rejected',
  'sending',
  'sent',
  'bounced',
  'failed'
);

create type pitch_event_type as enum (
  'sent',
  'open',
  'click',
  'reply',
  'bounce',
  'spam_complaint',
  'unsubscribe'
);

-- ============================================================================
-- SECTION 3 — Core: tenants, brand_instances, users
-- ============================================================================

create table tenants (
  id             uuid primary key default gen_random_uuid(),
  code           text not null unique,                         -- 'RUNNA_CA', 'RUNNA_MX'
  display_name   text not null,
  default_market market not null,
  default_language language not null,
  timezone       text not null default 'America/Edmonton',
  monthly_budget_usd numeric(10,2) not null default 75.00,
  hard_budget_cap_usd numeric(10,2) not null default 150.00,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);

create table brand_instances (
  id             uuid primary key default gen_random_uuid(),
  tenant_id      uuid not null references tenants(id) on delete restrict,
  code           brand_code not null,
  display_name   text not null,                                -- 'Runna CA', 'Rünna'
  website_url    text,
  primary_market market not null,
  languages      language[] not null default array['en']::language[],
  signature_html text,
  logo_url       text,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  unique (tenant_id, code)
);

create table users (
  id             uuid primary key references auth.users(id) on delete cascade,
  tenant_id      uuid not null references tenants(id) on delete restrict,
  email          text not null unique,
  full_name      text,
  avatar_url     text,
  role           user_role not null default 'reviewer',
  timezone       text not null default 'America/Edmonton',
  invited_by     uuid references users(id),
  invited_at     timestamptz,
  last_seen_at   timestamptz,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);

create table invitations (
  id             uuid primary key default gen_random_uuid(),
  tenant_id      uuid not null references tenants(id) on delete cascade,
  email          text not null,
  role           user_role not null default 'reviewer',
  token          text not null unique,
  invited_by     uuid not null references users(id),
  expires_at     timestamptz not null default (now() + interval '7 days'),
  accepted_at    timestamptz,
  created_at     timestamptz not null default now()
);

create table audit_log (
  id             uuid primary key default gen_random_uuid(),
  tenant_id      uuid references tenants(id) on delete set null,
  actor_id       uuid references users(id) on delete set null,
  action         text not null,                                -- 'pitch.approved', 'icp.updated'
  entity_type    text,
  entity_id      uuid,
  metadata       jsonb not null default '{}'::jsonb,
  ip_address     inet,
  user_agent     text,
  created_at     timestamptz not null default now()
);

create index idx_audit_log_tenant_created on audit_log(tenant_id, created_at desc);
create index idx_audit_log_actor on audit_log(actor_id, created_at desc);

-- ============================================================================
-- SECTION 4 — Sending infrastructure
-- ============================================================================

create table sender_inboxes (
  id             uuid primary key default gen_random_uuid(),
  tenant_id      uuid not null references tenants(id) on delete cascade,
  brand_instance_id uuid not null references brand_instances(id) on delete restrict,
  user_id        uuid references users(id) on delete set null,
  email          text not null unique,
  display_name   text not null,
  linkedin_url   text,
  warming_stage  warming_stage not null default 'not_started',
  daily_cap      integer not null default 30,
  sends_today    integer not null default 0,
  last_send_at   timestamptz,
  last_reset_date date not null default current_date,
  bounce_rate_7d numeric(5,4) not null default 0,
  spam_rate_7d   numeric(5,4) not null default 0,
  paused         boolean not null default false,
  paused_reason  text,
  gmail_access_token_encrypted text,
  gmail_refresh_token_encrypted text,
  gmail_token_expires_at timestamptz,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);

-- ============================================================================
-- SECTION 5 — Library: services, case studies, pain taxonomy, ICPs
-- ============================================================================

create table services (
  id             uuid primary key default gen_random_uuid(),
  tenant_id      uuid not null references tenants(id) on delete cascade,
  code           text not null,                                -- 'unlimited_design'
  display_name_en text not null,
  display_name_es text,
  description_en text,
  description_es text,
  price_cad      numeric(10,2),
  price_mxn      numeric(10,2),
  price_usd      numeric(10,2),
  pricing_model  text,                                         -- 'monthly', 'project', 'hourly'
  is_active      boolean not null default true,
  sort_order     integer not null default 0,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  unique (tenant_id, code)
);

create table pain_taxonomy (
  id             uuid primary key default gen_random_uuid(),
  tenant_id      uuid not null references tenants(id) on delete cascade,
  code           text not null,                                -- 'poor_mobile_conversion'
  display_name_en text not null,
  display_name_es text,
  description_en text,                                         -- canonical pain label
  evidence_phrases_en text[] not null default '{}',             -- example URL/text phrases that signal this pain
  evidence_phrases_es text[] not null default '{}',
  is_active      boolean not null default true,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  unique (tenant_id, code)
);

create table case_studies (
  id             uuid primary key default gen_random_uuid(),
  tenant_id      uuid not null references tenants(id) on delete cascade,
  brand_instance_id uuid not null references brand_instances(id) on delete restrict,
  client_name    text not null,                                -- 'Ford', 'DiDi', 'Aeromexico'
  industry       text,
  logo_url       text,
  hero_metric_en text,                                         -- '100K+ TikTok followers in 7 months'
  hero_metric_es text,
  result_description_en text,                                   -- full result paragraph
  result_description_es text,
  testimonial_quote_en text,
  testimonial_quote_es text,
  testimonial_author text,
  testimonial_title  text,
  measurable_results jsonb not null default '[]'::jsonb,        -- [{ metric: '+1,400%', label: 'positive sentiment' }]
  featured_services_id uuid[] not null default '{}',             -- services this case demonstrates
  tags           text[] not null default '{}',
  embedding      vector(1536),                                 -- text-embedding-3-small dimensions
  is_active      boolean not null default true,
  sort_order     integer not null default 0,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);

create index idx_case_studies_brand on case_studies(brand_instance_id) where is_active = true;

create table case_study_pain_tags (
  case_study_id  uuid not null references case_studies(id) on delete cascade,
  pain_id        uuid not null references pain_taxonomy(id) on delete cascade,
  strength       numeric(3,2) not null default 1.0             -- 0.0–1.0 how strongly this case addresses this pain
    check (strength >= 0 and strength <= 1),
  primary key (case_study_id, pain_id)
);

create table icps (
  id             uuid primary key default gen_random_uuid(),
  tenant_id      uuid not null references tenants(id) on delete cascade,
  name           text not null,                                -- 'Alberta DTC 5-50 employees'
  market         market not null,
  language       language not null,
  industry_tags  text[] not null default '{}',
  geo_regions    text[] not null default '{}',                 -- ['Alberta', 'British Columbia']
  employee_size_min integer,
  employee_size_max integer,
  revenue_min_usd numeric(12,2),
  revenue_max_usd numeric(12,2),
  business_types text[] not null default '{}',                 -- ['dtc_ecommerce', 'professional_services']
  google_places_types text[] not null default '{}',            -- Google Places 'type' values
  search_keywords text[] not null default '{}',
  excluded_keywords text[] not null default '{}',
  is_active      boolean not null default true,
  reachable_pool_count integer,                                -- last computed size
  reachable_pool_computed_at timestamptz,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);

-- ============================================================================
-- SECTION 6 — Prompt system
-- ============================================================================

create table prompts (
  id             uuid primary key default gen_random_uuid(),
  tenant_id      uuid not null references tenants(id) on delete cascade,
  purpose        prompt_purpose not null,
  language       language not null default 'en',
  description    text,
  is_active      boolean not null default true,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  unique (tenant_id, purpose, language)
);

create table prompt_variants (
  id             uuid primary key default gen_random_uuid(),
  prompt_id      uuid not null references prompts(id) on delete cascade,
  version        text not null,                                -- semver '1.0.0'
  status         prompt_variant_status not null default 'candidate',
  system_prompt  text not null,
  user_prompt_template text not null,                           -- {{vars}} substituted at runtime
  model          text not null,                                -- 'claude-sonnet-4-7'
  temperature    numeric(3,2) default 0.7,
  max_tokens     integer default 1024,
  challenger_traffic_pct numeric(5,2) default 0,               -- 0–100
  hit_count      integer not null default 0,                   -- times used
  reply_count    integer not null default 0,                   -- resulting replies
  booked_count   integer not null default 0,                   -- resulting meetings
  created_by     uuid references users(id),
  promoted_at    timestamptz,
  retired_at     timestamptz,
  created_at     timestamptz not null default now(),
  unique (prompt_id, version)
);

create index idx_prompt_variants_champion on prompt_variants(prompt_id) where status = 'champion';
create index idx_prompt_variants_challenger on prompt_variants(prompt_id) where status = 'challenger';

create table prompt_change_proposals (
  id             uuid primary key default gen_random_uuid(),
  tenant_id      uuid not null references tenants(id) on delete cascade,
  prompt_id      uuid not null references prompts(id) on delete cascade,
  current_variant_id uuid references prompt_variants(id),
  proposed_variant_id uuid references prompt_variants(id),
  status         prompt_change_status not null default 'pending',
  evidence       jsonb not null default '{}'::jsonb,            -- supporting data (N sends, reply lift %)
  expected_impact text,
  reasoning      text,                                         -- Claude's written explanation
  reviewed_by    uuid references users(id),
  reviewed_at    timestamptz,
  proposed_at    timestamptz not null default now(),
  expires_at     timestamptz not null default (now() + interval '14 days')
);

-- ============================================================================
-- SECTION 7 — Discovery runs
-- ============================================================================

create table discovery_runs (
  id             uuid primary key default gen_random_uuid(),
  tenant_id      uuid not null references tenants(id) on delete cascade,
  icp_id         uuid references icps(id) on delete set null,
  source         discovery_source not null,
  triggered_by   uuid references users(id),
  status         text not null default 'pending',              -- pending, running, complete, failed
  candidates_found integer not null default 0,
  candidates_new integer not null default 0,
  candidates_duplicate integer not null default 0,
  cost_usd       numeric(10,4) not null default 0,
  error_message  text,
  started_at     timestamptz,
  completed_at   timestamptz,
  created_at     timestamptz not null default now()
);

-- ============================================================================
-- SECTION 8 — Prospects, contacts, research, scores, pitches
-- ============================================================================

create table prospects (
  id             uuid primary key default gen_random_uuid(),
  tenant_id      uuid not null references tenants(id) on delete cascade,
  icp_id         uuid references icps(id) on delete set null,
  discovery_run_id uuid references discovery_runs(id) on delete set null,
  discovery_source discovery_source not null,

  -- Company identity
  company_name   text not null,
  domain         text,
  website_url    text,
  place_id       text,                                         -- Google Places ID when applicable
  industry       text,
  employee_size_estimate integer,
  address_line   text,
  city           text,
  region         text,
  country_code   text,
  postal_code    text,
  timezone       text,                                         -- derived from address for send-time optimization
  market         market not null,
  language       language not null default 'en',

  -- Status + gating
  status         prospect_status not null default 'raw',
  research_quality_score numeric(3,2),                         -- 0.0–1.0
  match_score    integer,                                      -- composite 0–100
  red_flags      text[] not null default '{}',
  pitch_gate_passed boolean not null default false,

  -- Compliance
  consent_basis  consent_basis not null default 'none',
  consent_evidence_url text,
  suppressed_at  timestamptz,
  suppressed_reason text,

  -- Cooldown (re-pitching)
  cooldown_until timestamptz,
  cooldown_reason cooldown_reason,

  -- Research correction tracking
  corrected_by_user_id uuid references users(id),
  corrected_at   timestamptz,

  -- Timestamps
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),

  unique (tenant_id, domain),
  check (employee_size_estimate is null or employee_size_estimate >= 0),
  check (match_score is null or (match_score >= 0 and match_score <= 100))
);

create index idx_prospects_tenant_status on prospects(tenant_id, status);
create index idx_prospects_icp on prospects(icp_id) where status != 'suppressed';
create index idx_prospects_score on prospects(tenant_id, match_score desc) where status = 'match';

create table prospect_contacts (
  id             uuid primary key default gen_random_uuid(),
  tenant_id      uuid not null references tenants(id) on delete cascade,
  prospect_id    uuid not null references prospects(id) on delete cascade,
  full_name      text,
  role_title     text,
  email          text,
  email_verified boolean not null default false,
  email_is_role_based boolean not null default false,          -- info@, hello@, sales@ → downranked
  linkedin_url   text,
  phone          text,
  priority_rank  integer not null default 1,                   -- 1 = best, higher = worse
  selected_at    timestamptz,                                  -- when engine picked this contact
  selected_by    text,                                         -- 'engine' | 'reviewer'
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);

create index idx_prospect_contacts_prospect on prospect_contacts(prospect_id);
create unique index idx_prospect_contacts_email on prospect_contacts(tenant_id, email) where email is not null;

create table research (
  id             uuid primary key default gen_random_uuid(),
  tenant_id      uuid not null references tenants(id) on delete cascade,
  prospect_id    uuid not null references prospects(id) on delete cascade,
  prompt_variant_id uuid references prompt_variants(id),
  what_they_do   text,
  tech_stack     text[] not null default '{}',
  pain_points    jsonb not null default '[]'::jsonb,           -- [{ pain_code, evidence_url, quote }]
  raw_output     jsonb,                                        -- full Claude response
  quality_score  numeric(3,2),
  cost_usd       numeric(8,4),
  token_count_in integer,
  token_count_out integer,
  generated_at   timestamptz not null default now(),
  superseded_at  timestamptz                                   -- set when Research Correction Loop runs again
);

create index idx_research_prospect_active on research(prospect_id) where superseded_at is null;

create table research_corrections (
  id             uuid primary key default gen_random_uuid(),
  tenant_id      uuid not null references tenants(id) on delete cascade,
  research_id    uuid not null references research(id) on delete cascade,
  corrected_by   uuid not null references users(id),
  original_output jsonb not null,
  corrected_output jsonb not null,
  correction_note text,
  created_at     timestamptz not null default now()
);

create table scores (
  id             uuid primary key default gen_random_uuid(),
  tenant_id      uuid not null references tenants(id) on delete cascade,
  prospect_id    uuid not null references prospects(id) on delete cascade,
  prompt_variant_id uuid references prompt_variants(id),
  composite_score integer not null,                            -- 0–100
  industry_fit_pts integer not null default 0,
  size_fit_pts   integer not null default 0,
  digital_maturity_pts integer not null default 0,
  pain_signal_pts integer not null default 0,
  service_match_pts integer not null default 0,
  contact_discoverability_pts integer not null default 0,
  red_flag_penalty integer not null default 0,
  best_service_id uuid references services(id),
  best_pain_id   uuid references pain_taxonomy(id),
  best_case_study_id uuid references case_studies(id),
  confidence     numeric(3,2),
  reasoning      text,
  cost_usd       numeric(8,4),
  generated_at   timestamptz not null default now(),
  superseded_at  timestamptz
);

create index idx_scores_prospect_active on scores(prospect_id) where superseded_at is null;

create table pitches (
  id             uuid primary key default gen_random_uuid(),
  tenant_id      uuid not null references tenants(id) on delete cascade,
  prospect_id    uuid not null references prospects(id) on delete cascade,
  contact_id     uuid references prospect_contacts(id) on delete set null,
  sender_inbox_id uuid references sender_inboxes(id) on delete set null,
  prompt_variant_id uuid references prompt_variants(id),

  -- Grounding enforcement (schema-level guarantee: every pitch cites a case study)
  case_study_id  uuid not null references case_studies(id),
  service_id     uuid references services(id),
  pain_id        uuid references pain_taxonomy(id),
  measurable_result_included boolean not null default false,

  -- Content
  subject        text not null,
  body_original  text not null,                                -- what Claude generated
  body_edited    text,                                         -- what reviewer saved (if edited)
  body_sent      text,                                         -- final sent copy (with footer)
  compliance_footer text,
  variant_index  integer not null default 1,                   -- 1/2/3 of up-to-three variants

  -- Quality gate
  quality_self_score numeric(3,2),                             -- Claude's pre-queue self-grade
  quality_threshold numeric(3,2) not null default 0.70,
  auto_rejected  boolean not null default false,
  auto_rejected_reason text,

  -- State machine
  status         pitch_send_status not null default 'draft',
  approved_by    uuid references users(id),
  approved_at    timestamptz,
  rejected_by    uuid references users(id),
  rejected_at    timestamptz,
  rejection_reason text,
  queued_at      timestamptz,
  sent_at        timestamptz,
  scheduled_send_at timestamptz,                               -- for send-time optimization

  -- Economics
  cost_usd       numeric(8,4),
  token_count_in integer,
  token_count_out integer,

  -- Thread tracking
  gmail_thread_id text,
  gmail_message_id text,
  postmark_message_id text,

  -- Follow-up linkage
  parent_pitch_id uuid references pitches(id),                 -- follow-up step N points to step N-1
  follow_up_step integer not null default 0,                   -- 0 = first send, 1 = first f/u, 2 = second f/u

  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),

  check (quality_self_score is null or (quality_self_score >= 0 and quality_self_score <= 1)),
  check (variant_index >= 1 and variant_index <= 3),
  check (follow_up_step >= 0 and follow_up_step <= 2)
);

create index idx_pitches_queue on pitches(tenant_id, status) where status = 'queued_for_approval';
create index idx_pitches_prospect on pitches(prospect_id, follow_up_step);
create index idx_pitches_sender_sent on pitches(sender_inbox_id, sent_at desc) where sent_at is not null;

create table pitch_events (
  id             uuid primary key default gen_random_uuid(),
  tenant_id      uuid not null references tenants(id) on delete cascade,
  pitch_id       uuid not null references pitches(id) on delete cascade,
  event_type     pitch_event_type not null,
  event_at       timestamptz not null default now(),
  payload        jsonb not null default '{}'::jsonb,
  ip_address     inet,
  user_agent     text
);

create index idx_pitch_events_pitch_type on pitch_events(pitch_id, event_type, event_at desc);

create table replies (
  id             uuid primary key default gen_random_uuid(),
  tenant_id      uuid not null references tenants(id) on delete cascade,
  pitch_id       uuid not null references pitches(id) on delete cascade,
  prospect_id    uuid not null references prospects(id) on delete cascade,
  gmail_message_id text,
  from_email     text not null,
  subject        text,
  body_text      text,
  body_html      text,
  received_at    timestamptz not null default now(),

  -- Classification
  intent         reply_intent not null default 'unclassified',
  urgency        reply_urgency,
  sentiment      reply_sentiment,
  classified_at  timestamptz,
  classifier_variant_id uuid references prompt_variants(id),
  classification_cost_usd numeric(8,4),

  -- Handoff
  hot_alert_sent_at timestamptz,
  handled_by     uuid references users(id),
  handled_at     timestamptz,
  auto_draft_body text,
  auto_draft_generated_at timestamptz
);

create index idx_replies_pitch on replies(pitch_id, received_at desc);
create index idx_replies_hot_unhandled on replies(tenant_id, received_at desc)
  where intent = 'wants_meeting' and handled_at is null;

-- ============================================================================
-- SECTION 9 — Suppression + compliance
-- ============================================================================

create table suppressions (
  id             uuid primary key default gen_random_uuid(),
  tenant_id      uuid not null references tenants(id) on delete cascade,
  email          text,
  domain         text,
  reason         text not null,                                -- 'unsubscribed', 'bounced_hard', 'spam_complaint', 'manual'
  source_pitch_id uuid references pitches(id) on delete set null,
  suppressed_at  timestamptz not null default now(),
  check (email is not null or domain is not null)
);

create unique index idx_suppressions_email on suppressions(tenant_id, email) where email is not null;
create unique index idx_suppressions_domain on suppressions(tenant_id, domain) where domain is not null;

create table do_not_contact_list (
  id             uuid primary key default gen_random_uuid(),
  tenant_id      uuid not null references tenants(id) on delete cascade,
  entry_type     text not null,                                -- 'existing_client', 'competitor', 'runna_staff', 'friend_of_firm'
  email          text,
  domain         text,
  company_name   text,
  notes          text,
  added_by       uuid references users(id),
  created_at     timestamptz not null default now(),
  check (email is not null or domain is not null or company_name is not null)
);

create index idx_dnc_tenant on do_not_contact_list(tenant_id);

create table blackout_dates (
  id             uuid primary key default gen_random_uuid(),
  tenant_id      uuid not null references tenants(id) on delete cascade,
  market         market not null,
  blackout_date  date not null,
  label          text not null,                                -- 'Canada Day', 'Christmas Day'
  created_at     timestamptz not null default now(),
  unique (tenant_id, market, blackout_date)
);

-- ============================================================================
-- SECTION 10 — Opportunities (post-meeting-booked)
-- ============================================================================

create table opportunities (
  id             uuid primary key default gen_random_uuid(),
  tenant_id      uuid not null references tenants(id) on delete cascade,
  prospect_id    uuid not null references prospects(id) on delete restrict,
  contact_id     uuid references prospect_contacts(id) on delete set null,
  owner_id       uuid references users(id) on delete set null,
  stage          opportunity_stage not null default 'meeting_booked',
  deal_value_cad numeric(12,2),
  probability    numeric(3,2),
  expected_close_date date,
  actual_close_date date,
  services_pitched_ids uuid[] not null default '{}',
  won_services_ids uuid[] not null default '{}',
  loss_reason    text,
  notes          text,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  check (probability is null or (probability >= 0 and probability <= 1))
);

create index idx_opportunities_owner_stage on opportunities(owner_id, stage);
create index idx_opportunities_tenant_stage on opportunities(tenant_id, stage);

create table opportunity_activities (
  id             uuid primary key default gen_random_uuid(),
  tenant_id      uuid not null references tenants(id) on delete cascade,
  opportunity_id uuid not null references opportunities(id) on delete cascade,
  actor_id       uuid references users(id),
  activity_type  text not null,                                -- 'call', 'email', 'meeting', 'note', 'stage_change'
  summary        text not null,
  metadata       jsonb not null default '{}'::jsonb,
  occurred_at    timestamptz not null default now()
);

create index idx_opportunity_activities_opportunity on opportunity_activities(opportunity_id, occurred_at desc);

-- ============================================================================
-- SECTION 11 — Telemetry (deliverability, cost)
-- ============================================================================

create table deliverability_snapshots (
  id             uuid primary key default gen_random_uuid(),
  tenant_id      uuid not null references tenants(id) on delete cascade,
  sender_inbox_id uuid not null references sender_inboxes(id) on delete cascade,
  snapshot_date  date not null,
  sent_count     integer not null default 0,
  delivered_count integer not null default 0,
  bounce_count   integer not null default 0,
  spam_count     integer not null default 0,
  open_count     integer not null default 0,
  click_count    integer not null default 0,
  reply_count    integer not null default 0,
  unsubscribe_count integer not null default 0,
  bounce_rate    numeric(5,4) generated always as (
    case when sent_count > 0 then bounce_count::numeric / sent_count else 0 end
  ) stored,
  created_at     timestamptz not null default now(),
  unique (sender_inbox_id, snapshot_date)
);

create index idx_deliverability_sender_date on deliverability_snapshots(sender_inbox_id, snapshot_date desc);

create table cost_tracking (
  id             uuid primary key default gen_random_uuid(),
  tenant_id      uuid not null references tenants(id) on delete cascade,
  category       text not null,                                -- 'anthropic', 'google_places', 'serpapi', 'postmark', 'unipile'
  sub_category   text,                                         -- e.g. claude model name
  entity_type    text,                                         -- 'research', 'scoring', 'pitch', 'reply_classify'
  entity_id      uuid,
  cost_usd       numeric(10,6) not null,
  metadata       jsonb not null default '{}'::jsonb,
  incurred_at    timestamptz not null default now()
);

create index idx_cost_tenant_date on cost_tracking(tenant_id, incurred_at desc);
create index idx_cost_tenant_category on cost_tracking(tenant_id, category, incurred_at desc);

-- ============================================================================
-- SECTION 12 — updated_at triggers
-- ============================================================================

create or replace function set_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

do $$
declare
  t text;
begin
  for t in
    select c.table_name::text
    from information_schema.columns c
    where c.table_schema = 'public'
      and c.column_name = 'updated_at'
      and c.table_name not like 'pg_%'
  loop
    execute format('create trigger set_updated_at_%I before update on %I for each row execute function set_updated_at()', t, t);
  end loop;
end $$;

-- ============================================================================
-- SECTION 13 — Row-Level Security
-- ============================================================================

-- Helper: returns the tenant_id associated with the current authenticated user.
create or replace function current_tenant_id()
returns uuid language sql stable security definer set search_path = public as $$
  select tenant_id from public.users where id = auth.uid() limit 1
$$;

-- Enable RLS on every table
alter table tenants enable row level security;
alter table brand_instances enable row level security;
alter table users enable row level security;
alter table invitations enable row level security;
alter table audit_log enable row level security;
alter table sender_inboxes enable row level security;
alter table services enable row level security;
alter table pain_taxonomy enable row level security;
alter table case_studies enable row level security;
alter table case_study_pain_tags enable row level security;
alter table icps enable row level security;
alter table prompts enable row level security;
alter table prompt_variants enable row level security;
alter table prompt_change_proposals enable row level security;
alter table discovery_runs enable row level security;
alter table prospects enable row level security;
alter table prospect_contacts enable row level security;
alter table research enable row level security;
alter table research_corrections enable row level security;
alter table scores enable row level security;
alter table pitches enable row level security;
alter table pitch_events enable row level security;
alter table replies enable row level security;
alter table suppressions enable row level security;
alter table do_not_contact_list enable row level security;
alter table blackout_dates enable row level security;
alter table opportunities enable row level security;
alter table opportunity_activities enable row level security;
alter table deliverability_snapshots enable row level security;
alter table cost_tracking enable row level security;

-- Tenant-isolation policy applied to every table with tenant_id
do $$
declare
  t text;
begin
  for t in
    select c.table_name::text
    from information_schema.columns c
    where c.table_schema = 'public'
      and c.column_name = 'tenant_id'
      and c.table_name not like 'pg_%'
  loop
    execute format(
      'create policy tenant_isolation on %I for all to authenticated using (tenant_id = current_tenant_id()) with check (tenant_id = current_tenant_id())',
      t
    );
  end loop;
end $$;

-- Tenants + users: user can read their own rows
create policy users_self_read on users for select to authenticated
  using (id = auth.uid() or tenant_id = current_tenant_id());

create policy users_self_update on users for update to authenticated
  using (id = auth.uid()) with check (id = auth.uid());

create policy tenants_self_read on tenants for select to authenticated
  using (id = current_tenant_id());

-- case_study_pain_tags has no tenant_id directly — inherits from case_studies
create policy cspt_via_case_study on case_study_pain_tags for all to authenticated
  using (
    exists (select 1 from case_studies cs where cs.id = case_study_id and cs.tenant_id = current_tenant_id())
  )
  with check (
    exists (select 1 from case_studies cs where cs.id = case_study_id and cs.tenant_id = current_tenant_id())
  );
