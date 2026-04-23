-- ============================================================================
-- Migration 0003 — Refresh case studies from Rünna 2026 ESP deck
--
-- Source: /Users/work/Downloads/MASTER- Runna Pres '26-ESP.pdf
--
-- Goal: every active case study reflects real Rünna work with honest
-- attribution. Specifically fixes three hallucinated rows that the first seed
-- contained (Niki, SnapPad, DevFest) and adds ten additional cases pulled
-- directly from the deck. Final state: 20 active case studies, 3 of which
-- carry real client testimonials.
--
-- Safe to run multiple times:
--   - UPDATEs are keyed on fixed UUIDs and are idempotent
--   - Pain tags are DELETEd wholesale and re-INSERTed
--   - New rows use INSERT ... ON CONFLICT (id) DO UPDATE to stay idempotent
-- ============================================================================

-- Pain-taxonomy UUIDs used below (from 0001_initial_schema + seed):
--   ...4441 brand_inconsistency      ...4448 outdated_website
--   ...4442 slow_production_cycles   ...4449 no_proof
--   ...4443 poor_mobile_conversion   ...444a poor_social_engagement
--   ...4444 weak_packaging           ...444b manual_sales_process
--   ...4445 no_content_velocity      ...444c competitor_pressure
--   ...4446 unclear_value_prop       ...444d event_activation_needs
--   ...4447 low_email_performance    ...444e product_launch_support
--                                    ...444f localization_needs

-- ============================================================================
-- PART 1 — Correct + enhance the 10 existing case studies
-- ============================================================================

-- 1. Ford (training) — was correct; tighten the description
update case_studies set
  client_name = 'Ford',
  industry = 'Automotive / enterprise training',
  hero_metric_en = 'Sales-force training: 3 months → 1 week',
  result_description_en = E'Built an interactive gamified training platform that cut Ford México''s sales-force onboarding from a 3-month average to 1 week. Ford México received a national innovation award for the platform.',
  measurable_results = '[{"metric": "3 months → 1 week", "label": "training cycle"}, {"metric": "Innovation Award", "label": "Ford México recognition"}]'::jsonb,
  featured_services_id = array['33333333-3333-3333-3333-333333333334', '33333333-3333-3333-3333-333333333333']::uuid[],
  is_active = true,
  sort_order = 1
where id = '55555555-5555-5555-5555-555555555551';

-- 2. DiDi (main) — split out: keep DiDi as the LATAM-wide main brand, move
-- the DiDi Food metrics (100K TikTok, +1,400% sentiment) to a new row below.
update case_studies set
  client_name = 'DiDi',
  industry = 'Mobility / ride-share',
  hero_metric_en = '5 years across 10 LATAM countries',
  result_description_en = E'Ran DiDi México''s FB / IG / TikTok / X social for 5 years with an entertainment-led strategy focused on engagement, community, and leads-to-app. In the last 2 years scaled to 10 LATAM countries, doubling DiDi''s total digital community. Produced original content + trend filmings for the brand and its Key Accounts.',
  measurable_results = '[{"metric": "10 LATAM countries", "label": "regional expansion"}, {"metric": "Doubled", "label": "total digital community"}, {"metric": "5 years", "label": "continuous social management"}]'::jsonb,
  featured_services_id = array['33333333-3333-3333-3333-333333333335']::uuid[],
  is_active = true,
  sort_order = 2
where id = '55555555-5555-5555-5555-555555555552';

-- 3. Aeromexico VR — accurate; tighten
update case_studies set
  client_name = 'Aeromexico',
  industry = 'Airlines',
  hero_metric_en = '35K downloads, 1M impressions',
  result_description_en = E'360° VR destination app promoting Aeromexico''s new direct routes. Conceived as a short-term campaign; word-of-mouth alone drove 35,000+ downloads and 1M+ impressions without paid media.',
  measurable_results = '[{"metric": "35,000+", "label": "downloads"}, {"metric": "1M+", "label": "impressions (organic)"}, {"metric": "$0", "label": "paid media"}]'::jsonb,
  featured_services_id = array['33333333-3333-3333-3333-333333333333']::uuid[],
  is_active = true,
  sort_order = 3
where id = '55555555-5555-5555-5555-555555555553';

-- 4. Bayer / Aspirina Protect — accurate; tighten
update case_studies set
  client_name = 'Bayer / Aspirina Protect',
  industry = 'Pharmaceutical',
  hero_metric_en = 'Doctor attention: <1 min → 5+ min',
  result_description_en = E'Augmented Reality app built for Bayer to hold doctors'' attention on a box of Aspirina Protect. A 3D human body model appeared over the box and walked through the drug''s benefits. Doctors not only engaged longer, they called colleagues over. Bayer México presented the app at a global convention.',
  measurable_results = '[{"metric": "<1 min → 5+ min", "label": "doctor engagement time"}, {"metric": "Global convention", "label": "Bayer international presentation"}]'::jsonb,
  featured_services_id = array['33333333-3333-3333-3333-333333333334']::uuid[],
  is_active = true,
  sort_order = 4
where id = '55555555-5555-5555-5555-555555555554';

-- 5. Golden Hills (rebrand) — tighten with 400+ packages
update case_studies set
  client_name = 'Golden Hills',
  industry = 'CPG / retail',
  hero_metric_en = '400+ SKUs in a single packaging system',
  result_description_en = E'Full rebrand + packaging operation for Golden Hills. 400+ products redesigned around a clean, minimalist system with strategic chromatics, plus internal banners, tech sheets, and product mock-ups / renders for web + print.',
  measurable_results = '[{"metric": "400+", "label": "SKUs redesigned"}, {"metric": "1", "label": "unified packaging system"}]'::jsonb,
  featured_services_id = array['33333333-3333-3333-3333-333333333331', '33333333-3333-3333-3333-333333333332']::uuid[],
  is_active = true,
  sort_order = 5
where id = '55555555-5555-5555-5555-555555555555';

-- 6. ANA Seguros — accurate
update case_studies set
  client_name = 'ANA Seguros',
  industry = 'Insurance',
  hero_metric_en = 'Applications +1,000%',
  result_description_en = E'Digitized and automated the agent recruitment process for ANA Seguros via a dedicated app. Recruitment applications rose more than 1,000% and the hiring cycle compressed from ~2 months to under 2 weeks.',
  measurable_results = '[{"metric": "+1,000%", "label": "recruitment applications"}, {"metric": "2 months → <2 weeks", "label": "hiring cycle"}]'::jsonb,
  featured_services_id = array['33333333-3333-3333-3333-333333333334', '33333333-3333-3333-3333-333333333333']::uuid[],
  is_active = true,
  sort_order = 6
where id = '55555555-5555-5555-5555-555555555556';

-- 7. Pet's Club — correct with 290+ packages across 3 pillars
update case_studies set
  client_name = 'Pet''s Club',
  industry = 'Retail / pet products',
  hero_metric_en = '290+ packages across 3 product pillars',
  result_description_en = E'Relaunched Pet''s Club''s visual identity and packaging. Segmented the line into 3 pillars (Dogs / Cats / Other pets), each with its own personality but a unified master system. Designed a premium subline for dogs and cats. 290+ unique packages and labels shipped across the catalog.',
  measurable_results = '[{"metric": "290+", "label": "packages + labels designed"}, {"metric": "3 pillars", "label": "product-segment identity system"}]'::jsonb,
  featured_services_id = array['33333333-3333-3333-3333-333333333331', '33333333-3333-3333-3333-333333333332']::uuid[],
  is_active = true,
  sort_order = 7
where id = '55555555-5555-5555-5555-555555555557';

-- 8. SnapPad — CORRECT the fabricated sales metrics. Reframe as packaging
-- work. This was my hallucination; the real deck shows Rünna designed
-- Canadian packaging for SnapPad, no revenue metric claimed.
update case_studies set
  client_name = 'SnapPad',
  industry = 'DTC / RV accessories',
  hero_metric_en = 'Canadian retail packaging system',
  result_description_en = E'Designed the Canadian retail packaging for SnapPad''s RV-accessories line, engineered to stand out at point-of-sale with clearer information hierarchy and stronger shelf presence. A Rünna proof point of Canadian retail work, delivered from the same MX creative team.',
  measurable_results = '[{"metric": "Canadian retail", "label": "shelf-ready packaging"}, {"metric": "RV-accessories line", "label": "category scope"}]'::jsonb,
  featured_services_id = array['33333333-3333-3333-3333-333333333331']::uuid[],
  is_active = true,
  sort_order = 8
where id = '55555555-5555-5555-5555-555555555558';

-- 9. Niki — CORRECT. Not the AI assistant; it's a platform placing
-- international students in Canada, with real first-month social metrics.
update case_studies set
  client_name = 'Niki',
  industry = 'Education / study-abroad platform',
  hero_metric_en = '2,000 followers + 40K video views in 1 month',
  result_description_en = E'Launched Niki''s brand and social presence from zero on a startup budget. Niki is a platform placing international students in Canadian institutions. In the first month the launch generated 2,000+ followers, 40,000+ video views, and 1,000+ unique visitors driven to the platform.',
  measurable_results = '[{"metric": "2,000+", "label": "followers in month 1"}, {"metric": "40,000+", "label": "video views in month 1"}, {"metric": "1,000+", "label": "unique platform visitors"}]'::jsonb,
  featured_services_id = array['33333333-3333-3333-3333-333333333332', '33333333-3333-3333-3333-333333333335']::uuid[],
  is_active = true,
  sort_order = 9
where id = '55555555-5555-5555-5555-555555555559';

-- 10. DevFest Calgary 2024 — CORRECT the fabricated "event brand + content
-- system" claim. The real work was a Meta + Instagram ad campaign promoting
-- speakers and driving attendance for the Calgary tech conference.
update case_studies set
  client_name = 'DevFest Calgary 2024',
  industry = 'Events / tech conference',
  hero_metric_en = 'Canadian tech event ad campaign',
  result_description_en = E'Meta + Instagram ad campaign for DevFest Calgary 2024, the local Google Developers conference. Promoted headline speakers, schedule, and event details; built anticipation and drove attendance within the Canadian developer community. Runna CA''s first public Canadian event-marketing work.',
  measurable_results = '[{"metric": "DevFest Calgary 2024", "label": "local developer conference"}, {"metric": "Meta + Instagram", "label": "ad campaign platforms"}]'::jsonb,
  featured_services_id = array['33333333-3333-3333-3333-333333333335']::uuid[],
  is_active = true,
  sort_order = 10
where id = '55555555-5555-5555-5555-55555555555a';

-- ============================================================================
-- PART 2 — Insert 10 new case studies from the 2026 ESP deck
-- ============================================================================

insert into case_studies (id, tenant_id, brand_instance_id, client_name, industry, hero_metric_en, result_description_en, measurable_results, featured_services_id, sort_order, is_active) values
  ('5555555b-5555-5555-5555-55555555555b', '11111111-1111-1111-1111-111111111111', '22222222-2222-2222-2222-222222222222',
   'DiDi Food', 'Food delivery / mobility',
   '100K TikTok followers in 7 months, +1,400% positive sentiment',
   E'Managed DiDi Food''s social across FB / IG / TikTok / X in México + 6 LATAM countries for 4 years. An entertainment-led strategy doubled DiDi Food''s total community and lifted positive sentiment by 1,400%. Opened DiDi Food''s TikTok from scratch and reached 100,000+ followers in México in under 7 months.',
   '[{"metric": "100,000+", "label": "TikTok followers in 7 months"}, {"metric": "+1,400%", "label": "positive sentiment"}, {"metric": "6 LATAM countries", "label": "regional reach"}, {"metric": "Doubled", "label": "community size"}]'::jsonb,
   array['33333333-3333-3333-3333-333333333335']::uuid[], 11, true),

  ('5555555c-5555-5555-5555-55555555555c', '11111111-1111-1111-1111-111111111111', '22222222-2222-2222-2222-222222222222',
   'DiDi (TikTok paid)', 'Performance marketing',
   '120M+ impressions, 25K app downloads, $0.02 CPM',
   E'"We don''t make ads, we make TikToks." Built DiDi''s TikTok paid-media strategy end-to-end: creative, production, and campaign management. Generated 120M+ impressions and 25,000+ app downloads at a $0.02 USD CPM using low-budget productions that read as native platform content.',
   '[{"metric": "120M+", "label": "impressions"}, {"metric": "25,000+", "label": "app downloads"}, {"metric": "$0.02 USD", "label": "CPM"}]'::jsonb,
   array['33333333-3333-3333-3333-333333333335']::uuid[], 12, true),

  ('5555555d-5555-5555-5555-55555555555d', '11111111-1111-1111-1111-111111111111', '22222222-2222-2222-2222-222222222222',
   'Blues Real', 'Real estate / DTC',
   '$1,000/mo budget → 950 clicks, 40K reach',
   E'Brand awareness + lead-gen campaign on Meta + Instagram for Blues Real, a Riviera Maya real-estate agency. Static + animated creative highlighting exclusive investment opportunities, driving qualified leads to the Blues Real website. On a $1,000 USD monthly budget we averaged 950 clicks and 40,000 accounts reached.',
   '[{"metric": "$1,000/mo", "label": "ad budget"}, {"metric": "950 clicks/mo", "label": "site traffic"}, {"metric": "40,000 accounts/mo", "label": "reach"}]'::jsonb,
   array['33333333-3333-3333-3333-333333333335']::uuid[], 13, true),

  ('5555555e-5555-5555-5555-55555555555e', '11111111-1111-1111-1111-111111111111', '22222222-2222-2222-2222-222222222222',
   'El Club', 'Fitness / wellness',
   '2nd-location launch: 900 leads, 30 quality, 12+ enrollments',
   E'Fitness studio in a saturated market. Built an organic posting grid and complemented it with Meta Ads. Month-over-month community growth to +3k followers. The launch campaign for the second location delivered 900+ leads, 30 quality leads, and 12+ first-day enrollments (vs 1 at the first location''s opening).',
   '[{"metric": "900+", "label": "leads on 2nd-location launch"}, {"metric": "30", "label": "quality leads"}, {"metric": "12+ enrollments", "label": "2nd-location opening day"}, {"metric": "+3k", "label": "community growth"}]'::jsonb,
   array['33333333-3333-3333-3333-333333333335']::uuid[], 14, true),

  ('5555555f-5555-5555-5555-55555555555f', '11111111-1111-1111-1111-111111111111', '22222222-2222-2222-2222-222222222222',
   'Lila', 'CPG / sustainability',
   '1,300 leads in 3 weeks (Meta + LinkedIn Ads)',
   E'Launched a new composting product priced above the market average. Rigorous industry research surfaced the real pain points and informed the creative for a Meta + LinkedIn Ads campaign. 1,300+ leads generated in the first 3 weeks, with sales ramping as the campaign matured.',
   '[{"metric": "1,300+", "label": "leads in 3 weeks"}, {"metric": "Above-market pricing", "label": "premium positioning"}]'::jsonb,
   array['33333333-3333-3333-3333-333333333335']::uuid[], 15, true),

  ('55555560-5555-5555-5555-555555555560', '11111111-1111-1111-1111-111111111111', '22222222-2222-2222-2222-222222222222',
   'Walt Disney Studios', 'Entertainment',
   'Last-minute high-impact project, MX leadership',
   E'When other agencies declined, Rünna accepted a last-minute project for Walt Disney Studios Motion Pictures México''s leadership with a clear scope and fast turnaround. Delivered a professional, interactive piece that — in the client''s words — "made us shine." Disney is a repeat testimonial client.',
   '[{"metric": "Walt Disney Studios Motion Pictures México", "label": "enterprise client"}, {"metric": "Same-week delivery", "label": "rapid turnaround"}]'::jsonb,
   array['33333333-3333-3333-3333-333333333333']::uuid[], 16, true),

  ('55555561-5555-5555-5555-555555555561', '11111111-1111-1111-1111-111111111111', '22222222-2222-2222-2222-222222222222',
   'Ford Edge 360', 'Automotive / immersive',
   'First VR test drive ever for a Ford vehicle',
   E'Ford Edge was delayed arriving to México and the sales force needed a way to demo the car before launch. Built the first VR test drive ever for a Ford vehicle: a 3D exterior model and a 360° interior tour, delivered in an app with Google Cardboard kits distributed in magazines. Customers took the test drive from home and Ford''s pre-launch interest climbed.',
   '[{"metric": "First", "label": "VR test drive in Ford history"}, {"metric": "Google Cardboard", "label": "distributed in-magazine"}, {"metric": "Pre-launch demo", "label": "unblocked sales force"}]'::jsonb,
   array['33333333-3333-3333-3333-333333333334', '33333333-3333-3333-3333-333333333333']::uuid[], 17, true),

  ('55555562-5555-5555-5555-555555555562', '11111111-1111-1111-1111-111111111111', '22222222-2222-2222-2222-222222222222',
   'Ford Pass Lincoln', 'Automotive / sales enablement',
   'Sales-floor app simulation with guided tour',
   E'Lincoln sales reps couldn''t use the Ford Pass companion app without a physical vehicle to pair. Built a full app simulation with a guided tour so reps, distributors, and floor staff could demo every feature without the car. Standard demo-gap problem, solved without changing the underlying app.',
   '[{"metric": "App simulation", "label": "demo-gap solved"}, {"metric": "Guided tour", "label": "no-training onboarding"}]'::jsonb,
   array['33333333-3333-3333-3333-333333333334', '33333333-3333-3333-3333-333333333333']::uuid[], 18, true),

  ('55555563-5555-5555-5555-555555555563', '11111111-1111-1111-1111-111111111111', '22222222-2222-2222-2222-222222222222',
   'Santander Universidades', 'Banking / education',
   'Full student platform with geolocated coupons',
   E'Integrated platform for Santander to reach university students: financial tips, a founder blog, interactive games, advisor contact, and a geolocated coupon book with partner brands. Generated a valuable student database for Santander and strengthened brand affinity with the next generation of clients.',
   '[{"metric": "5 modules", "label": "tips + blog + games + advisor + coupons"}, {"metric": "Geolocated", "label": "partner-brand discount book"}]'::jsonb,
   array['33333333-3333-3333-3333-333333333334', '33333333-3333-3333-3333-333333333333']::uuid[], 19, true),

  ('55555564-5555-5555-5555-555555555564', '11111111-1111-1111-1111-111111111111', '22222222-2222-2222-2222-222222222222',
   'Estadio Azteca', 'Sports / live events',
   'Real-time event social + brand identity reinforcement',
   E'Ran a new social-media strategy for Estadio Azteca: real-time event coverage (photo, video, static), reinforcing brand identity and promoting new products + services. Social became a live extension of the stadium experience rather than a promotional afterthought.',
   '[{"metric": "Real-time", "label": "event coverage"}, {"metric": "Estadio Azteca", "label": "iconic MX venue"}]'::jsonb,
   array['33333333-3333-3333-3333-333333333335']::uuid[], 20, true)

on conflict (id) do update set
  client_name = excluded.client_name,
  industry = excluded.industry,
  hero_metric_en = excluded.hero_metric_en,
  result_description_en = excluded.result_description_en,
  measurable_results = excluded.measurable_results,
  featured_services_id = excluded.featured_services_id,
  sort_order = excluded.sort_order,
  is_active = excluded.is_active;

-- ============================================================================
-- PART 3 — Client testimonials (3 real quotes from the deck)
-- ============================================================================

-- Ford — Melissa López, CX y Entrenamiento a Distribuidores
update case_studies set
  testimonial_quote_es = E'Cuando necesitamos un proveedor con ideas innovadoras, siempre encontramos en Rünna el mejor equipo creativo. Durante todos los años que hemos trabajado con ellos, su profesionalismo, sinceridad y espíritu transformador los ha destacado como uno de nuestros mejores proveedores.',
  testimonial_quote_en = E'When we need a partner with innovative ideas, we always find the best creative team at Rünna. Across all the years we''ve worked together, their professionalism, sincerity, and transformative spirit have stood out as one of our best providers.',
  testimonial_author = 'Melissa López',
  testimonial_title = 'CX & Distributor Training, Ford Motor Company México'
where id = '55555555-5555-5555-5555-555555555551';

-- DiDi — Evelena Zamorano, Sr. Brand Manager LATAM
update case_studies set
  testimonial_quote_es = E'En 2020 necesitábamos un partner que nos ayudara a construir una mejor presencia en medios digitales. El apoyo de Rünna nos dio la oportunidad de seguir construyendo nuestra marca en un nuevo nivel. Rünna siempre está abierta a encontrar soluciones a nuestros desafíos, a tiempo y manteniendo el paso de nuestra industria; tienen un equipo increíble que enriquece nuestra estrategia hasta el día de hoy.',
  testimonial_quote_en = E'In 2020 we needed a partner to help us build a better presence in digital media. Rünna''s support gave us the chance to keep building our brand at a new level. They''re always open to finding solutions to our challenges, on time, matching the pace of our industry — an incredible team that enriches our strategy to this day.',
  testimonial_author = 'Evelena Zamorano',
  testimonial_title = 'Sr. Brand Manager LATAM, DiDi Global Inc.'
where id = '55555555-5555-5555-5555-555555555552';

-- Walt Disney Studios — Ana C Díaz Montes, PR & Advertising
update case_studies set
  testimonial_quote_es = E'Tuvimos un proyecto de último minuto pero de alto impacto para el liderazgo de The Walt Disney Company México. Otras agencias se negaron a hacerlo y Rünna respondió de manera inmediata, dejaron muy claro qué podían hacer para nosotros y entregaron un proyecto súper profesional, interactivo y que nos hizo brillar.',
  testimonial_quote_en = E'We had a last-minute but high-impact project for The Walt Disney Company México''s leadership. Other agencies refused; Rünna responded immediately, made it very clear what they could do for us, and delivered a super-professional, interactive project that made us shine.',
  testimonial_author = 'Ana C Díaz Montes',
  testimonial_title = 'PR & Advertising, Walt Disney Studios Motion Pictures'
where id = '55555560-5555-5555-5555-555555555560';

-- ============================================================================
-- PART 4 — Wipe + rebuild case_study_pain_tags for all 20 active cases
-- ============================================================================

delete from case_study_pain_tags where case_study_id in (
  select id from case_studies where tenant_id = '11111111-1111-1111-1111-111111111111'
);

insert into case_study_pain_tags (case_study_id, pain_id, strength) values
  -- 1. Ford training — slow production cycles, unclear value prop
  ('55555555-5555-5555-5555-555555555551', '44444444-4444-4444-4444-444444444442', 1.0),
  ('55555555-5555-5555-5555-555555555551', '44444444-4444-4444-4444-44444444444b', 0.7),

  -- 2. DiDi main — poor social engagement, no content velocity, competitor pressure
  ('55555555-5555-5555-5555-555555555552', '44444444-4444-4444-4444-44444444444a', 1.0),
  ('55555555-5555-5555-5555-555555555552', '44444444-4444-4444-4444-444444444445', 1.0),
  ('55555555-5555-5555-5555-555555555552', '44444444-4444-4444-4444-44444444444c', 0.6),

  -- 3. Aeromexico VR — event/launch needs, unclear value prop
  ('55555555-5555-5555-5555-555555555553', '44444444-4444-4444-4444-44444444444d', 1.0),
  ('55555555-5555-5555-5555-555555555553', '44444444-4444-4444-4444-44444444444e', 0.8),

  -- 4. Bayer/Aspirina — product launch support, event/convention needs
  ('55555555-5555-5555-5555-555555555554', '44444444-4444-4444-4444-44444444444e', 1.0),
  ('55555555-5555-5555-5555-555555555554', '44444444-4444-4444-4444-44444444444d', 0.8),

  -- 5. Golden Hills — weak packaging, brand inconsistency
  ('55555555-5555-5555-5555-555555555555', '44444444-4444-4444-4444-444444444444', 1.0),
  ('55555555-5555-5555-5555-555555555555', '44444444-4444-4444-4444-444444444441', 1.0),

  -- 6. ANA Seguros — manual sales process, slow production cycles
  ('55555555-5555-5555-5555-555555555556', '44444444-4444-4444-4444-44444444444b', 1.0),
  ('55555555-5555-5555-5555-555555555556', '44444444-4444-4444-4444-444444444442', 0.9),

  -- 7. Pet's Club — weak packaging, brand inconsistency
  ('55555555-5555-5555-5555-555555555557', '44444444-4444-4444-4444-444444444444', 1.0),
  ('55555555-5555-5555-5555-555555555557', '44444444-4444-4444-4444-444444444441', 0.9),

  -- 8. SnapPad — weak packaging, competitor pressure
  ('55555555-5555-5555-5555-555555555558', '44444444-4444-4444-4444-444444444444', 1.0),
  ('55555555-5555-5555-5555-555555555558', '44444444-4444-4444-4444-44444444444c', 0.5),

  -- 9. Niki — product launch support, no proof, localization needs
  ('55555555-5555-5555-5555-555555555559', '44444444-4444-4444-4444-44444444444e', 1.0),
  ('55555555-5555-5555-5555-555555555559', '44444444-4444-4444-4444-444444444449', 0.8),
  ('55555555-5555-5555-5555-555555555559', '44444444-4444-4444-4444-44444444444f', 0.7),

  -- 10. DevFest Calgary — event activation, local proof
  ('55555555-5555-5555-5555-55555555555a', '44444444-4444-4444-4444-44444444444d', 1.0),
  ('55555555-5555-5555-5555-55555555555a', '44444444-4444-4444-4444-444444444449', 0.6),

  -- 11. DiDi Food — poor social engagement, no content velocity, competitor pressure
  ('5555555b-5555-5555-5555-55555555555b', '44444444-4444-4444-4444-44444444444a', 1.0),
  ('5555555b-5555-5555-5555-55555555555b', '44444444-4444-4444-4444-444444444445', 1.0),
  ('5555555b-5555-5555-5555-55555555555b', '44444444-4444-4444-4444-44444444444c', 0.7),

  -- 12. DiDi TikTok paid — product launch support, poor social engagement
  ('5555555c-5555-5555-5555-55555555555c', '44444444-4444-4444-4444-44444444444a', 0.9),
  ('5555555c-5555-5555-5555-55555555555c', '44444444-4444-4444-4444-44444444444e', 0.7),

  -- 13. Blues Real — manual sales process, unclear value prop
  ('5555555d-5555-5555-5555-55555555555d', '44444444-4444-4444-4444-44444444444b', 1.0),
  ('5555555d-5555-5555-5555-55555555555d', '44444444-4444-4444-4444-444444444446', 0.8),

  -- 14. El Club — competitor pressure, product launch support, no proof
  ('5555555e-5555-5555-5555-55555555555e', '44444444-4444-4444-4444-44444444444c', 1.0),
  ('5555555e-5555-5555-5555-55555555555e', '44444444-4444-4444-4444-44444444444e', 0.9),
  ('5555555e-5555-5555-5555-55555555555e', '44444444-4444-4444-4444-444444444449', 0.6),

  -- 15. Lila — product launch, unclear value prop, competitor pressure
  ('5555555f-5555-5555-5555-55555555555f', '44444444-4444-4444-4444-44444444444e', 1.0),
  ('5555555f-5555-5555-5555-55555555555f', '44444444-4444-4444-4444-444444444446', 0.9),
  ('5555555f-5555-5555-5555-55555555555f', '44444444-4444-4444-4444-44444444444c', 0.7),

  -- 16. Walt Disney Studios — event/launch needs, no proof (as credibility anchor)
  ('55555560-5555-5555-5555-555555555560', '44444444-4444-4444-4444-44444444444d', 0.9),
  ('55555560-5555-5555-5555-555555555560', '44444444-4444-4444-4444-444444444449', 0.8),

  -- 17. Ford Edge 360 — product launch support, event activation
  ('55555561-5555-5555-5555-555555555561', '44444444-4444-4444-4444-44444444444e', 1.0),
  ('55555561-5555-5555-5555-555555555561', '44444444-4444-4444-4444-44444444444d', 0.8),

  -- 18. Ford Pass Lincoln — manual sales process, slow production cycles
  ('55555562-5555-5555-5555-555555555562', '44444444-4444-4444-4444-44444444444b', 1.0),
  ('55555562-5555-5555-5555-555555555562', '44444444-4444-4444-4444-444444444442', 0.6),

  -- 19. Santander Universidades — no content velocity, unclear value prop, outdated website
  ('55555563-5555-5555-5555-555555555563', '44444444-4444-4444-4444-444444444445', 0.9),
  ('55555563-5555-5555-5555-555555555563', '44444444-4444-4444-4444-444444444446', 0.8),
  ('55555563-5555-5555-5555-555555555563', '44444444-4444-4444-4444-444444444448', 0.7),

  -- 20. Estadio Azteca — no content velocity, event activation
  ('55555564-5555-5555-5555-555555555564', '44444444-4444-4444-4444-444444444445', 1.0),
  ('55555564-5555-5555-5555-555555555564', '44444444-4444-4444-4444-44444444444d', 0.9);
