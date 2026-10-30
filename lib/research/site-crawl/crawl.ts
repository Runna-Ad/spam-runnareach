/**
 * Crawl one prospect site: the home page, then up to MAX_SUBPAGES same-site
 * pages chosen by link text/path, ONE REQUEST AT A TIME, every fetch inside a
 * per-site budget. Returns the pages tried (with what was readable) and the
 * detector checks. Pure I/O + parsing; no database, no AI.
 */

import { redirectedOffsite } from "../scraper.ts";
import { runDetectors, unseenChecks, type CrawledPage } from "./detectors.ts";
import { fetchPage as defaultFetchPage, type FetchOutcome, type FetchPage } from "./fetch-page.ts";
import { parsePage, readableOf, type ParsedPage } from "./parse.ts";
import { ALLOW_ALL, fetchRobots as defaultFetchRobots, ROBOTS_TIMEOUT_MS, robotsAllows, type FetchRobots } from "./robots.ts";
import { MAX_SUBPAGES, selectPages } from "./select-pages.ts";
import { CRAWLER_VERSION, type ObservationStatus, type PageObservation, type PageReadable, type SiteObservation } from "./types.ts";

/** Whole site, home + sub-pages. Study 2026-10-30: ~3.5 s per site on average. */
export const SITE_BUDGET_MS = 25_000;
/** One page. */
export const PAGE_TIMEOUT_MS = 8_000;
/** A page is not started with less than this left: it would only time out. */
export const MIN_PAGE_MS = 1_500;

export type CrawlOptions = {
  fetchPage?: FetchPage;
  fetchRobots?: FetchRobots;
  siteBudgetMs?: number;
  pageTimeoutMs?: number;
  maxSubpages?: number;
  now?: () => number;
};

const UNREADABLE: PageReadable = { html: false, text: false, links: false };
/** Nothing is hidden on a page that does not exist (404/410): it counts as read. */
const GONE: PageReadable = { html: true, text: true, links: true };

export function normalizeSiteUrl(raw: string): string | null {
  const v = raw.trim();
  if (!v) return null;
  try {
    const u = new URL(/^https?:\/\//i.test(v) ? v : `https://${v}`);
    if (!/^https?:$/.test(u.protocol) || !u.hostname.includes(".")) return null;
    u.hash = "";
    return u.toString();
  } catch {
    return null;
  }
}

function statusOf(f: Extract<FetchOutcome, { ok: false }>): ObservationStatus {
  if (f.error === "blocked") return "blocked";
  if (f.error === "not_html") return "not_html";
  if (f.error === "too_large") return "too_large";
  return "unreachable";
}

/**
 * A same-site link that redirects to another domain ("Book now" → /book →
 * reservations.travelclick.com) is a link to that domain: kept as a one-link
 * page so the detectors see where it goes.
 */
function redirectStub(fromUrl: string, toUrl: string, role: string): ParsedPage {
  return {
    url: fromUrl,
    title: null,
    text: "",
    textChars: 0,
    links: [{ href: toUrl, text: `${role} link (redirects)`, fragment: false }],
    forms: [],
    buttons: [],
    scriptSrcs: [],
    iframeSrcs: [],
    jsonld: [],
    viewport: null,
    htmlLang: null,
    hreflangs: [],
    generator: null,
    html: "",
  };
}

export async function crawlSite(rawUrl: string, opts: CrawlOptions = {}): Promise<SiteObservation> {
  const now = opts.now ?? Date.now;
  const fetchPage = opts.fetchPage ?? defaultFetchPage;
  const pageTimeout = opts.pageTimeoutMs ?? PAGE_TIMEOUT_MS;
  const start = now();
  const deadline = start + (opts.siteBudgetMs ?? SITE_BUDGET_MS);
  const left = () => deadline - now();
  const crawledAt = new Date(start).toISOString();
  const url = normalizeSiteUrl(rawUrl) ?? rawUrl;

  const done = (status: ObservationStatus, finalUrl: string | null, pages: PageObservation[], crawled: CrawledPage[]): SiteObservation => {
    const readable: PageReadable =
      status === "ok" && pages.length > 0
        ? {
            html: pages.every((p) => p.readable.html),
            text: pages.every((p) => p.readable.text),
            links: pages.every((p) => p.readable.links),
          }
        : UNREADABLE;
    return {
      url,
      final_url: finalUrl,
      crawled_at: crawledAt,
      crawler_version: CRAWLER_VERSION,
      status,
      readable,
      pages,
      checks: status === "ok" ? runDetectors(crawled, finalUrl ?? url) : unseenChecks(),
      duration_ms: Math.max(0, now() - start),
    };
  };

  if (!normalizeSiteUrl(rawUrl)) {
    return done("unreachable", null, [{ url, role: "home", http_status: null, title: null, text_chars: 0, links_seen: 0, readable: UNREADABLE, error: "invalid url" }], []);
  }

  // robots.txt first: a site that asks crawlers to stay out is "blocked", never read.
  const robots = await (opts.fetchRobots ?? defaultFetchRobots)(new URL(url).origin, Math.min(ROBOTS_TIMEOUT_MS, left())).catch(() => ALLOW_ALL);
  if (!robotsAllows(robots, url)) {
    return done("blocked", null, [{ url, role: "home", http_status: null, title: null, text_chars: 0, links_seen: 0, readable: UNREADABLE, error: "robots.txt disallows it" }], []);
  }

  const home = await fetchPage(url, Math.min(pageTimeout, left()));
  if (!home.ok) {
    const page: PageObservation = { url, role: "home", http_status: home.status, title: null, text_chars: 0, links_seen: 0, readable: UNREADABLE, error: `${home.error}: ${home.detail}` };
    return done(statusOf(home), home.finalUrl, [page], []);
  }
  // Redirected to another company's site (acquisitions do this): never describe it as theirs.
  if (redirectedOffsite(url, home.finalUrl)) {
    const page: PageObservation = { url, role: "home", http_status: home.status, title: null, text_chars: 0, links_seen: 0, readable: UNREADABLE, error: `redirected to ${home.finalUrl}` };
    return done("offsite", home.finalUrl, [page], []);
  }

  const homeParsed = parsePage(home.html, home.finalUrl);
  const pages: PageObservation[] = [];
  const crawled: CrawledPage[] = [];
  const record = (p: ParsedPage | null, role: string, httpStatus: number | null, readable: PageReadable, error?: string, url_ = p?.url ?? "") => {
    pages.push({
      url: url_,
      role,
      http_status: httpStatus,
      title: p?.title ?? null,
      text_chars: p?.textChars ?? 0,
      links_seen: p ? p.links.length : 0,
      readable,
      ...(error ? { error } : {}),
    });
    crawled.push({ url: url_, readable, parsed: p });
  };
  record(homeParsed, "home", home.status, readableOf(homeParsed));

  for (const sub of selectPages(homeParsed.links, home.finalUrl, opts.maxSubpages ?? MAX_SUBPAGES, (u) => robotsAllows(robots, u))) {
    if (left() < MIN_PAGE_MS) {
      record(null, sub.role, null, UNREADABLE, "site budget spent", sub.url);
      continue;
    }
    const res = await fetchPage(sub.url, Math.min(pageTimeout, left()));
    if (res.ok) {
      if (redirectedOffsite(home.finalUrl, res.finalUrl)) {
        record(redirectStub(sub.url, res.finalUrl, sub.role), sub.role, res.status, GONE);
        continue;
      }
      const parsed = parsePage(res.html, res.finalUrl);
      record(parsed, sub.role, res.status, readableOf(parsed));
    } else if (res.finalUrl && redirectedOffsite(home.finalUrl, res.finalUrl)) {
      // Left the site (to an engine that answered 403 to us, say): where it goes is still the fact.
      record(redirectStub(sub.url, res.finalUrl, sub.role), sub.role, res.status, GONE);
    } else if (res.error === "http" && (res.status === 404 || res.status === 410)) {
      record(null, sub.role, res.status, GONE, `${res.error}: ${res.detail}`, sub.url);
    } else {
      record(null, sub.role, res.status, UNREADABLE, `${res.error}: ${res.detail}`, sub.url);
    }
  }
  return done("ok", home.finalUrl, pages, crawled);
}
