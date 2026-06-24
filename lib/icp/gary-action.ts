"use server";

/**
 * "Gary" — guided ICP-building wizard (server action).
 *
 * Gary is a senior ICP strategist + market-research analyst. He's grounded in
 * Runna's REAL data (services, case studies, where we've won) and the tenant's
 * existing ICP coverage, so his questions are sharp and his proposals match
 * where Runna can actually win. He asks at most ~3 rounds of the highest-leverage
 * questions, then proposes a complete ICP.
 *
 * GUARDRAIL: the proposal is a SUGGESTION the human reviews + edits + Saves in
 * the ICP drawer. Gary never writes to the DB. Grounded-only: he is given the
 * real Runna context and told never to invent services/markets/case studies.
 *
 * Stateless-friendly: the client sends the full Q&A transcript each turn; Gary
 * decides whether to ask more or to propose.
 */

import { z } from "zod";
import { ANTHROPIC_DEFAULT_MODEL, claudeIsAvailable, structuredCall } from "@/lib/anthropic/client";
import { requireUser } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { RUNNA_CAPABILITIES } from "@/lib/runna/capabilities";
import {
  BUSINESS_TYPES,
  EXCLUDED_KEYWORDS,
  GEO_REGIONS,
  GOOGLE_PLACES_TYPES,
  INDUSTRY_TAGS,
  SEARCH_KEYWORDS,
} from "./option-sources";
import type { GaryAnswer, GaryProposedIcp, GaryResponse } from "./gary-types";

const MAX_ROUNDS = 3;

// Clip-not-reject for free-text LLM output — a hard .max() FAILS the whole parse
// when Claude runs a few chars long (tasks/lessons.md 2026-05-29 "use .transform()
// to clip rather than hard .max()"). DB-bound array values stay short anyway.
const clipped = (max: number) =>
  z.string().trim().min(1).max(max * 6).transform((s) => s.slice(0, max));
const clippedOpt = (max: number) =>
  z.string().trim().max(max * 6).transform((s) => s.slice(0, max)).optional();
// Clip array LENGTH too — a hard .max(n) rejects the whole parse when Claude
// returns one extra item (same lesson as string clipping). Slice instead.
const clippedArr = (lenMax: number, itemMax = 60) =>
  z.array(clipped(itemMax)).transform((a) => a.slice(0, lenMax));

// ── Response schema (discriminated union: ask more, or propose) ────────────────

const questionSchema = z.object({
  phase: z.literal("question"),
  message: clipped(700),
  questions: z
    .array(
      z.object({
        id: clipped(40),
        question: clipped(300),
        hint: clippedOpt(200),
        suggestions: z.array(clipped(120)).transform((a) => a.slice(0, 8)).optional(),
      }),
    )
    .min(1)
    .max(3),
});

const nullableStr = (n: number | null | undefined): string | null =>
  n === null || n === undefined ? null : String(n);

const proposalSchema = z.object({
  phase: z.literal("proposal"),
  message: clipped(700),
  rationale: clipped(1200),
  icp: z.object({
    name: clipped(120),
    market: z.enum(["CA", "MX", "US", "LATAM"]),
    language: z.enum(["en", "es"]),
    industry_tags: clippedArr(16),
    business_types: clippedArr(16),
    geo_regions: clippedArr(20),
    google_places_types: clippedArr(20),
    search_keywords: clippedArr(16),
    excluded_keywords: clippedArr(16),
    employee_size_min: z.number().int().min(0).max(1_000_000).nullable(),
    employee_size_max: z.number().int().min(0).max(1_000_000).nullable(),
    revenue_min_usd: z.number().min(0).max(1_000_000_000_000).nullable(),
    revenue_max_usd: z.number().min(0).max(1_000_000_000_000).nullable(),
  }),
});

const garySchema = z.discriminatedUnion("phase", [questionSchema, proposalSchema]);

// ── Entry point ────────────────────────────────────────────────────────────────

export async function garyBuildIcpAction(answered: GaryAnswer[]): Promise<GaryResponse> {
  if (!claudeIsAvailable()) {
    return {
      phase: "error",
      message:
        "Gary needs the Anthropic API key to run. Use the manual form or the 'Suggest from name' heuristic instead.",
    };
  }

  // Defensive: cap + sanitize the transcript the client sends back.
  const safeAnswered: GaryAnswer[] = (Array.isArray(answered) ? answered : [])
    .slice(0, 12)
    .map((a) => ({
      question: String(a?.question ?? "").slice(0, 300),
      answer: String(a?.answer ?? "").slice(0, 600),
    }))
    .filter((a) => a.question && a.answer);

  const roundsAnswered = safeAnswered.length;

  let user;
  try {
    const ctx = await gatherRunnaContext();
    user = buildUserPrompt(safeAnswered, ctx, roundsAnswered);
  } catch (err) {
    console.error("[gary] context load failed:", err);
    return { phase: "error", message: "Gary couldn't load Runna's context — please try again." };
  }

  const result = await structuredCall({
    model: ANTHROPIC_DEFAULT_MODEL,
    system: SYSTEM_PROMPT,
    user,
    max_tokens: 1400,
    schema: garySchema,
    // Gary makes ONE Sonnet call with a large grounding prompt — give it room
    // beyond the 20s default, but stay under the Vercel function maxDuration.
    timeoutMs: 50_000,
  });

  if (!result.ok) {
    console.error(`[gary] Claude call failed (${result.reason}): ${result.error}`);
    return { phase: "error", message: "Gary hit a snag generating a response. Try again." };
  }

  const data = result.data;
  if (data.phase === "question") {
    return { phase: "question", message: data.message, questions: data.questions };
  }

  const industryTags = dedupe(data.icp.industry_tags);
  const businessTypes = dedupe(data.icp.business_types);

  // Deterministic safety net: even with the prompt rule, the model drifts and
  // fills targeting fields with what Runna SELLS. Strip offering terms, backfill
  // buyer keywords from the verticals, and force provider exclusions.
  const targeting = enforceBuyerTargeting({
    language: data.icp.language,
    industry_tags: industryTags,
    business_types: businessTypes,
    search_keywords: dedupe(data.icp.search_keywords),
    google_places_types: dedupe(data.icp.google_places_types),
    excluded_keywords: dedupe(data.icp.excluded_keywords),
  });

  const icp: GaryProposedIcp = {
    name: data.icp.name,
    market: data.icp.market,
    language: data.icp.language,
    industry_tags: industryTags,
    business_types: businessTypes,
    geo_regions: dedupe(data.icp.geo_regions),
    google_places_types: targeting.google_places_types,
    search_keywords: targeting.search_keywords,
    excluded_keywords: targeting.excluded_keywords,
    employee_size_min: nullableStr(data.icp.employee_size_min),
    employee_size_max: nullableStr(data.icp.employee_size_max),
    revenue_min_usd: nullableStr(data.icp.revenue_min_usd),
    revenue_max_usd: nullableStr(data.icp.revenue_max_usd),
  };

  return { phase: "proposal", message: data.message, icp, rationale: data.rationale };
}

// ── System prompt — Gary the expert ────────────────────────────────────────────

const SYSTEM_PROMPT = `You are Gary, a senior Ideal Customer Profile (ICP) strategist and market-research analyst working for Runna, a creative + digital agency with a broad modern toolkit (see RUNNA'S CAPABILITIES in the context).

YOUR EXPERTISE (apply all of it):
- B2B audience segmentation and firmographic targeting (industry, business type, size, geography, revenue).
- Market research and demand analysis: which segments have budget, urgency, and a surface Runna can improve.
- Reachability: you design ICPs tight enough that Discovery can actually FIND real, contactable companies — not vague TAMs.
- Win-pattern matching: bias toward segments where Runna can credibly help — using its BROAD CAPABILITIES (AI, automation, optimization, dashboards, asset + video production, growth) and YEARS OF EXPERTISE as proof. You are NOT limited to industries we happen to have a case study for — case studies are bonus proof points to use WHEN they fit, never a precondition. Bias away from competitors (other agencies) and already-served businesses.
- You know that consumer-facing service businesses (gyms, clinics, salons, restaurants, hospitality, local services) ARE valid Runna customers — they have real needs. The only correct exclusions are competitors (marketing/creative/dev agencies, consultancies) and businesses that already have an agency.

HOW YOU WORK (guided wizard — be efficient and sharp):
1. Lead with what you can already INFER from Runna's data (provided below). Don't ask what you can deduce.
2. Ask ONLY the 2-3 highest-leverage questions you genuinely need to nail the profile — typically: target market/geography, who to explicitly EXCLUDE, the size/budget band, and (if unclear) the vertical focus. Never ask more than 3 questions in a round, and never more than ${MAX_ROUNDS} rounds total.
3. For each question, offer 'suggestions' — concrete clickable example answers grounded in Runna's data — so the user can answer in one click.
4. As soon as you have enough to build a sharp profile (or once ${MAX_ROUNDS} rounds of answers exist), output a COMPLETE proposal.

OUTPUT — respond with JSON in ONE of these two shapes:
A) Ask more:
{ "phase": "question", "message": "<short framing of what you know + why you're asking>", "questions": [{ "id": "<slug>", "question": "...", "hint": "<optional>", "suggestions": ["...","..."] }] }
B) Propose the ICP:
{ "phase": "proposal", "message": "<1-2 sentence summary>", "rationale": "<why this profile — tie to Runna's strengths + the user's answers, 3-5 sentences>", "icp": { "name", "market", "language", "industry_tags"[], "business_types"[], "geo_regions"[], "google_places_types"[], "search_keywords"[], "excluded_keywords"[], "employee_size_min"|null, "employee_size_max"|null, "revenue_min_usd"|null, "revenue_max_usd"|null } }

RULES:
- ⚠️ TARGET THE BUYER, NOT THE OFFERING (most important rule). Runna SELLS software, automation, dashboards, BI, AI, video/creative. Those are what we PROVIDE — they must NEVER appear in industry_tags / business_types / google_places_types / search_keywords, because Discovery uses those fields to FIND companies, and searching them returns SERVICE PROVIDERS (our competitors), not customers. Every target field must describe the CUSTOMER's OWN business — the words you'd type into Google Maps or a directory to find the buyer (e.g. "law firm", "accounting firm", "medical clinic", "manufacturer", "real estate agency"). The services Runna offers belong in the rationale/positioning, never in the targeting fields.
  WORKED EXAMPLE of the trap: ICP "sell software & automation to mid-market firms". WRONG → search_keywords:["software development","business intelligence","custom dashboard"], industry_tags:["saas_b2b"] (this finds software vendors = competitors). RIGHT → search_keywords:["despacho de abogados","despacho contable","clínica","empresa manufacturera","consultoría"], industry_tags:["law_firm","accounting_firm","healthcare","manufacturer","professional_services"], and put "software development / dashboards / automation" only in the rationale as the VALUE we bring them.
- search_keywords: the BUYER's business category as a real searchable phrase (in the market's language — ES for MX/LATAM). These literally become the Discovery query, so they decide WHO gets found.
- excluded_keywords: hard-filter out anyone who PROVIDES what Runna provides — always include software/SaaS/IT/dev/data-analytics/BI companies plus marketing/creative/digital/ad agencies and consultancies, since these are peers/competitors, not buyers.
- Prefer canonical values from the lists provided; invent new ones ONLY when nothing fits.
- market is one of CA, MX, US, LATAM. language is en or es and should match the market (CA/US→en, MX→es, LATAM→es unless told otherwise).
- google_places_types: FILL these whenever the ICP targets businesses with a physical/local presence findable on Google Maps — this INCLUDES professional services (lawyer, accounting, real_estate_agency, insurance_agency), health/wellness (gym, spa, dentist, doctor, physiotherapist), trades (plumber, electrician, general_contractor, roofing_contractor), food (restaurant, cafe, bakery, bar), and retail stores. Map the business_types/industries you chose to the closest canonical GOOGLE_PLACES_TYPES values. Leave [] ONLY for pure-online/DTC brands with no storefront. Don't skip this for "B2B services" — most are local businesses on Maps.
- Numeric fields: use null when you have no real basis for a number — never fabricate a precise range to look thorough.
- GROUNDING & HONESTY: reason freely about Runna's CAPABILITIES and use its years of expertise as general proof — a specific case study is NOT required to justify targeting a segment. Use the provided case studies as proof points only WHEN they genuinely fit. The ONE hard rule: never fabricate a SPECIFIC client name, metric, or geography that isn't in the provided data.
- The proposal is a SUGGESTION the human will review, edit, and save. Do not claim it is final or saved.`;

// ── User prompt ────────────────────────────────────────────────────────────────

type RunnaContext = {
  services: { name: string; desc: string | null }[];
  caseStudies: { client: string; industry: string | null; tier: string | null; metric: string | null }[];
  existingIcps: { name: string; market: string; industries: string[]; geos: string[] }[];
};

function buildUserPrompt(answered: GaryAnswer[], ctx: RunnaContext, rounds: number): string {
  const servicesText =
    ctx.services.length > 0
      ? ctx.services.map((s) => `- ${s.name}${s.desc ? `: ${s.desc}` : ""}`).join("\n")
      : "(no services configured)";

  const casesText =
    ctx.caseStudies.length > 0
      ? ctx.caseStudies
          .map(
            (c) =>
              `- ${c.client} (${c.industry ?? "industry n/a"}, ${c.tier ?? "tier n/a"})${c.metric ? ` — ${c.metric}` : ""}`,
          )
          .join("\n")
      : "(no case studies)";

  const icpsText =
    ctx.existingIcps.length > 0
      ? ctx.existingIcps
          .map(
            (i) =>
              `- "${i.name}" [${i.market}] industries: ${i.industries.join(", ") || "—"}; geos: ${i.geos.join(", ") || "—"}`,
          )
          .join("\n")
      : "(none yet)";

  const transcript =
    answered.length > 0
      ? answered.map((a, i) => `Q${i + 1}: ${a.question}\nA${i + 1}: ${a.answer}`).join("\n\n")
      : "(no questions answered yet — this is the first turn)";

  const forceProposal =
    rounds >= MAX_ROUNDS
      ? `\n\nYou have ${rounds} rounds of answers — that is enough. You MUST output a "proposal" now, not more questions.`
      : "";

  return `RUNNA CONTEXT:

${RUNNA_CAPABILITIES}

SERVICES configured in the system (a subset of the capabilities above):
${servicesText}

CASE STUDIES (proof of where Runna wins):
${casesText}

EXISTING ICPs (avoid duplicating; complement coverage or sharpen a gap):
${icpsText}

CANONICAL VALUE LISTS (prefer these):
- INDUSTRY_TAGS: ${INDUSTRY_TAGS.join(", ")}
- BUSINESS_TYPES: ${BUSINESS_TYPES.join(", ")}
- GEO_REGIONS: ${GEO_REGIONS.join(", ")}
- GOOGLE_PLACES_TYPES: ${GOOGLE_PLACES_TYPES.join(", ")}
- SEARCH_KEYWORDS: ${SEARCH_KEYWORDS.join(", ")}
- EXCLUDED_KEYWORDS: ${EXCLUDED_KEYWORDS.join(", ")}

CONVERSATION SO FAR:
${transcript}${forceProposal}

Respond with your next step as JSON (either "question" or "proposal").`;
}

// ── Runna context fetch (tenant-scoped) ────────────────────────────────────────

async function gatherRunnaContext(): Promise<RunnaContext> {
  const user = await requireUser();
  const supabase = await createClient();

  const [{ data: services }, { data: cases }, { data: icps }] = await Promise.all([
    supabase
      .from("services")
      .select("display_name_en, description_en")
      .eq("tenant_id", user.tenantId)
      .eq("is_active", true)
      .order("sort_order", { ascending: true })
      .returns<{ display_name_en: string; description_en: string | null }[]>(),
    supabase
      .from("case_studies")
      .select("client_name, industry, tier, hero_metric_en")
      .eq("tenant_id", user.tenantId)
      .eq("is_active", true)
      .returns<{ client_name: string; industry: string | null; tier: string | null; hero_metric_en: string | null }[]>(),
    supabase
      .from("icps")
      .select("name, market, industry_tags, geo_regions")
      .eq("tenant_id", user.tenantId)
      .eq("is_active", true)
      .returns<{ name: string; market: string; industry_tags: string[] | null; geo_regions: string[] | null }[]>(),
  ]);

  return {
    services: (services ?? []).map((s) => ({
      name: s.display_name_en,
      desc: s.description_en ? s.description_en.slice(0, 160) : null,
    })),
    caseStudies: (cases ?? []).map((c) => ({
      client: c.client_name,
      industry: c.industry,
      tier: c.tier,
      metric: c.hero_metric_en,
    })),
    existingIcps: (icps ?? []).map((i) => ({
      name: i.name,
      market: i.market,
      industries: i.industry_tags ?? [],
      geos: i.geo_regions ?? [],
    })),
  };
}

function dedupe(values: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const v of values) {
    const key = v.trim().toLowerCase();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(v.trim());
  }
  return out;
}

// ── Buyer-targeting guard (deterministic) ──────────────────────────────────────
// Gary's prompt says "target the buyer, not the offering", but the model still
// drifts — when an ICP is themed around what Runna SELLS (automation, dashboards),
// it fills search_keywords/google_places_types with those service terms, which
// makes Discovery find COMPETITORS instead of customers. This guard enforces the
// rule no matter what the model returns: strip offering terms from the targeting
// fields, backfill buyer-vertical search terms from the industry tags, and make
// sure the excluded list blocks service providers. See tasks/lessons.md.

// Substrings that name something RUNNA OFFERS (en + es). If a search keyword or
// places type contains one of these, it's an offering term, not a buyer.
const OFFERING_NEEDLES = [
  "automation", "automatización", "automatizado", "automatizada",
  "dashboard", "tablero", "panel de control", "cuadro de mando",
  "internal tool", "herramientas internas", "herramienta interna",
  "custom software", "software personalizado", "software a medida",
  "software development", "desarrollo de software", "software",
  "artificial intelligence", "inteligencia artificial", " ai ", "machine learning", "aprendizaje automático",
  "business intelligence", "inteligencia de negocios", " bi ",
  "process optimization", "optimización de procesos", "optimización", "optimization",
  "automated report", "reportes automatizados", "reporte automatizado",
  "data visualization", "visualización de datos", "analytics", "analítica", "analitica",
  "workflow", "flujo de trabajo", "crm", "erp", "saas", "web app", "integration", "integración",
];

// Provider categories to ALWAYS exclude (peers/competitors who sell what we sell).
const PROVIDER_EXCLUSIONS = [
  "software", "saas", "desarrollo de software", "empresa de software",
  "agencia digital", "consultora de ti", "it services", "business intelligence",
  "data analytics", "marketing agency", "creative agency",
];

// Map an industry tag / business type → a real searchable BUYER phrase. Spanish
// for MX/LATAM, English otherwise. Falls back to the humanized tag.
const BUYER_PHRASES: Record<string, { es: string; en: string }> = {
  law_firm: { es: "despacho de abogados", en: "law firm" },
  legal: { es: "despacho de abogados", en: "law firm" },
  accounting_firm: { es: "despacho contable", en: "accounting firm" },
  accounting: { es: "despacho contable", en: "accounting firm" },
  finance: { es: "despacho financiero", en: "financial services firm" },
  financial_services: { es: "despacho financiero", en: "financial services firm" },
  insurance: { es: "agencia de seguros", en: "insurance agency" },
  healthcare: { es: "clínica privada", en: "medical clinic" },
  medical: { es: "consultorio médico", en: "medical practice" },
  dental: { es: "clínica dental", en: "dental clinic" },
  real_estate: { es: "inmobiliaria", en: "real estate agency" },
  education: { es: "colegio privado", en: "private school" },
  automotive: { es: "agencia automotriz", en: "auto dealership" },
  manufacturer: { es: "empresa de manufactura", en: "manufacturer" },
  manufacturing: { es: "empresa de manufactura", en: "manufacturer" },
  distribution: { es: "empresa de distribución", en: "distributor" },
  wholesale: { es: "empresa mayorista", en: "wholesaler" },
  logistics: { es: "empresa de logística", en: "logistics company" },
  construction: { es: "constructora", en: "construction company" },
  hospitality: { es: "hotel", en: "hotel" },
  retail: { es: "tienda minorista", en: "retail store" },
  professional_services: { es: "despacho profesional", en: "professional services firm" },
  consulting: { es: "consultoría empresarial", en: "consulting firm" },
};

const isOffering = (term: string): boolean => {
  const t = ` ${term.toLowerCase()} `;
  return OFFERING_NEEDLES.some((n) => t.includes(n));
};

function buyerPhraseFor(tag: string, lang: "en" | "es"): string {
  const key = tag.trim().toLowerCase().replace(/\s+/g, "_");
  const hit = BUYER_PHRASES[key];
  if (hit) return lang === "es" ? hit.es : hit.en;
  return tag.trim().replace(/_/g, " ");
}

type Targeting = Pick<
  GaryProposedIcp,
  "language" | "industry_tags" | "business_types" | "search_keywords" | "google_places_types" | "excluded_keywords"
>;

/** Strip offering terms from targeting; backfill buyer keywords; enforce exclusions. */
function enforceBuyerTargeting(t: Targeting): Pick<GaryProposedIcp, "search_keywords" | "google_places_types" | "excluded_keywords"> {
  const lang = t.language === "es" ? "es" : "en";

  // 1. Drop offering terms from search keywords + places types.
  let searchKeywords = t.search_keywords.filter((k) => !isOffering(k));
  const placesTypes = t.google_places_types.filter((p) => !isOffering(p));

  // 2. If the model gutted search keywords by filling them with offering terms,
  //    backfill from the (buyer) industry tags / business types.
  if (searchKeywords.length < 2) {
    const sources = [...t.industry_tags, ...t.business_types].filter((s) => !isOffering(s));
    const backfilled = dedupe(sources.map((s) => buyerPhraseFor(s, lang)));
    searchKeywords = dedupe([...searchKeywords, ...backfilled]).slice(0, 12);
  }

  // 3. Guarantee provider categories are excluded.
  const excluded = dedupe([...t.excluded_keywords, ...PROVIDER_EXCLUSIONS]).slice(0, 16);

  return { search_keywords: searchKeywords, google_places_types: placesTypes, excluded_keywords: excluded };
}
