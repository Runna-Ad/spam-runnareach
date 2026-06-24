"use server";

/**
 * Reachable-pool preview for an ICP — sizes (samples) how many real businesses
 * Google Places surfaces for the ICP's places-types × geo-regions. Google's
 * Text Search doesn't return a true total, so this is a SAMPLE estimate: it runs
 * a capped set of queries (max 9, to bound API cost — ~$0.03/call), dedupes the
 * results by domain, and reports the count as "≥N found in a quick sample".
 *
 * Persists reachable_pool_count + reachable_pool_computed_at so the drawer can
 * show "last preview" without re-querying.
 */

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { requireUser } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { googlePlacesIsAvailable, searchGooglePlaces } from "@/lib/discover/sources/google-places";

export type PreviewPoolResult =
  | { ok: true; count: number; sampled: boolean; queries_run: number }
  | { ok: false; error: string };

const MARKET_COUNTRY: Record<string, string> = {
  CA: "Canada",
  MX: "Mexico",
  US: "United States",
  LATAM: "",
};

const MAX_TERMS = 3;
const MAX_REGIONS = 3; // 3×3 = 9 queries max

export async function previewIcpReachablePool(icpId: string): Promise<PreviewPoolResult> {
  const idParse = z.string().uuid().safeParse(icpId);
  if (!idParse.success) return { ok: false, error: "Invalid ICP id." };

  if (!googlePlacesIsAvailable()) {
    return { ok: false, error: "Google Places API key not set — add GOOGLE_PLACES_API_KEY." };
  }

  const user = await requireUser();
  const supabase = await createClient();

  type IcpRow = {
    google_places_types: string[] | null;
    geo_regions: string[] | null;
    search_keywords: string[] | null;
    market: string;
    language: string;
  };
  const { data: icp } = await supabase
    .from("icps")
    .select("google_places_types, geo_regions, search_keywords, market, language")
    .eq("id", idParse.data)
    .eq("tenant_id", user.tenantId)
    .single<IcpRow>();
  if (!icp) return { ok: false, error: "ICP not found." };

  const country = MARKET_COUNTRY[icp.market] ?? "";
  // Prefer places types; fall back to search keywords if none set.
  const rawTerms = (icp.google_places_types?.length ? icp.google_places_types : icp.search_keywords) ?? [];
  const terms = rawTerms.slice(0, MAX_TERMS).map((t) => t.replace(/_/g, " ").trim()).filter(Boolean);
  const regions = (icp.geo_regions?.length ? icp.geo_regions : country ? [country] : []).slice(0, MAX_REGIONS);

  if (terms.length === 0) {
    return { ok: false, error: "Add Google Places types (or search keywords) to preview the pool." };
  }
  if (regions.length === 0) {
    return { ok: false, error: "Add a geo region (or set a market) to preview the pool." };
  }

  // Build queries: "{type} in {region}, {country}".
  const queries: string[] = [];
  for (const term of terms) {
    for (const region of regions) {
      const where = region === country || !country ? region : `${region}, ${country}`;
      queries.push(`${term} in ${where}`);
    }
  }

  const languageCode = icp.language === "es" ? "es" : "en";
  const seen = new Set<string>();

  // Run in chunks of 3 concurrently to stay within the function budget.
  for (let i = 0; i < queries.length; i += 3) {
    const chunk = queries.slice(i, i + 3);
    const results = await Promise.all(
      chunk.map((q) => searchGooglePlaces({ query: q, maxResults: 20, languageCode })),
    );
    for (const r of results) {
      if (!r.ok) continue;
      for (const l of r.listings) {
        // Dedupe by domain when present, else name+city.
        const key = l.domain ?? `${l.company_name.toLowerCase()}|${(l.city ?? "").toLowerCase()}`;
        if (key.trim()) seen.add(key);
      }
    }
  }

  const count = seen.size;
  const now = new Date().toISOString();
  await supabase
    .from("icps")
    .update({ reachable_pool_count: count, reachable_pool_computed_at: now } as never)
    .eq("id", idParse.data)
    .eq("tenant_id", user.tenantId);

  revalidatePath("/icp");
  return { ok: true, count, sampled: true, queries_run: queries.length };
}
