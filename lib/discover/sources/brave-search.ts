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
      // Hard timeout — an unbounded Brave fetch can hang a pipeline slice past
      // the serverless cap. Abort and let the caller fall back.
      signal: AbortSignal.timeout(8_000),
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
 * Returns true if a page title looks like an article/listicle rather than
 * a business homepage — e.g. "Top 10 Shopify Stores in Canada" or
 * "List of Best Pet Food Brands | Blog".
 */
function isArticleTitle(title: string): boolean {
  return /^(top\s+\d+|best\s+\d+|list\s+of|how\s+to|\d+\s+best|\d+\s+top|the\s+best|what\s+is|what\s+are|why\s+|guide\s+to|complete\s+guide|ultimate\s+guide|everything\s+you)/i.test(
    title.trim(),
  );
}

/**
 * Strip common suffixes from page titles so "Acme Pet Food | Home – Shopify"
 * becomes "Acme Pet Food". Falls back to the domain name if the cleaned title
 * still looks like an article or is too long to be a business name.
 */
function cleanTitle(title: string, url: string): string {
  // Remove common page-title suffixes
  let clean = title
    .replace(/\s*[|·—–-]\s*(Home|Welcome|Shop|Shopify|WooCommerce|Store)[^|]*$/i, "")
    .replace(/\s*[|·—–-]\s*(What You Need to Know|Tips?|Guide|Blog|Article)[^|]*$/i, "")
    .replace(/\s*[|·—–-]\s*$/, "")
    .trim();

  // If the result still looks like an article title, is very long (>60 chars),
  // or starts with a common service keyword rather than a proper noun,
  // use the domain as the company name instead.
  const looksLikeService = /^(shopify|woocommerce|wordpress|ecommerce|e-commerce|web\s+design|website\s+design|digital\s+marketing|seo|custom\s+|online\s+store)/i.test(clean);
  if (!clean || isArticleTitle(clean) || clean.length > 60 || looksLikeService) {
    try {
      const hostname = new URL(url).hostname.replace(/^www\./, "");
      // Use just the first label (e.g. "cloudstech" from "cloudstech.ca")
      clean = hostname.split(".")[0] ?? hostname;
      // Capitalise first letter
      clean = clean.charAt(0).toUpperCase() + clean.slice(1);
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
    // Directories, social media, aggregators, dev tools — not prospects
    const blocked = [
      // Social & search
      "google.com", "yelp.com", "yelp.ca", "facebook.com", "instagram.com",
      "linkedin.com", "twitter.com", "x.com", "youtube.com", "tiktok.com",
      // E-commerce giants
      "amazon.com", "amazon.ca", "ebay.com", "etsy.com",
      // Directories / review sites
      "reddit.com", "yellowpages.ca", "canada411.ca", "tripadvisor.com",
      "bbb.org", "trustpilot.com", "g2.com", "capterra.com",
      // E-commerce platform / tooling meta-sites
      "shopify.com", "woocommerce.com", "bigcommerce.com",
      "gempages.net", "pagefly.io", "zipify.com",
      "analyzify.com", "storeleads.app", "aftership.com",
      "sitebuilderreport.com", "omnithemes.com", "myip.ms",
      "builtwith.com", "similarweb.com", "semrush.com", "ahrefs.com",
      // News / content farms
      "entrepreneur.com", "forbes.com", "inc.com", "medium.com",
      "wordpress.com", "substack.com", "hubspot.com",
      "webpronews.com", "techcrunch.com", "mashable.com", "venturebeat.com",
      "businessinsider.com", "globeandmail.com", "theglobeandmail.com",
      "financialpost.com", "nationalpost.com", "cbc.ca", "bbc.com",
      "ctvnews.ca", "thestar.com", "montrealgazette.com", "vancouversun.com",
      // Vendors / e-commerce service providers (not DTC brands)
      "magenest.com", "plytix.com", "tidio.com", "klaviyo.com",
      "yotpo.com", "gorgias.com", "recharge.com", "omnisend.com",
      "acowebs.com", "woocommerce.com",
    ];
    if (blocked.some((b) => u.hostname === b || u.hostname.endsWith(`.${b}`))) {
      return false;
    }
    // Block URL paths that look like blog/article pages (list posts, guides, etc.)
    const path = u.pathname.toLowerCase();
    if (/\/(blog|article|news|resources|guide|post)\//.test(path)) return false;
    return true;
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
