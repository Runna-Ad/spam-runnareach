/**
 * Curated option lists for the ICP form. These are *suggestions*, not
 * hard-allowlists — the TagInput still accepts free-form values for
 * anything that isn't here. Two purposes:
 *   1. Drive the autocomplete dropdown so common values are one click
 *   2. Give a clear vocabulary so different team members don't write
 *      "DTC" / "dtc" / "Direct to consumer" for the same thing
 *
 * When the AI Suggest button lands (Phase 2), Claude will be told to
 * prefer values from these lists when one fits, and to invent new ones
 * only when none does.
 */

/**
 * Google Places `type` values. Subset of the official list at
 * https://developers.google.com/maps/documentation/places/web-service/place-types
 * — keeping ~80 types that are realistic targets for B2B prospecting.
 * (Excluded: airports, transit stations, government, religious sites, etc.)
 */
export const GOOGLE_PLACES_TYPES: readonly string[] = [
  // Retail
  "store",
  "shopping_mall",
  "clothing_store",
  "shoe_store",
  "jewelry_store",
  "department_store",
  "convenience_store",
  "supermarket",
  "grocery_or_supermarket",
  "electronics_store",
  "furniture_store",
  "home_goods_store",
  "hardware_store",
  "book_store",
  "bicycle_store",
  "pet_store",
  "florist",
  "liquor_store",

  // Food & beverage
  "restaurant",
  "cafe",
  "bakery",
  "bar",
  "meal_delivery",
  "meal_takeaway",
  "food",

  // Health & wellness
  "gym",
  "spa",
  "beauty_salon",
  "hair_care",
  "doctor",
  "dentist",
  "pharmacy",
  "physiotherapist",
  "veterinary_care",

  // Professional services
  "lawyer",
  "accounting",
  "real_estate_agency",
  "insurance_agency",
  "travel_agency",
  "moving_company",
  "storage",
  "car_rental",
  "car_dealer",
  "car_repair",

  // Trades & home services
  "electrician",
  "plumber",
  "painter",
  "roofing_contractor",
  "general_contractor",
  "locksmith",
  "laundry",
  "car_wash",

  // Hospitality & lodging
  "lodging",

  // Education & creative
  "school",
  "university",
  "library",
  "art_gallery",
  "museum",

  // Entertainment & venue
  "amusement_park",
  "aquarium",
  "bowling_alley",
  "casino",
  "movie_theater",
  "night_club",
  "stadium",
  "tourist_attraction",
  "zoo",

  // Other
  "establishment",
  "point_of_interest",
] as const;

/**
 * Curated business types. The DB column is `text[]`, so this is purely
 * advisory — but pinning the vocabulary keeps reports clean.
 */
export const BUSINESS_TYPES: readonly string[] = [
  "dtc_ecommerce",
  "shopify_brand",
  "marketplace_seller",
  "wholesale_brand",
  "subscription_box",
  "saas_b2b",
  "saas_b2c",
  "professional_services",
  "marketing_agency",
  "creative_agency",
  "consulting",
  "law_firm",
  "accounting_firm",
  "real_estate",
  "restaurant_group",
  "hospitality",
  "fitness_studio",
  "wellness_brand",
  "nonprofit",
  "education",
  "healthcare",
  "manufacturer",
  "trade_services",
  "retailer_brick_and_mortar",
] as const;

/**
 * Industry tags — a baseline list. Tenants extend this with their own
 * via the auto-suggest "used by your team" group.
 */
export const INDUSTRY_TAGS: readonly string[] = [
  "dtc",
  "ecommerce",
  "consumer goods",
  "lifestyle brands",
  "apparel",
  "food and beverage",
  "beauty",
  "wellness",
  "home goods",
  "outdoor",
  "pet",
  "fitness",
  "professional services",
  "saas",
  "agency",
  "hospitality",
  "real estate",
  "automotive",
  "education",
  "healthcare",
  "nonprofit",
] as const;

/**
 * Provincial/regional baselines for Canada + Mexico + LATAM. The
 * tenant-derived suggestions augment this with values already in use.
 */
export const GEO_REGIONS: readonly string[] = [
  // Canada — provinces
  "Alberta",
  "British Columbia",
  "Manitoba",
  "New Brunswick",
  "Newfoundland and Labrador",
  "Nova Scotia",
  "Ontario",
  "Prince Edward Island",
  "Quebec",
  "Saskatchewan",
  // Canada — major cities
  "Calgary",
  "Edmonton",
  "Toronto",
  "Vancouver",
  "Montreal",
  "Ottawa",
  "Halifax",
  "Winnipeg",
  // Mexico — states + CDMX
  "Ciudad de México",
  "Estado de México",
  "Jalisco",
  "Nuevo León",
  "Querétaro",
  "Yucatán",
  // Mexico — major cities
  "Guadalajara",
  "Monterrey",
  "Puebla",
  "Mérida",
  // LATAM
  "Bogotá",
  "Medellín",
  "Buenos Aires",
  "Santiago",
  "Lima",
  "São Paulo",
  "Rio de Janeiro",
] as const;

/**
 * Common search-keyword starting points. These tend to overlap with
 * industry tags but are framed as queryable phrases.
 */
export const SEARCH_KEYWORDS: readonly string[] = [
  "shopify",
  "shopify plus",
  "online shop",
  "direct to consumer",
  "dtc brand",
  "ecommerce",
  "subscription",
  "online store",
  "drop shipping",
  "made in canada",
  "small batch",
  "handmade",
  "sustainable",
  "organic",
  "premium",
  "luxury",
  "boutique",
] as const;

/**
 * Excluded keywords that are commonly hard-filters across most ICPs
 * (Runna CA's compliance posture). Used as suggestions only.
 */
export const EXCLUDED_KEYWORDS: readonly string[] = [
  "dropshipping",
  "MLM",
  "multi-level marketing",
  "adult",
  "cannabis retail",
  "vape",
  "tobacco",
  "gambling",
  "crypto",
  "weapons",
  "casino",
] as const;
