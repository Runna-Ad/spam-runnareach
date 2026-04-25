import * as cheerio from "cheerio";

/**
 * Politeness: identify ourselves so site owners can opt out, and provide a
 * URL where they can read about the bot. The +URL convention is standard
 * for crawler User-Agents.
 */
const USER_AGENT =
  "Mozilla/5.0 (compatible; RunnaCABot/0.1; +https://runna.agency/bot)";

const FETCH_TIMEOUT_MS = 15_000;
const MAX_HTML_BYTES = 2_000_000; // 2 MB hard cap

export type ScrapedSite = {
  fetched_url: string;
  final_url: string;        // after redirects
  http_status: number;
  what_they_do: string | null;
  tech_stack: string[];
  contact_emails: string[];
  social_links: { platform: string; url: string }[];
  key_pages: { label: string; url: string }[];
  scraped_at: string;       // ISO
};

export type ScrapeError =
  | { kind: "timeout" }
  | { kind: "network"; detail: string }
  | { kind: "http"; status: number; final_url: string }
  | { kind: "too_large"; bytes: number }
  | { kind: "not_html"; content_type: string }
  | { kind: "parse"; detail: string };

export type ScrapeResult =
  | { ok: true; site: ScrapedSite }
  | { ok: false; error: ScrapeError };

/**
 * Top-level scrape: fetch homepage, parse, return structured facts.
 *
 * Domain-only inputs (`example.com`) are normalized to `https://example.com`.
 */
export async function scrapeSite(rawUrl: string): Promise<ScrapeResult> {
  const url = normalizeUrl(rawUrl);
  if (!url) {
    return { ok: false, error: { kind: "network", detail: "Invalid URL" } };
  }

  const fetched = await fetchHtml(url);
  if (!fetched.ok) return { ok: false, error: fetched.error };

  try {
    const parsed = parseSite(fetched.html, fetched.final_url);
    return {
      ok: true,
      site: {
        fetched_url: url,
        final_url: fetched.final_url,
        http_status: fetched.status,
        ...parsed,
        scraped_at: new Date().toISOString(),
      },
    };
  } catch (err) {
    return {
      ok: false,
      error: {
        kind: "parse",
        detail: err instanceof Error ? err.message : String(err),
      },
    };
  }
}

function normalizeUrl(raw: string): string | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  try {
    if (/^https?:\/\//i.test(trimmed)) {
      return new URL(trimmed).toString();
    }
    return new URL(`https://${trimmed}`).toString();
  } catch {
    return null;
  }
}

type FetchResult =
  | { ok: true; html: string; final_url: string; status: number }
  | { ok: false; error: ScrapeError };

async function fetchHtml(url: string): Promise<FetchResult> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

  try {
    const response = await fetch(url, {
      method: "GET",
      headers: {
        "User-Agent": USER_AGENT,
        Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "en-US,en;q=0.9,es;q=0.8",
      },
      redirect: "follow",
      signal: controller.signal,
    });

    if (!response.ok) {
      return {
        ok: false,
        error: { kind: "http", status: response.status, final_url: response.url },
      };
    }

    const contentType = response.headers.get("content-type") ?? "";
    if (!/text\/html|application\/xhtml/i.test(contentType)) {
      return { ok: false, error: { kind: "not_html", content_type: contentType } };
    }

    // Stream-then-cap to avoid pulling massive HTML files into memory.
    const text = await response.text();
    if (text.length > MAX_HTML_BYTES) {
      return { ok: false, error: { kind: "too_large", bytes: text.length } };
    }

    return {
      ok: true,
      html: text,
      final_url: response.url,
      status: response.status,
    };
  } catch (err) {
    if (err instanceof Error && err.name === "AbortError") {
      return { ok: false, error: { kind: "timeout" } };
    }
    return {
      ok: false,
      error: {
        kind: "network",
        detail: err instanceof Error ? err.message : String(err),
      },
    };
  } finally {
    clearTimeout(timer);
  }
}

type ParsedSite = Omit<ScrapedSite, "fetched_url" | "final_url" | "http_status" | "scraped_at">;

export function parseSite(html: string, baseUrl: string): ParsedSite {
  const $ = cheerio.load(html);

  return {
    what_they_do: extractWhatTheyDo($),
    tech_stack: detectTechStack(html, $),
    contact_emails: extractContactEmails(html, $),
    social_links: extractSocials($, baseUrl),
    key_pages: extractKeyPages($, baseUrl),
  };
}

function extractWhatTheyDo($: cheerio.CheerioAPI): string | null {
  // Priority order:
  //   1. og:description (curated by the site owner — usually a good elevator pitch)
  //   2. <meta name="description"> (SEO standard)
  //   3. First H1 + first paragraph in <main> or <body> (last resort)
  const og = $('meta[property="og:description"]').attr("content");
  if (og && og.trim().length >= 30) return cleanText(og);

  const description = $('meta[name="description"]').attr("content");
  if (description && description.trim().length >= 30) return cleanText(description);

  const h1 = $("h1").first().text().trim();
  const p = $("main p, body > p").first().text().trim();
  if (h1 && p) return cleanText(`${h1}. ${p}`).slice(0, 600);
  if (h1) return cleanText(h1);

  return null;
}

function cleanText(s: string): string {
  return s.replace(/\s+/g, " ").trim();
}

/**
 * Tech-stack fingerprints. Each entry checks the raw HTML for a known
 * substring or attribute. Order doesn't matter — duplicates are filtered.
 */
/**
 * Each fingerprint must be specific enough that a marketing page MENTIONING
 * the platform doesn't trigger it. We bias toward asset URLs (script srcs,
 * CDN hostnames), generator meta tags, and JS globals — the things that only
 * exist when the platform is actually serving the page.
 */
const TECH_FINGERPRINTS: Array<{
  name: string;
  test: (html: string, $: cheerio.CheerioAPI) => boolean;
}> = [
  {
    name: "Shopify",
    test: (h, $) =>
      /cdn\.shopify\.com|\.myshopify\.com|Shopify\.theme\s*=/i.test(h) ||
      /shopify/i.test($('meta[name="generator"]').attr("content") ?? ""),
  },
  {
    name: "WooCommerce",
    // Must be loading WooCommerce's own assets (not just mentioning it)
    test: (h) => /wp-content\/plugins\/woocommerce|woocommerce\/assets/i.test(h),
  },
  {
    name: "WordPress",
    test: (h, $) =>
      /wordpress/i.test($('meta[name="generator"]').attr("content") ?? "") ||
      /\/wp-content\/themes\/|\/wp-includes\/js\//i.test(h),
  },
  {
    name: "Webflow",
    test: (h, $) =>
      /assets-global\.website-files\.com|d3e54v103j8qbb\.cloudfront\.net/i.test(h) ||
      $("html[data-wf-page]").length > 0 ||
      /webflow/i.test($('meta[name="generator"]').attr("content") ?? ""),
  },
  {
    name: "Squarespace",
    test: (h) => /static1?\.squarespace\.com|Static\.SQUARESPACE_CONTEXT/i.test(h),
  },
  {
    name: "Wix",
    test: (h) => /static\.parastorage\.com|_wixCIDX/i.test(h),
  },
  {
    name: "Framer",
    test: (h) => /framerusercontent\.com|framer-app\./i.test(h),
  },
  {
    name: "Klaviyo",
    test: (h) =>
      /static-forms\.klaviyo\.com|static\.klaviyo\.com|_learnq|a\.klaviyo\.com/i.test(h),
  },
  { name: "Mailchimp", test: (h) => /chimpstatic\.com|mailchimp\.com\/mc\/embed/i.test(h) },
  {
    name: "HubSpot",
    test: (h) => /js\.hsforms\.net|js\.hs-scripts\.com|js\.hubspot\.com|_hsq\b/i.test(h),
  },
  { name: "Recharge", test: (h) => /rechargeapps\.com|cdn\.rechargeapps/i.test(h) },
  { name: "Gorgias", test: (h) => /gorgias\.chat|gorgias-cdn\.com/i.test(h) },
  { name: "Intercom", test: (h) => /widget\.intercom\.io|intercomcdn\.com/i.test(h) },
  { name: "Stripe", test: (h) => /js\.stripe\.com\/v\d/i.test(h) },
  {
    name: "Google Analytics",
    test: (h) => /www\.google-analytics\.com\/analytics\.js|gtag\s*\(\s*['"]config['"]/i.test(h),
  },
  { name: "Meta Pixel", test: (h) => /connect\.facebook\.net.*fbevents\.js/i.test(h) },
  { name: "Google Tag Manager", test: (h) => /googletagmanager\.com\/gtm\.js/i.test(h) },
  {
    name: "Next.js",
    test: (h, $) => $('script[id="__NEXT_DATA__"]').length > 0 || /\/_next\/static\//.test(h),
  },
];

export function detectTechStack(html: string, $: cheerio.CheerioAPI): string[] {
  const out = new Set<string>();
  for (const fp of TECH_FINGERPRINTS) {
    try {
      if (fp.test(html, $)) out.add(fp.name);
    } catch {
      /* ignore individual fingerprint failures */
    }
  }
  return Array.from(out).sort();
}

const EMAIL_REGEX = /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g;

function extractContactEmails(html: string, $: cheerio.CheerioAPI): string[] {
  const found = new Set<string>();

  // mailto: links
  $('a[href^="mailto:"]').each((_, el) => {
    const href = $(el).attr("href") ?? "";
    const email = href.replace(/^mailto:/i, "").split("?")[0]?.trim().toLowerCase();
    if (email && isValidEmail(email)) found.add(email);
  });

  // Plaintext scan — but only on visible text (script/style noise is a lot)
  const visibleText = $("body").text();
  const matches = visibleText.match(EMAIL_REGEX) ?? [];
  for (const raw of matches) {
    const email = raw.toLowerCase();
    if (isValidEmail(email)) found.add(email);
  }

  // Strip obvious junk (image hashes that happen to look like emails — rare,
  // but kept simple).
  return Array.from(found).filter((e) => !e.includes("@2x.") && !e.includes("@3x."));
}

function isValidEmail(email: string): boolean {
  // Basic shape + reject internal placeholders
  if (!/^[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}$/i.test(email)) return false;
  if (email.endsWith(".png") || email.endsWith(".jpg") || email.endsWith(".svg")) return false;
  return true;
}

const SOCIAL_HOSTS: Array<{ platform: string; pattern: RegExp }> = [
  { platform: "LinkedIn", pattern: /(?:^|\.)linkedin\.com$/i },
  { platform: "Instagram", pattern: /(?:^|\.)instagram\.com$/i },
  { platform: "Twitter", pattern: /(?:^|\.)(?:twitter|x)\.com$/i },
  { platform: "Facebook", pattern: /(?:^|\.)facebook\.com$/i },
  { platform: "TikTok", pattern: /(?:^|\.)tiktok\.com$/i },
  { platform: "YouTube", pattern: /(?:^|\.)youtube\.com$/i },
  { platform: "GitHub", pattern: /(?:^|\.)github\.com$/i },
];

function extractSocials($: cheerio.CheerioAPI, baseUrl: string): { platform: string; url: string }[] {
  const seen = new Map<string, string>();
  $("a[href]").each((_, el) => {
    const raw = $(el).attr("href");
    if (!raw) return;
    let abs: URL;
    try {
      abs = new URL(raw, baseUrl);
    } catch {
      return;
    }
    if (abs.protocol !== "https:" && abs.protocol !== "http:") return;
    for (const { platform, pattern } of SOCIAL_HOSTS) {
      if (pattern.test(abs.hostname)) {
        if (!seen.has(platform)) seen.set(platform, abs.toString());
        break;
      }
    }
  });
  return Array.from(seen.entries()).map(([platform, url]) => ({ platform, url }));
}

const KEY_PAGE_PATHS: Array<{ label: string; pattern: RegExp }> = [
  { label: "About", pattern: /\/about(\/|$|\?)/i },
  { label: "Services", pattern: /\/services?(\/|$|\?)/i },
  { label: "Pricing", pattern: /\/pricing(\/|$|\?)/i },
  { label: "Plans", pattern: /\/plans?(\/|$|\?)/i },
  { label: "Case studies", pattern: /\/case-?studies?(\/|$|\?)/i },
  { label: "Work", pattern: /\/work(\/|$|\?)/i },
  { label: "Contact", pattern: /\/contact(\/|$|\?)/i },
  { label: "Team", pattern: /\/(team|people|founders?)(\/|$|\?)/i },
  { label: "Careers", pattern: /\/careers?(\/|$|\?)/i },
];

function extractKeyPages(
  $: cheerio.CheerioAPI,
  baseUrl: string,
): { label: string; url: string }[] {
  const seen = new Map<string, string>();
  const baseHost = (() => {
    try {
      return new URL(baseUrl).hostname;
    } catch {
      return null;
    }
  })();

  $("a[href]").each((_, el) => {
    const raw = $(el).attr("href");
    if (!raw) return;
    let abs: URL;
    try {
      abs = new URL(raw, baseUrl);
    } catch {
      return;
    }
    if (abs.protocol !== "https:" && abs.protocol !== "http:") return;
    if (baseHost && abs.hostname !== baseHost) return; // internal only
    for (const { label, pattern } of KEY_PAGE_PATHS) {
      if (pattern.test(abs.pathname)) {
        if (!seen.has(label)) seen.set(label, abs.toString());
        break;
      }
    }
  });

  return Array.from(seen.entries()).map(([label, url]) => ({ label, url }));
}
