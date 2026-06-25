/**
 * Pitch → Inefficiency Hunter handoff.
 *
 * The cold-email CTA links to the Inefficiency Hunter (a SEPARATE app,
 * runna-hunter.vercel.app). Historically that link carried only `?market=`, so
 * the Hunter ran blind and surfaced findings unrelated to what the email
 * promised. These pure helpers derive the Hunter's form inputs from data we
 * already store (prospect + chosen pain) and build a deep link that PRE-FILLS
 * the audit and PINS the email's hero play as finding #1.
 *
 * Everything is derived at URL-build time — no DB migration, no new stored field.
 *
 * ⚠️ CROSS-REPO CONTRACT: HUNTER_LEAD_SLUGS below must stay in sync with the
 * finding `id` slugs in runna-hunter/index.html (MARKET_DATA[*].ineff[*].id).
 * The slug set is market-agnostic (mx and ca share the same ids per industry).
 * A smoke test (tests/hunter-mapping.test.ts) guards drift; if you add/rename a
 * finding in the Hunter, update this map in the same change.
 */

import { detectIndustryKey, HUNTER_URL } from "./industry-templates.ts";

export type HunterIndustry =
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

export type HunterSize = "solo" | "small" | "mid" | "large";
export type HunterTimesink =
  | "social"
  | "email"
  | "leads"
  | "ads"
  | "reporting"
  | "production";

/**
 * The finding id slugs available per industry in the Hunter catalog — the set
 * of valid pin targets. Mirror of runna-hunter/index.html MARKET_DATA ineff ids.
 * `ai-automation` exists in every industry (the AI/automation hero play).
 */
export const HUNTER_LEAD_SLUGS: Record<HunterIndustry, string[]> = {
  ecommerce:   ["content-system", "email-automation", "creative-testing", "dashboard", "ai-automation"],
  restaurant:  ["content-system", "email-loyalty", "paid-ads", "brand-library", "ai-automation"],
  realestate:  ["lead-nurture", "listing-content", "authority-content", "segmented-ads", "ai-automation"],
  proservices: ["thought-leadership", "referral-program", "automated-reporting", "search-ads", "ai-automation"],
  retail:      ["content-system", "email-segmentation", "ugc-creative", "attribution-dashboard", "ai-automation"],
  automotive:  ["digital-leads", "brand-content", "post-sale-retention", "buyer-profile-ads", "ai-automation"],
  fitness:     ["trial-nurture", "story-content", "local-ads", "member-comms", "ai-automation"],
  hospitality: ["direct-booking", "past-guest-email", "content-system", "traveller-ads", "ai-automation"],
  trades:      ["google-local", "project-content", "seasonal-reengagement", "high-intent-ads", "ai-automation"],
  other:       ["content-system", "email-marketing", "ad-attribution", "lead-nurture", "dashboard", "ai-automation"],
};

// ── Industry: prospect.industry (free text) → Hunter enum ──────────────────────
// Reuse the same keyword detector the fallback templates use, then translate its
// richer key set to the Hunter's enum. Market-agnostic (enum is symmetric).
const TEMPLATE_KEY_TO_HUNTER: Record<string, HunterIndustry> = {
  ecommerce: "ecommerce",
  restaurant: "restaurant",
  realestate: "realestate",
  professional: "proservices",
  retail: "retail",
  automotive: "automotive",
  health: "fitness",
  hotel: "hospitality",
  beach_club: "hospitality",
  villa_rental: "hospitality",
  other: "other",
};

export function mapToHunterIndustry(industry: string | null): HunterIndustry {
  const key = detectIndustryKey(industry);
  return TEMPLATE_KEY_TO_HUNTER[key] ?? "other";
}

// ── Size: headcount → Hunter size bucket (omit when unknown) ───────────────────
export function mapToHunterSize(
  employeeEstimate: number | null | undefined,
): HunterSize | null {
  if (employeeEstimate == null || employeeEstimate <= 0) return null;
  if (employeeEstimate <= 1) return "solo";
  if (employeeEstimate <= 10) return "small";
  if (employeeEstimate <= 50) return "mid";
  return "large";
}

// ── Pain → timesink + lead (pin) ──────────────────────────────────────────────
// pain_label is stored in English regardless of prospect language. We classify it
// into a category, then map the category to (a) the Hunter timesink dropdown and
// (b) an ordered list of candidate finding slugs — returning the first that
// actually exists in the chosen industry's pool.

type PainCategory =
  | "ai"
  | "email"
  | "leads"
  | "ads"
  | "social"
  | "brand"
  | "reporting";

// "AI" needs word-boundary matching — a bare "ai" substring falsely hits
// "paid", "campaign", "retain", etc. Checked before the substring table.
const AI_RE = /\bai\b|\ba\.i\.?\b|artificial intelligence/;

// First keyword wins; order matters (specific before generic).
const PAIN_KEYWORDS: [string, PainCategory][] = [
  ["automat", "ai"],          // automation / automate / automated
  ["chatbot", "ai"],
  ["abandon", "email"],
  ["cart", "email"],
  ["retention", "email"],
  ["nurtur", "leads"],
  ["follow", "leads"],        // follow-up
  ["lead", "leads"],
  ["sales process", "leads"], // (also caught by "sales" below if present)
  ["booking", "leads"],
  ["conversion", "leads"],
  ["roas", "ads"],
  ["paid media", "ads"],
  ["paid", "ads"],
  ["ad ", "ads"],
  ["campaign", "ads"],
  ["competitor", "ads"],
  ["email", "email"],
  ["social", "social"],
  ["content", "social"],
  ["engagement", "social"],
  ["launch", "social"],
  ["event", "social"],
  ["packaging", "brand"],
  ["brand", "brand"],
  ["value prop", "brand"],
  ["website", "brand"],
  ["outdated", "brand"],
  ["proof", "brand"],
  ["report", "reporting"],
  ["dashboard", "reporting"],
  ["analytic", "reporting"],
  ["data", "reporting"],
];

const CATEGORY_TO_TIMESINK: Record<PainCategory, HunterTimesink> = {
  ai: "leads",
  email: "email",
  leads: "leads",
  ads: "ads",
  social: "social",
  brand: "production",
  reporting: "reporting",
};

// Ordered candidate slugs per category — first one valid for the industry wins.
const CATEGORY_TO_SLUGS: Record<PainCategory, string[]> = {
  ai: ["ai-automation"],
  email: ["email-automation", "email-loyalty", "email-segmentation", "email-marketing", "lead-nurture", "past-guest-email", "referral-program", "seasonal-reengagement"],
  leads: ["lead-nurture", "digital-leads", "trial-nurture", "direct-booking", "google-local", "search-ads"],
  ads: ["paid-ads", "creative-testing", "segmented-ads", "ugc-creative", "buyer-profile-ads", "high-intent-ads", "local-ads"],
  social: ["content-system", "thought-leadership", "authority-content", "story-content", "project-content", "brand-content", "listing-content"],
  brand: ["content-system", "brand-library", "brand-content", "listing-content"],
  reporting: ["dashboard", "attribution-dashboard", "automated-reporting", "ad-attribution"],
};

function classifyPain(painLabel: string | null): PainCategory | null {
  if (!painLabel) return null;
  const lower = painLabel.toLowerCase();
  if (AI_RE.test(lower)) return "ai";
  for (const [keyword, category] of PAIN_KEYWORDS) {
    if (lower.includes(keyword)) return category;
  }
  return null;
}

export function painToTimesink(painLabel: string | null): HunterTimesink | null {
  const category = classifyPain(painLabel);
  return category ? CATEGORY_TO_TIMESINK[category] : null;
}

/**
 * Resolve the pin: the finding slug to lead with. Returns a slug only when it
 * exists in the chosen industry's pool (so the Hunter can actually pin it);
 * otherwise null → the Hunter discovers its own top-3 (graceful degradation).
 */
export function painToLeadKey(
  painLabel: string | null,
  industry: HunterIndustry,
): string | null {
  const category = classifyPain(painLabel);
  if (!category) return null;
  const valid = HUNTER_LEAD_SLUGS[industry];
  for (const slug of CATEGORY_TO_SLUGS[category]) {
    if (valid.includes(slug)) return slug;
  }
  return null;
}

// ── URL builder ────────────────────────────────────────────────────────────────
function domainFromWebsite(
  domain: string | null | undefined,
  websiteUrl: string | null | undefined,
): string | null {
  if (domain?.trim()) return domain.trim().replace(/^https?:\/\//, "").replace(/\/.*$/, "");
  if (websiteUrl?.trim()) {
    try {
      return new URL(websiteUrl).hostname;
    } catch {
      return websiteUrl.trim().replace(/^https?:\/\//, "").replace(/\/.*$/, "") || null;
    }
  }
  return null;
}

export type BuildHunterUrlInput = {
  market: "ca" | "mx";
  industry?: HunterIndustry | null;
  size?: HunterSize | null;
  timesink?: HunterTimesink | null;
  tools?: string[] | null;
  website?: string | null;
  lead?: string | null;
};

/**
 * Build the Hunter CTA URL. Keeps the existing `?market=` and appends the
 * pitch-handoff params (only the non-empty ones) plus `v=1`. Supersedes
 * hunterUrlForLanguage — the Hunter degrades gracefully if any param is missing.
 */
export function buildHunterUrl(input: BuildHunterUrlInput): string {
  const params = new URLSearchParams();
  params.set("market", input.market);
  if (input.industry) params.set("industry", input.industry);
  if (input.size) params.set("size", input.size);
  if (input.timesink) params.set("timesink", input.timesink);
  const tools = (input.tools ?? []).map((t) => t.trim()).filter(Boolean);
  if (tools.length) params.set("tools", tools.join(","));
  if (input.website?.trim()) params.set("website", input.website.trim());
  if (input.lead) params.set("lead", input.lead);
  params.set("v", "1");
  return `${HUNTER_URL}?${params.toString()}`;
}

/**
 * Convenience: build the full handoff URL straight from prospect + chosen pain.
 * Used by the pitch generator (lib/pitches/actions.ts).
 */
export function buildHunterUrlForPitch(args: {
  language: "en" | "es";
  market: string | null;
  industry: string | null;
  employeeEstimate: number | null | undefined;
  painLabel: string | null;
  techStack: string[] | null | undefined;
  domain: string | null | undefined;
  websiteUrl: string | null | undefined;
}): string {
  // Market: trust an explicit ca/mx, else derive from language (en→ca, es→mx)
  // to match the historical hunterUrlForLanguage behavior.
  const market: "ca" | "mx" =
    args.market === "ca" || args.market === "mx"
      ? args.market
      : args.language === "en"
        ? "ca"
        : "mx";

  const industry = mapToHunterIndustry(args.industry);
  return buildHunterUrl({
    market,
    industry,
    size: mapToHunterSize(args.employeeEstimate),
    timesink: painToTimesink(args.painLabel),
    tools: args.techStack ?? [],
    website: domainFromWebsite(args.domain, args.websiteUrl),
    lead: painToLeadKey(args.painLabel, industry),
  });
}
