/**
 * Brave Search API — web search for lead discovery.
 *
 * Free tier: 2,000 queries / month.
 * Paid: $3 / 1,000 queries after that.
 * Docs: https://api.search.brave.com/app/documentation/web-search/get-started
 *
 * Strategy: caller passes a natural-language query (e.g.
 * '"pet food" "shopify" canada') and we return normalized listing rows.
 * Activated only when BRAVE_SEARCH_API_KEY is present in the environment.
 */

import { normalizeDomain } from "../fuzzy-dedupe";

// ── Public types ─────────────────────────────────────────────────────────────

export type BraveListing = {
  company_name: string;       // cleaned from page title
  website_url: string;
  domain: string | null;
  description: string | null; // snippet from search result
};

export type BraveSearchInput = {
  query: string;              // full search query string
  country?: "CA" | "MX" | "US";
  count?: number;             // 1–20 per request (Brave max), default 20
};

export type BraveSearchResult =
  | { ok: true; listings: BraveListing[]; total_fetched: number }
  | { ok: false; error: string; code: BraveErrorCode };

export type BraveErrorCode =
  | "no_key"
  | "rate_limit"
  | "auth"
  | "http_error"
  | "network";

const BRAVE_API_URL =
  "https://api.search.brave.com/res/v1/web/search";

// ── Public helpers ────────────────────────────────────────────────────────────

export function braveIsAvailable(): boolean {
  return Boolean(process.env.BRAVE_SEARCH_API_KEY);
}

// ── Entry point ───────────────────────────────────────────────────────────────

export async function searchBrave(
  input: BraveSearchInput,
): Promise<BraveSearchResult> {
  const apiKey = process.env.BRAVE_SEARCH_API_KEY;
  if (!apiKey) {
    return { ok: false, error: "BRAVE_SEARCH_API_KEY not set", code: "no_key" };
  }

  const params = new URLSearchParams({
    q: input.query,
    count: String(Math.min(Math.max(1, input.count ?? 20), 20)),
    country: input.country ?? "CA",
    search_lang: "en",
    result_filter: "web",
    safesearch: "off",
  });

  try {
    const res = await fetch(`${BRAVE_API_URL}?${params.toString()}`, {
      headers: {
        Accept: "application/json",
        "Accept-Encoding": "gzip",
        "X-Subscription-Token": apiKey,
      },
    });

    if (res.status === 429) {
      return {
        ok: false,
        error: "Brave rate limit exceeded — wait before retrying",
        code: "rate_limit",
      };
    }
    if (res.status === 401) {
      return { ok: false, error: "Invalid Brave API key", code: "auth" };
    }
    if (!res.ok) {
      return {
        ok: false,
        error: `Brave API returned HTTP ${res.status}`,
        code: "http_error",
      };
    }

    const data = (await res.json()) as BraveApiResponse;
    const results = data?.web?.results ?? [];

    const listings: BraveListing[] = results
      .map((r) => {
        let domain: string | null = null;
        try {
          domain = normalizeDomain(new URL(r.url).hostname);
        } catch {
          /* ignore */
        }
        return {
          company_name: cleanTitle(r.title ?? "", r.url),
          website_url: r.url,
          domain,
          description: r.description ?? null,
        };
      })
      .filter((l) => isUsableUrl(l.website_url));

    return { ok: true, listings, total_fetched: listings.length };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
      code: "network",
    };
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Strip common suffixes from page titles so "Acme Pet Food | Home – Shopify"
 * becomes "Acme Pet Food".
 */
function cleanTitle(title: string, url: string): string {
  let clean = title
    .replace(/\s*[|·—–-]\s*(Home|Welcome|Shop|Shopify|WooCommerce|Store)[^|]*$/i, "")
    .replace(/\s*[|·—–-]\s*$/, "")
    .trim();

  if (!clean) {
    // Fall back to domain as name
    try {
      clean = new URL(url).hostname.replace(/^www\./, "").split(".")[0] ?? url;
    } catch {
      clean = url;
    }
  }
  return clean.slice(0, 200);
}

/** Filter out results that are clearly not brand websites */
function isUsableUrl(url: string): boolean {
  try {
    const u = new URL(url);
    const blocked = [
      "google.com", "yelp.com", "facebook.com", "instagram.com",
      "linkedin.com", "twitter.com", "youtube.com", "amazon.com",
      "reddit.com", "yellowpages.ca", "yelp.ca", "canada411.ca",
    ];
    return !blocked.some((b) => u.hostname.endsWith(b));
  } catch {
    return false;
  }
}

// ── Brave API response types (partial) ───────────────────────────────────────

type BraveApiResponse = {
  web?: {
    results?: Array<{
      title?: string;
      url: string;
      description?: string;
    }>;
  };
};
