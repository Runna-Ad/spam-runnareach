/**
 * Yellow Pages Canada scraper.
 *
 * URL pattern: https://www.yellowpages.ca/search/si/{page}/{keyword}/{location}
 * e.g. https://www.yellowpages.ca/search/si/1/pet+food/Alberta
 *
 * Politeness: 1.5 s between pages, RunnaCABot User-Agent.
 * Resilient selectors: YP's class names are stable but we fall back through
 * several known patterns to survive minor template changes.
 */

import * as cheerio from "cheerio";
import type { AnyNode } from "domhandler";
import { normalizeDomain } from "../fuzzy-dedupe";

const USER_AGENT =
  "Mozilla/5.0 (compatible; RunnaCABot/0.1; +https://runna.agency/bot)";
const FETCH_TIMEOUT_MS = 15_000;
const RATE_LIMIT_MS = 1_500;

// ── Public types ─────────────────────────────────────────────────────────────

export type YPListing = {
  company_name: string;
  website_url: string | null;
  domain: string | null;
  phone: string | null;
  city: string | null;
  province_code: string | null; // "AB", "BC", etc.
};

export type YPSearchInput = {
  keyword: string;   // e.g. "pet food"
  location: string;  // province name ("Alberta") or "Canada"
  pages?: number;    // 1–10, default 3
};

export type YPSearchResult =
  | { ok: true; listings: YPListing[]; pages_fetched: number }
  | { ok: false; error: string };

// ── Province name → code ─────────────────────────────────────────────────────

const PROVINCE_CODE: Record<string, string> = {
  alberta: "AB",
  "british columbia": "BC",
  manitoba: "MB",
  "new brunswick": "NB",
  "newfoundland and labrador": "NL",
  "northwest territories": "NT",
  "nova scotia": "NS",
  nunavut: "NU",
  ontario: "ON",
  "prince edward island": "PE",
  quebec: "QC",
  saskatchewan: "SK",
  yukon: "YT",
};

const TWO_LETTER_PROVINCES = new Set(Object.values(PROVINCE_CODE));

// ── Entry point ───────────────────────────────────────────────────────────────

export async function searchYellowPagesCA(
  input: YPSearchInput,
): Promise<YPSearchResult> {
  const maxPages = Math.min(Math.max(1, input.pages ?? 3), 10);
  const listings: YPListing[] = [];
  let pagesFetched = 0;

  for (let page = 1; page <= maxPages; page++) {
    const url = buildUrl(input.keyword, input.location, page);
    const fetched = await fetchPage(url);

    if (!fetched.ok) {
      if (page === 1) return { ok: false, error: fetched.error };
      break; // partial is fine
    }

    const parsed = parseListings(fetched.html, input.location);
    pagesFetched = page;
    listings.push(...parsed);

    if (parsed.length === 0) break; // no more results
    if (page < maxPages) await sleep(RATE_LIMIT_MS);
  }

  return { ok: true, listings, pages_fetched: pagesFetched };
}

// ── URL builder ───────────────────────────────────────────────────────────────

function buildUrl(keyword: string, location: string, page: number): string {
  const kw = encodeURIComponent(keyword.trim());
  const loc = encodeURIComponent(location.trim());
  return `https://www.yellowpages.ca/search/si/${page}/${kw}/${loc}`;
}

// ── HTTP fetch ────────────────────────────────────────────────────────────────

type FetchOk = { ok: true; html: string };
type FetchErr = { ok: false; error: string };

async function fetchPage(url: string): Promise<FetchOk | FetchErr> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      headers: {
        "User-Agent": USER_AGENT,
        Accept:
          "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "en-CA,en;q=0.9",
      },
      signal: controller.signal,
    });
    if (!res.ok) return { ok: false, error: `HTTP ${res.status} from ${url}` };
    return { ok: true, html: await res.text() };
  } catch (err) {
    if (err instanceof Error && err.name === "AbortError") {
      return { ok: false, error: "Timeout fetching YP page" };
    }
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    };
  } finally {
    clearTimeout(timer);
  }
}

// ── HTML parser ───────────────────────────────────────────────────────────────

function parseListings(html: string, location: string): YPListing[] {
  const $ = cheerio.load(html);
  const out: YPListing[] = [];

  // YP uses several container patterns across versions:
  const containers = $(
    [
      "div.listing__content",
      "div[class*='OrganicListing']",
      "article.listing",
      "div[class*='listing'][data-listing-id]",
    ].join(", "),
  );

  containers.each((_, el) => {
    const name = extractName($, el);
    if (!name) return;

    const website = extractWebsite($, el);
    const domain = website ? normalizeDomain(website) : null;
    const phone = extractPhone($, el);
    const { city, province_code } = extractLocation($, el, location);

    out.push({
      company_name: name,
      website_url: website,
      domain,
      phone,
      city,
      province_code,
    });
  });

  return out;
}

function extractName($: cheerio.CheerioAPI, el: AnyNode): string | null {
  const selectors = [
    "a.listing__name",
    "h3.listing__name",
    "a[class*='businessName']",
    "h2[class*='businessName']",
    "[class*='listing__name']",
    "a[class*='Business'] span",
  ];
  for (const sel of selectors) {
    const text = $(el).find(sel).first().text().trim();
    if (text) return text;
  }
  return null;
}

function extractWebsite($: cheerio.CheerioAPI, el: AnyNode): string | null {
  // YP wraps external links with a redirect URL containing the real dest
  const externalLink = $(el)
    .find("a[href]")
    .filter((_, a) => {
      const href = $(a).attr("href") ?? "";
      return (
        href.includes("websiteUrl=") ||
        href.includes("/goto/") ||
        (href.startsWith("http") && !href.includes("yellowpages.ca"))
      );
    })
    .first();

  const raw = externalLink.attr("href") ?? null;
  if (!raw) return null;

  try {
    const u = new URL(raw);
    // Unwrap YP redirect
    const dest =
      u.searchParams.get("websiteUrl") ??
      u.searchParams.get("url") ??
      (raw.includes("yellowpages.ca") ? null : raw);
    if (!dest) return null;
    const clean = new URL(dest.startsWith("http") ? dest : `https://${dest}`);
    return `https://${clean.hostname}`;
  } catch {
    return raw.startsWith("http") ? raw : null;
  }
}

function extractPhone($: cheerio.CheerioAPI, el: AnyNode): string | null {
  const selectors = [
    "[class*='phone']",
    "[class*='Phone']",
    "span[itemprop='telephone']",
  ];
  for (const sel of selectors) {
    const text = $(el).find(sel).first().text().trim();
    if (text) return text;
  }
  return null;
}

function extractLocation(
  $: cheerio.CheerioAPI,
  el: AnyNode,
  searchLocation: string,
): { city: string | null; province_code: string | null } {
  const addrSelectors = [
    "[class*='address']",
    "[class*='Address']",
    "span[itemprop='addressLocality']",
    "address",
  ];
  let addrText = "";
  for (const sel of addrSelectors) {
    addrText = $(el).find(sel).first().text().trim();
    if (addrText) break;
  }

  // Format: "123 Main St, Calgary, AB T2P 1A1"
  const parts = addrText.split(",").map((s) => s.trim());
  const city = parts.length >= 2 ? (parts[parts.length - 2] ?? null) : null;

  const lastPart = parts[parts.length - 1] ?? "";
  const proMatch = lastPart.match(/\b([A-Z]{2})\b/);
  const province_code =
    proMatch && TWO_LETTER_PROVINCES.has(proMatch[1]!)
      ? proMatch[1]!
      : inferProvinceFromLocation(searchLocation);

  return { city: city || null, province_code };
}

function inferProvinceFromLocation(location: string): string | null {
  const lower = location.toLowerCase().trim();
  // Direct two-letter match
  if (TWO_LETTER_PROVINCES.has(lower.toUpperCase())) {
    return lower.toUpperCase();
  }
  return PROVINCE_CODE[lower] ?? null;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
