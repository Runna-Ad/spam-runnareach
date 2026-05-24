/**
 * Google Places API (New) — Text Search
 *
 * Uses the new Places API v1 text search endpoint, which returns richer
 * business data than the legacy Nearby Search including websiteUri directly.
 *
 * Free tier: $200 Google Cloud credit/month (~7,000 text-search calls free).
 * Billing kicks in after that at ~$0.032 per call.
 *
 * Docs: https://developers.google.com/maps/documentation/places/web-service/text-search
 * Console: https://console.cloud.google.com/apis/library/places-backend.googleapis.com
 *
 * Env var: GOOGLE_PLACES_API_KEY
 *
 * Key advantage over Yelp: returns websiteUri directly — no Brave enrichment needed.
 * Returns up to 20 results per call; supports pagination via nextPageToken.
 */

import { normalizeDomain } from "../fuzzy-dedupe";

const BASE_URL = "https://places.googleapis.com/v1/places:searchText";
const FETCH_TIMEOUT_MS = 20_000;

// Fields to request — only what we need (billing is per-field in Places API)
const FIELD_MASK = [
  "places.displayName",
  "places.websiteUri",
  "places.formattedAddress",
  "places.nationalPhoneNumber",
  "places.types",
  "places.addressComponents",
  "places.businessStatus",
].join(",");

// ── Public types ───────────────────────────────────────────────────────────────

export type GooglePlacesListing = {
  company_name: string;
  website_url: string | null;
  domain: string | null;
  phone: string | null;
  city: string | null;
  state_code: string | null;
  country_code: string | null;
  place_types: string[]; // e.g. ["clothing_store", "store"]
  formatted_address: string | null;
};

export type GooglePlacesInput = {
  /** Natural language search query e.g. "pet food store Alberta Canada" */
  query: string;
  /** Max results. Google caps each call at 20. Default 20. */
  maxResults?: number;
  /** BCP-47 language code for results. Defaults to "en". */
  languageCode?: string;
  /**
   * Optional circle bias — lat/lng center + radius in meters.
   * When provided, results are biased toward this area.
   * Use locationRestriction for hard geo-bounding.
   */
  locationBias?: { lat: number; lng: number; radiusMeters: number };
};

export type GooglePlacesResult =
  | { ok: true; listings: GooglePlacesListing[]; total_returned: number }
  | { ok: false; error: string };

// ── Availability check ─────────────────────────────────────────────────────────

export function googlePlacesIsAvailable(): boolean {
  return !!process.env.GOOGLE_PLACES_API_KEY;
}

// ── Entry point ───────────────────────────────────────────────────────────────

export async function searchGooglePlaces(
  input: GooglePlacesInput,
): Promise<GooglePlacesResult> {
  const apiKey = process.env.GOOGLE_PLACES_API_KEY;
  if (!apiKey) {
    return {
      ok: false,
      error: "GOOGLE_PLACES_API_KEY not set — enable Places API in Google Cloud Console",
    };
  }

  const pageSize = Math.min(input.maxResults ?? 20, 20);
  const languageCode = input.languageCode ?? "en";

  const body: Record<string, unknown> = {
    textQuery: input.query,
    pageSize,
    languageCode,
  };

  if (input.locationBias) {
    body.locationBias = {
      circle: {
        center: { latitude: input.locationBias.lat, longitude: input.locationBias.lng },
        radius: input.locationBias.radiusMeters,
      },
    };
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

  try {
    const res = await fetch(BASE_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Goog-Api-Key": apiKey,
        "X-Goog-FieldMask": FIELD_MASK,
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });

    if (!res.ok) {
      const errBody = await res.text().catch(() => "");
      let hint = "";
      if (res.status === 403) hint = " — check Places API is enabled and key has correct permissions";
      if (res.status === 400) hint = " — check query format";
      return {
        ok: false,
        error: `Google Places API returned HTTP ${res.status}${hint}: ${errBody.slice(0, 200)}`,
      };
    }

    const data = (await res.json()) as GooglePlacesResponse;

    if (!data.places || data.places.length === 0) {
      return { ok: true, listings: [], total_returned: 0 };
    }

    // Domains we'd never pitch — SaaS platforms, directories
    const GP_BLOCKED = new Set([
      "shopify.com", "woocommerce.com", "bigcommerce.com", "squarespace.com",
      "wix.com", "weebly.com", "wordpress.com", "google.com",
      "facebook.com", "instagram.com", "linkedin.com",
      "amazon.com", "amazon.ca", "etsy.com", "ebay.com",
      "yelp.com", "yelp.ca", "yellowpages.ca",
    ]);

    const listings: GooglePlacesListing[] = data.places
      .filter((p) => p.businessStatus !== "CLOSED_PERMANENTLY")
      .filter((p) => {
        if (!p.websiteUri) return true; // no site — filter handled downstream
        try {
          const host = new URL(p.websiteUri).hostname.replace(/^www\./, "");
          return !GP_BLOCKED.has(host);
        } catch { return true; }
      })
      .map((place) => {
        const website_url = place.websiteUri
          ? normalizeWebsite(place.websiteUri)
          : null;
        const domain = website_url ? normalizeDomain(website_url) : null;

        // Extract city, state, country from addressComponents
        let city: string | null = null;
        let state_code: string | null = null;
        let country_code: string | null = null;

        for (const comp of place.addressComponents ?? []) {
          const t = comp.types ?? [];
          if (t.includes("locality")) city = comp.longText;
          if (t.includes("sublocality_level_1") && !city) city = comp.longText;
          if (t.includes("administrative_area_level_1")) state_code = comp.shortText;
          if (t.includes("country")) country_code = comp.shortText;
        }

        return {
          company_name: place.displayName?.text ?? "",
          website_url,
          domain,
          phone: place.nationalPhoneNumber ?? null,
          city,
          state_code,
          country_code,
          place_types: place.types ?? [],
          formatted_address: place.formattedAddress ?? null,
        };
      })
      .filter((l) => l.company_name.length > 1);

    return { ok: true, listings, total_returned: listings.length };
  } catch (err) {
    if (err instanceof Error && err.name === "AbortError") {
      return { ok: false, error: "Google Places request timed out (20 s)" };
    }
    return {
      ok: false,
      error: `Google Places error: ${err instanceof Error ? err.message : String(err)}`,
    };
  } finally {
    clearTimeout(timer);
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function normalizeWebsite(raw: string): string | null {
  if (!raw) return null;
  try {
    const u = new URL(raw.startsWith("http") ? raw : `https://${raw}`);
    return `https://${u.hostname}`;
  } catch {
    return null;
  }
}

// ── Internal Google Places API response shape ─────────────────────────────────

type GooglePlacesResponse = {
  places?: GooglePlace[];
  nextPageToken?: string;
};

type GooglePlace = {
  name: string; // resource name: "places/ChIJ..."
  displayName?: { text: string; languageCode: string };
  websiteUri?: string;
  formattedAddress?: string;
  nationalPhoneNumber?: string;
  types?: string[];
  businessStatus?: string; // "OPERATIONAL" | "CLOSED_TEMPORARILY" | "CLOSED_PERMANENTLY"
  addressComponents?: Array<{
    longText: string;
    shortText: string;
    types: string[];
    languageCode?: string;
  }>;
};
