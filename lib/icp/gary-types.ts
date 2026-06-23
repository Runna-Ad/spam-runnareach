/**
 * Client-safe types for "Gary" — the guided ICP-building wizard.
 *
 * Gary is an expert ICP / market-research analyst that knows Runna (services,
 * case studies, where we win) and the existing ICP coverage. He asks the 2-3
 * highest-leverage questions, then proposes a complete ICP for the human to
 * REVIEW and Save — never auto-applied.
 *
 * No server imports here so the wizard component can import these types
 * without bundle bleed (see tasks/lessons.md RSC-bleed lessons).
 */

export type IcpMarket = "CA" | "MX" | "US" | "LATAM";
export type IcpLanguage = "en" | "es";

/** One question Gary asks. `suggestions` are clickable example answers. */
export type GaryQuestion = {
  id: string;
  question: string;
  hint?: string;
  suggestions?: string[];
};

/** A complete proposed ICP — numeric fields are strings so they drop straight into the form. */
export type GaryProposedIcp = {
  name: string;
  market: IcpMarket;
  language: IcpLanguage;
  industry_tags: string[];
  business_types: string[];
  geo_regions: string[];
  google_places_types: string[];
  search_keywords: string[];
  excluded_keywords: string[];
  employee_size_min: string | null;
  employee_size_max: string | null;
  revenue_min_usd: string | null;
  revenue_max_usd: string | null;
};

/** One answered round in the conversation, sent back to Gary on the next turn. */
export type GaryAnswer = { question: string; answer: string };

export type GaryResponse =
  | { phase: "question"; message: string; questions: GaryQuestion[] }
  | { phase: "proposal"; message: string; icp: GaryProposedIcp; rationale: string }
  | { phase: "error"; message: string };
