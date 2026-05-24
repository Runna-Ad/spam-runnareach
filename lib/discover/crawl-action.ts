"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { writeAuditLog } from "@/lib/audit/log";
import { requireUser } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import type { Database } from "@/lib/supabase/types";
import { findDuplicate, normalizeDomain } from "./fuzzy-dedupe";
import { searchBrave, braveIsAvailable } from "./sources/brave-search";
import { searchYellowPagesCA } from "./sources/yellowpages-ca";
import { searchDenue, denueIsAvailable, deriveMexicoStateCode, MEXICO_STATE_CODES } from "./sources/denue";
import { searchYelp, yelpIsAvailable } from "./sources/yelp";
import { searchGooglePlaces, googlePlacesIsAvailable } from "./sources/google-places";
import { anymailFindDecisionMaker } from "@/lib/research/anymail-finder";
import { hunterDomainSearch } from "@/lib/research/hunter";

// ── Input schema ──────────────────────────────────────────────────────────────

const crawlSchema = z.object({
  source: z.enum(["yellowpages_ca", "brave_search", "denue", "yelp", "google_places"]),
  keyword: z.string().trim().min(1).max(200),
  /** Province name for YP ("Alberta"), or omit for Brave (uses market) */
  location: z.string().trim().max(200).optional(),
  market: z.enum(["CA", "MX", "US", "LATAM"]).default("CA"),
  /** How many YP pages to scrape (1-10). Brave always fetches 20 results. */
  pages: z.number().int().min(1).max(10).default(3),
  icp_id: z.string().uuid().nullable().optional(),
  /**
   * Clean industry label stored in prospects.industry — separate from the
   * search keyword so Brave's full query string ("\"shopify\" \"dtc\" canada")
   * doesn't pollute the column. Falls back to keyword if not provided.
   */
  industry_label: z.string().trim().max(100).optional(),
});

export type CrawlInput = z.input<typeof crawlSchema>;

export type CrawlResult =
  | {
      ok: true;
      run_id: string;
      source: "yellowpages_ca" | "brave_search" | "denue" | "yelp" | "google_places";
      candidates_found: number;
      candidates_new: number;
      candidates_duplicate: number;
      red_flags: number;
    }
  | { ok: false; error: string };

// ── Main action ───────────────────────────────────────────────────────────────

export async function runCrawl(input: CrawlInput): Promise<CrawlResult> {
  const user = await requireUser();
  if (user.role === "viewer") {
    return { ok: false, error: "Viewers cannot run discovery crawls." };
  }

  const parsed = crawlSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? "Invalid input." };
  }

  const { source, keyword, location, market, pages, icp_id, industry_label } = parsed.data;
  const supabase = await createClient();
  const nowIso = new Date().toISOString();

  // ── Open discovery_run row ──────────────────────────────────────────────
  const { data: runRow, error: runErr } = await supabase
    .from("discovery_runs")
    .insert({
      tenant_id: user.tenantId,
      icp_id: icp_id ?? null,
      source,
      triggered_by: user.id,
      status: "running",
      started_at: nowIso,
    })
    .select("id")
    .single<{ id: string }>();

  if (runErr || !runRow) {
    return {
      ok: false,
      error: `Could not start crawl run: ${runErr?.message ?? "no row"}`,
    };
  }

  // ── Fetch raw listings from source ──────────────────────────────────────
  const rawListings = await fetchFromSource({
    source,
    keyword,
    location,
    market,
    pages,
  });

  if (!rawListings.ok) {
    await failRun(runRow.id, rawListings.error);
    return { ok: false, error: rawListings.error };
  }

  // ── Load existing prospects for dedupe ──────────────────────────────────
  const { data: existing, error: existingErr } = await supabase
    .from("prospects")
    .select("company_name, domain")
    .eq("tenant_id", user.tenantId)
    .returns<{ company_name: string; domain: string | null }[]>();

  if (existingErr) {
    await failRun(runRow.id, `Could not preload prospects: ${existingErr.message}`);
    return { ok: false, error: `Could not preload prospects: ${existingErr.message}` };
  }

  const seen: { name: string; domain: string | null }[] = (existing ?? []).map((e) => ({
    name: e.company_name,
    domain: e.domain,
  }));

  // ── Dedupe + build inserts ──────────────────────────────────────────────
  let candidates_new = 0;
  let candidates_duplicate = 0;
  let red_flags = 0;
  const inserts: Database["public"]["Tables"]["prospects"]["Insert"][] = [];

  // Domains that are SaaS platforms, not prospects we'd ever pitch
  const BLOCKED_PROSPECT_DOMAINS = new Set([
    "shopify.com", "woocommerce.com", "bigcommerce.com", "squarespace.com",
    "wix.com", "weebly.com", "ecwid.com", "volusion.com", "prestashop.com",
    "magento.com", "wordpress.com", "wordpress.org",
    "google.com", "facebook.com", "instagram.com", "linkedin.com",
    "amazon.com", "amazon.ca", "ebay.com", "etsy.com",
    "yelp.com", "yelp.ca", "yellowpages.ca",
  ]);

  for (const listing of rawListings.listings) {
    const normalizedDomain = listing.domain
      ? normalizeDomain(listing.domain)
      : null;

    // Skip SaaS platforms / directories that slipped past source-level filters
    if (normalizedDomain && BLOCKED_PROSPECT_DOMAINS.has(normalizedDomain)) {
      candidates_duplicate++; // count as dup so stats stay accurate
      continue;
    }

    // Skip prospects with no name or a name that's clearly just a platform keyword
    const nameClean = listing.company_name.trim().toLowerCase();
    if (!nameClean || nameClean === "shopify" || nameClean === "shopify partner"
        || nameClean === "woocommerce" || nameClean === "squarespace") {
      candidates_duplicate++;
      continue;
    }

    // Skip obvious web agencies / digital service providers — these are competitors,
    // not prospects. Match on whole words to avoid false positives (e.g. "Design" in
    // a product brand name vs a web-design agency). Case-insensitive.
    const AGENCY_SIGNALS = [
      /\bweb\s*(design|development|developer|solutions)\b/i,
      /\bdigital\s*(agency|marketing|solutions|studio|media)\b/i,
      /\bseo\s*(agency|services|company)\b/i,
      /\bshopify\s*(developer|expert|agency|partner|plus\s*partner)\b/i,
      /\b(ecommerce|e-?commerce)\s*(agency|developer|solutions|consultant)\b/i,
      /\b(marketing|media)\s*(agency|group|firm)\b/i,
      /\b(creative|design|branding)\s*(agency|studio|firm)\b/i,
      /\b(software|tech|it)\s*(solutions|consulting|services|agency)\b/i,
    ];
    const isAgency = AGENCY_SIGNALS.some((re) => re.test(listing.company_name));
    if (isAgency) {
      candidates_duplicate++; // treat as filtered so stats stay accurate
      continue;
    }

    const dup = findDuplicate(
      { name: listing.company_name, domain: normalizedDomain },
      seen,
    );
    if (dup !== -1) {
      candidates_duplicate++;
      continue;
    }

    // Skip prospects with no domain — no URL means no research, no scoring, no pitch.
    if (!normalizedDomain) {
      candidates_duplicate++; // counts as filtered so totals stay accurate
      continue;
    }

    seen.push({ name: listing.company_name, domain: normalizedDomain });
    candidates_new++;

    const flags: string[] = [];
    red_flags += flags.length;

    inserts.push({
      tenant_id: user.tenantId,
      icp_id: icp_id ?? null,
      discovery_run_id: runRow.id,
      discovery_source: source as never, // denue not yet in generated types
      company_name: listing.company_name,
      domain: normalizedDomain,
      website_url: listing.website_url ?? null,
      industry: industry_label ?? keyword, // use clean label; Brave passes keyword separately
      city: listing.city ?? null,
      region: listing.region ?? null,
      country_code: marketToCountry(market),
      market,
      language: market === "MX" ? "es" : "en",
      status: "raw",
      red_flags: flags,
    });
  }

  // ── Bulk insert ─────────────────────────────────────────────────────────
  if (inserts.length > 0) {
    const { error: insertErr } = await supabase.from("prospects").insert(inserts);
    if (insertErr) {
      await failRun(runRow.id, `Insert failed: ${insertErr.message}`);
      return { ok: false, error: `Could not save prospects: ${insertErr.message}` };
    }
  }

  // ── Contact enrichment — Anymail then Hunter (short-circuit) ─────────────
  // Fires for every new prospect with a domain, regardless of score (score
  // doesn't exist yet at crawl time). Anymail is tried first; Hunter only
  // runs if Anymail returns no verified contact — preserves free-tier credits.
  // Runs in parallel across prospects; individual failures are silent (no contact = no crash).
  if (inserts.length > 0) {
    // Fetch the IDs of just-inserted prospects so we can write contacts to them.
    const domains = inserts.map((p) => p.domain).filter(Boolean) as string[];
    const { data: newProspects } = await supabase
      .from("prospects")
      .select("id, domain")
      .eq("tenant_id", user.tenantId)
      .in("domain", domains)
      .returns<{ id: string; domain: string }[]>();

    if (newProspects && newProspects.length > 0) {
      await Promise.allSettled(
        newProspects.map(async (p) => {
          if (!p.domain) return;

          // Anymail first — verified decision-maker, priority_rank=1
          const anymailResult = await anymailFindDecisionMaker(p.domain);
          if (anymailResult.ok) {
            const c = anymailResult.contact;
            await supabase.from("prospect_contacts").insert({
              tenant_id: user.tenantId,
              prospect_id: p.id,
              email: c.email,
              full_name: c.full_name ?? null,
              role_title: c.job_title ?? null,
              linkedin_url: c.linkedin_url ?? null,
              email_is_role_based: false,
              priority_rank: 1,
              selected_by: "anymail",
              selected_at: new Date().toISOString(),
            } as never);
            return; // short-circuit — Anymail found someone, skip Hunter
          }

          // Hunter only if Anymail missed — domain sweep, priority_rank=2/3
          const hunterResult = await hunterDomainSearch(p.domain);
          if (hunterResult.ok && hunterResult.contacts.length > 0) {
            for (const contact of hunterResult.contacts) {
              const rank = contact.confidence >= 70 ? 2 : 3;
              await supabase.from("prospect_contacts").insert({
                tenant_id: user.tenantId,
                prospect_id: p.id,
                email: contact.email,
                full_name:
                  contact.first_name || contact.last_name
                    ? [contact.first_name, contact.last_name].filter(Boolean).join(" ")
                    : null,
                role_title: contact.position ?? null,
                email_is_role_based: false,
                priority_rank: rank,
                selected_by: "hunter",
                selected_at: new Date().toISOString(),
              } as never);
            }
          }
        }),
      );
    }
  }

  // ── Close run ───────────────────────────────────────────────────────────
  await supabase
    .from("discovery_runs")
    .update({
      status: "complete",
      candidates_found: rawListings.listings.length,
      candidates_new,
      candidates_duplicate,
      completed_at: new Date().toISOString(),
    })
    .eq("id", runRow.id);

  await writeAuditLog({
    tenantId: user.tenantId,
    actorId: user.id,
    action: "prospect.scored", // closest existing; future: discovery.run_completed
    entityType: "prospect",
    entityId: runRow.id,
    metadata: {
      kind: "crawl",
      source,
      keyword,
      location: location ?? null,
      market,
      candidates_found: rawListings.listings.length,
      candidates_new,
      candidates_duplicate,
    },
  });

  revalidatePath("/discover");
  revalidatePath("/companies");

  return {
    ok: true,
    run_id: runRow.id,
    source,
    candidates_found: rawListings.listings.length,
    candidates_new,
    candidates_duplicate,
    red_flags,
  };
}

// ── Source dispatcher ─────────────────────────────────────────────────────────

type NormalizedListing = {
  company_name: string;
  website_url: string | null;
  domain: string | null;
  city: string | null;
  region: string | null; // province code for CA, state for US/MX
};

type FetchSourceResult =
  | { ok: true; listings: NormalizedListing[] }
  | { ok: false; error: string };

async function fetchFromSource(opts: {
  source: "yellowpages_ca" | "brave_search" | "denue" | "yelp" | "google_places";
  keyword: string;
  location: string | undefined;
  market: "CA" | "MX" | "US" | "LATAM";
  pages: number;
}): Promise<FetchSourceResult> {
  if (opts.source === "yellowpages_ca") {
    const loc = opts.location ?? "Canada";
    const result = await searchYellowPagesCA({
      keyword: opts.keyword,
      location: loc,
      pages: opts.pages,
    });
    if (!result.ok) return { ok: false, error: result.error };
    return {
      ok: true,
      listings: result.listings.map((l) => ({
        company_name: l.company_name,
        website_url: l.website_url,
        domain: l.domain,
        city: l.city,
        region: l.province_code,
      })),
    };
  }

  if (opts.source === "brave_search") {
    if (!braveIsAvailable()) {
      return {
        ok: false,
        error: "Brave Search not configured — add BRAVE_SEARCH_API_KEY to .env.local",
      };
    }
    const country =
      opts.market === "CA" ? "CA"
      : opts.market === "MX" ? "MX"
      : opts.market === "US" ? "US"
      : "CA";

    const result = await searchBrave({
      query: opts.keyword,
      country,
      count: 20,
    });
    if (!result.ok) return { ok: false, error: result.error };
    return {
      ok: true,
      listings: result.listings.map((l) => ({
        company_name: l.company_name,
        website_url: l.website_url,
        domain: l.domain,
        city: null,
        region: null,
      })),
    };
  }

  if (opts.source === "denue") {
    if (!denueIsAvailable()) {
      return {
        ok: false,
        error: "DENUE not configured — add DENUE_API_KEY to .env.local (register at inegi.org.mx/servicios/api_denue.html)",
      };
    }
    // Convert state name → INEGI numeric code if needed (UI sends full names like "Ciudad de México")
    const rawLocation = opts.location ?? "0";
    const stateCode = /^\d{1,2}$/.test(rawLocation)
      ? rawLocation
      : (MEXICO_STATE_CODES[rawLocation] ?? deriveMexicoStateCode([rawLocation]));
    const result = await searchDenue({
      keyword: opts.keyword,
      stateCode,
      maxResults: 100, // 100 per run is plenty for discovery
    });
    if (!result.ok) return { ok: false, error: result.error };
    return {
      ok: true,
      listings: result.listings.map((l) => ({
        company_name: l.company_name,
        website_url: l.website_url,
        domain: l.domain,
        city: l.city,
        region: l.state_code,
      })),
    };
  }

  if (opts.source === "google_places") {
    if (!googlePlacesIsAvailable()) {
      return {
        ok: false,
        error: "Google Places not configured — add GOOGLE_PLACES_API_KEY to .env.local",
      };
    }
    // Build a natural-language query with location baked in.
    // resolveLocationForGeoApi converts INEGI codes ("09") → "Ciudad de México, Mexico"
    const locationHint = resolveLocationForGeoApi(opts.location, opts.market);

    const result = await searchGooglePlaces({
      query: `${opts.keyword} ${locationHint}`,
      maxResults: 20,
      languageCode: opts.market === "MX" ? "es" : "en",
      locationBias: getGooglePlacesBias(opts.location),
    });
    if (!result.ok) return { ok: false, error: result.error };
    return {
      ok: true,
      listings: result.listings.map((l) => ({
        company_name: l.company_name,
        website_url: l.website_url,
        domain: l.domain,
        city: l.city,
        region: l.state_code,
      })),
    };
  }

  if (opts.source === "yelp") {
    if (!yelpIsAvailable()) {
      return {
        ok: false,
        error: "Yelp not configured — add YELP_API_KEY to .env.local (free at developer.yelp.com)",
      };
    }
    // resolveLocationForGeoApi converts INEGI codes ("09") → "Ciudad de México, Mexico"
    const loc = resolveLocationForGeoApi(opts.location, opts.market);

    const result = await searchYelp({
      keyword: opts.keyword,
      location: loc,
      limit: 50,
    });
    if (!result.ok) return { ok: false, error: result.error };
    return {
      ok: true,
      listings: result.listings.map((l) => ({
        company_name: l.company_name,
        website_url: l.website_url, // null — Yelp search doesn't expose business sites
        domain: l.domain,           // null
        city: l.city,
        region: l.state_code,
      })),
    };
  }

  return { ok: false, error: `Unknown source: ${opts.source}` };
}

// ── Helpers ───────────────────────────────────────────────────────────────────

async function failRun(runId: string, msg: string) {
  const supabase = await createClient();
  await supabase
    .from("discovery_runs")
    .update({
      status: "failed",
      error_message: msg.slice(0, 500),
      completed_at: new Date().toISOString(),
    })
    .eq("id", runId);
}

function marketToCountry(market: "CA" | "MX" | "US" | "LATAM"): string {
  switch (market) {
    case "CA": return "CA";
    case "MX": return "MX";
    case "US": return "US";
    case "LATAM": return "MX";
  }
}

// Converts INEGI numeric state codes (used in the drawer for DENUE) to
// human-readable location names suitable for Yelp / Google Places geocoding.
const INEGI_CODE_TO_LOCATION: Record<string, string> = {
  "0":  "Mexico",
  "01": "Aguascalientes, Mexico",
  "02": "Baja California, Mexico",
  "03": "Baja California Sur, Mexico",
  "04": "Campeche, Mexico",
  "05": "Coahuila, Mexico",
  "06": "Colima, Mexico",
  "07": "Chiapas, Mexico",
  "08": "Chihuahua, Mexico",
  "09": "Ciudad de México, Mexico",
  "10": "Durango, Mexico",
  "11": "Guanajuato, Mexico",
  "12": "Guerrero, Mexico",
  "13": "Hidalgo, Mexico",
  "14": "Jalisco, Mexico",
  "15": "Estado de México, Mexico",
  "16": "Michoacán, Mexico",
  "17": "Morelos, Mexico",
  "18": "Nayarit, Mexico",
  "19": "Nuevo León, Mexico",
  "20": "Oaxaca, Mexico",
  "21": "Puebla, Mexico",
  "22": "Querétaro, Mexico",
  "23": "Quintana Roo, Mexico",
  "24": "San Luis Potosí, Mexico",
  "25": "Sinaloa, Mexico",
  "26": "Sonora, Mexico",
  "27": "Tabasco, Mexico",
  "28": "Tamaulipas, Mexico",
  "29": "Tlaxcala, Mexico",
  "30": "Veracruz, Mexico",
  "31": "Yucatán, Mexico",
  "32": "Zacatecas, Mexico",
};

/** Resolve a location string for Yelp / Google Places.
 *  If it's an INEGI numeric code, convert to a geocodable place name.
 *  Otherwise return as-is (already a province name, city, or country). */
function resolveLocationForGeoApi(location: string | undefined, market: "CA" | "MX" | "US" | "LATAM"): string {
  if (!location) {
    return market === "MX" ? "Mexico" : market === "US" ? "United States" : "Canada";
  }
  // INEGI code: 1–2 digit numeric string (with or without leading zero)
  if (/^\d{1,2}$/.test(location)) {
    const padded = location.padStart(2, "0");
    return INEGI_CODE_TO_LOCATION[padded] ?? INEGI_CODE_TO_LOCATION[location] ?? "Mexico";
  }
  return location;
}

// Geo-center + radius for each Mexican state (INEGI code → lat/lng/radius).
// Used as locationBias for Google Places to keep results inside the selected state.
const MX_STATE_GEO: Record<string, { lat: number; lng: number; radiusMeters: number }> = {
  "09": { lat: 19.4326, lng: -99.1332, radiusMeters: 60_000 },  // CDMX
  "14": { lat: 20.6534, lng: -103.3460, radiusMeters: 120_000 }, // Jalisco
  "19": { lat: 25.6866, lng: -100.3161, radiusMeters: 100_000 }, // Nuevo León
  "15": { lat: 19.2965, lng: -99.6545, radiusMeters: 120_000 }, // Estado de México
  "21": { lat: 19.0413, lng: -98.2062, radiusMeters: 100_000 }, // Puebla
  "22": { lat: 20.5888, lng: -100.3899, radiusMeters: 80_000 }, // Querétaro
  "11": { lat: 21.0190, lng: -101.2574, radiusMeters: 120_000 }, // Guanajuato
  "26": { lat: 29.0730, lng: -110.9559, radiusMeters: 200_000 }, // Sonora
  "28": { lat: 23.7369, lng: -99.1411, radiusMeters: 150_000 }, // Tamaulipas
  "30": { lat: 19.1738, lng: -96.1342, radiusMeters: 200_000 }, // Veracruz
  "31": { lat: 20.9674, lng: -89.6237, radiusMeters: 150_000 }, // Yucatán
  "02": { lat: 32.5027, lng: -117.0037, radiusMeters: 150_000 }, // Baja California
  "25": { lat: 24.8091, lng: -107.3940, radiusMeters: 150_000 }, // Sinaloa
  "08": { lat: 28.6353, lng: -106.0889, radiusMeters: 200_000 }, // Chihuahua
};

/** Returns a locationBias for Google Places if we have geo data for the location code. */
function getGooglePlacesBias(location: string | undefined): { lat: number; lng: number; radiusMeters: number } | undefined {
  if (!location) return undefined;
  const padded = location.padStart(2, "0");
  return MX_STATE_GEO[padded] ?? MX_STATE_GEO[location];
}
