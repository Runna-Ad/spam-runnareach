-- ============================================================================
-- S.P.A.M. — Seed Data
-- Run after 0001_initial_schema.sql
--
-- Seeds:
--   - 1 tenant (SAGA-CA)
--   - 2 brand instances (SAGA + RUNNA)
--   - 5 SAGA services with CAD/MXN/USD pricing
--   - 15 pain taxonomy entries
--   - 10 Rünna case studies (Ford, DiDi, Aeromexico, Bayer/Aspirina,
--     Golden Hills, ANA Seguros, Pet's Club, SnapPad, Niki, DevFest YYC)
--   - 2 Alberta ICPs (DTC + pro services)
--   - 11 prompt purposes × 1 champion variant each
--   - 14 Canadian 2026 blackout dates
-- ============================================================================

-- ----------------------------------------------------------------------------
-- Tenant + brands
-- ----------------------------------------------------------------------------

insert into tenants (id, code, display_name, default_market, default_language, timezone, monthly_budget_usd, hard_budget_cap_usd)
values
  ('11111111-1111-1111-1111-111111111111', 'SAGA_CA', 'SAGA Canada', 'CA', 'en', 'America/Edmonton', 75.00, 150.00);

insert into brand_instances (id, tenant_id, code, display_name, website_url, primary_market, languages)
values
  ('22222222-2222-2222-2222-222222222221', '11111111-1111-1111-1111-111111111111', 'SAGA', 'SAGA', 'https://sagareach.com', 'CA', array['en']::language[]),
  ('22222222-2222-2222-2222-222222222222', '11111111-1111-1111-1111-111111111111', 'RUNNA', 'Rünna', 'https://runna.mx', 'MX', array['es', 'en']::language[]);

-- ----------------------------------------------------------------------------
-- Services (5 SAGA services)
-- ----------------------------------------------------------------------------

insert into services (id, tenant_id, code, display_name_en, display_name_es, description_en, price_cad, price_mxn, price_usd, pricing_model, sort_order) values
  ('33333333-3333-3333-3333-333333333331', '11111111-1111-1111-1111-111111111111', 'unlimited_design',
   'Unlimited Design', 'Diseño Ilimitado',
   'Design-on-demand subscription. Unlimited design requests, fast turnaround, full brand consistency.',
   3500.00, 45000.00, 2500.00, 'monthly', 1),

  ('33333333-3333-3333-3333-333333333332', '11111111-1111-1111-1111-111111111111', 'brand_identity',
   'Brand Identity Sprint', 'Sprint de Identidad de Marca',
   '4-week intensive brand build: strategy, visual system, voice, applications, and guidelines.',
   18000.00, 240000.00, 13000.00, 'project', 2),

  ('33333333-3333-3333-3333-333333333333', '11111111-1111-1111-1111-111111111111', 'fast_website',
   'Fast Website', 'Sitio Web Rápido',
   'High-converting website in 3 weeks. Mobile-first, SEO-optimized, built on modern stack.',
   12000.00, 160000.00, 8500.00, 'project', 3),

  ('33333333-3333-3333-3333-333333333334', '11111111-1111-1111-1111-111111111111', 'smart_chatbot',
   'Smart Chatbot', 'Chatbot Inteligente',
   'AI-powered chatbot trained on your brand. Qualifies leads, books meetings, handles FAQs 24/7.',
   6000.00, 80000.00, 4200.00, 'project', 4),

  ('33333333-3333-3333-3333-333333333335', '11111111-1111-1111-1111-111111111111', 'content_system',
   'Content System', 'Sistema de Contenido',
   'Monthly content engine: 8-12 social pieces, 2 long-form, 1 video. Built for velocity and consistency.',
   4500.00, 60000.00, 3200.00, 'monthly', 5);

-- ----------------------------------------------------------------------------
-- Pain taxonomy (15 canonical pain labels)
-- ----------------------------------------------------------------------------

insert into pain_taxonomy (id, tenant_id, code, display_name_en, description_en, evidence_phrases_en) values
  ('44444444-4444-4444-4444-444444444441', '11111111-1111-1111-1111-111111111111', 'brand_inconsistency',
   'Brand inconsistency', 'Visual or voice inconsistency across touchpoints — different logos on social vs site, contradictory tone of voice.',
   array['logo variations', 'inconsistent colors', 'different fonts across pages', 'off-brand photography']),

  ('44444444-4444-4444-4444-444444444442', '11111111-1111-1111-1111-111111111111', 'slow_production_cycles',
   'Slow production cycles', 'Design and content requests take weeks; creative team is bottlenecked or outsourced expensively.',
   array['email us for a quote', 'contact for custom designs', 'turnaround 4-6 weeks']),

  ('44444444-4444-4444-4444-444444444443', '11111111-1111-1111-1111-111111111111', 'poor_mobile_conversion',
   'Poor mobile conversion', 'Mobile experience is broken — slow load, assets not optimized, poor responsive layout.',
   array['images load at full res', 'layout breaks on mobile', 'mobile checkout abandoned']),

  ('44444444-4444-4444-4444-444444444444', '11111111-1111-1111-1111-111111111111', 'weak_packaging',
   'Weak packaging', 'Product packaging looks amateur, inconsistent across SKUs, or fails shelf differentiation.',
   array['generic packaging', 'inconsistent SKU design', 'no shelf presence']),

  ('44444444-4444-4444-4444-444444444445', '11111111-1111-1111-1111-111111111111', 'no_content_velocity',
   'No content velocity', 'Organic social dead for 30+ days; blog stale; no consistent content cadence.',
   array['last post 3 months ago', 'blog last updated', 'no recent activity']),

  ('44444444-4444-4444-4444-444444444446', '11111111-1111-1111-1111-111111111111', 'unclear_value_prop',
   'Unclear value proposition', 'Hero copy is vague or feature-heavy; visitors can''t tell what the business does in 5 seconds.',
   array['transforming businesses', 'leveraging synergies', 'cutting-edge solutions']),

  ('44444444-4444-4444-4444-444444444447', '11111111-1111-1111-1111-111111111111', 'low_email_performance',
   'Low email performance', 'Email flows are broken, unsegmented, or nonexistent. Missing welcome, abandoned cart, post-purchase.',
   array['no welcome email', 'single broadcast lists', 'no automation detected']),

  ('44444444-4444-4444-4444-444444444448', '11111111-1111-1111-1111-111111111111', 'outdated_website',
   'Outdated website', 'Site looks 5+ years old, unresponsive, or technically broken. Trust signals absent.',
   array['Flash elements', 'table-based layout', 'no HTTPS', 'copyright 2019']),

  ('44444444-4444-4444-4444-444444444449', '11111111-1111-1111-1111-111111111111', 'no_proof',
   'No proof or case studies', 'Site has no testimonials, logos, case studies, or social proof. Cold visitors bounce.',
   array['no testimonials found', 'no client logos', 'no case studies page']),

  ('44444444-4444-4444-4444-44444444444a', '11111111-1111-1111-1111-111111111111', 'poor_social_engagement',
   'Poor social engagement', 'Posts getting <10 likes, no comments, no shares. Followers not activating.',
   array['low engagement rate', '10k followers 5 likes', 'no comments']),

  ('44444444-4444-4444-4444-44444444444b', '11111111-1111-1111-1111-111111111111', 'manual_sales_process',
   'Manual sales / lead process', 'Leads handled in email and spreadsheets. No automation, no qualification, slow response times.',
   array['email us at', 'contact form only', 'no booking system', 'reply within 48 hours']),

  ('44444444-4444-4444-4444-44444444444c', '11111111-1111-1111-1111-111111111111', 'competitor_pressure',
   'Competitor pressure', 'Clear competitors doing better creative / marketing. Client is visibly losing ground.',
   array['competitor launched', 'market share declining', 'losing to']),

  ('44444444-4444-4444-4444-44444444444d', '11111111-1111-1111-1111-111111111111', 'event_activation_needs',
   'Event or launch needs', 'Running a conference, product launch, campaign activation. Needs creative firepower fast.',
   array['upcoming event', 'product launch', 'campaign kicking off', 'conference coming']),

  ('44444444-4444-4444-4444-44444444444e', '11111111-1111-1111-1111-111111111111', 'product_launch_support',
   'Product launch support', 'New product hitting market. Needs brand positioning, creative assets, go-to-market.',
   array['launching soon', 'coming 2026', 'beta launching', 'new product line']),

  ('44444444-4444-4444-4444-44444444444f', '11111111-1111-1111-1111-111111111111', 'localization_needs',
   'Localization gaps', 'Company serves bilingual or multi-market audience but only produces in one language.',
   array['English only', 'Spanish coming soon', 'LATAM expansion', 'bilingual planned']);

-- ----------------------------------------------------------------------------
-- Case studies (10 Rünna wins)
-- ----------------------------------------------------------------------------

insert into case_studies (id, tenant_id, brand_instance_id, client_name, industry, hero_metric_en, result_description_en, measurable_results, featured_services_id, sort_order, is_active) values
  ('55555555-5555-5555-5555-555555555551', '11111111-1111-1111-1111-111111111111', '22222222-2222-2222-2222-222222222222',
   'Ford', 'Automotive',
   'Onboarding: 3 months → 1 week',
   'Rebuilt Ford''s partner onboarding experience end-to-end. What took 3 months of back-and-forth now closes in a week. Won the Ford Global Innovation Award.',
   '[{"metric": "3 months → 1 week", "label": "onboarding reduction"}, {"metric": "Global Innovation Award", "label": "Ford recognition"}]'::jsonb,
   array['33333333-3333-3333-3333-333333333331', '33333333-3333-3333-3333-333333333333']::uuid[], 1, true),

  ('55555555-5555-5555-5555-555555555552', '11111111-1111-1111-1111-111111111111', '22222222-2222-2222-2222-222222222222',
   'DiDi', 'Mobility / ride-share',
   '100K+ TikTok followers in 7 months',
   'Built DiDi''s TikTok presence from zero. 100K+ followers in 7 months with a 1,400% positive sentiment lift. Asset pipeline overhauled for compressed-but-gorgeous output.',
   '[{"metric": "100K+", "label": "TikTok followers in 7 months"}, {"metric": "+1,400%", "label": "positive sentiment"}]'::jsonb,
   array['33333333-3333-3333-3333-333333333335']::uuid[], 2, true),

  ('55555555-5555-5555-5555-555555555553', '11111111-1111-1111-1111-111111111111', '22222222-2222-2222-2222-222222222222',
   'Aeromexico', 'Airlines',
   '35K downloads, 1M impressions',
   'VR destination app built for Aeromexico. 35K downloads with zero paid media — purely word-of-mouth and earned reach driving 1M impressions.',
   '[{"metric": "35K", "label": "downloads"}, {"metric": "1M", "label": "impressions"}, {"metric": "$0", "label": "paid media"}]'::jsonb,
   array['33333333-3333-3333-3333-333333333333']::uuid[], 3, true),

  ('55555555-5555-5555-5555-555555555554', '11111111-1111-1111-1111-111111111111', '22222222-2222-2222-2222-222222222222',
   'Bayer / Aspirina', 'Pharmaceutical',
   'Doctor engagement: <1 min → 5+ min',
   'AR medical app launched at Bayer''s global convention. Doctor engagement went from under a minute to over five — a 5x increase in time-in-experience.',
   '[{"metric": "<1 min → 5+ min", "label": "engagement duration"}, {"metric": "5x", "label": "time-in-experience lift"}]'::jsonb,
   array['33333333-3333-3333-3333-333333333334']::uuid[], 4, true),

  ('55555555-5555-5555-5555-555555555555', '11111111-1111-1111-1111-111111111111', '22222222-2222-2222-2222-222222222222',
   'Golden Hills', 'CPG / pet food',
   '400+ SKU packaging system',
   'Full brand and packaging operation for Golden Hills. 400+ SKUs designed with a systemized approach — no one-off art, every package repeatable and on-brand.',
   '[{"metric": "400+", "label": "SKUs"}, {"metric": "1", "label": "unified packaging system"}]'::jsonb,
   array['33333333-3333-3333-3333-333333333331', '33333333-3333-3333-3333-333333333332']::uuid[], 5, true),

  ('55555555-5555-5555-5555-555555555556', '11111111-1111-1111-1111-111111111111', '22222222-2222-2222-2222-222222222222',
   'ANA Seguros', 'Insurance',
   'Applications +1,000%',
   'Recruitment campaign for ANA Seguros took the hiring cycle from 2 months to 2 weeks, with applications up 1,000%. Brand repositioning drove the entire funnel.',
   '[{"metric": "+1,000%", "label": "applications"}, {"metric": "2 months → 2 weeks", "label": "hiring cycle"}]'::jsonb,
   array['33333333-3333-3333-3333-333333333332', '33333333-3333-3333-3333-333333333335']::uuid[], 6, true),

  ('55555555-5555-5555-5555-555555555557', '11111111-1111-1111-1111-111111111111', '22222222-2222-2222-2222-222222222222',
   'Pet''s Club', 'Retail / pet services',
   'Loyalty system + brand overhaul',
   'Rebuilt Pet''s Club as a system — brand, app, loyalty program, in-store experience. All pieces working as one.',
   '[{"metric": "1", "label": "unified brand system"}, {"metric": "Full stack", "label": "brand to in-store"}]'::jsonb,
   array['33333333-3333-3333-3333-333333333332', '33333333-3333-3333-3333-333333333334']::uuid[], 7, true),

  ('55555555-5555-5555-5555-555555555558', '11111111-1111-1111-1111-111111111111', '22222222-2222-2222-2222-222222222222',
   'RV SnapPad', 'DTC / RV accessories',
   '+10% sales YoY, +50% email revenue',
   'Calgary-based DTC brand. Scaled revenue +10% year-over-year and grew email-attributed revenue by 50% through a systemized content + email flow rebuild.',
   '[{"metric": "+10%", "label": "sales YoY"}, {"metric": "+50%", "label": "email revenue"}]'::jsonb,
   array['33333333-3333-3333-3333-333333333335', '33333333-3333-3333-3333-333333333333']::uuid[], 8, true),

  ('55555555-5555-5555-5555-555555555559', '11111111-1111-1111-1111-111111111111', '22222222-2222-2222-2222-222222222222',
   'Niki', 'Consumer tech / AI assistant',
   'Brand + product launch',
   'Full brand system and launch campaign for Niki, the AI assistant for Mexican Spanish speakers. Strategy, identity, product positioning, and go-to-market in one sprint.',
   '[{"metric": "Full launch", "label": "brand + GTM"}, {"metric": "1", "label": "integrated program"}]'::jsonb,
   array['33333333-3333-3333-3333-333333333332', '33333333-3333-3333-3333-333333333333']::uuid[], 9, true),

  ('55555555-5555-5555-5555-55555555555a', '11111111-1111-1111-1111-111111111111', '22222222-2222-2222-2222-222222222222',
   'DevFest YYC', 'Events / tech conference',
   'Event brand + content system',
   'DevFest Calgary. Built the event brand + full content system for the local Google Developers conference. Clean Calgary-based proof point for tech-audience SMBs.',
   '[{"metric": "Calgary", "label": "local proof"}, {"metric": "Full event brand", "label": "scope"}]'::jsonb,
   array['33333333-3333-3333-3333-333333333332', '33333333-3333-3333-3333-333333333335']::uuid[], 10, true);

-- ----------------------------------------------------------------------------
-- Case study → pain taxonomy mapping (many-to-many)
-- ----------------------------------------------------------------------------

-- Ford: slow cycles, unclear value prop
insert into case_study_pain_tags (case_study_id, pain_id, strength) values
  ('55555555-5555-5555-5555-555555555551', '44444444-4444-4444-4444-444444444442', 1.0),
  ('55555555-5555-5555-5555-555555555551', '44444444-4444-4444-4444-444444444446', 0.7);

-- DiDi: poor social engagement, no content velocity, brand inconsistency
insert into case_study_pain_tags (case_study_id, pain_id, strength) values
  ('55555555-5555-5555-5555-555555555552', '44444444-4444-4444-4444-44444444444a', 1.0),
  ('55555555-5555-5555-5555-555555555552', '44444444-4444-4444-4444-444444444445', 1.0),
  ('55555555-5555-5555-5555-555555555552', '44444444-4444-4444-4444-444444444441', 0.6);

-- Aeromexico: event/launch needs, competitor pressure
insert into case_study_pain_tags (case_study_id, pain_id, strength) values
  ('55555555-5555-5555-5555-555555555553', '44444444-4444-4444-4444-44444444444d', 1.0),
  ('55555555-5555-5555-5555-555555555553', '44444444-4444-4444-4444-44444444444c', 0.7);

-- Bayer/Aspirina: event/launch needs, product launch support
insert into case_study_pain_tags (case_study_id, pain_id, strength) values
  ('55555555-5555-5555-5555-555555555554', '44444444-4444-4444-4444-44444444444d', 1.0),
  ('55555555-5555-5555-5555-555555555554', '44444444-4444-4444-4444-44444444444e', 0.8);

-- Golden Hills: weak packaging, brand inconsistency
insert into case_study_pain_tags (case_study_id, pain_id, strength) values
  ('55555555-5555-5555-5555-555555555555', '44444444-4444-4444-4444-444444444444', 1.0),
  ('55555555-5555-5555-5555-555555555555', '44444444-4444-4444-4444-444444444441', 1.0);

-- ANA Seguros: manual sales process, unclear value prop, low email performance
insert into case_study_pain_tags (case_study_id, pain_id, strength) values
  ('55555555-5555-5555-5555-555555555556', '44444444-4444-4444-4444-44444444444b', 0.8),
  ('55555555-5555-5555-5555-555555555556', '44444444-4444-4444-4444-444444444446', 0.9),
  ('55555555-5555-5555-5555-555555555556', '44444444-4444-4444-4444-444444444447', 0.6);

-- Pet's Club: brand inconsistency, manual sales process, weak packaging
insert into case_study_pain_tags (case_study_id, pain_id, strength) values
  ('55555555-5555-5555-5555-555555555557', '44444444-4444-4444-4444-444444444441', 1.0),
  ('55555555-5555-5555-5555-555555555557', '44444444-4444-4444-4444-44444444444b', 0.7);

-- SnapPad: low email performance, no content velocity, poor mobile conversion
insert into case_study_pain_tags (case_study_id, pain_id, strength) values
  ('55555555-5555-5555-5555-555555555558', '44444444-4444-4444-4444-444444444447', 1.0),
  ('55555555-5555-5555-5555-555555555558', '44444444-4444-4444-4444-444444444445', 1.0),
  ('55555555-5555-5555-5555-555555555558', '44444444-4444-4444-4444-444444444443', 0.7);

-- Niki: product launch support, unclear value prop, localization needs
insert into case_study_pain_tags (case_study_id, pain_id, strength) values
  ('55555555-5555-5555-5555-555555555559', '44444444-4444-4444-4444-44444444444e', 1.0),
  ('55555555-5555-5555-5555-555555555559', '44444444-4444-4444-4444-444444444446', 0.8),
  ('55555555-5555-5555-5555-555555555559', '44444444-4444-4444-4444-44444444444f', 1.0);

-- DevFest YYC: event/launch needs, no content velocity
insert into case_study_pain_tags (case_study_id, pain_id, strength) values
  ('55555555-5555-5555-5555-55555555555a', '44444444-4444-4444-4444-44444444444d', 1.0),
  ('55555555-5555-5555-5555-55555555555a', '44444444-4444-4444-4444-444444444445', 0.8);

-- ----------------------------------------------------------------------------
-- ICPs (2 Alberta initial)
-- ----------------------------------------------------------------------------

insert into icps (id, tenant_id, name, market, language, industry_tags, geo_regions, employee_size_min, employee_size_max, business_types, google_places_types, search_keywords, excluded_keywords, is_active) values
  ('66666666-6666-6666-6666-666666666661', '11111111-1111-1111-1111-111111111111',
   'Alberta DTC ecommerce, 5-50 employees', 'CA', 'en',
   array['dtc', 'ecommerce', 'consumer goods', 'lifestyle brands'],
   array['Alberta', 'Calgary', 'Edmonton'],
   5, 50,
   array['dtc_ecommerce', 'shopify_brand'],
   array['store', 'clothing_store', 'shopping_mall'],
   array['shopify', 'direct to consumer', 'online shop', 'dtc brand'],
   array['dropshipping', 'MLM', 'adult', 'cannabis retail'],
   true),

  ('66666666-6666-6666-6666-666666666662', '11111111-1111-1111-1111-111111111111',
   'Western Canada professional services, 10-100 employees', 'CA', 'en',
   array['legal', 'accounting', 'consulting', 'financial services', 'agencies'],
   array['Alberta', 'British Columbia', 'Saskatchewan'],
   10, 100,
   array['professional_services', 'b2b_services'],
   array['lawyer', 'accounting', 'financial_planner', 'consultant'],
   array['law firm', 'accounting firm', 'consulting', 'financial advisory'],
   array['franchise', 'network marketing', 'real estate agent'],
   true);

-- ----------------------------------------------------------------------------
-- Prompts (one row per purpose)
-- ----------------------------------------------------------------------------

insert into prompts (id, tenant_id, purpose, language, description) values
  ('77777777-7777-7777-7777-777777777771', '11111111-1111-1111-1111-111111111111', 'research', 'en', 'Extract what the company does, tech stack, and 3 pain points from scraped site content.'),
  ('77777777-7777-7777-7777-777777777772', '11111111-1111-1111-1111-111111111111', 'scoring', 'en', 'Score a prospect 0-100 against the 5 SAGA services composite rubric.'),
  ('77777777-7777-7777-7777-777777777773', '11111111-1111-1111-1111-111111111111', 'pain_classification', 'en', 'Classify the extracted pain points into the canonical pain taxonomy.'),
  ('77777777-7777-7777-7777-777777777774', '11111111-1111-1111-1111-111111111111', 'contact_selection', 'en', 'Pick the best decision-maker contact for the outreach.'),
  ('77777777-7777-7777-7777-777777777775', '11111111-1111-1111-1111-111111111111', 'pitch_en', 'en', 'Generate a 90-word pitch body + <7-word subject citing a specific case study by name with measurable result.'),
  ('77777777-7777-7777-7777-777777777776', '11111111-1111-1111-1111-111111111111', 'pitch_es', 'es', 'Pitch generation for Spanish-speaking MX market (Rünna brand).'),
  ('77777777-7777-7777-7777-777777777777', '11111111-1111-1111-1111-111111111111', 'reply_classify', 'en', 'Classify an inbound reply: intent / urgency / sentiment.'),
  ('77777777-7777-7777-7777-777777777778', '11111111-1111-1111-1111-111111111111', 'reply_auto_draft', 'en', 'Draft a personalized reply to an inbound reply for reviewer approval.'),
  ('77777777-7777-7777-7777-777777777779', '11111111-1111-1111-1111-111111111111', 'learning_proposal', 'en', 'Weekly analysis of 4-week rolling window; propose prompt tweaks with evidence and impact estimate.'),
  ('77777777-7777-7777-7777-77777777777a', '11111111-1111-1111-1111-111111111111', 'compliance_footer_ca', 'en', 'CASL-compliant email footer with physical address + unsubscribe link.'),
  ('77777777-7777-7777-7777-77777777777b', '11111111-1111-1111-1111-111111111111', 'compliance_footer_mx', 'es', 'LFPDPPP-compliant email footer with opt-out basis + aviso de privacidad link.');

-- ----------------------------------------------------------------------------
-- Prompt variants (v1 champion for each)
-- ----------------------------------------------------------------------------

insert into prompt_variants (id, prompt_id, version, status, system_prompt, user_prompt_template, model, temperature, max_tokens) values
  (
    '88888888-8888-8888-8888-888888888881',
    '77777777-7777-7777-7777-777777777771', '1.0.0', 'champion',
    'You are a research analyst for SAGA, a Canadian creative agency. Extract structured intelligence from raw website content. Be specific, cite URL evidence, never hallucinate. If a pain point has no URL evidence, omit it. Never invent tech stack items you cannot verify from visible HTML, script src, or common platform signals.',
    E'Analyze the following scraped content from {{domain}}.\n\nReturn strict JSON:\n{\n  "what_they_do": "<one sentence, concrete>",\n  "tech_stack": ["<verified platforms/tools>"],\n  "pain_points": [\n    {"pain_code": "<from taxonomy>", "evidence_url": "<exact URL>", "quote": "<direct quote or observation>"}\n  ]\n}\n\nContent:\n{{scraped_content}}\n\nPain taxonomy options: {{taxonomy_codes}}',
    'claude-sonnet-4-7', 0.3, 2048
  ),
  (
    '88888888-8888-8888-8888-888888888882',
    '77777777-7777-7777-7777-777777777772', '1.0.0', 'champion',
    'You are a sales qualifier for SAGA. Score prospects 0-100 using the composite rubric. Be rigorous about red flags — any single red flag means the prospect is a hard no, regardless of other points.',
    E'Score this prospect:\n\n{{research_brief}}\n\nRubric (max 100):\n- Industry fit (0-25): matches ICP industry tags\n- Size fit (0-10): 5-50 employees is ideal\n- Digital maturity (0-10): active site, social, last updated <90d\n- Pain signal strength (0-20): URL-level evidence of pains we solve\n- Service match (0-15): fit to at least 1 of 5 SAGA services\n- Contact discoverability (0-10): decision-maker email or LinkedIn found\n\nRed flags (hard -100): agency, competitor, existing R\u00fcnna client, wrong country, dead site, MLM, adult, DNC list.\n\nReturn JSON: {composite_score, points_breakdown, red_flags, best_service_code, best_pain_code, best_case_study_client, confidence, reasoning}',
    'claude-haiku-4-5-20251001', 0.2, 1024
  ),
  (
    '88888888-8888-8888-8888-888888888883',
    '77777777-7777-7777-7777-777777777773', '1.0.0', 'champion',
    'You classify pain points into a canonical taxonomy. Match conservatively — only apply a pain code if the evidence clearly supports it.',
    E'Research brief:\n{{research_brief}}\n\nTaxonomy:\n{{taxonomy}}\n\nReturn JSON: [{"pain_code": "<code>", "confidence": 0-1, "evidence": "<quote>"}, ...]',
    'claude-haiku-4-5-20251001', 0.2, 512
  ),
  (
    '88888888-8888-8888-8888-888888888884',
    '77777777-7777-7777-7777-777777777774', '1.0.0', 'champion',
    'You pick the best outreach contact from candidates. Prefer named decision-makers with matching LinkedIn over role-based emails (info@, hello@, sales@). Founders/partners/BD/marketing leads score higher than generic addresses.',
    E'Candidates:\n{{candidates}}\n\nCompany context:\n{{research_brief}}\n\nReturn JSON: {selected_contact_index, reasoning}',
    'claude-haiku-4-5-20251001', 0.2, 256
  ),
  (
    '88888888-8888-8888-8888-888888888885',
    '77777777-7777-7777-7777-777777777775', '1.0.0', 'champion',
    E'You write cold pitches for SAGA (Canadian arm of R\u00fcnna). Every pitch MUST cite a specific R\u00fcnna case study by client name with a measurable result from the provided case study data.\n\nHard rules:\n- Subject line <7 words, observational not promotional\n- Body 70-110 words\n- Open with a specific observation about their site or business (cite URL)\n- Pivot to a parallel R\u00fcnna win using the exact client name and measurable number\n- Single soft CTA at end (15-min call, quick question, worth a look)\n- No superlatives, no "transform your business," no "leverage synergies"\n- Write like a human, not a template\n\nIf you cannot ground the pitch in a real case study with a real metric, REFUSE and return {"refused": true, "reason": "..."}.',
    E'Prospect: {{company_name}} ({{domain}})\nObservation: {{primary_pain_observation}}\nPain code: {{pain_code}}\n\nCase study to ground:\nClient: {{case_study_client_name}}\nResult: {{case_study_hero_metric}}\nDetail: {{case_study_result_description}}\nMeasurable: {{case_study_measurable_result}}\n\nSender: {{sender_name}}\nService being pitched: {{service_display_name}}\n\nReturn JSON: {subject, body, case_study_client_cited, measurable_number_cited, self_quality_score}',
    'claude-sonnet-4-7', 0.7, 1024
  ),
  (
    '88888888-8888-8888-8888-888888888886',
    '77777777-7777-7777-7777-777777777776', '1.0.0', 'champion',
    E'Escribes pitches fr\u00edos para R\u00fcnna (brand mexicana). Cada pitch DEBE citar un caso de \u00e9xito R\u00fcnna espec\u00edfico por nombre de cliente con un resultado medible.\n\nReglas:\n- Subject <7 palabras, observacional no promocional\n- Cuerpo 70-110 palabras\n- Apertura con observaci\u00f3n espec\u00edfica de su sitio/negocio\n- Pivote a un caso paralelo de R\u00fcnna con nombre exacto y n\u00famero medible\n- Un CTA suave al final\n- Sin superlativos',
    E'Prospecto: {{company_name}} ({{domain}})\nObservaci\u00f3n: {{primary_pain_observation}}\nC\u00f3digo de dolor: {{pain_code}}\n\nCaso R\u00fcnna:\nCliente: {{case_study_client_name}}\nResultado: {{case_study_hero_metric}}\n\nRemitente: {{sender_name}}\n\nRetorna JSON: {subject, body, case_study_client_cited, measurable_number_cited, self_quality_score}',
    'claude-sonnet-4-7', 0.7, 1024
  ),
  (
    '88888888-8888-8888-8888-888888888887',
    '77777777-7777-7777-7777-777777777777', '1.0.0', 'champion',
    'You classify inbound replies to cold outreach. Be precise about intent. Misclassifying a hot lead as warm costs us a meeting; misclassifying a hard no as warm costs us credibility.',
    E'Subject: {{subject}}\n\nBody:\n{{body}}\n\nReturn JSON:\n{\n  "intent": "wants_meeting | wants_info | hard_no | not_now | wrong_person | auto_reply",\n  "urgency": "hot | warm | cold",\n  "sentiment": "positive | neutral | negative",\n  "reasoning": "<one sentence>"\n}',
    'claude-haiku-4-5-20251001', 0.1, 256
  ),
  (
    '88888888-8888-8888-8888-888888888888',
    '77777777-7777-7777-7777-777777777778', '1.0.0', 'champion',
    'You draft reply emails to warm inbound responses. Tone: human, specific, helpful. The reviewer will edit or send as-is. Keep it under 80 words, propose a concrete next step.',
    E'Original pitch we sent:\n{{original_pitch}}\n\nTheir reply:\n{{reply_body}}\n\nIntent: {{intent}}\n\nDraft a reply (under 80 words) that moves this toward a call.',
    'claude-sonnet-4-7', 0.6, 512
  ),
  (
    '88888888-8888-8888-8888-888888888889',
    '77777777-7777-7777-7777-777777777779', '1.0.0', 'champion',
    'You analyze 4 weeks of outbound performance and propose prompt tweaks. Conservative mindset — never propose change without statistical evidence. If sample size is too small, say so and recommend waiting another week.',
    E'4-week rolling window:\n{{window_data}}\n\nCurrent champion prompt:\n{{champion_prompt}}\n\nWhat opened vs. what replied:\n{{open_vs_reply_analysis}}\n\nReturn JSON:\n{\n  "has_proposal": true|false,\n  "evidence": "<summary with numbers>",\n  "proposed_change": "<specific prompt delta>",\n  "expected_impact": "<+X% reply rate on similar profiles>",\n  "confidence": 0-1,\n  "recommend_ab_test": true|false\n}',
    'claude-sonnet-4-7', 0.4, 2048
  ),
  (
    '88888888-8888-8888-8888-88888888888a',
    '77777777-7777-7777-7777-77777777777a', '1.0.0', 'champion',
    'You generate CASL-compliant email footers in English for Canadian recipients. Must include: full physical mailing address, working unsubscribe link, clear identification of the sender.',
    E'{{sender_full_name}}\n{{sender_title}} \u2022 {{brand_display_name}}\n{{mailing_address}}\n\nYou\u2019re receiving this because your email was conspicuously published in a business context. If this isn\u2019t relevant, reply with "unsubscribe" or click here: {{unsubscribe_url}}\n\nSAGA is part of R\u00fcnna. More about us: {{website_url}}',
    'claude-haiku-4-5-20251001', 0.0, 256
  ),
  (
    '88888888-8888-8888-8888-88888888888b',
    '77777777-7777-7777-7777-77777777777b', '1.0.0', 'champion',
    'You generate LFPDPPP-compliant email footers in Spanish for Mexican recipients. Must include: sender identity, physical address, privacy notice link, opt-out mechanism.',
    E'{{sender_full_name}}\n{{sender_title}} \u2022 {{brand_display_name}}\n{{mailing_address}}\n\nRecibes este correo por encontrarse tu direcci\u00f3n publicada en contexto comercial. Para optar por no recibir m\u00e1s comunicaciones, responde con "baja" o visita: {{unsubscribe_url}}\n\nAviso de privacidad: {{privacy_url}}',
    'claude-haiku-4-5-20251001', 0.0, 256
  );

-- Backlink prompts to their champion variants (not strictly required but useful for queries)
-- (No extra column — the variant has prompt_id + status='champion')

-- ----------------------------------------------------------------------------
-- Blackout dates (Canada stat holidays 2026)
-- ----------------------------------------------------------------------------

insert into blackout_dates (tenant_id, market, blackout_date, label) values
  ('11111111-1111-1111-1111-111111111111', 'CA', '2026-01-01', 'New Year''s Day'),
  ('11111111-1111-1111-1111-111111111111', 'CA', '2026-02-16', 'Family Day (AB/BC/ON)'),
  ('11111111-1111-1111-1111-111111111111', 'CA', '2026-04-03', 'Good Friday'),
  ('11111111-1111-1111-1111-111111111111', 'CA', '2026-04-06', 'Easter Monday'),
  ('11111111-1111-1111-1111-111111111111', 'CA', '2026-05-18', 'Victoria Day'),
  ('11111111-1111-1111-1111-111111111111', 'CA', '2026-07-01', 'Canada Day'),
  ('11111111-1111-1111-1111-111111111111', 'CA', '2026-08-03', 'Civic Holiday'),
  ('11111111-1111-1111-1111-111111111111', 'CA', '2026-09-07', 'Labour Day'),
  ('11111111-1111-1111-1111-111111111111', 'CA', '2026-10-12', 'Thanksgiving'),
  ('11111111-1111-1111-1111-111111111111', 'CA', '2026-11-11', 'Remembrance Day'),
  ('11111111-1111-1111-1111-111111111111', 'CA', '2026-12-24', 'Christmas Eve (low-send)'),
  ('11111111-1111-1111-1111-111111111111', 'CA', '2026-12-25', 'Christmas Day'),
  ('11111111-1111-1111-1111-111111111111', 'CA', '2026-12-26', 'Boxing Day'),
  ('11111111-1111-1111-1111-111111111111', 'CA', '2026-12-31', 'New Year''s Eve (low-send)');
