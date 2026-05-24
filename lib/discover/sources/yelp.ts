/**
 * Yelp Fusion API — Business Search
 *
 * Covers Canada, United States, and Mexico.
 * 500 free requests/day per API key.
 * Register at: https://developer.yelp.com
 *
 * Env var: YELP_API_KEY (Bearer token, no "Bearer " prefix needed)
 *
 * Endpoint: GET https://api.yelp.com/v3/businesses/search
 *
 * Note: The Yelp Search API does NOT return business website URLs —
 * only the Yelp listing URL. Prospects discovered via Yelp will have
 * domain=null and enter the website-pitch pipeline lane (or suppressed
 * if no ICP is assigned). This makes Yelp an intentional "website lead"
 * source — great for pitching web design to businesses with no site.
 */

const BASE_URL = "https://api.yelp.com/v3/businesses/search";
const FETCH_TIMEOUT_MS = 15_000;

// ── Public types ───────────────────────────────────────────────────────────────

export type YelpListing = {
  company_name: string;
  website_url: string | null; // always null from search API
  domain: string | null;      // always null from search API
  phone: string | null;
  city: string | null;
  state_code: string | null;
  country_code: string | null;
  categories: string[];       // e.g. ["Restaurants", "Italian"]
  rating: number | null;
  yelp_url: string | null;    // the Yelp listing page (not the business site)
};

export type YelpSearchInput = {
  /** Search term — business type, category, or brand keyword */
  keyword: string;
  /**
   * Location string — Yelp geocodes this.
   * Examples: "Alberta, Canada", "Ciudad de México", "Toronto, ON", "Canada"
   */
  location: string;
  /** Max results per call. Yelp caps at 50. Default 50. */
  limit?: number;
};

export type YelpSearchResult =
  | { ok: true; listings: YelpListing[]; total_available: number }
  | { ok: false; error: string };

// ── Availability check ─────────────────────────────────────────────────────────

export function yelpIsAvailable(): boolean {
  return !!process.env.YELP_API_KEY;
}

// ── Entry point ───────────────────────────────────────────────────────────────

export async function searchYelp(input: YelpSearchInput): Promise<YelpSearchResult> {
  const apiKey = process.env.YELP_API_KEY;
  if (!apiKey) {
    return {
      ok: false,
      error: "YELP_API_KEY not set — get a free key at developer.yelp.com (500 free calls/day)",
    };
  }

  const limit = Math.min(input.limit ?? 50, 50);

  const params = new URLSearchParams({
    term: input.keyword,
    location: input.location,
    limit: String(limit),
    sort_by: "review_count", // most-reviewed = most established businesses
  });

  const url = `${BASE_URL}?${params.toString()}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

  try {
    const res = await fetch(url, {
      headers: {
        Authorization: `Bearer ${apiKey}`,
        Accept: "application/json",
        "User-Agent": "Mozilla/5.0 (compatible; RunnaBot/0.1; +https://runna.agency/bot)",
      },
      signal: controller.signal,
    });

    if (!res.ok) {
      const body = await res.text().catch(() => "");
      const detail = body ? `: ${body.slice(0, 200)}` : "";
      return { ok: false, error: `Yelp API returned HTTP ${res.status}${detail}` };
    }

    const data = (await res.json()) as {
      businesses?: YelpBusiness[];
      total?: number;
      error?: { code: string; description: string };
    };

    if (data.error) {
      return { ok: false, error: `Yelp API error ${data.error.code}: ${data.error.description}` };
    }

    const listings: YelpListing[] = (data.businesses ?? []).map((b) => ({
      company_name: b.name,
      website_url: null, // not available in search endpoint
      domain: null,
      phone: b.phone ? b.phone.trim() : null,
      city: b.location?.city || null,
      state_code: b.location?.state || null,
      country_code: b.location?.country || null,
      categories: (b.categories ?? []).map((c) => c.title),
      rating: typeof b.rating === "number" ? b.rating : null,
      yelp_url: b.url || null,
    }));

    return {
      ok: true,
      listings,
      total_available: data.total ?? listings.length,
    };
  } catch (err) {
    if (err instanceof Error && err.name === "AbortError") {
      return { ok: false, error: "Yelp request timed out (15 s)" };
    }
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  } finally {
    clearTimeout(timer);
  }
}

// ── Internal Yelp API response shape ─────────────────────────────────────────

type YelpBusiness = {
  id: string;
  name: string;
  url: string;
  phone: string;
  location: {
    address1: string;
    city: string;
    state: string;
    zip_code: string;
    country: string;
  };
  categories: Array<{ alias: string; title: string }>;
  rating: number;
  review_count: number;
  is_closed: boolean;
};
