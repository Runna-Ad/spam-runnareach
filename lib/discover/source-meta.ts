/**
 * Pure metadata + types for discovery sources. Lives in its own file so the
 * client `<DiscoverPage>` can import `SOURCE_META` without dragging the
 * server-only `runs-queries.ts` (which imports next/headers) into the
 * client bundle.
 */

export type DiscoverySource =
  | "google_places"
  | "industry_directory"
  | "google_operator"
  | "competitor_mining"
  | "linkedin"
  | "manual_upload"
  | "yellowpages_ca"
  | "brave_search"
  | "denue"
  | "yelp";

/** Sources that support the keyword-based crawl drawer */
export const CRAWLABLE_SOURCES = ["yellowpages_ca", "brave_search", "denue", "yelp", "google_places"] as const;
export type CrawlableSource = (typeof CRAWLABLE_SOURCES)[number];

export const SOURCE_META: Record<
  DiscoverySource,
  { label: string; description: string; available: boolean; blockedOn: string | null }
> = {
  manual_upload: {
    label: "Manual upload",
    description: "Import a CSV of companies you already know about.",
    available: true,
    blockedOn: null,
  },
  yellowpages_ca: {
    label: "Yellow Pages CA",
    description:
      "Scrape yellowpages.ca by keyword + province — free, no API key needed.",
    available: true,
    blockedOn: null,
  },
  brave_search: {
    label: "Brave Search",
    description:
      "Keyword + operator queries via Brave Search API. 2,000 free/month. Add BRAVE_SEARCH_API_KEY to activate.",
    available: false, // toggled to true at runtime when key is present
    blockedOn: "Add BRAVE_SEARCH_API_KEY to .env.local (free at brave.com/search/api).",
  },
  denue: {
    label: "DENUE (México)",
    description:
      "INEGI's national business registry — ~5M Mexican businesses searchable by industry + state. Free API key.",
    available: false, // toggled to true at runtime when key is present
    blockedOn: "Add DENUE_API_KEY to .env.local — free at inegi.org.mx/servicios/api_denue.html (note: INEGI API may only respond from Mexican IPs)",
  },
  yelp: {
    label: "Yelp Fusion",
    description:
      "Search Yelp's business directory across Canada, US, and Mexico. 500 free calls/day. Ideal for finding SMBs without websites.",
    available: false, // toggled to true at runtime when key is present
    blockedOn: "Add YELP_API_KEY to .env.local — free at developer.yelp.com (instant, 500 calls/day).",
  },
  google_places: {
    label: "Google Places",
    description:
      "Text search across Google's full business index — returns website URL directly. ~7,000 free calls/month via Cloud credit.",
    available: false, // toggled to true at runtime when key is present
    blockedOn: "Add GOOGLE_PLACES_API_KEY to .env.local — enable Places API (New) in Google Cloud Console.",
  },
  industry_directory: {
    label: "Industry directory",
    description: "Crawl Alberta Chamber, association rosters, Shopify partner dir.",
    available: false,
    blockedOn: "Per-directory selectors not yet implemented.",
  },
  google_operator: {
    label: "Google search operators",
    description: "site: / intitle: / geo-filtered queries via SerpAPI.",
    available: false,
    blockedOn: "SerpAPI key.",
  },
  competitor_mining: {
    label: "Competitor mining",
    description: "Find lookalike sites of a known good customer via BuiltWith + backlinks.",
    available: false,
    blockedOn: "BuiltWith API key.",
  },
  linkedin: {
    label: "LinkedIn",
    description: "Companies + 1 candidate contact via Unipile.",
    available: false,
    blockedOn: "Unipile account + OAuth.",
  },
};
