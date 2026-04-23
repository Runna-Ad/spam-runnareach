// Apply migration 0003_refresh_case_studies.sql to the live Supabase project
// via the service-role client. The raw SQL lives in
// supabase/migrations/0003_refresh_case_studies.sql (for fresh installs and
// review); this script mirrors it programmatically so we can run it without
// asking Pedro to paste SQL into the dashboard.
//
// Idempotent — safe to run multiple times.
//
// Env required:
//   NEXT_PUBLIC_SUPABASE_URL
//   SUPABASE_SERVICE_ROLE_KEY
// Run from project root:
//   export $(grep -v '^#' .env.local | xargs) && node scripts/apply-0003.mjs

import { createClient } from "@supabase/supabase-js";

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !key) {
  console.error("Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY");
  process.exit(1);
}
const admin = createClient(url, key, { auth: { persistSession: false } });

const TENANT = "11111111-1111-1111-1111-111111111111";
const BRAND = "22222222-2222-2222-2222-222222222222";

// Service UUIDs (from seed)
const S = {
  unlimited_design: "33333333-3333-3333-3333-333333333331",
  brand_identity: "33333333-3333-3333-3333-333333333332",
  fast_website: "33333333-3333-3333-3333-333333333333",
  smart_chatbot: "33333333-3333-3333-3333-333333333334",
  content_system: "33333333-3333-3333-3333-333333333335",
};

// Pain taxonomy UUIDs
const P = {
  brand_inconsistency: "44444444-4444-4444-4444-444444444441",
  slow_production_cycles: "44444444-4444-4444-4444-444444444442",
  poor_mobile_conversion: "44444444-4444-4444-4444-444444444443",
  weak_packaging: "44444444-4444-4444-4444-444444444444",
  no_content_velocity: "44444444-4444-4444-4444-444444444445",
  unclear_value_prop: "44444444-4444-4444-4444-444444444446",
  low_email_performance: "44444444-4444-4444-4444-444444444447",
  outdated_website: "44444444-4444-4444-4444-444444444448",
  no_proof: "44444444-4444-4444-4444-444444444449",
  poor_social_engagement: "44444444-4444-4444-4444-44444444444a",
  manual_sales_process: "44444444-4444-4444-4444-44444444444b",
  competitor_pressure: "44444444-4444-4444-4444-44444444444c",
  event_activation_needs: "44444444-4444-4444-4444-44444444444d",
  product_launch_support: "44444444-4444-4444-4444-44444444444e",
  localization_needs: "44444444-4444-4444-4444-44444444444f",
};

// 20 case studies (10 corrected + 10 new)
const CASES = [
  {
    id: "55555555-5555-5555-5555-555555555551",
    client_name: "Ford",
    industry: "Automotive / enterprise training",
    hero_metric_en: "Sales-force training: 3 months → 1 week",
    result_description_en:
      "Built an interactive gamified training platform that cut Ford México's sales-force onboarding from a 3-month average to 1 week. Ford México received a national innovation award for the platform.",
    measurable_results: [
      { metric: "3 months → 1 week", label: "training cycle" },
      { metric: "Innovation Award", label: "Ford México recognition" },
    ],
    featured_services_id: [S.smart_chatbot, S.fast_website],
    sort_order: 1,
  },
  {
    id: "55555555-5555-5555-5555-555555555552",
    client_name: "DiDi",
    industry: "Mobility / ride-share",
    hero_metric_en: "5 years across 10 LATAM countries",
    result_description_en:
      "Ran DiDi México's FB / IG / TikTok / X social for 5 years with an entertainment-led strategy focused on engagement, community, and leads-to-app. In the last 2 years scaled to 10 LATAM countries, doubling DiDi's total digital community. Produced original content + trend filmings for the brand and its Key Accounts.",
    measurable_results: [
      { metric: "10 LATAM countries", label: "regional expansion" },
      { metric: "Doubled", label: "total digital community" },
      { metric: "5 years", label: "continuous social management" },
    ],
    featured_services_id: [S.content_system],
    sort_order: 2,
  },
  {
    id: "55555555-5555-5555-5555-555555555553",
    client_name: "Aeromexico",
    industry: "Airlines",
    hero_metric_en: "35K downloads, 1M impressions",
    result_description_en:
      "360° VR destination app promoting Aeromexico's new direct routes. Conceived as a short-term campaign; word-of-mouth alone drove 35,000+ downloads and 1M+ impressions without paid media.",
    measurable_results: [
      { metric: "35,000+", label: "downloads" },
      { metric: "1M+", label: "impressions (organic)" },
      { metric: "$0", label: "paid media" },
    ],
    featured_services_id: [S.fast_website],
    sort_order: 3,
  },
  {
    id: "55555555-5555-5555-5555-555555555554",
    client_name: "Bayer / Aspirina Protect",
    industry: "Pharmaceutical",
    hero_metric_en: "Doctor attention: <1 min → 5+ min",
    result_description_en:
      "Augmented Reality app built for Bayer to hold doctors' attention on a box of Aspirina Protect. A 3D human body model appeared over the box and walked through the drug's benefits. Doctors not only engaged longer, they called colleagues over. Bayer México presented the app at a global convention.",
    measurable_results: [
      { metric: "<1 min → 5+ min", label: "doctor engagement time" },
      { metric: "Global convention", label: "Bayer international presentation" },
    ],
    featured_services_id: [S.smart_chatbot],
    sort_order: 4,
  },
  {
    id: "55555555-5555-5555-5555-555555555555",
    client_name: "Golden Hills",
    industry: "CPG / retail",
    hero_metric_en: "400+ SKUs in a single packaging system",
    result_description_en:
      "Full rebrand + packaging operation for Golden Hills. 400+ products redesigned around a clean, minimalist system with strategic chromatics, plus internal banners, tech sheets, and product mock-ups / renders for web + print.",
    measurable_results: [
      { metric: "400+", label: "SKUs redesigned" },
      { metric: "1", label: "unified packaging system" },
    ],
    featured_services_id: [S.unlimited_design, S.brand_identity],
    sort_order: 5,
  },
  {
    id: "55555555-5555-5555-5555-555555555556",
    client_name: "ANA Seguros",
    industry: "Insurance",
    hero_metric_en: "Applications +1,000%",
    result_description_en:
      "Digitized and automated the agent recruitment process for ANA Seguros via a dedicated app. Recruitment applications rose more than 1,000% and the hiring cycle compressed from ~2 months to under 2 weeks.",
    measurable_results: [
      { metric: "+1,000%", label: "recruitment applications" },
      { metric: "2 months → <2 weeks", label: "hiring cycle" },
    ],
    featured_services_id: [S.smart_chatbot, S.fast_website],
    sort_order: 6,
  },
  {
    id: "55555555-5555-5555-5555-555555555557",
    client_name: "Pet's Club",
    industry: "Retail / pet products",
    hero_metric_en: "290+ packages across 3 product pillars",
    result_description_en:
      "Relaunched Pet's Club's visual identity and packaging. Segmented the line into 3 pillars (Dogs / Cats / Other pets), each with its own personality but a unified master system. Designed a premium subline for dogs and cats. 290+ unique packages and labels shipped across the catalog.",
    measurable_results: [
      { metric: "290+", label: "packages + labels designed" },
      { metric: "3 pillars", label: "product-segment identity system" },
    ],
    featured_services_id: [S.unlimited_design, S.brand_identity],
    sort_order: 7,
  },
  {
    id: "55555555-5555-5555-5555-555555555558",
    client_name: "SnapPad",
    industry: "DTC / RV accessories",
    hero_metric_en: "Canadian retail packaging system",
    result_description_en:
      "Designed the Canadian retail packaging for SnapPad's RV-accessories line, engineered to stand out at point-of-sale with clearer information hierarchy and stronger shelf presence. A Rünna proof point of Canadian retail work, delivered from the same MX creative team.",
    measurable_results: [
      { metric: "Canadian retail", label: "shelf-ready packaging" },
      { metric: "RV-accessories line", label: "category scope" },
    ],
    featured_services_id: [S.unlimited_design],
    sort_order: 8,
  },
  {
    id: "55555555-5555-5555-5555-555555555559",
    client_name: "Niki",
    industry: "Education / study-abroad platform",
    hero_metric_en: "2,000 followers + 40K video views in 1 month",
    result_description_en:
      "Launched Niki's brand and social presence from zero on a startup budget. Niki is a platform placing international students in Canadian institutions. In the first month the launch generated 2,000+ followers, 40,000+ video views, and 1,000+ unique visitors driven to the platform.",
    measurable_results: [
      { metric: "2,000+", label: "followers in month 1" },
      { metric: "40,000+", label: "video views in month 1" },
      { metric: "1,000+", label: "unique platform visitors" },
    ],
    featured_services_id: [S.brand_identity, S.content_system],
    sort_order: 9,
  },
  {
    id: "55555555-5555-5555-5555-55555555555a",
    client_name: "DevFest Calgary 2024",
    industry: "Events / tech conference",
    hero_metric_en: "Canadian tech event ad campaign",
    result_description_en:
      "Meta + Instagram ad campaign for DevFest Calgary 2024, the local Google Developers conference. Promoted headline speakers, schedule, and event details; built anticipation and drove attendance within the Canadian developer community. Runna CA's first public Canadian event-marketing work.",
    measurable_results: [
      { metric: "DevFest Calgary 2024", label: "local developer conference" },
      { metric: "Meta + Instagram", label: "ad campaign platforms" },
    ],
    featured_services_id: [S.content_system],
    sort_order: 10,
  },
  // New cases below
  {
    id: "5555555b-5555-5555-5555-55555555555b",
    client_name: "DiDi Food",
    industry: "Food delivery / mobility",
    hero_metric_en: "100K TikTok followers in 7 months, +1,400% positive sentiment",
    result_description_en:
      "Managed DiDi Food's social across FB / IG / TikTok / X in México + 6 LATAM countries for 4 years. An entertainment-led strategy doubled DiDi Food's total community and lifted positive sentiment by 1,400%. Opened DiDi Food's TikTok from scratch and reached 100,000+ followers in México in under 7 months.",
    measurable_results: [
      { metric: "100,000+", label: "TikTok followers in 7 months" },
      { metric: "+1,400%", label: "positive sentiment" },
      { metric: "6 LATAM countries", label: "regional reach" },
      { metric: "Doubled", label: "community size" },
    ],
    featured_services_id: [S.content_system],
    sort_order: 11,
  },
  {
    id: "5555555c-5555-5555-5555-55555555555c",
    client_name: "DiDi (TikTok paid)",
    industry: "Performance marketing",
    hero_metric_en: "120M+ impressions, 25K app downloads, $0.02 CPM",
    result_description_en:
      '"We don\'t make ads, we make TikToks." Built DiDi\'s TikTok paid-media strategy end-to-end: creative, production, and campaign management. Generated 120M+ impressions and 25,000+ app downloads at a $0.02 USD CPM using low-budget productions that read as native platform content.',
    measurable_results: [
      { metric: "120M+", label: "impressions" },
      { metric: "25,000+", label: "app downloads" },
      { metric: "$0.02 USD", label: "CPM" },
    ],
    featured_services_id: [S.content_system],
    sort_order: 12,
  },
  {
    id: "5555555d-5555-5555-5555-55555555555d",
    client_name: "Blues Real",
    industry: "Real estate / DTC",
    hero_metric_en: "$1,000/mo budget → 950 clicks, 40K reach",
    result_description_en:
      "Brand awareness + lead-gen campaign on Meta + Instagram for Blues Real, a Riviera Maya real-estate agency. Static + animated creative highlighting exclusive investment opportunities, driving qualified leads to the Blues Real website. On a $1,000 USD monthly budget we averaged 950 clicks and 40,000 accounts reached.",
    measurable_results: [
      { metric: "$1,000/mo", label: "ad budget" },
      { metric: "950 clicks/mo", label: "site traffic" },
      { metric: "40,000 accounts/mo", label: "reach" },
    ],
    featured_services_id: [S.content_system],
    sort_order: 13,
  },
  {
    id: "5555555e-5555-5555-5555-55555555555e",
    client_name: "El Club",
    industry: "Fitness / wellness",
    hero_metric_en: "2nd-location launch: 900 leads, 30 quality, 12+ enrollments",
    result_description_en:
      "Fitness studio in a saturated market. Built an organic posting grid and complemented it with Meta Ads. Month-over-month community growth to +3k followers. The launch campaign for the second location delivered 900+ leads, 30 quality leads, and 12+ first-day enrollments (vs 1 at the first location's opening).",
    measurable_results: [
      { metric: "900+", label: "leads on 2nd-location launch" },
      { metric: "30", label: "quality leads" },
      { metric: "12+ enrollments", label: "2nd-location opening day" },
      { metric: "+3k", label: "community growth" },
    ],
    featured_services_id: [S.content_system],
    sort_order: 14,
  },
  {
    id: "5555555f-5555-5555-5555-55555555555f",
    client_name: "Lila",
    industry: "CPG / sustainability",
    hero_metric_en: "1,300 leads in 3 weeks (Meta + LinkedIn Ads)",
    result_description_en:
      "Launched a new composting product priced above the market average. Rigorous industry research surfaced the real pain points and informed the creative for a Meta + LinkedIn Ads campaign. 1,300+ leads generated in the first 3 weeks, with sales ramping as the campaign matured.",
    measurable_results: [
      { metric: "1,300+", label: "leads in 3 weeks" },
      { metric: "Above-market pricing", label: "premium positioning" },
    ],
    featured_services_id: [S.content_system],
    sort_order: 15,
  },
  {
    id: "55555560-5555-5555-5555-555555555560",
    client_name: "Walt Disney Studios",
    industry: "Entertainment",
    hero_metric_en: "Last-minute high-impact project, MX leadership",
    result_description_en:
      'When other agencies declined, Rünna accepted a last-minute project for Walt Disney Studios Motion Pictures México\'s leadership with a clear scope and fast turnaround. Delivered a professional, interactive piece that — in the client\'s words — "made us shine." Disney is a repeat testimonial client.',
    measurable_results: [
      { metric: "Walt Disney Studios Motion Pictures México", label: "enterprise client" },
      { metric: "Same-week delivery", label: "rapid turnaround" },
    ],
    featured_services_id: [S.fast_website],
    sort_order: 16,
  },
  {
    id: "55555561-5555-5555-5555-555555555561",
    client_name: "Ford Edge 360",
    industry: "Automotive / immersive",
    hero_metric_en: "First VR test drive ever for a Ford vehicle",
    result_description_en:
      "Ford Edge was delayed arriving to México and the sales force needed a way to demo the car before launch. Built the first VR test drive ever for a Ford vehicle: a 3D exterior model and a 360° interior tour, delivered in an app with Google Cardboard kits distributed in magazines. Customers took the test drive from home and Ford's pre-launch interest climbed.",
    measurable_results: [
      { metric: "First", label: "VR test drive in Ford history" },
      { metric: "Google Cardboard", label: "distributed in-magazine" },
      { metric: "Pre-launch demo", label: "unblocked sales force" },
    ],
    featured_services_id: [S.smart_chatbot, S.fast_website],
    sort_order: 17,
  },
  {
    id: "55555562-5555-5555-5555-555555555562",
    client_name: "Ford Pass Lincoln",
    industry: "Automotive / sales enablement",
    hero_metric_en: "Sales-floor app simulation with guided tour",
    result_description_en:
      "Lincoln sales reps couldn't use the Ford Pass companion app without a physical vehicle to pair. Built a full app simulation with a guided tour so reps, distributors, and floor staff could demo every feature without the car. Standard demo-gap problem, solved without changing the underlying app.",
    measurable_results: [
      { metric: "App simulation", label: "demo-gap solved" },
      { metric: "Guided tour", label: "no-training onboarding" },
    ],
    featured_services_id: [S.smart_chatbot, S.fast_website],
    sort_order: 18,
  },
  {
    id: "55555563-5555-5555-5555-555555555563",
    client_name: "Santander Universidades",
    industry: "Banking / education",
    hero_metric_en: "Full student platform with geolocated coupons",
    result_description_en:
      "Integrated platform for Santander to reach university students: financial tips, a founder blog, interactive games, advisor contact, and a geolocated coupon book with partner brands. Generated a valuable student database for Santander and strengthened brand affinity with the next generation of clients.",
    measurable_results: [
      { metric: "5 modules", label: "tips + blog + games + advisor + coupons" },
      { metric: "Geolocated", label: "partner-brand discount book" },
    ],
    featured_services_id: [S.smart_chatbot, S.fast_website],
    sort_order: 19,
  },
  {
    id: "55555564-5555-5555-5555-555555555564",
    client_name: "Estadio Azteca",
    industry: "Sports / live events",
    hero_metric_en: "Real-time event social + brand identity reinforcement",
    result_description_en:
      "Ran a new social-media strategy for Estadio Azteca: real-time event coverage (photo, video, static), reinforcing brand identity and promoting new products + services. Social became a live extension of the stadium experience rather than a promotional afterthought.",
    measurable_results: [
      { metric: "Real-time", label: "event coverage" },
      { metric: "Estadio Azteca", label: "iconic MX venue" },
    ],
    featured_services_id: [S.content_system],
    sort_order: 20,
  },
];

// Pain-tag mappings — one entry per (case_id, pain_id)
const PAIN_TAGS = [
  ["55555555-5555-5555-5555-555555555551", P.slow_production_cycles, 1.0],
  ["55555555-5555-5555-5555-555555555551", P.manual_sales_process, 0.7],
  ["55555555-5555-5555-5555-555555555552", P.poor_social_engagement, 1.0],
  ["55555555-5555-5555-5555-555555555552", P.no_content_velocity, 1.0],
  ["55555555-5555-5555-5555-555555555552", P.competitor_pressure, 0.6],
  ["55555555-5555-5555-5555-555555555553", P.event_activation_needs, 1.0],
  ["55555555-5555-5555-5555-555555555553", P.product_launch_support, 0.8],
  ["55555555-5555-5555-5555-555555555554", P.product_launch_support, 1.0],
  ["55555555-5555-5555-5555-555555555554", P.event_activation_needs, 0.8],
  ["55555555-5555-5555-5555-555555555555", P.weak_packaging, 1.0],
  ["55555555-5555-5555-5555-555555555555", P.brand_inconsistency, 1.0],
  ["55555555-5555-5555-5555-555555555556", P.manual_sales_process, 1.0],
  ["55555555-5555-5555-5555-555555555556", P.slow_production_cycles, 0.9],
  ["55555555-5555-5555-5555-555555555557", P.weak_packaging, 1.0],
  ["55555555-5555-5555-5555-555555555557", P.brand_inconsistency, 0.9],
  ["55555555-5555-5555-5555-555555555558", P.weak_packaging, 1.0],
  ["55555555-5555-5555-5555-555555555558", P.competitor_pressure, 0.5],
  ["55555555-5555-5555-5555-555555555559", P.product_launch_support, 1.0],
  ["55555555-5555-5555-5555-555555555559", P.no_proof, 0.8],
  ["55555555-5555-5555-5555-555555555559", P.localization_needs, 0.7],
  ["55555555-5555-5555-5555-55555555555a", P.event_activation_needs, 1.0],
  ["55555555-5555-5555-5555-55555555555a", P.no_proof, 0.6],
  ["5555555b-5555-5555-5555-55555555555b", P.poor_social_engagement, 1.0],
  ["5555555b-5555-5555-5555-55555555555b", P.no_content_velocity, 1.0],
  ["5555555b-5555-5555-5555-55555555555b", P.competitor_pressure, 0.7],
  ["5555555c-5555-5555-5555-55555555555c", P.poor_social_engagement, 0.9],
  ["5555555c-5555-5555-5555-55555555555c", P.product_launch_support, 0.7],
  ["5555555d-5555-5555-5555-55555555555d", P.manual_sales_process, 1.0],
  ["5555555d-5555-5555-5555-55555555555d", P.unclear_value_prop, 0.8],
  ["5555555e-5555-5555-5555-55555555555e", P.competitor_pressure, 1.0],
  ["5555555e-5555-5555-5555-55555555555e", P.product_launch_support, 0.9],
  ["5555555e-5555-5555-5555-55555555555e", P.no_proof, 0.6],
  ["5555555f-5555-5555-5555-55555555555f", P.product_launch_support, 1.0],
  ["5555555f-5555-5555-5555-55555555555f", P.unclear_value_prop, 0.9],
  ["5555555f-5555-5555-5555-55555555555f", P.competitor_pressure, 0.7],
  ["55555560-5555-5555-5555-555555555560", P.event_activation_needs, 0.9],
  ["55555560-5555-5555-5555-555555555560", P.no_proof, 0.8],
  ["55555561-5555-5555-5555-555555555561", P.product_launch_support, 1.0],
  ["55555561-5555-5555-5555-555555555561", P.event_activation_needs, 0.8],
  ["55555562-5555-5555-5555-555555555562", P.manual_sales_process, 1.0],
  ["55555562-5555-5555-5555-555555555562", P.slow_production_cycles, 0.6],
  ["55555563-5555-5555-5555-555555555563", P.no_content_velocity, 0.9],
  ["55555563-5555-5555-5555-555555555563", P.unclear_value_prop, 0.8],
  ["55555563-5555-5555-5555-555555555563", P.outdated_website, 0.7],
  ["55555564-5555-5555-5555-555555555564", P.no_content_velocity, 1.0],
  ["55555564-5555-5555-5555-555555555564", P.event_activation_needs, 0.9],
];

// Testimonials keyed by case-study id
const TESTIMONIALS = [
  {
    id: "55555555-5555-5555-5555-555555555551",
    testimonial_quote_es:
      "Cuando necesitamos un proveedor con ideas innovadoras, siempre encontramos en Rünna el mejor equipo creativo. Durante todos los años que hemos trabajado con ellos, su profesionalismo, sinceridad y espíritu transformador los ha destacado como uno de nuestros mejores proveedores.",
    testimonial_quote_en:
      "When we need a partner with innovative ideas, we always find the best creative team at Rünna. Across all the years we've worked together, their professionalism, sincerity, and transformative spirit have stood out as one of our best providers.",
    testimonial_author: "Melissa López",
    testimonial_title: "CX & Distributor Training, Ford Motor Company México",
  },
  {
    id: "55555555-5555-5555-5555-555555555552",
    testimonial_quote_es:
      "En 2020 necesitábamos un partner que nos ayudara a construir una mejor presencia en medios digitales. El apoyo de Rünna nos dio la oportunidad de seguir construyendo nuestra marca en un nuevo nivel. Rünna siempre está abierta a encontrar soluciones a nuestros desafíos, a tiempo y manteniendo el paso de nuestra industria; tienen un equipo increíble que enriquece nuestra estrategia hasta el día de hoy.",
    testimonial_quote_en:
      "In 2020 we needed a partner to help us build a better presence in digital media. Rünna's support gave us the chance to keep building our brand at a new level. They're always open to finding solutions to our challenges, on time, matching the pace of our industry — an incredible team that enriches our strategy to this day.",
    testimonial_author: "Evelena Zamorano",
    testimonial_title: "Sr. Brand Manager LATAM, DiDi Global Inc.",
  },
  {
    id: "55555560-5555-5555-5555-555555555560",
    testimonial_quote_es:
      "Tuvimos un proyecto de último minuto pero de alto impacto para el liderazgo de The Walt Disney Company México. Otras agencias se negaron a hacerlo y Rünna respondió de manera inmediata, dejaron muy claro qué podían hacer para nosotros y entregaron un proyecto súper profesional, interactivo y que nos hizo brillar.",
    testimonial_quote_en:
      "We had a last-minute but high-impact project for The Walt Disney Company México's leadership. Other agencies refused; Rünna responded immediately, made it very clear what they could do for us, and delivered a super-professional, interactive project that made us shine.",
    testimonial_author: "Ana C Díaz Montes",
    testimonial_title: "PR & Advertising, Walt Disney Studios Motion Pictures",
  },
];

async function upsertCases() {
  const rows = CASES.map((c) => ({
    id: c.id,
    tenant_id: TENANT,
    brand_instance_id: BRAND,
    client_name: c.client_name,
    industry: c.industry,
    hero_metric_en: c.hero_metric_en,
    result_description_en: c.result_description_en,
    measurable_results: c.measurable_results,
    featured_services_id: c.featured_services_id,
    sort_order: c.sort_order,
    is_active: true,
  }));
  const { error } = await admin.from("case_studies").upsert(rows, { onConflict: "id" });
  if (error) throw new Error(`upsertCases: ${error.message}`);
  console.log(`✓ upsert case_studies: ${rows.length} rows`);
}

async function applyTestimonials() {
  for (const t of TESTIMONIALS) {
    const { error } = await admin
      .from("case_studies")
      .update({
        testimonial_quote_es: t.testimonial_quote_es,
        testimonial_quote_en: t.testimonial_quote_en,
        testimonial_author: t.testimonial_author,
        testimonial_title: t.testimonial_title,
      })
      .eq("id", t.id);
    if (error) throw new Error(`testimonial ${t.id}: ${error.message}`);
  }
  console.log(`✓ testimonials applied: ${TESTIMONIALS.length} rows`);
}

async function rebuildPainTags() {
  // DELETE all existing pain tags for this tenant's case studies, then insert fresh
  const { data: ids, error: selErr } = await admin
    .from("case_studies")
    .select("id")
    .eq("tenant_id", TENANT);
  if (selErr) throw new Error(`fetch ids: ${selErr.message}`);
  const caseIds = ids.map((r) => r.id);

  const { error: delErr } = await admin
    .from("case_study_pain_tags")
    .delete()
    .in("case_study_id", caseIds);
  if (delErr) throw new Error(`delete pain tags: ${delErr.message}`);

  const rows = PAIN_TAGS.map(([case_study_id, pain_id, strength]) => ({
    case_study_id,
    pain_id,
    strength,
  }));
  const { error: insErr } = await admin.from("case_study_pain_tags").insert(rows);
  if (insErr) throw new Error(`insert pain tags: ${insErr.message}`);
  console.log(`✓ pain tags rebuilt: ${rows.length} rows`);
}

async function run() {
  await upsertCases();
  await applyTestimonials();
  await rebuildPainTags();

  // Verify
  const { count: total } = await admin
    .from("case_studies")
    .select("id", { count: "exact", head: true })
    .eq("is_active", true);
  const { count: tagCount } = await admin
    .from("case_study_pain_tags")
    .select("case_study_id", { count: "exact", head: true });
  const { data: tests } = await admin
    .from("case_studies")
    .select("client_name, testimonial_author")
    .not("testimonial_author", "is", null)
    .order("client_name");

  console.log("");
  console.log(`active case studies: ${total}`);
  console.log(`pain-tag rows:       ${tagCount}`);
  console.log(`testimonials:        ${tests?.length ?? 0}`);
  tests?.forEach((t) => console.log(`  • ${t.client_name} — ${t.testimonial_author}`));
}

run().catch((e) => {
  console.error("FAIL:", e.message);
  process.exit(1);
});
