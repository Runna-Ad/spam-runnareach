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

import type { Actor } from "@/lib/actor";
import { runCrawlWith } from "./crawl-stage";
import { braveIsAvailable } from "./sources/brave-search";
import { denueIsAvailable, deriveScianCode, deriveMexicoStateCode, MEXICO_STATE_CODES, INDUSTRY_TO_SCIAN } from "./sources/denue";
import { googlePlacesIsAvailable } from "./sources/google-places";
import { searchGeo } from "./search-geo";

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
 * Build a Brave Search query.
 * Platform keywords get "online store" appended to target merchants, not agencies.
 * Non-platform keywords are used as-is with geo (searchGeo's brave words).
 */
function deriveBraveQuery(icp: { search_keywords: string[]; industry_tags: string[] }, geo: string): string {
  const primaryKeyword = icp.search_keywords[0] ?? icp.industry_tags[0] ?? "ecommerce";

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

/** A scout-chosen search cell: one keyword (and optionally one region) of an ICP. */
export type DiscoveryFocus = { keyword: string; region: string | null };

export async function runAllSourcesWith(
  actor: Actor,
  icpId: string,
  focus?: DiscoveryFocus | null,
): Promise<RunAllResult> {
  const { user } = actor;
  if (user.role === "viewer") {
    return { ok: false, error: "Viewers cannot run discovery." };
  }

  const { supabase } = actor;

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

  // The autopilot's scout picks one cell (keyword × region) per run, so each
  // run's yield can be credited to that cell (lib/learning/scout.ts).
  let focusRegion: string | null = null;
  if (focus?.keyword.trim()) {
    icp.search_keywords = [focus.keyword.trim()];
    focusRegion = focus.region?.trim() || null;
    if (focusRegion) icp.geo_regions = [focusRegion];
  }

  // LATAM is retired (removed from the ICP selector 2026-07-17). Legacy rows
  // map to MX — matching crawl-action's marketToCountry, which already stored
  // LATAM prospects as Mexican. The old CA mapping here meant a LATAM ICP
  // searched Canadian directories and then labelled the results Mexican.
  const market = icp.market === "LATAM" ? "MX" : (icp.market as "CA" | "MX" | "US");
  const geo = searchGeo(market, icp.geo_regions, focusRegion, MEXICO_STATE_CODES);
  const ypLocation = geo.yp;
  const braveQuery = deriveBraveQuery(icp, geo.brave);
  const directoryKeywords = deriveDirectoryKeywords(icp);
  const firstKeyword = directoryKeywords[0]!;

  const runIds: string[] = [];
  const errors: string[] = [];
  let candidatesNew = 0;
  let candidatesDuplicate = 0;

  // Helper to accumulate results
  function collect(result: Awaited<ReturnType<typeof runCrawlWith>>, source: string) {
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
    // Yellow Pages CA is Canada-only. (LATAM used to be included here —
    // wrong, now that LATAM maps to MX.)
    if (icp.market === "CA") {
      collect(
        await runCrawlWith(actor, {
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
      collect(
        await runCrawlWith(actor, {
          source: "google_places",
          keyword: kw,
          location: geo.places,
          market,
          pages: 1,
          icp_id: icpId,
          industry_label: kw,
        }),
        `Google Places (${kw})`,
      );
    }

    // Yelp was removed 2026-06-22 (expired API trial) — do not re-add without
    // Pedro's say-so. Keying availability off YELP_API_KEY alone kept firing
    // it long after removal because the env var stayed set in Vercel.
  }

  // ── DENUE (MX market only, if key configured) ────────────────────────────
  // DENUE uses SCIAN codes, not keyword loops — run once.
  if (icp.market === "MX" && denueIsAvailable()) {
    const scianCode = deriveScianCode(icp.industry_tags);
    const stateCode = deriveMexicoStateCode(icp.geo_regions);
    collect(
      await runCrawlWith(actor, {
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
      await runCrawlWith(actor, {
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
  // Google Places — all markets
  googlePlacesAvailable: boolean;
  googlePlacesLocation: string;
};

export async function previewRunAllSourcesWith(
  actor: Actor,
  icpId: string): Promise<RunAllPreview | null> {
  const { user } = actor;
  const { supabase } = actor;

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

  // Preview must show the same market the run will actually use (LATAM -> MX).
  const previewMarket = icp.market === "LATAM" ? "MX" : icp.market;
  const geo = searchGeo(previewMarket, icp.geo_regions, null, MEXICO_STATE_CODES);
  const ypLoc = geo.yp;
  const googleLocation = geo.places;

  const directoryKeywords = deriveDirectoryKeywords(icp);

  // Count how many directory sources are active
  let activeDirSources = 0;
  if (icp.market === "CA") activeDirSources += 1; // YP (Canada-only)
  if (googlePlacesIsAvailable()) activeDirSources += 1;

  return {
    market: icp.market,
    directoryKeywords,
    ypLocation: ypLoc,
    totalDirectoryCrawls: directoryKeywords.length * activeDirSources,
    braveQuery: deriveBraveQuery(icp, geo.brave),
    braveAvailable: braveIsAvailable(),
    denueAvailable: denueIsAvailable(),
    denueActivity,
    denueState: stateName,
    googlePlacesAvailable: googlePlacesIsAvailable(),
    googlePlacesLocation: googleLocation,
  };
}
