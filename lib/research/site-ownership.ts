/**
 * Does a website (and so its email addresses) belong to the prospect?
 *
 * Pure, no imports: used by the scraper (harvest contacts only on "yes",
 * treat "parked" as no website) and by the send gate (an address on a domain
 * we can't tie to the company goes to a person first).
 */

/**
 * Generic words that must not, on their own, prove two businesses are the same.
 * "Arctic Spas Manufacturing" and "Blue Falls Manufacturing" share a word and
 * nothing else; without this list that pair reads as a match.
 */
const GENERIC_NAME_TOKENS = new Set([
  "manufacturing", "manufacturer", "manufacturers", "construction", "constructions",
  "distributors", "distributor", "distribution", "wholesale", "wholesaler",
  "hospital", "health", "healthcare", "centre", "center", "general", "district",
  "regional", "memorial", "clinic", "medical",
  "company", "corporation", "corp", "incorporated", "inc", "ltd", "limited",
  "llp", "group", "holdings", "enterprises", "industries", "industrial",
  "services", "service", "solutions", "systems", "supply", "supplies",
  "professional", "associates", "partners", "consulting", "contractors",
  "canada", "canadian", "mexico", "toronto", "calgary", "edmonton", "ontario",
  "alberta", "hotel", "hotels", "resort", "inn", "spa", "spas", "machine",
  "welding", "tool", "tools", "products", "international", "national",
]);

export function distinctiveNameTokens(s: string): Set<string> {
  return new Set(
    s
      .toLowerCase()
      .normalize("NFD")
      .replace(/[̀-ͯ]/g, "")
      .split(/[^a-z0-9]+/)
      .filter((t) => t.length >= 4 && !GENERIC_NAME_TOKENS.has(t)),
  );
}

/** Domain-parking / for-sale landing pages — the business has no real site. */
const PARKED_SITE_RE =
  /hugedomains|godaddy|domain (?:is )?for sale|buy this domain|dan\.com|sedo|afternic|namecheap|parked|under construction|coming soon/i;

export type SiteOwnership = "yes" | "parked" | "unsure";

/**
 * Does the scraped site actually belong to this prospect?
 *
 * Auto-discovery attaches wrong domains — a Google Places listing for a plant
 * owned by a larger company returns the PARENT's website. "Corvex
 * Manufacturing" was stored with domain=linamar.com, so scraping it produced a
 * real, deliverable address for a Linamar employee. A pitch addressed to Corvex
 * would have landed in a stranger's inbox. Same shape: Holiday Inn Niagara ->
 * ihg.com, Canweld Group -> symposiumcafe.com.
 *
 * Deliberately THREE-valued. Two attempts at a boolean failed in opposite
 * directions: strict substring matching rejected "Brewers Distributor Ltd"
 * against its own site "Brewers Distributor Limited", and loose token overlap
 * accepted "Arctic Spas Manufacturing" as "Blue Falls Manufacturing". <title>
 * is frequently a tagline ("3M Science. Applied to Life.", "Chartered
 * Professional Accountants"), so a non-match proves nothing — which is why
 * "unsure" exists and callers must not treat it as "no".
 *
 * Callers should act only on a confident verdict: harvest contacts on "yes",
 * treat "parked" as no-website, and route "unsure" to a human.
 */
export function siteOwnership(
  companyName: string,
  siteName: string | null,
  domain: string | null,
): SiteOwnership {
  if (siteName && PARKED_SITE_RE.test(siteName)) return "parked";

  const want = distinctiveNameTokens(companyName);
  if (!want.size) return "unsure"; // nothing distinctive to match on

  if (siteName) {
    const have = distinctiveNameTokens(siteName);
    for (const t of want) if (have.has(t)) return "yes";
  }

  // The domain is weaker evidence than the site's own name, but a distinctive
  // token embedded in it ("jonesoconnell.ca" for Jones & O'Connell) is still
  // strong — generic words are excluded, so this can't fire on "canada".
  const domainLc = (domain ?? "").toLowerCase();
  for (const t of want) if (domainLc.includes(t)) return "yes";

  // An acronym domain that spells the company's initials: sbghc.on.ca for
  // South Bruce Grey Health Centre, bdl.ca for Brewers Distributor Ltd. Four
  // letters minimum; three-letter acronyms collide too often to prove anything.
  const label = domainLc.replace(/^www\./, "").split(".")[0] ?? "";
  if (label.length >= 4 && nameInitials(companyName).includes(label)) return "yes";

  return "unsure";
}

const INITIALS_SKIP = new Set(["and", "y", "e", "de", "del", "la", "las", "el", "los", "the", "of"]);
const LEGAL_SUFFIXES = new Set(["ltd", "inc", "limited", "llp", "corp", "sa", "cv", "sc", "de", "rl", "sapi"]);

/** The company's initials, with and without trailing legal suffixes ("Ltd", "S.A. de C.V."). */
function nameInitials(companyName: string): string[] {
  const words = companyName
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .split(/[^a-z0-9]+/)
    .filter((w) => w && !INITIALS_SKIP.has(w));
  const all = words.map((w) => w[0]).join("");
  const core = [...words];
  while (core.length > 1 && LEGAL_SUFFIXES.has(core[core.length - 1]!)) core.pop();
  return Array.from(new Set([all, core.map((w) => w[0]).join("")]));
}
