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

// yellowpages.ca began returning HTTP 403 to the self-identifying bot UA
// (2026-07-21 — every search 403'd while Google Places kept working). Verified
// against the live site: the bot UA gets 403, a normal browser UA gets 200 with
// the full listing markup intact. Same failure mode as INEGI/DENUE.
//
// The politeness that actually matters is unchanged and enforced below: one
// request at a time, RATE_LIMIT_MS between pages, a hard page cap, and only
// public directory pages are read.
const USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";
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
    if (!res.ok) {
      // 403/429 = bot detection, not a bad query. Say so, or the run history
      // just shows a bare status code and looks like a broken keyword.
      if (res.status === 403 || res.status === 429) {
        return {
          ok: false,
          error:
            `Yellow Pages blocked the request (HTTP ${res.status}) — bot detection, ` +
            `not a bad search. If this persists the scraper's headers need updating.`,
        };
      }
      return { ok: false, error: `HTTP ${res.status} from ${url}` };
    }
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

  // YP uses several container patterns across versions. Current (2026-06) markup
  // wraps each result in `div.listing__content__wrapper` (holds name + the
  // website/phone action menu + address). Older patterns kept as fallbacks so a
  // future template tweak degrades gracefully. NOTE: selectors must not nest
  // (e.g. don't add both a wrapper and its child) or listings get double-counted.
  // `div.listing__content` is intentionally excluded — it is the PARENT of
  // `listing__content__wrapper`, so including both double-counts every listing.
  const containers = $(
    [
      "div.listing__content__wrapper",
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
    "a.listing__name--link",
    ".jsListingName",
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

// Resolve relative YP hrefs (e.g. "/gourl/...") against the site origin so
// `new URL()` can parse them.
const YP_ORIGIN = "https://www.yellowpages.ca";

function extractWebsite($: cheerio.CheerioAPI, el: AnyNode): string | null {
  // Current (2026-06) markup: the website CTA lives in
  //   <li class="mlr__item--website"><a href="/gourl/{hash}?redirect=<encoded>">
  // The real destination is the URL-encoded `redirect` query param. Older
  // templates used `websiteUrl=` / `/goto/` or a bare external link — all
  // handled below so the scraper survives either version.
  const candidate = $(el)
    .find("li.mlr__item--website a[href], a[href*='/gourl/'], a[href]")
    .filter((_, a) => {
      const href = $(a).attr("href") ?? "";
      return (
        href.includes("/gourl/") ||
        href.includes("redirect=") ||
        href.includes("websiteUrl=") ||
        href.includes("/goto/") ||
        (href.startsWith("http") && !href.includes("yellowpages.ca"))
      );
    })
    .first();

  const raw = candidate.attr("href") ?? null;
  if (!raw) return null;

  try {
    // Resolve relative ("/gourl/...") and absolute hrefs alike.
    const u = new URL(raw, YP_ORIGIN);
    // Unwrap YP redirect — `redirect` is the current param, the others legacy.
    const dest =
      u.searchParams.get("redirect") ??
      u.searchParams.get("websiteUrl") ??
      u.searchParams.get("url") ??
      (u.hostname.includes("yellowpages.ca") ? null : raw);
    if (!dest) return null;
    const clean = new URL(dest.startsWith("http") ? dest : `https://${dest}`);
    // Drop YP's own domain — those are profile links, not business sites.
    if (clean.hostname.includes("yellowpages.ca")) return null;
    return `https://${clean.hostname}`;
  } catch {
    return raw.startsWith("http") && !raw.includes("yellowpages.ca") ? raw : null;
  }
}

function extractPhone($: cheerio.CheerioAPI, el: AnyNode): string | null {
  // Current markup exposes the number in a `data-phone` attribute.
  const dataPhone = $(el).find("[data-phone]").first().attr("data-phone");
  if (dataPhone?.trim()) return dataPhone.trim();

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
