/**
 * "Suggest with AI" helper for the ICP form. Today this is a deterministic
 * heuristic that infers tag values from the ICP name. When Anthropic
 * credits land, this function gets swapped for a Claude call that takes
 * the same input and returns the same shape — the form code doesn't
 * change.
 *
 * Inputs we have today:
 *   - The ICP name (Pedro types one before clicking Suggest)
 *   - The market + language (already on the form)
 *
 * Output: a partial FormState with proposed tag arrays. The user reviews
 * and removes anything that doesn't fit before saving — we never
 * auto-save.
 */

import {
  BUSINESS_TYPES,
  GEO_REGIONS,
  GOOGLE_PLACES_TYPES,
  INDUSTRY_TAGS,
  SEARCH_KEYWORDS,
} from "./option-sources";

export type SuggestInput = {
  name: string;
  market: "CA" | "MX" | "US" | "LATAM";
  language: "en" | "es";
  /** Values already on the form — we won't propose anything already there. */
  existing: {
    industry_tags: string[];
    business_types: string[];
    geo_regions: string[];
    google_places_types: string[];
    search_keywords: string[];
  };
};

export type SuggestOutput = {
  industry_tags: string[];
  business_types: string[];
  geo_regions: string[];
  google_places_types: string[];
  search_keywords: string[];
  reasoning: string;
};

/**
 * Heuristic: scan the ICP name for known tokens and propose matching
 * canonical values. Plus a few strong correlations:
 *   - "DTC" / "ecommerce" → adds shopify_brand business type, shopify
 *     search keyword, store + clothing_store places types
 *   - Region names in the name → add to geo_regions
 *   - Keyword "gym/fitness" / "spa" / "restaurant" / etc. → add the
 *     matching Google Places type
 *
 * Phase-2 swap: replace the body with `await scoreWithClaude(input)` and
 * map the response into SuggestOutput.
 */
export function suggestIcpFields(input: SuggestInput): SuggestOutput {
  const lowerName = input.name.toLowerCase();
  const reasoning: string[] = [];
  const existingLower = (k: keyof SuggestInput["existing"]) =>
    new Set(input.existing[k].map((v) => v.toLowerCase()));

  // ---- Industry tags ------------------------------------------------------
  const industrySet = existingLower("industry_tags");
  const industry_tags: string[] = [];
  for (const tag of INDUSTRY_TAGS) {
    if (industrySet.has(tag.toLowerCase())) continue;
    if (lowerName.includes(tag.toLowerCase())) industry_tags.push(tag);
  }
  // Common shorthand: "DTC" + "ecommerce" co-imply each other
  if (lowerName.includes("dtc") && !industrySet.has("ecommerce") && !industry_tags.includes("ecommerce")) {
    industry_tags.push("ecommerce");
  }
  if (industry_tags.length > 0) {
    reasoning.push(`Industry tags from name keywords: ${industry_tags.join(", ")}`);
  }

  // ---- Business types -----------------------------------------------------
  const btSet = existingLower("business_types");
  const business_types: string[] = [];
  if (lowerName.includes("dtc") || lowerName.includes("ecommerce") || lowerName.includes("e-commerce")) {
    if (!btSet.has("dtc_ecommerce")) business_types.push("dtc_ecommerce");
    if (!btSet.has("shopify_brand") && lowerName.includes("shopify")) {
      business_types.push("shopify_brand");
    }
  }
  if (lowerName.includes("agency")) {
    if (!btSet.has("creative_agency")) business_types.push("creative_agency");
  }
  if (lowerName.includes("saas")) {
    if (!btSet.has("saas_b2b")) business_types.push("saas_b2b");
  }
  if (lowerName.includes("law") && !btSet.has("law_firm")) business_types.push("law_firm");
  if (lowerName.includes("restaurant") && !btSet.has("restaurant_group")) {
    business_types.push("restaurant_group");
  }
  if (lowerName.includes("fitness") || lowerName.includes("gym")) {
    if (!btSet.has("fitness_studio")) business_types.push("fitness_studio");
  }
  // Sanity: only keep values that ARE in the canonical list
  const allowedBt = new Set(BUSINESS_TYPES.map((s) => s.toLowerCase()));
  const business_types_clean = business_types.filter((v) => allowedBt.has(v.toLowerCase()));
  if (business_types_clean.length > 0) {
    reasoning.push(`Business types from name: ${business_types_clean.join(", ")}`);
  }

  // ---- Geo regions --------------------------------------------------------
  const geoSet = existingLower("geo_regions");
  const geo_regions: string[] = [];
  for (const region of GEO_REGIONS) {
    if (geoSet.has(region.toLowerCase())) continue;
    if (lowerName.includes(region.toLowerCase())) geo_regions.push(region);
  }
  // Default fallbacks by market when nothing matches in the name
  if (geo_regions.length === 0 && input.existing.geo_regions.length === 0) {
    if (input.market === "CA") geo_regions.push("Ontario", "Alberta", "British Columbia");
    if (input.market === "MX") geo_regions.push("Ciudad de México", "Jalisco", "Nuevo León");
    reasoning.push(`Default ${input.market} regions added (none matched name)`);
  } else if (geo_regions.length > 0) {
    reasoning.push(`Geo regions from name: ${geo_regions.join(", ")}`);
  }

  // ---- Google Places types ------------------------------------------------
  // Map common name keywords → likely Places type
  const placesSet = existingLower("google_places_types");
  const placesGuesses: string[] = [];
  const tokenMap: Record<string, string[]> = {
    coffee: ["cafe", "restaurant"],
    cafe: ["cafe"],
    restaurant: ["restaurant"],
    bakery: ["bakery"],
    bar: ["bar"],
    spa: ["spa"],
    fitness: ["gym"],
    gym: ["gym"],
    salon: ["beauty_salon", "hair_care"],
    apparel: ["clothing_store"],
    clothing: ["clothing_store"],
    skincare: ["beauty_salon"],
    pet: ["pet_store"],
    "law firm": ["lawyer"],
    accounting: ["accounting"],
    "real estate": ["real_estate_agency"],
    dtc: ["store"],
    ecommerce: ["store"],
    "e-commerce": ["store"],
  };
  for (const [token, types] of Object.entries(tokenMap)) {
    if (lowerName.includes(token)) {
      for (const t of types) {
        if (placesSet.has(t)) continue;
        if (!placesGuesses.includes(t)) placesGuesses.push(t);
      }
    }
  }
  // Sanity: only keep values that ARE in the canonical list
  const allowedPlaces = new Set(GOOGLE_PLACES_TYPES.map((s) => s.toLowerCase()));
  const google_places_types = placesGuesses.filter((v) => allowedPlaces.has(v.toLowerCase()));
  if (google_places_types.length > 0) {
    reasoning.push(`Google Places types from name tokens: ${google_places_types.join(", ")}`);
  }

  // ---- Search keywords ----------------------------------------------------
  const swSet = existingLower("search_keywords");
  const search_keywords: string[] = [];
  // Pull industry tags also as search keywords if not present
  for (const tag of industry_tags) {
    if (!swSet.has(tag.toLowerCase()) && !search_keywords.includes(tag)) {
      search_keywords.push(tag);
    }
  }
  // Cherry-pick keywords from the canonical list whose tokens appear in name
  for (const kw of SEARCH_KEYWORDS) {
    if (swSet.has(kw.toLowerCase()) || search_keywords.includes(kw)) continue;
    const kwLower = kw.toLowerCase();
    if (lowerName.includes(kwLower)) search_keywords.push(kw);
  }
  if (search_keywords.length > 0) {
    reasoning.push(`Search keywords seeded from industry tags + name`);
  }

  return {
    industry_tags,
    business_types: business_types_clean,
    geo_regions,
    google_places_types,
    search_keywords,
    reasoning:
      reasoning.length > 0
        ? `Suggested via heuristic. ${reasoning.join(". ")}.`
        : "Heuristic found no strong signals — try a more descriptive name like 'Calgary DTC ecommerce, 5–50 employees'. Phase-2 Claude will be smarter here.",
  };
}
