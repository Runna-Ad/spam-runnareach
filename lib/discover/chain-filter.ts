// National-chain / enterprise filter for discovery.
//
// Directory sources answer a keyword, not an ICP. A "wholesale / Alberta"
// search on Yellow Pages returns Walmart, Shoppers Drug Mart, Loblaw and Rexall
// — perfectly real businesses, and completely wrong for an SMB/mid-market ICP.
// Left in, each one is scraped, deep-researched, scored and THEN suppressed, so
// the cost is paid before the rejection.
//
// Killing them at insert is the cheapest possible point.
//
// PURE + conservative by design. A false positive silently deletes a real
// prospect, so matching is on distinctive brand names with word boundaries —
// never bare common words ("Shell", "Bay", "Source") that appear inside
// legitimate local business names.

/**
 * Distinctive national/enterprise brand names (CA + MX). Matched as whole
 * words, case- and accent-insensitively, against the company name.
 *
 * Deliberately excludes ambiguous single words. "Shell" would match "Shell
 * Beach Boutique"; "Bay" would match "Bay Street Dental". Where a brand's name
 * is a common word, it is listed only in a multi-word form.
 */
const CHAIN_BRANDS: string[] = [
  // Canada — big box / grocery / pharmacy
  "walmart", "wal-mart", "costco", "loblaw", "loblaws", "superstore",
  "no frills", "shoppers drug mart", "rexall", "pharmasave", "sobeys",
  "safeway", "save-on-foods", "london drugs", "dollarama", "canadian tire",
  "home depot", "lowes", "rona", "home hardware", "princess auto",
  "best buy", "staples", "winners", "marshalls", "hudsons bay",
  "hudson's bay", "sport chek", "sportchek", "atmosphere", "marks work",
  "indigo books", "chapters indigo", "giant tiger", "real canadian",
  // Canada — fuel / convenience
  "petro-canada", "petro canada", "esso", "husky energy", "7-eleven",
  "seven eleven", "circle k", "mac's convenience",
  // Canada — food service
  "tim hortons", "mcdonald", "starbucks", "subway restaurant", "burger king",
  "wendy's", "dairy queen", "pizza hut", "domino's pizza", "dominos pizza",
  "boston pizza", "swiss chalet", "harvey's", "a&w restaurant", "kfc",
  "popeyes", "second cup", "good earth cafe",
  // Canada — telecom / banking / logistics
  "telus", "rogers communications", "bell canada", "shaw communications",
  "scotiabank", "royal bank of canada", "td bank", "td canada trust",
  "cibc", "bmo bank", "bank of montreal", "desjardins", "atb financial",
  "purolator", "fedex", "ups store", "canada post",
  // Mexico
  "oxxo", "soriana", "chedraui", "liverpool", "coppel", "elektra",
  "bodega aurrera", "sams club", "sam's club", "farmacias guadalajara",
  "farmacias similares", "farmacia benavides", "sanborns",
  "palacio de hierro", "telcel", "telmex", "bancomer", "banamex",
  "banorte", "cinepolis", "cinemex", "waldos", "del sol",
];

/**
 * Suffixes that mark a listing as a BRANCH of something larger rather than an
 * independent business. Conservative: only unambiguous branch language.
 */
const BRANCH_SIGNALS: RegExp[] = [
  /\b(store|branch|location)\s*#\s*\d+/i,   // "Store #1234"
  /\bsucursal\b/i,                          // Spanish "branch"
  /\b(supercentre|supercenter)\b/i,
];

/** Lowercase + strip accents + collapse punctuation to spaces. */
function normalize(name: string): string {
  return name
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9&'-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Escape a brand string for use inside a RegExp. */
function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * True when a company name is a national chain / enterprise brand that would
 * never be an SMB prospect.
 *
 * Matches on WORD BOUNDARIES so "Walmart" hits but "Walmartinez Consulting"
 * does not, and a local business merely containing a common word is safe.
 */
export function isNationalChain(companyName: string): boolean {
  const name = normalize(companyName);
  if (!name) return false;

  for (const brand of CHAIN_BRANDS) {
    const b = normalize(brand);
    if (!b) continue;
    const re = new RegExp(`(^|\\s)${escapeRe(b)}(\\s|$)`);
    if (re.test(name)) return true;
  }
  return BRANCH_SIGNALS.some((re) => re.test(companyName));
}

/**
 * Known chain domains — a second signal for listings whose NAME is a local
 * franchise string but whose website points at the national brand.
 */
const CHAIN_DOMAINS = new Set([
  "walmart.ca", "walmart.com", "walmart.com.mx", "costco.ca", "costco.com",
  "loblaws.ca", "realcanadiansuperstore.ca", "nofrills.ca", "shoppersdrugmart.ca",
  "rexall.ca", "sobeys.com", "safeway.ca", "saveonfoods.com", "londondrugs.com",
  "dollarama.com", "canadiantire.ca", "homedepot.ca", "homedepot.com.mx",
  "lowes.ca", "rona.ca", "homehardware.ca", "bestbuy.ca", "staples.ca",
  "winners.ca", "marshalls.ca", "thebay.com", "sportchek.ca", "indigo.ca",
  "petro-canada.ca", "esso.ca", "circlek.com", "7-eleven.com",
  "timhortons.com", "mcdonalds.ca", "starbucks.ca", "subway.com",
  "bostonpizza.com", "telus.com", "rogers.com", "bell.ca", "shaw.ca",
  "scotiabank.com", "rbc.com", "td.com", "cibc.com", "bmo.com", "atb.com",
  "purolator.com", "fedex.com", "canadapost.ca",
  "oxxo.com", "soriana.com", "chedraui.com.mx", "liverpool.com.mx",
  "coppel.com", "elektra.com.mx", "farmaciasguadalajara.com",
  "sanborns.com.mx", "elpalaciodehierro.com", "telcel.com", "telmex.com",
  "cinepolis.com", "cinemex.com",
]);

/** True when a domain belongs to a known national chain. */
export function isChainDomain(domain: string | null | undefined): boolean {
  if (!domain) return false;
  const d = domain.toLowerCase().replace(/^www\./, "");
  if (CHAIN_DOMAINS.has(d)) return true;
  // Subdomains of a chain domain (careers.walmart.ca) are still the chain.
  return [...CHAIN_DOMAINS].some((c) => d.endsWith(`.${c}`));
}

/** Convenience: should this listing be dropped as a national chain? */
export function isChainListing(
  companyName: string,
  domain: string | null | undefined,
): boolean {
  return isNationalChain(companyName) || isChainDomain(domain);
}
