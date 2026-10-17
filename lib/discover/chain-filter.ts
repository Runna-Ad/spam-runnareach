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
 * words, case- and accent-insensitively, ANYWHERE in the company name.
 *
 * Only names nobody gives an independent business. "Shell" would match "Shell
 * Beach Boutique" and "Bay" would match "Bay Street Dental"; brands whose name
 * is an ordinary word, surname or first name go in AMBIGUOUS_BRANDS instead.
 * "No Frills" stays here on purpose: its stores are franchises named
 * "<Owner>'s No Frills", so the brand at the end IS the chain pattern.
 */
const CHAIN_BRANDS: string[] = [
  // Canada — big box / grocery / pharmacy
  "walmart", "wal-mart", "costco", "loblaw", "loblaws",
  "real canadian superstore", "real canadian wholesale club",
  "no frills", "shoppers drug mart", "rexall", "pharmasave", "sobeys",
  "save-on-foods", "london drugs", "dollarama", "canadian tire",
  "home depot", "home hardware", "princess auto", "winners homesense",
  "hudsons bay", "hudson's bay", "sport chek", "sportchek", "marks work",
  "indigo books", "chapters indigo", "giant tiger",
  // Canada — fuel / convenience
  "petro-canada", "petro canada", "esso", "husky energy", "7-eleven",
  "seven eleven", "mac's convenience",
  // Canada — food service
  "tim hortons", "starbucks", "subway restaurant", "burger king",
  "dairy queen", "pizza hut", "domino's pizza", "dominos pizza",
  "boston pizza", "swiss chalet", "a&w restaurant", "kfc",
  "popeyes", "second cup", "good earth cafe",
  // Canada — telecom / banking / logistics
  "telus", "rogers communications", "bell canada", "shaw communications",
  "scotiabank", "royal bank of canada", "td bank", "td canada trust",
  "cibc", "bmo bank", "bank of montreal", "caisse desjardins",
  "desjardins insurance", "desjardins assurances", "atb financial",
  "purolator", "fedex", "ups store", "canada post",
  // Mexico
  "oxxo", "soriana", "chedraui", "tiendas coppel", "bancoppel",
  "tienda elektra", "tiendas elektra", "banco azteca",
  "bodega aurrera", "sams club", "sam's club", "farmacias guadalajara",
  "farmacias similares", "farmacia benavides", "sanborns",
  "palacio de hierro", "telcel", "telmex", "bancomer", "banamex",
  "banorte", "cinepolis", "cinemex", "waldos dollar mart",
  "waldo's dollar mart", "tiendas del sol",
];

/**
 * Chain brands whose name is also an ordinary word, a surname or a first name:
 * "Atmosphere Hair Studio", "McDonald & Sons Plumbing", "Wendy's Bakery",
 * "Safeway Driving School", "Panadería del Sol", the town of Liverpool, NS.
 * Each one matches only when the listing is plainly the chain:
 *   - the name is the brand alone ("Safeway");
 *   - the brand, then a branch tail after punctuation ("Safeway - Kitsilano",
 *     "Staples (Macleod Trail)", "Winners #212");
 *   - the brand, then one of its own qualifiers ("Safeway Pharmacy",
 *     "Staples Print & Marketing", "McDonald's Restaurant").
 * Anything else survives. A missed chain costs one research run and gets
 * suppressed later; a wrong match deletes a real prospect nobody ever sees.
 */
const AMBIGUOUS_BRANDS: ReadonlyArray<{ brand: string; qualifiers?: readonly string[] }> = [
  { brand: "superstore" },
  { brand: "safeway", qualifiers: ["pharmacy", "liquor", "fuel", "gas", "food", "foods", "grocery"] },
  { brand: "staples", qualifiers: ["print", "copy", "business depot", "canada"] },
  { brand: "winners" },
  { brand: "marshalls" },
  { brand: "atmosphere" },
  { brand: "best buy", qualifiers: ["mobile", "canada", "express"] },
  { brand: "rona", qualifiers: ["home", "inc", "l'entrepot", "entrepot"] },
  { brand: "lowes", qualifiers: ["home improvement", "home", "canada"] },
  { brand: "lowe's", qualifiers: ["home improvement", "home", "canada"] },
  { brand: "circle k", qualifiers: ["convenience", "store", "gas"] },
  { brand: "mcdonald's", qualifiers: ["restaurant", "restaurants"] },
  { brand: "mcdonalds", qualifiers: ["restaurant", "restaurants"] },
  { brand: "wendy's", qualifiers: ["restaurant", "old fashioned hamburgers"] },
  { brand: "wendys", qualifiers: ["restaurant"] },
  { brand: "harvey's", qualifiers: ["restaurant"] },
  { brand: "desjardins" },
  { brand: "liverpool" },
  { brand: "coppel" },
  { brand: "elektra" },
  { brand: "waldos" },
  { brand: "del sol" },
];

/**
 * Text that marks a listing as a BRANCH of something larger rather than an
 * independent business. Conservative: a two-location bakery calls its second
 * shop "Sucursal Norte" or "Location #2", which is exactly the SMB we want, so
 * only a store NUMBER in the tens or more counts. ("Supercentre" was dropped:
 * "Mattress Supercentre" is a local shop, and Walmart is caught by name.)
 */
const BRANCH_SIGNALS: RegExp[] = [
  /\b(store|branch|location|tienda)\s*(#|no\.?|num\.?)\s*\d{2,}\b/i,   // "Store #1234"
  /\bsucursal\s*(#|no\.?|num\.?)?\s*\d{2,}\b/i,                     // "Sucursal 214"
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

/**
 * Lowercase + strip accents, KEEPING punctuation: an ambiguous brand needs to
 * know whether "Safeway" is followed by " - Kitsilano" or by " Driving School".
 */
function lightNormalize(name: string): string {
  return name
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[\u2018\u2019\u02bc`]/g, "'")
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

  const light = lightNormalize(companyName).replace(/^the\s+/, "");
  for (const { brand, qualifiers = [] } of AMBIGUOUS_BRANDS) {
    if (!light.startsWith(brand)) continue;
    const rest = light.slice(brand.length);
    // Brand alone, or brand then a branch tail after punctuation. A hyphen
    // counts only spaced ("Safeway - Kitsilano"): glued, it is part of a
    // compound name ("Rona-Lee's Bakery").
    if (/^(?:\s*$|\s*[|@(,:#/]|\s*[-\u2013\u2014]\s)/.test(rest)) return true;
    // Brand then one of its own qualifiers, as whole words.
    if (qualifiers.some((q) => new RegExp(`^\\s+${escapeRe(q)}(?![a-z0-9])`).test(rest))) return true;
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
