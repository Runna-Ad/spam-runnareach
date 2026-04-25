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
  | "manual_upload";

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
  google_places: {
    label: "Google Places",
    description: "ICP-driven Places search for local SMBs by industry + region.",
    available: false,
    blockedOn: "Google Cloud — Places API key + restricted referrer.",
  },
  industry_directory: {
    label: "Industry directory",
    description: "Crawl Shopify dir, Yellow Pages CA, Alberta Chamber, association rosters.",
    available: false,
    blockedOn: "Per-directory selectors not yet implemented (slice 1b).",
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
