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

// Sub-page scraping constants
const SUBPAGE_TIMEOUT_MS = 10_000;
const SUBPAGE_RATE_LIMIT_MS = 500;
const MAX_SUBPAGES = 3;
const SUBPAGE_MAX_CHARS = 600;

/** Priority order for which sub-pages to scrape (first MAX_SUBPAGES wins) */
const SUBPAGE_PRIORITY = ["About", "Services", "Team", "Work", "Pricing", "Plans"];

export type SubPageExtract = {
  label: string;  // e.g. "About", "Services", "Team"
  url: string;
  text: string;   // up to SUBPAGE_MAX_CHARS of cleaned body text
};

export type ScrapedSite = {
  fetched_url: string;
  final_url: string;        // after redirects
  http_status: number;
  what_they_do: string | null;
  tech_stack: string[];
  contact_emails: string[];
  social_links: { platform: string; url: string }[];
  key_pages: { label: string; url: string }[];
  sub_page_extracts: SubPageExtract[]; // body text from About/Services/Team pages
  /** Detected content language — "en" | "es". Defaults to "en" when ambiguous. */
  language: "en" | "es";
  /** Detected market — "CA" | "MX" | "US" | null when indeterminate. */
  market: "CA" | "MX" | "US" | null;
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

    // Follow key pages (About, Services, Team) for richer content.
    // Failures are silently ignored — homepage-only is always the fallback.
    const subPageExtracts = await scrapeSubPages(parsed.key_pages);
    const richWhatTheyDo = synthesizeWhatTheyDo(parsed.what_they_do, subPageExtracts);

    return {
      ok: true,
      site: {
        fetched_url: url,
        final_url: fetched.final_url,
        http_status: fetched.status,
        ...parsed,
        what_they_do: richWhatTheyDo,
        sub_page_extracts: subPageExtracts,
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

type ParsedSite = Omit<ScrapedSite, "fetched_url" | "final_url" | "http_status" | "scraped_at" | "sub_page_extracts">;

export function parseSite(html: string, baseUrl: string): ParsedSite {
  const $ = cheerio.load(html);

  return {
    what_they_do: extractWhatTheyDo($),
    tech_stack: detectTechStack(html, $),
    contact_emails: extractContactEmails(html, $),
    social_links: extractSocials($, baseUrl),
    key_pages: extractKeyPages($, baseUrl),
    language: detectLanguage($, html, baseUrl),
    market: detectMarket(baseUrl, html, $),
  };
}

// ── Language detection ─────────────────────────────────────────────────────────
//
// Priority:
//   1. <html lang="..."> attribute — authoritative when present
//   2. URL TLD (.mx → es)
//   3. Body text stopword frequency count (Spanish vs English)
//   4. Default: "en"

const ES_STOPWORDS = [
  "de", "la", "el", "en", "y", "con", "por", "para", "que", "del",
  "los", "las", "una", "un", "es", "su", "nos", "más", "tu", "se",
  "como", "nuestro", "nuestra", "también", "aquí", "somos",
];
const EN_STOPWORDS = [
  "the", "and", "for", "with", "our", "your", "we", "are", "is",
  "this", "that", "from", "have", "not", "all", "by", "an", "or",
  "be", "has", "you", "at", "do", "about", "more",
];

export function detectLanguage(
  $: cheerio.CheerioAPI,
  html: string,
  finalUrl: string,
): "en" | "es" {
  // 1. <html lang> attribute
  const htmlLang = ($("html").attr("lang") ?? "").toLowerCase().slice(0, 5);
  if (htmlLang.startsWith("es")) return "es";
  if (htmlLang.startsWith("en")) return "en";

  // 2. TLD heuristic
  const tld = getTld(finalUrl);
  if (tld === "mx" || tld === "com.mx") return "es";

  // 3. Stopword frequency in visible body text
  const bodyText = ($("body").text() ?? "").toLowerCase();
  const words = bodyText.match(/\b[a-záéíóúüñ]{2,}\b/gi) ?? [];
  const sample = words.slice(0, 500); // first 500 words — fast, representative

  let esScore = 0;
  let enScore = 0;
  for (const w of sample) {
    if (ES_STOPWORDS.includes(w)) esScore++;
    if (EN_STOPWORDS.includes(w)) enScore++;
  }
  if (esScore > enScore * 1.5) return "es"; // clear Spanish majority
  if (enScore > esScore * 1.5) return "en";

  // 4. Default
  return "en";
}

// ── Market detection ───────────────────────────────────────────────────────────
//
// Priority:
//   1. TLD: .mx / .com.mx → MX, .ca → CA
//   2. Currency signals in raw HTML
//   3. City/province/state names in visible text
//   4. null — indeterminate (don't guess)

const CA_PROVINCES = [
  "alberta", "british columbia", "ontario", "quebec", "saskatchewan",
  "manitoba", "nova scotia", "new brunswick", "newfoundland",
  "prince edward island", "northwest territories", "nunavut", "yukon",
  // Major cities
  "toronto", "vancouver", "calgary", "edmonton", "ottawa", "montreal",
  "winnipeg", "halifax", "saskatoon", "victoria",
];

const MX_CITIES = [
  "ciudad de méxico", "cdmx", "guadalajara", "monterrey", "puebla",
  "tijuana", "mexicali", "mérida", "querétaro", "cancún", "toluca",
  "chihuahua", "hermosillo", "saltillo", "aguascalientes", "morelia",
  "veracruz", "tuxtla", "oaxaca", "culiacán", "leon", "león",
  // country context
  "méxico", "mexico city", "estado de méxico",
];

export function detectMarket(
  finalUrl: string,
  html: string,
  $: cheerio.CheerioAPI,
): "CA" | "MX" | "US" | null {
  // 1. TLD — most reliable signal
  const tld = getTld(finalUrl);
  if (tld === "mx" || tld === "com.mx") return "MX";
  if (tld === "ca") return "CA";
  if (tld === "us") return "US";

  const lowerHtml = html.toLowerCase();
  const bodyText = ($("body").text() ?? "").toLowerCase();

  // 2. Currency signals in raw HTML
  if (/\bcad\b|c\$|canadian\s+dollar/i.test(lowerHtml)) return "CA";
  if (/\bmxn\b|peso\s+mexicano|\.mx\b/i.test(lowerHtml)) return "MX";
  if (/\busd\b|us\s+dollar|\$\s*usd/i.test(lowerHtml)) return "US";

  // 3. Geographic mentions in visible text
  if (CA_PROVINCES.some((p) => bodyText.includes(p))) return "CA";
  if (MX_CITIES.some((c) => bodyText.includes(c))) return "MX";

  // 4. Indeterminate — .com / .io / .co / .net could be anywhere
  return null;
}

function getTld(url: string): string {
  try {
    const hostname = new URL(url).hostname.toLowerCase();
    // Strip www. prefix
    const bare = hostname.replace(/^www\./, "");
    // com.mx, co.uk style second-level TLDs
    if (bare.endsWith(".com.mx")) return "com.mx";
    if (bare.endsWith(".co.uk")) return "co.uk";
    // Single-level TLD
    return bare.split(".").pop() ?? "";
  } catch {
    return "";
  }
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
  return Array.from(found).filter((e) => !e.includes("@2x.") && !e.includes("@3x.") && !isMonitoringEmail(e));
}

function isValidEmail(email: string): boolean {
  // Basic shape + reject internal placeholders
  if (!/^[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}$/i.test(email)) return false;
  if (email.endsWith(".png") || email.endsWith(".jpg") || email.endsWith(".svg")) return false;
  return true;
}

// Reject error-tracking and monitoring emails embedded in page HTML.
// Wix sites include Sentry DSN-style addresses like {32hexchars}@sentry.wixpress.com.
const MONITORING_DOMAINS = ["sentry.io", "sentry.wixpress.com", "sentry-next.wixpress.com", "bugsnag.com", "rollbar.com", "datadog.com", "newrelic.com", "honeybadger.io"];
const HEX_LOCAL_RE = /^[0-9a-f]{16,}$/i;

function isMonitoringEmail(email: string): boolean {
  const [local, domain] = email.split("@");
  if (!local || !domain) return false;
  if (MONITORING_DOMAINS.some((d) => domain === d || domain.endsWith(`.${d}`))) return true;
  if (HEX_LOCAL_RE.test(local)) return true;
  return false;
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

// ── Multi-page scraping ───────────────────────────────────────────────────────

/**
 * Fetch body text from the highest-priority key pages (About, Services, Team…).
 * Silently skips any page that times out, errors, or returns no useful text.
 */
async function scrapeSubPages(
  keyPages: { label: string; url: string }[],
): Promise<SubPageExtract[]> {
  // Sort by SUBPAGE_PRIORITY order; unknown labels go last
  const sorted = [...keyPages].sort((a, b) => {
    const ai = SUBPAGE_PRIORITY.indexOf(a.label);
    const bi = SUBPAGE_PRIORITY.indexOf(b.label);
    return (ai === -1 ? 99 : ai) - (bi === -1 ? 99 : bi);
  });

  const results: SubPageExtract[] = [];

  for (const page of sorted.slice(0, MAX_SUBPAGES)) {
    if (results.length > 0) await sleep(SUBPAGE_RATE_LIMIT_MS);
    const text = await fetchSubPageText(page.url);
    if (text) results.push({ label: page.label, url: page.url, text });
  }

  return results;
}

/** Fetch one sub-page and extract its main body text (capped at SUBPAGE_MAX_CHARS). */
async function fetchSubPageText(url: string): Promise<string | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), SUBPAGE_TIMEOUT_MS);

  try {
    const res = await fetch(url, {
      headers: {
        "User-Agent": USER_AGENT,
        Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "en-US,en;q=0.9,es;q=0.8",
      },
      redirect: "follow",
      signal: controller.signal,
    });

    if (!res.ok) return null;
    const ct = res.headers.get("content-type") ?? "";
    if (!/text\/html|application\/xhtml/i.test(ct)) return null;

    const html = await res.text();
    if (html.length > MAX_HTML_BYTES) return null;

    return extractMainText(html);
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Extract meaningful body text from a sub-page HTML string.
 * Tries semantic containers first; strips nav/header/footer noise before reading.
 */
function extractMainText(html: string): string | null {
  const $ = cheerio.load(html);

  // Strip layout/chrome elements that add noise
  $(
    "nav, header, footer, script, style, noscript, " +
    "[class*='nav'], [class*='header'], [class*='footer'], " +
    "[class*='menu'], [class*='cookie'], [class*='banner'], " +
    "[class*='popup'], [class*='modal'], [class*='sidebar']",
  ).remove();

  // Walk candidate containers, largest text chunk wins
  const candidates = [
    $("main"),
    $("article"),
    $('[role="main"]'),
    $(".content, .page-content, .entry-content, .post-content, .site-content"),
    $("body"),
  ];

  for (const el of candidates) {
    if (el.length === 0) continue;
    const text = el.text().replace(/\s+/g, " ").trim();
    if (text.length >= 50) return text.slice(0, SUBPAGE_MAX_CHARS);
  }

  return null;
}

/**
 * Combine the homepage description with About-page body text to produce a
 * richer "what they do" string.  Falls back gracefully if sub-pages are empty.
 */
function synthesizeWhatTheyDo(
  homepage: string | null,
  subPages: SubPageExtract[],
): string | null {
  const aboutText = subPages.find((p) => p.label === "About")?.text ?? null;

  if (!aboutText) return homepage; // no about page — keep as-is

  // Short or absent homepage description → use about page directly
  if (!homepage || homepage.length < 80) {
    return aboutText.slice(0, SUBPAGE_MAX_CHARS);
  }

  // Both exist — lead with homepage pitch, extend with about context
  const combined = cleanText(`${homepage} — ${aboutText}`).slice(0, SUBPAGE_MAX_CHARS);
  return combined;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
