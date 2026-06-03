"use server";

/**
 * "Run All Sources" orchestrator — multi-keyword edition.
 *
 * Strategy:
 * - Directory sources (YP, Google Places, Yelp) run once per non-platform
 *   search_keyword — finding "furniture store" and "clothing boutique" in
 *   separate crawls rather than one generic search.
 * - Brave Search runs once using the platform keyword (e.g. "shopify online store")
 *   to find digital-native merchants across the web.
 * - DENUE (MX) runs once using SCIAN category inference.
 *
 * Each keyword crawl produces a separate discovery_run row so history is clean.
 * Industry label is always set to the clean keyword (never the raw query string).
 */

import { requireUser } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { runCrawl } from "./crawl-action";
import { braveIsAvailable } from "./sources/brave-search";
import { denueIsAvailable, deriveScianCode, deriveMexicoStateCode, MEXICO_STATE_CODES, INDUSTRY_TO_SCIAN } from "./sources/denue";
import { yelpIsAvailable } from "./sources/yelp";
import { googlePlacesIsAvailable } from "./sources/google-places";

// ── Types ─────────────────────────────────────────────────────────────────────

export type RunAllResult =
  | {
      ok: true;
      runIds: string[];
      candidatesNew: number;
      candidatesDuplicate: number;
      errors: string[]; // non-fatal per-source errors
    }
  | { ok: false; error: string };

// ── Constants ─────────────────────────────────────────────────────────────────

/**
 * Platform/tool names — these identify a tech stack, NOT a product category.
 * Searching directories (YP, Google Places, Yelp) for "shopify" finds agencies,
 * not merchants. Skip these for directory searches; only use for Brave queries.
 */
const PLATFORM_KEYWORDS = new Set([
  "shopify", "woocommerce", "bigcommerce", "squarespace", "wix",
  "magento", "prestashop", "volusion", "ecwid", "wordpress",
]);

const CANADIAN_PROVINCES = new Set([
  "Alberta", "British Columbia", "Manitoba", "New Brunswick",
  "Newfoundland and Labrador", "Northwest Territories", "Nova Scotia",
  "Nunavut", "Ontario", "Prince Edward Island", "Quebec", "Saskatchewan", "Yukon",
]);

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Return all non-platform search_keywords, capped at 5 to bound run time.
 * Falls back to first industry_tag, then "ecommerce" if nothing else is available.
 */
function deriveDirectoryKeywords(icp: {
  search_keywords: string[];
  industry_tags: string[];
}): string[] {
  const nonPlatform = icp.search_keywords.filter(
    (k) => !PLATFORM_KEYWORDS.has(k.toLowerCase()),
  );
  if (nonPlatform.length > 0) return nonPlatform.slice(0, 5);
  return [(icp.industry_tags[0] ?? "ecommerce")];
}

/**
 * Derive the YP province/location from an ICP's geo_regions.
 * YP expects a full province name (e.g. "Alberta") or "Canada".
 */
function deriveYpLocation(geoRegions: string[]): string {
  const province = geoRegions.find((r) => CANADIAN_PROVINCES.has(r));
  return province ?? "Canada";
}

/**
 * Build a Brave Search query.
 * Platform keywords get "online store" appended to target merchants, not agencies.
 * Non-platform keywords are used as-is with geo.
 */
function deriveBraveQuery(icp: {
  search_keywords: string[];
  industry_tags: string[];
  market: string;
  geo_regions: string[];
}): string {
  const primaryKeyword = icp.search_keywords[0] ?? icp.industry_tags[0] ?? "ecommerce";
  const geo =
    icp.market === "MX" ? "Mexico"
    : icp.market === "US" ? "United States"
    : icp.geo_regions.find((r) => CANADIAN_PROVINCES.has(r)) ?? "Canada";

  if (PLATFORM_KEYWORDS.has(primaryKeyword.toLowerCase())) {
    return `"${primaryKeyword}" online store ${geo}`;
  }
  return `"${primaryKeyword}" ${geo}`;
}

/**
 * Best single keyword to label industry on prospects (used when industry_label
 * is needed for a specific crawl that doesn't have a per-keyword label).
 */
function _deriveKeyword(icp: {
  search_keywords: string[];
  industry_tags: string[];
}): string {
  const nonPlatform = icp.search_keywords.find(
    (k) => !PLATFORM_KEYWORDS.has(k.toLowerCase()),
  );
  return nonPlatform ?? icp.industry_tags[0] ?? "ecommerce";
}

// ── Entry point ───────────────────────────────────────────────────────────────

export async function runAllSources(icpId: string): Promise<RunAllResult> {
  const user = await requireUser();
  if (user.role === "viewer") {
    return { ok: false, error: "Viewers cannot run discovery." };
  }

  const supabase = await createClient();

  // Load ICP
  type IcpRow = {
    id: string;
    market: "CA" | "MX" | "US" | "LATAM";
    search_keywords: string[];
    industry_tags: string[];
    geo_regions: string[];
  };
  const { data: icp, error: icpErr } = await supabase
    .from("icps")
    .select("id, market, search_keywords, industry_tags, geo_regions")
    .eq("id", icpId)
    .eq("tenant_id", user.tenantId)
    .maybeSingle<IcpRow>();

  if (icpErr || !icp) {
    return { ok: false, error: icpErr?.message ?? "ICP not found." };
  }

  const market = icp.market === "LATAM" ? "CA" : (icp.market as "CA" | "MX" | "US");
  const ypLocation = deriveYpLocation(icp.geo_regions);
  const braveQuery = deriveBraveQuery(icp);
  const directoryKeywords = deriveDirectoryKeywords(icp);
  const firstKeyword = directoryKeywords[0]!;

  const runIds: string[] = [];
  const errors: string[] = [];
  let candidatesNew = 0;
  let candidatesDuplicate = 0;

  // Helper to accumulate results
  function collect(result: Awaited<ReturnType<typeof runCrawl>>, source: string) {
    if (result.ok) {
      runIds.push(result.run_id);
      candidatesNew += result.candidates_new;
      candidatesDuplicate += result.candidates_duplicate;
    } else {
      errors.push(`${source}: ${result.error}`);
    }
  }

  // ── Directory sources: one crawl per keyword ─────────────────────────────
  // Each keyword gets its own crawl row so run history is traceable.
  // industry_label is set to the keyword so prospect.industry = "furniture store",
  // NOT the raw query string.

  for (const kw of directoryKeywords) {
    // Yellow Pages CA (CA market)
    if (icp.market === "CA" || icp.market === "LATAM") {
      collect(
        await runCrawl({
          source: "yellowpages_ca",
          keyword: kw,
          location: ypLocation,
          market: "CA",
          pages: 3,
          icp_id: icpId,
          industry_label: kw,
        }),
        `Yellow Pages (${kw})`,
      );
    }

    // Google Places (all markets)
    if (googlePlacesIsAvailable()) {
      const googleLocation =
        icp.market === "MX" ? "Mexico"
        : icp.market === "US" ? "United States"
        : ypLocation !== "Canada" ? `${ypLocation}, Canada`
        : "Canada";

      collect(
        await runCrawl({
          source: "google_places",
          keyword: kw,
          location: googleLocation,
          market,
          pages: 1,
          icp_id: icpId,
          industry_label: kw,
        }),
        `Google Places (${kw})`,
      );
    }

    // Yelp (CA/MX/US)
    if (yelpIsAvailable()) {
      const yelpLocation =
        icp.market === "MX" ? "Mexico"
        : icp.market === "US" ? "United States"
        : ypLocation !== "Canada" ? `${ypLocation}, Canada`
        : "Canada";

      collect(
        await runCrawl({
          source: "yelp",
          keyword: kw,
          location: yelpLocation,
          market,
          pages: 1,
          icp_id: icpId,
          industry_label: kw,
        }),
        `Yelp (${kw})`,
      );
    }
  }

  // ── DENUE (MX market only, if key configured) ────────────────────────────
  // DENUE uses SCIAN codes, not keyword loops — run once.
  if (icp.market === "MX" && denueIsAvailable()) {
    const scianCode = deriveScianCode(icp.industry_tags);
    const stateCode = deriveMexicoStateCode(icp.geo_regions);
    collect(
      await runCrawl({
        source: "denue",
        keyword: scianCode,
        location: stateCode,
        market: "MX",
        pages: 1,
        icp_id: icpId,
        industry_label: firstKeyword,
      }),
      "DENUE",
    );
  }

  // ── Brave Search (all markets, once) ──────────────────────────────────────
  // Brave is a web search engine — a single well-constructed query is better
  // than repeating per keyword. Uses platform keyword to find digital-native
  // merchants (e.g. Shopify stores) that directories don't list.
  if (braveIsAvailable()) {
    collect(
      await runCrawl({
        source: "brave_search",
        keyword: braveQuery,
        industry_label: firstKeyword, // store clean label, not the full query string
        market,
        pages: 1,
        icp_id: icpId,
      }),
      "Brave Search",
    );
  }

  if (runIds.length === 0) {
    return { ok: false, error: errors.join("; ") || "All sources failed." };
  }

  return { ok: true, runIds, candidatesNew, candidatesDuplicate, errors };
}

// ── Preview helper (called from modal before running) ────────────────────────

export type RunAllPreview = {
  market: "CA" | "MX" | "US" | "LATAM";
  // Directory sources
  directoryKeywords: string[];     // all non-platform keywords that will be searched
  ypLocation: string;
  totalDirectoryCrawls: number;    // directoryKeywords × active directory sources
  // MX sources
  denueAvailable: boolean;
  denueActivity: string | null;    // SCIAN code label
  denueState: string | null;       // state name
  // Brave
  braveQuery: string;
  braveAvailable: boolean;
  // Yelp — CA/MX/US
  yelpAvailable: boolean;
  yelpLocation: string;
  // Google Places — all markets
  googlePlacesAvailable: boolean;
  googlePlacesLocation: string;
};

export async function previewRunAllSources(icpId: string): Promise<RunAllPreview | null> {
  const user = await requireUser();
  const supabase = await createClient();

  type IcpRow = {
    market: "CA" | "MX" | "US" | "LATAM";
    search_keywords: string[];
    industry_tags: string[];
    geo_regions: string[];
  };
  const { data: icp } = await supabase
    .from("icps")
    .select("market, search_keywords, industry_tags, geo_regions")
    .eq("id", icpId)
    .eq("tenant_id", user.tenantId)
    .maybeSingle<IcpRow>();

  if (!icp) return null;

  const scianCode = deriveScianCode(icp.industry_tags);
  const stateName = icp.geo_regions.find((r) => MEXICO_STATE_CODES[r]) ?? null;
  const scianEntry = Object.entries(INDUSTRY_TO_SCIAN).find(([, code]) => code === scianCode);
  const denueActivity = scianEntry
    ? `${scianEntry[0]} (SCIAN ${scianCode})`
    : scianCode !== "0" ? `SCIAN ${scianCode}` : "all industries";

  const ypLoc = deriveYpLocation(icp.geo_regions);
  const yelpLocation =
    icp.market === "MX" ? "Mexico"
    : icp.market === "US" ? "United States"
    : ypLoc !== "Canada" ? `${ypLoc}, Canada`
    : "Canada";

  const googleLocation =
    icp.market === "MX" ? "Mexico"
    : icp.market === "US" ? "United States"
    : ypLoc !== "Canada" ? `${ypLoc}, Canada`
    : "Canada";

  const directoryKeywords = deriveDirectoryKeywords(icp);

  // Count how many directory sources are active
  let activeDirSources = 0;
  if (icp.market === "CA" || icp.market === "LATAM") activeDirSources += 1; // YP
  if (googlePlacesIsAvailable()) activeDirSources += 1;
  if (yelpIsAvailable()) activeDirSources += 1;

  return {
    market: icp.market,
    directoryKeywords,
    ypLocation: ypLoc,
    totalDirectoryCrawls: directoryKeywords.length * activeDirSources,
    braveQuery: deriveBraveQuery(icp),
    braveAvailable: braveIsAvailable(),
    denueAvailable: denueIsAvailable(),
    denueActivity,
    denueState: stateName,
    yelpAvailable: yelpIsAvailable(),
    yelpLocation,
    googlePlacesAvailable: googlePlacesIsAvailable(),
    googlePlacesLocation: googleLocation,
  };
}
