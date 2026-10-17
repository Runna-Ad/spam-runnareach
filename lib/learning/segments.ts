/**
 * One segment language for every learner.
 *
 * Discovery, ICPs, the pitch writer, the send scheduler and the Inefficiency
 * Hunter all learn from the same outcomes, so they must describe a business
 * the same way. A segment is market × industry × size, with coarser keys to
 * fall back on while the fine ones have too little data ("ca:legal:small" →
 * "ca:legal" → "legal" → "all").
 *
 * The industry list is finer than the Hunter's (S.P.A.M. mostly pitches
 * manufacturers, distributors, clinics and law firms, which the Hunter lumps
 * into "other") and maps onto it, so a Hunter scan and a S.P.A.M. pitch land in
 * comparable buckets. Sizes are the Hunter's buckets.
 *
 * Pure — tested in tests/learning.test.ts.
 */

export type SegmentIndustry =
  | "manufacturing"
  | "distribution"
  | "logistics"
  | "construction"
  | "trades"
  | "legal"
  | "accounting"
  | "consulting"
  | "healthcare"
  | "dental"
  | "fitness"
  | "beauty"
  | "restaurant"
  | "hospitality"
  | "realestate"
  | "retail"
  | "ecommerce"
  | "automotive"
  | "education"
  | "other";

export type SegmentSize = "solo" | "small" | "mid" | "large" | "unknown";
export type SegmentMarket = "ca" | "mx" | "unknown";

export type Segment = {
  market: SegmentMarket;
  industry: SegmentIndustry;
  size: SegmentSize;
};

/** The Hunter's industry enum (runna-hunter MARKET_DATA keys). */
export type HunterIndustryKey =
  | "ecommerce"
  | "restaurant"
  | "realestate"
  | "proservices"
  | "retail"
  | "automotive"
  | "fitness"
  | "hospitality"
  | "trades"
  | "other";

/**
 * First match wins, so specific industries come before generic ones: a
 * "medical supplies distributor" is a distributor, a "dental clinic" is dental,
 * a "food distributor" is not a restaurant. Patterns run on lower-cased,
 * accent-free text and use word boundaries where a bare substring would
 * misfire ("law" in "lawn", "inn" in "dinner", "bar" in "barber").
 */
const INDUSTRY_PATTERNS: ReadonlyArray<[SegmentIndustry, RegExp]> = [
  ["dental", /dental|dentist|orthodont|odontolog|endodon/],
  ["ecommerce", /e-?commerce|online store|tienda en linea|shopify|dropship/],
  ["distribution", /distribut|wholesal|mayorist|abarrot|supplier|proveedor|\bsupply\b|\bsupplies\b/],
  ["logistics", /logistic|freight|trucking|courier|shipping|transport|fletes|mudanza|paqueteria|almacen/],
  ["manufacturing", /manufactur|fabricat|machining|machine shop|\bmfg\b|plastics|metal|weld|foundry|industrial|maquila|fabrica\b|manufactura/],
  ["construction", /construct|contractor|homebuilder|\bbuilders?\b|renovat|remodel|concrete|excavat|constructora|obra/],
  ["trades", /plumb|lawn|electrician|electrical|hvac|roofing|landscap|carpent|painting|janitorial|cleaning|pest control|plomer|electricist|limpieza|jardiner/],
  ["legal", /\blaw\b|lawyer|law firm|legal|attorney|notar|barrister|solicitor|abogad|despacho|bufete|juridic/],
  ["accounting", /accountan|accounting|bookkeep|\bcpa\b|\btax\b|payroll|contador|contable|contabilidad|fiscal/],
  ["healthcare", /hospital|clinic|medical|health|physio|chiropract|pharmac|laborator|optometr|veterinar|clinica|medic|salud|farmacia/],
  ["fitness", /\bgym\b|fitness|yoga|pilates|crossfit|martial|boxing|gimnasio/],
  ["beauty", /salon|\bspa\b|beauty|barber|nail|esthetic|estetica|belleza|barberia/],
  ["restaurant", /restaurant|\bcafe\b|coffee|\bbar\b|bakery|catering|bistro|pizzeria|brewery|restaurante|panaderia|taqueria|cocina|comida/],
  ["hospitality", /hotel|\binn\b|resort|motel|hostel|lodge|villa|beach club|b&b|hostal|hospedaje/],
  ["realestate", /real estate|realtor|realty|property|properties|inmobiliari|bienes raices|propiedades/],
  ["automotive", /automotive|car dealer|dealership|\bauto\b|collision|body shop|mechanic|tire|automotriz|taller|refaccion/],
  ["education", /school|academy|college|universit|tutor|training|escuela|colegio|academia/],
  ["consulting", /consult|advisory|advisor|asesor|consultor/],
  ["retail", /store|\bshop\b|boutique|retail|jewel|florist|tienda|ferreteria|joyeria|mueble/],
];

const TO_HUNTER: Record<SegmentIndustry, HunterIndustryKey> = {
  manufacturing: "other",
  distribution: "other",
  logistics: "other",
  construction: "trades",
  trades: "trades",
  legal: "proservices",
  accounting: "proservices",
  consulting: "proservices",
  healthcare: "other",
  dental: "other",
  fitness: "fitness",
  beauty: "fitness",
  restaurant: "restaurant",
  hospitality: "hospitality",
  realestate: "realestate",
  retail: "retail",
  ecommerce: "ecommerce",
  automotive: "automotive",
  education: "other",
  other: "other",
};

function fold(s: string): string {
  return s.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "");
}

/** Free-text industry (prospect.industry, an ICP tag, a search keyword) → segment industry. */
export function normalizeIndustry(text: string | null | undefined): SegmentIndustry {
  if (!text) return "other";
  const t = fold(text);
  for (const [industry, re] of INDUSTRY_PATTERNS) if (re.test(t)) return industry;
  return "other";
}

/** The Hunter's industry bucket for a segment industry. */
export function hunterIndustryFor(industry: SegmentIndustry): HunterIndustryKey {
  return TO_HUNTER[industry];
}

/** Headcount → the Hunter's size buckets. */
export function sizeFor(employees: number | null | undefined): SegmentSize {
  if (employees == null || !Number.isFinite(employees) || employees <= 0) return "unknown";
  if (employees <= 1) return "solo";
  if (employees <= 10) return "small";
  if (employees <= 50) return "mid";
  return "large";
}

/** prospects.market is stored upper-case ("CA"); fall back to language. */
export function marketFor(market: string | null | undefined, language?: string | null): SegmentMarket {
  const m = market?.trim().toLowerCase();
  if (m === "ca" || m === "mx") return m;
  if (language === "en") return "ca";
  if (language === "es") return "mx";
  return "unknown";
}

export function segmentOf(p: {
  market?: string | null;
  language?: string | null;
  industry?: string | null;
  employee_size_estimate?: number | null;
}): Segment {
  return {
    market: marketFor(p.market, p.language),
    industry: normalizeIndustry(p.industry),
    size: sizeFor(p.employee_size_estimate),
  };
}

/**
 * Keys from finest to coarsest. A learner reads the finest key with enough
 * data and backs off to coarser ones, so a new segment starts from what its
 * neighbours taught instead of from nothing.
 */
export function segmentKeys(s: Segment): [string, string, string, string] {
  return [`${s.market}:${s.industry}:${s.size}`, `${s.market}:${s.industry}`, s.industry, "all"];
}

export function segmentKey(s: Segment): string {
  return segmentKeys(s)[0];
}

export function parseSegmentKey(key: string): Segment | null {
  const [market, industry, size] = key.split(":");
  if (!market || !industry || !size) return null;
  return {
    market: market as SegmentMarket,
    industry: industry as SegmentIndustry,
    size: size as SegmentSize,
  };
}
