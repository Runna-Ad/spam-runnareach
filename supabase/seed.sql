-- ============================================================================
-- S.P.A.M. — Seed Data
-- Run after 0001_initial_schema.sql
--
-- Seeds:
--   - 1 tenant (RUNNA_CA)
--   - 2 brand instances (Runna CA + Rünna)
--   - 5 Runna CA services with CAD/MXN/USD pricing
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
  ('11111111-1111-1111-1111-111111111111', 'RUNNA_CA', 'Runna CA', 'CA', 'en', 'America/Edmonton', 75.00, 150.00);

insert into brand_instances (id, tenant_id, code, display_name, website_url, primary_market, languages)
values
  ('22222222-2222-2222-2222-222222222221', '11111111-1111-1111-1111-111111111111', 'RUNNA_CA', 'Runna CA', 'https://runna.agency', 'CA', array['en']::language[]),
  ('22222222-2222-2222-2222-222222222222', '11111111-1111-1111-1111-111111111111', 'RUNNA', 'Rünna', 'https://runna.mx', 'MX', array['es', 'en']::language[]);

-- ----------------------------------------------------------------------------
-- Services (5 Runna CA services)
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
-- Case studies (20 Rünna wins, sourced from the 2026 ESP deck)
-- Every row has either a verified numeric result or a specific, honestly
-- scoped deliverable from the deck. No fabricated metrics.
-- ----------------------------------------------------------------------------

insert into case_studies (id, tenant_id, brand_instance_id, client_name, industry, hero_metric_en, result_description_en, measurable_results, featured_services_id, sort_order, is_active,
  testimonial_quote_en, testimonial_quote_es, testimonial_author, testimonial_title) values

  -- 1. Ford (training platform) — includes Melissa López testimonial
  ('55555555-5555-5555-5555-555555555551', '11111111-1111-1111-1111-111111111111', '22222222-2222-2222-2222-222222222222',
   'Ford', 'Automotive / enterprise training',
   'Sales-force training: 3 months → 1 week',
   E'Built an interactive gamified training platform that cut Ford México''s sales-force onboarding from a 3-month average to 1 week. Ford México received a national innovation award for the platform.',
   '[{"metric": "3 months → 1 week", "label": "training cycle"}, {"metric": "Innovation Award", "label": "Ford México recognition"}]'::jsonb,
   array['33333333-3333-3333-3333-333333333334', '33333333-3333-3333-3333-333333333333']::uuid[], 1, true,
   E'When we need a partner with innovative ideas, we always find the best creative team at Rünna. Across all the years we''ve worked together, their professionalism, sincerity, and transformative spirit have stood out as one of our best providers.',
   E'Cuando necesitamos un proveedor con ideas innovadoras, siempre encontramos en Rünna el mejor equipo creativo. Durante todos los años que hemos trabajado con ellos, su profesionalismo, sinceridad y espíritu transformador los ha destacado como uno de nuestros mejores proveedores.',
   'Melissa López', 'CX & Distributor Training, Ford Motor Company México'),

  -- 2. DiDi (main, LATAM) — includes Evelena Zamorano testimonial
  ('55555555-5555-5555-5555-555555555552', '11111111-1111-1111-1111-111111111111', '22222222-2222-2222-2222-222222222222',
   'DiDi', 'Mobility / ride-share',
   '5 years across 10 LATAM countries',
   E'Ran DiDi México''s FB / IG / TikTok / X social for 5 years with an entertainment-led strategy focused on engagement, community, and leads-to-app. In the last 2 years scaled to 10 LATAM countries, doubling DiDi''s total digital community. Produced original content + trend filmings for the brand and its Key Accounts.',
   '[{"metric": "10 LATAM countries", "label": "regional expansion"}, {"metric": "Doubled", "label": "total digital community"}, {"metric": "5 years", "label": "continuous social management"}]'::jsonb,
   array['33333333-3333-3333-3333-333333333335']::uuid[], 2, true,
   E'In 2020 we needed a partner to help us build a better presence in digital media. Rünna''s support gave us the chance to keep building our brand at a new level. They''re always open to finding solutions to our challenges, on time, matching the pace of our industry — an incredible team that enriches our strategy to this day.',
   E'En 2020 necesitábamos un partner que nos ayudara a construir una mejor presencia en medios digitales. El apoyo de Rünna nos dio la oportunidad de seguir construyendo nuestra marca en un nuevo nivel. Rünna siempre está abierta a encontrar soluciones a nuestros desafíos, a tiempo y manteniendo el paso de nuestra industria; tienen un equipo increíble que enriquece nuestra estrategia hasta el día de hoy.',
   'Evelena Zamorano', 'Sr. Brand Manager LATAM, DiDi Global Inc.'),

  -- 3. Aeromexico VR
  ('55555555-5555-5555-5555-555555555553', '11111111-1111-1111-1111-111111111111', '22222222-2222-2222-2222-222222222222',
   'Aeromexico', 'Airlines',
   '35K downloads, 1M impressions',
   E'360° VR destination app promoting Aeromexico''s new direct routes. Conceived as a short-term campaign; word-of-mouth alone drove 35,000+ downloads and 1M+ impressions without paid media.',
   '[{"metric": "35,000+", "label": "downloads"}, {"metric": "1M+", "label": "impressions (organic)"}, {"metric": "$0", "label": "paid media"}]'::jsonb,
   array['33333333-3333-3333-3333-333333333333']::uuid[], 3, true,
   null, null, null, null),

  -- 4. Bayer / Aspirina Protect (AR)
  ('55555555-5555-5555-5555-555555555554', '11111111-1111-1111-1111-111111111111', '22222222-2222-2222-2222-222222222222',
   'Bayer / Aspirina Protect', 'Pharmaceutical',
   'Doctor attention: <1 min → 5+ min',
   E'Augmented Reality app built for Bayer to hold doctors'' attention on a box of Aspirina Protect. A 3D human body model appeared over the box and walked through the drug''s benefits. Doctors not only engaged longer, they called colleagues over. Bayer México presented the app at a global convention.',
   '[{"metric": "<1 min → 5+ min", "label": "doctor engagement time"}, {"metric": "Global convention", "label": "Bayer international presentation"}]'::jsonb,
   array['33333333-3333-3333-3333-333333333334']::uuid[], 4, true,
   null, null, null, null),

  -- 5. Golden Hills (rebrand)
  ('55555555-5555-5555-5555-555555555555', '11111111-1111-1111-1111-111111111111', '22222222-2222-2222-2222-222222222222',
   'Golden Hills', 'CPG / retail',
   '400+ SKUs in a single packaging system',
   E'Full rebrand + packaging operation for Golden Hills. 400+ products redesigned around a clean, minimalist system with strategic chromatics, plus internal banners, tech sheets, and product mock-ups / renders for web + print.',
   '[{"metric": "400+", "label": "SKUs redesigned"}, {"metric": "1", "label": "unified packaging system"}]'::jsonb,
   array['33333333-3333-3333-3333-333333333331', '33333333-3333-3333-3333-333333333332']::uuid[], 5, true,
   null, null, null, null),

  -- 6. ANA Seguros
  ('55555555-5555-5555-5555-555555555556', '11111111-1111-1111-1111-111111111111', '22222222-2222-2222-2222-222222222222',
   'ANA Seguros', 'Insurance',
   'Applications +1,000%',
   E'Digitized and automated the agent recruitment process for ANA Seguros via a dedicated app. Recruitment applications rose more than 1,000% and the hiring cycle compressed from ~2 months to under 2 weeks.',
   '[{"metric": "+1,000%", "label": "recruitment applications"}, {"metric": "2 months → <2 weeks", "label": "hiring cycle"}]'::jsonb,
   array['33333333-3333-3333-3333-333333333334', '33333333-3333-3333-3333-333333333333']::uuid[], 6, true,
   null, null, null, null),

  -- 7. Pet's Club (rebrand + packaging)
  ('55555555-5555-5555-5555-555555555557', '11111111-1111-1111-1111-111111111111', '22222222-2222-2222-2222-222222222222',
   'Pet''s Club', 'Retail / pet products',
   '290+ packages across 3 product pillars',
   E'Relaunched Pet''s Club''s visual identity and packaging. Segmented the line into 3 pillars (Dogs / Cats / Other pets), each with its own personality but a unified master system. Designed a premium subline for dogs and cats. 290+ unique packages and labels shipped across the catalog.',
   '[{"metric": "290+", "label": "packages + labels designed"}, {"metric": "3 pillars", "label": "product-segment identity system"}]'::jsonb,
   array['33333333-3333-3333-3333-333333333331', '33333333-3333-3333-3333-333333333332']::uuid[], 7, true,
   null, null, null, null),

  -- 8. SnapPad (Canadian retail packaging)
  ('55555555-5555-5555-5555-555555555558', '11111111-1111-1111-1111-111111111111', '22222222-2222-2222-2222-222222222222',
   'SnapPad', 'DTC / RV accessories',
   'Canadian retail packaging system',
   E'Designed the Canadian retail packaging for SnapPad''s RV-accessories line, engineered to stand out at point-of-sale with clearer information hierarchy and stronger shelf presence. A Rünna proof point of Canadian retail work, delivered from the same MX creative team.',
   '[{"metric": "Canadian retail", "label": "shelf-ready packaging"}, {"metric": "RV-accessories line", "label": "category scope"}]'::jsonb,
   array['33333333-3333-3333-3333-333333333331']::uuid[], 8, true,
   null, null, null, null),

  -- 9. Niki (Canadian study-abroad platform)
  ('55555555-5555-5555-5555-555555555559', '11111111-1111-1111-1111-111111111111', '22222222-2222-2222-2222-222222222222',
   'Niki', 'Education / study-abroad platform',
   '2,000 followers + 40K video views in 1 month',
   E'Launched Niki''s brand and social presence from zero on a startup budget. Niki is a platform placing international students in Canadian institutions. In the first month the launch generated 2,000+ followers, 40,000+ video views, and 1,000+ unique visitors driven to the platform.',
   '[{"metric": "2,000+", "label": "followers in month 1"}, {"metric": "40,000+", "label": "video views in month 1"}, {"metric": "1,000+", "label": "unique platform visitors"}]'::jsonb,
   array['33333333-3333-3333-3333-333333333332', '33333333-3333-3333-3333-333333333335']::uuid[], 9, true,
   null, null, null, null),

  -- 10. DevFest Calgary 2024
  ('55555555-5555-5555-5555-55555555555a', '11111111-1111-1111-1111-111111111111', '22222222-2222-2222-2222-222222222222',
   'DevFest Calgary 2024', 'Events / tech conference',
   'Canadian tech event ad campaign',
   E'Meta + Instagram ad campaign for DevFest Calgary 2024, the local Google Developers conference. Promoted headline speakers, schedule, and event details; built anticipation and drove attendance within the Canadian developer community. Runna CA''s first public Canadian event-marketing work.',
   '[{"metric": "DevFest Calgary 2024", "label": "local developer conference"}, {"metric": "Meta + Instagram", "label": "ad campaign platforms"}]'::jsonb,
   array['33333333-3333-3333-3333-333333333335']::uuid[], 10, true,
   null, null, null, null),

  -- 11. DiDi Food
  ('5555555b-5555-5555-5555-55555555555b', '11111111-1111-1111-1111-111111111111', '22222222-2222-2222-2222-222222222222',
   'DiDi Food', 'Food delivery / mobility',
   '100K TikTok followers in 7 months, +1,400% positive sentiment',
   E'Managed DiDi Food''s social across FB / IG / TikTok / X in México + 6 LATAM countries for 4 years. An entertainment-led strategy doubled DiDi Food''s total community and lifted positive sentiment by 1,400%. Opened DiDi Food''s TikTok from scratch and reached 100,000+ followers in México in under 7 months.',
   '[{"metric": "100,000+", "label": "TikTok followers in 7 months"}, {"metric": "+1,400%", "label": "positive sentiment"}, {"metric": "6 LATAM countries", "label": "regional reach"}, {"metric": "Doubled", "label": "community size"}]'::jsonb,
   array['33333333-3333-3333-3333-333333333335']::uuid[], 11, true,
   null, null, null, null),

  -- 12. DiDi (TikTok paid)
  ('5555555c-5555-5555-5555-55555555555c', '11111111-1111-1111-1111-111111111111', '22222222-2222-2222-2222-222222222222',
   'DiDi (TikTok paid)', 'Performance marketing',
   '120M+ impressions, 25K app downloads, $0.02 CPM',
   E'"We don''t make ads, we make TikToks." Built DiDi''s TikTok paid-media strategy end-to-end: creative, production, and campaign management. Generated 120M+ impressions and 25,000+ app downloads at a $0.02 USD CPM using low-budget productions that read as native platform content.',
   '[{"metric": "120M+", "label": "impressions"}, {"metric": "25,000+", "label": "app downloads"}, {"metric": "$0.02 USD", "label": "CPM"}]'::jsonb,
   array['33333333-3333-3333-3333-333333333335']::uuid[], 12, true,
   null, null, null, null),

  -- 13. Blues Real
  ('5555555d-5555-5555-5555-55555555555d', '11111111-1111-1111-1111-111111111111', '22222222-2222-2222-2222-222222222222',
   'Blues Real', 'Real estate / DTC',
   '$1,000/mo budget → 950 clicks, 40K reach',
   E'Brand awareness + lead-gen campaign on Meta + Instagram for Blues Real, a Riviera Maya real-estate agency. Static + animated creative highlighting exclusive investment opportunities, driving qualified leads to the Blues Real website. On a $1,000 USD monthly budget we averaged 950 clicks and 40,000 accounts reached.',
   '[{"metric": "$1,000/mo", "label": "ad budget"}, {"metric": "950 clicks/mo", "label": "site traffic"}, {"metric": "40,000 accounts/mo", "label": "reach"}]'::jsonb,
   array['33333333-3333-3333-3333-333333333335']::uuid[], 13, true,
   null, null, null, null),

  -- 14. El Club
  ('5555555e-5555-5555-5555-55555555555e', '11111111-1111-1111-1111-111111111111', '22222222-2222-2222-2222-222222222222',
   'El Club', 'Fitness / wellness',
   '2nd-location launch: 900 leads, 30 quality, 12+ enrollments',
   E'Fitness studio in a saturated market. Built an organic posting grid and complemented it with Meta Ads. Month-over-month community growth to +3k followers. The launch campaign for the second location delivered 900+ leads, 30 quality leads, and 12+ first-day enrollments (vs 1 at the first location''s opening).',
   '[{"metric": "900+", "label": "leads on 2nd-location launch"}, {"metric": "30", "label": "quality leads"}, {"metric": "12+ enrollments", "label": "2nd-location opening day"}, {"metric": "+3k", "label": "community growth"}]'::jsonb,
   array['33333333-3333-3333-3333-333333333335']::uuid[], 14, true,
   null, null, null, null),

  -- 15. Lila
  ('5555555f-5555-5555-5555-55555555555f', '11111111-1111-1111-1111-111111111111', '22222222-2222-2222-2222-222222222222',
   'Lila', 'CPG / sustainability',
   '1,300 leads in 3 weeks (Meta + LinkedIn Ads)',
   E'Launched a new composting product priced above the market average. Rigorous industry research surfaced the real pain points and informed the creative for a Meta + LinkedIn Ads campaign. 1,300+ leads generated in the first 3 weeks, with sales ramping as the campaign matured.',
   '[{"metric": "1,300+", "label": "leads in 3 weeks"}, {"metric": "Above-market pricing", "label": "premium positioning"}]'::jsonb,
   array['33333333-3333-3333-3333-333333333335']::uuid[], 15, true,
   null, null, null, null),

  -- 16. Walt Disney Studios — includes Ana C Díaz Montes testimonial
  ('55555560-5555-5555-5555-555555555560', '11111111-1111-1111-1111-111111111111', '22222222-2222-2222-2222-222222222222',
   'Walt Disney Studios', 'Entertainment',
   'Last-minute high-impact project, MX leadership',
   E'When other agencies declined, Rünna accepted a last-minute project for Walt Disney Studios Motion Pictures México''s leadership with a clear scope and fast turnaround. Delivered a professional, interactive piece that — in the client''s words — "made us shine." Disney is a repeat testimonial client.',
   '[{"metric": "Walt Disney Studios Motion Pictures México", "label": "enterprise client"}, {"metric": "Same-week delivery", "label": "rapid turnaround"}]'::jsonb,
   array['33333333-3333-3333-3333-333333333333']::uuid[], 16, true,
   E'We had a last-minute but high-impact project for The Walt Disney Company México''s leadership. Other agencies refused; Rünna responded immediately, made it very clear what they could do for us, and delivered a super-professional, interactive project that made us shine.',
   E'Tuvimos un proyecto de último minuto pero de alto impacto para el liderazgo de The Walt Disney Company México. Otras agencias se negaron a hacerlo y Rünna respondió de manera inmediata, dejaron muy claro qué podían hacer para nosotros y entregaron un proyecto súper profesional, interactivo y que nos hizo brillar.',
   'Ana C Díaz Montes', 'PR & Advertising, Walt Disney Studios Motion Pictures'),

  -- 17. Ford Edge 360
  ('55555561-5555-5555-5555-555555555561', '11111111-1111-1111-1111-111111111111', '22222222-2222-2222-2222-222222222222',
   'Ford Edge 360', 'Automotive / immersive',
   'First VR test drive ever for a Ford vehicle',
   E'Ford Edge was delayed arriving to México and the sales force needed a way to demo the car before launch. Built the first VR test drive ever for a Ford vehicle: a 3D exterior model and a 360° interior tour, delivered in an app with Google Cardboard kits distributed in magazines. Customers took the test drive from home and Ford''s pre-launch interest climbed.',
   '[{"metric": "First", "label": "VR test drive in Ford history"}, {"metric": "Google Cardboard", "label": "distributed in-magazine"}, {"metric": "Pre-launch demo", "label": "unblocked sales force"}]'::jsonb,
   array['33333333-3333-3333-3333-333333333334', '33333333-3333-3333-3333-333333333333']::uuid[], 17, true,
   null, null, null, null),

  -- 18. Ford Pass Lincoln
  ('55555562-5555-5555-5555-555555555562', '11111111-1111-1111-1111-111111111111', '22222222-2222-2222-2222-222222222222',
   'Ford Pass Lincoln', 'Automotive / sales enablement',
   'Sales-floor app simulation with guided tour',
   E'Lincoln sales reps couldn''t use the Ford Pass companion app without a physical vehicle to pair. Built a full app simulation with a guided tour so reps, distributors, and floor staff could demo every feature without the car. Standard demo-gap problem, solved without changing the underlying app.',
   '[{"metric": "App simulation", "label": "demo-gap solved"}, {"metric": "Guided tour", "label": "no-training onboarding"}]'::jsonb,
   array['33333333-3333-3333-3333-333333333334', '33333333-3333-3333-3333-333333333333']::uuid[], 18, true,
   null, null, null, null),

  -- 19. Santander Universidades
  ('55555563-5555-5555-5555-555555555563', '11111111-1111-1111-1111-111111111111', '22222222-2222-2222-2222-222222222222',
   'Santander Universidades', 'Banking / education',
   'Full student platform with geolocated coupons',
   E'Integrated platform for Santander to reach university students: financial tips, a founder blog, interactive games, advisor contact, and a geolocated coupon book with partner brands. Generated a valuable student database for Santander and strengthened brand affinity with the next generation of clients.',
   '[{"metric": "5 modules", "label": "tips + blog + games + advisor + coupons"}, {"metric": "Geolocated", "label": "partner-brand discount book"}]'::jsonb,
   array['33333333-3333-3333-3333-333333333334', '33333333-3333-3333-3333-333333333333']::uuid[], 19, true,
   null, null, null, null),

  -- 20. Estadio Azteca
  ('55555564-5555-5555-5555-555555555564', '11111111-1111-1111-1111-111111111111', '22222222-2222-2222-2222-222222222222',
   'Estadio Azteca', 'Sports / live events',
   'Real-time event social + brand identity reinforcement',
   E'Ran a new social-media strategy for Estadio Azteca: real-time event coverage (photo, video, static), reinforcing brand identity and promoting new products + services. Social became a live extension of the stadium experience rather than a promotional afterthought.',
   '[{"metric": "Real-time", "label": "event coverage"}, {"metric": "Estadio Azteca", "label": "iconic MX venue"}]'::jsonb,
   array['33333333-3333-3333-3333-333333333335']::uuid[], 20, true,
   null, null, null, null);

-- ----------------------------------------------------------------------------
-- Case study → pain taxonomy mapping (many-to-many)
-- 46 mappings across 20 cases
-- ----------------------------------------------------------------------------

insert into case_study_pain_tags (case_study_id, pain_id, strength) values
  -- 1. Ford training — slow cycles, manual sales process
  ('55555555-5555-5555-5555-555555555551', '44444444-4444-4444-4444-444444444442', 1.0),
  ('55555555-5555-5555-5555-555555555551', '44444444-4444-4444-4444-44444444444b', 0.7),
  -- 2. DiDi main — social engagement, content velocity, competitor pressure
  ('55555555-5555-5555-5555-555555555552', '44444444-4444-4444-4444-44444444444a', 1.0),
  ('55555555-5555-5555-5555-555555555552', '44444444-4444-4444-4444-444444444445', 1.0),
  ('55555555-5555-5555-5555-555555555552', '44444444-4444-4444-4444-44444444444c', 0.6),
  -- 3. Aeromexico VR — event activation, product launch support
  ('55555555-5555-5555-5555-555555555553', '44444444-4444-4444-4444-44444444444d', 1.0),
  ('55555555-5555-5555-5555-555555555553', '44444444-4444-4444-4444-44444444444e', 0.8),
  -- 4. Bayer Aspirina — product launch support, event activation
  ('55555555-5555-5555-5555-555555555554', '44444444-4444-4444-4444-44444444444e', 1.0),
  ('55555555-5555-5555-5555-555555555554', '44444444-4444-4444-4444-44444444444d', 0.8),
  -- 5. Golden Hills — weak packaging, brand inconsistency
  ('55555555-5555-5555-5555-555555555555', '44444444-4444-4444-4444-444444444444', 1.0),
  ('55555555-5555-5555-5555-555555555555', '44444444-4444-4444-4444-444444444441', 1.0),
  -- 6. ANA Seguros — manual sales, slow production cycles
  ('55555555-5555-5555-5555-555555555556', '44444444-4444-4444-4444-44444444444b', 1.0),
  ('55555555-5555-5555-5555-555555555556', '44444444-4444-4444-4444-444444444442', 0.9),
  -- 7. Pet's Club — weak packaging, brand inconsistency
  ('55555555-5555-5555-5555-555555555557', '44444444-4444-4444-4444-444444444444', 1.0),
  ('55555555-5555-5555-5555-555555555557', '44444444-4444-4444-4444-444444444441', 0.9),
  -- 8. SnapPad — weak packaging, competitor pressure
  ('55555555-5555-5555-5555-555555555558', '44444444-4444-4444-4444-444444444444', 1.0),
  ('55555555-5555-5555-5555-555555555558', '44444444-4444-4444-4444-44444444444c', 0.5),
  -- 9. Niki — product launch, no proof, localization
  ('55555555-5555-5555-5555-555555555559', '44444444-4444-4444-4444-44444444444e', 1.0),
  ('55555555-5555-5555-5555-555555555559', '44444444-4444-4444-4444-444444444449', 0.8),
  ('55555555-5555-5555-5555-555555555559', '44444444-4444-4444-4444-44444444444f', 0.7),
  -- 10. DevFest Calgary 2024 — event activation, no proof (for local proof angle)
  ('55555555-5555-5555-5555-55555555555a', '44444444-4444-4444-4444-44444444444d', 1.0),
  ('55555555-5555-5555-5555-55555555555a', '44444444-4444-4444-4444-444444444449', 0.6),
  -- 11. DiDi Food — social engagement, content velocity, competitor pressure
  ('5555555b-5555-5555-5555-55555555555b', '44444444-4444-4444-4444-44444444444a', 1.0),
  ('5555555b-5555-5555-5555-55555555555b', '44444444-4444-4444-4444-444444444445', 1.0),
  ('5555555b-5555-5555-5555-55555555555b', '44444444-4444-4444-4444-44444444444c', 0.7),
  -- 12. DiDi TikTok paid — social engagement, product launch
  ('5555555c-5555-5555-5555-55555555555c', '44444444-4444-4444-4444-44444444444a', 0.9),
  ('5555555c-5555-5555-5555-55555555555c', '44444444-4444-4444-4444-44444444444e', 0.7),
  -- 13. Blues Real — manual sales process, unclear value prop
  ('5555555d-5555-5555-5555-55555555555d', '44444444-4444-4444-4444-44444444444b', 1.0),
  ('5555555d-5555-5555-5555-55555555555d', '44444444-4444-4444-4444-444444444446', 0.8),
  -- 14. El Club — competitor pressure, product launch, no proof
  ('5555555e-5555-5555-5555-55555555555e', '44444444-4444-4444-4444-44444444444c', 1.0),
  ('5555555e-5555-5555-5555-55555555555e', '44444444-4444-4444-4444-44444444444e', 0.9),
  ('5555555e-5555-5555-5555-55555555555e', '44444444-4444-4444-4444-444444444449', 0.6),
  -- 15. Lila — product launch, unclear value prop, competitor pressure
  ('5555555f-5555-5555-5555-55555555555f', '44444444-4444-4444-4444-44444444444e', 1.0),
  ('5555555f-5555-5555-5555-55555555555f', '44444444-4444-4444-4444-444444444446', 0.9),
  ('5555555f-5555-5555-5555-55555555555f', '44444444-4444-4444-4444-44444444444c', 0.7),
  -- 16. Walt Disney Studios — event/launch, no proof (credibility anchor)
  ('55555560-5555-5555-5555-555555555560', '44444444-4444-4444-4444-44444444444d', 0.9),
  ('55555560-5555-5555-5555-555555555560', '44444444-4444-4444-4444-444444444449', 0.8),
  -- 17. Ford Edge 360 — product launch, event activation
  ('55555561-5555-5555-5555-555555555561', '44444444-4444-4444-4444-44444444444e', 1.0),
  ('55555561-5555-5555-5555-555555555561', '44444444-4444-4444-4444-44444444444d', 0.8),
  -- 18. Ford Pass Lincoln — manual sales, slow production cycles
  ('55555562-5555-5555-5555-555555555562', '44444444-4444-4444-4444-44444444444b', 1.0),
  ('55555562-5555-5555-5555-555555555562', '44444444-4444-4444-4444-444444444442', 0.6),
  -- 19. Santander Universidades — no content velocity, unclear value prop, outdated website
  ('55555563-5555-5555-5555-555555555563', '44444444-4444-4444-4444-444444444445', 0.9),
  ('55555563-5555-5555-5555-555555555563', '44444444-4444-4444-4444-444444444446', 0.8),
  ('55555563-5555-5555-5555-555555555563', '44444444-4444-4444-4444-444444444448', 0.7),
  -- 20. Estadio Azteca — no content velocity, event activation
  ('55555564-5555-5555-5555-555555555564', '44444444-4444-4444-4444-444444444445', 1.0),
  ('55555564-5555-5555-5555-555555555564', '44444444-4444-4444-4444-44444444444d', 0.9);

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
  ('77777777-7777-7777-7777-777777777772', '11111111-1111-1111-1111-111111111111', 'scoring', 'en', 'Score a prospect 0-100 against the 5 Runna CA services composite rubric.'),
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
    'You are a research analyst for Runna CA, a Canadian creative agency (the Canadian arm of Rünna). Extract structured intelligence from raw website content. Be specific, cite URL evidence, never hallucinate. If a pain point has no URL evidence, omit it. Never invent tech stack items you cannot verify from visible HTML, script src, or common platform signals.',
    E'Analyze the following scraped content from {{domain}}.\n\nReturn strict JSON:\n{\n  "what_they_do": "<one sentence, concrete>",\n  "tech_stack": ["<verified platforms/tools>"],\n  "pain_points": [\n    {"pain_code": "<from taxonomy>", "evidence_url": "<exact URL>", "quote": "<direct quote or observation>"}\n  ]\n}\n\nContent:\n{{scraped_content}}\n\nPain taxonomy options: {{taxonomy_codes}}',
    'claude-sonnet-4-7', 0.3, 2048
  ),
  (
    '88888888-8888-8888-8888-888888888882',
    '77777777-7777-7777-7777-777777777772', '1.0.0', 'champion',
    'You are a sales qualifier for Runna CA. Score prospects 0-100 using the composite rubric. Be rigorous about red flags — any single red flag means the prospect is a hard no, regardless of other points.',
    E'Score this prospect:\n\n{{research_brief}}\n\nRubric (max 100):\n- Industry fit (0-25): matches ICP industry tags\n- Size fit (0-10): 5-50 employees is ideal\n- Digital maturity (0-10): active site, social, last updated <90d\n- Pain signal strength (0-20): URL-level evidence of pains we solve\n- Service match (0-15): fit to at least 1 of 5 Runna CA services\n- Contact discoverability (0-10): decision-maker email or LinkedIn found\n\nRed flags (hard -100): agency, competitor, existing R\u00fcnna client, wrong country, dead site, MLM, adult, DNC list.\n\nReturn JSON: {composite_score, points_breakdown, red_flags, best_service_code, best_pain_code, best_case_study_client, confidence, reasoning}',
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
    E'You write cold pitches for Runna CA (Canadian arm of R\u00fcnna). Every pitch MUST cite a specific R\u00fcnna case study by client name with a measurable result from the provided case study data.\n\nHard rules:\n- Subject line <7 words, observational not promotional\n- Body 70-110 words\n- Open with a specific observation about their site or business (cite URL)\n- Pivot to a parallel R\u00fcnna win using the exact client name and measurable number\n- Single soft CTA at end (15-min call, quick question, worth a look)\n- No superlatives, no "transform your business," no "leverage synergies"\n- Write like a human, not a template\n\nIf you cannot ground the pitch in a real case study with a real metric, REFUSE and return {"refused": true, "reason": "..."}.',
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
    E'{{sender_full_name}}\n{{sender_title}} \u2022 {{brand_display_name}}\n{{mailing_address}}\n\nYou\u2019re receiving this because your email was conspicuously published in a business context. If this isn\u2019t relevant, reply with "unsubscribe" or click here: {{unsubscribe_url}}\n\nRunna CA is the Canadian arm of R\u00fcnna. More about us: {{website_url}}',
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
