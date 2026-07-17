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
  | "claude_search";

/** Sources that support the keyword-based crawl drawer */
export const CRAWLABLE_SOURCES = ["claude_search", "yellowpages_ca", "brave_search", "denue", "google_places"] as const;
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
  claude_search: {
    label: "AI Search (Claude)",
    description:
      "Claude researches the live web (via Brave) against your ICP — reads each result, filters out directories and off-ICP businesses, and returns a tight list of real fits. Smarter & narrower than raw keyword search.",
    available: false, // toggled to true at runtime when both keys are present
    blockedOn: "Requires ANTHROPIC_API_KEY + BRAVE_SEARCH_API_KEY in .env.local.",
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
  // Yelp was removed 2026-06-22 (expired trial) — run-history rows with
  // source='yelp' fall back to the raw string label in the UI.
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
