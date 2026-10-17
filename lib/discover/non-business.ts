/**
 * Hosts that are never a prospect: government and news sites. A web search for
 * a business-model keyword ("direct to consumer Alberta") returns mostly these,
 * and each one that slips through costs a scrape and a research call before
 * scoring throws it out.
 */

// Government: gov.bc.ca, news.gov.bc.ca, canada.gc.ca, gouv.qc.ca, gob.mx.
const GOVERNMENT_LABELS = new Set(["gov", "gouv", "gob", "gc", "govt"]);
const GOVERNMENT_HOSTS = [
  "canada.ca", "alberta.ca", "ontario.ca", "quebec.ca", "novascotia.ca",
  "saskatchewan.ca", "manitoba.ca", "yukon.ca", "princeedwardisland.ca", "gnb.ca",
];

// News: networks and papers a Canadian or Mexican search surfaces, plus any
// news.* subdomain.
const NEWS_HOSTS = [
  "citynews.ca", "globalnews.ca", "ctvnews.ca", "cbc.ca", "cp24.com", "thecanadianpress.com",
  "winnipegfreepress.com", "calgaryherald.com", "edmontonjournal.com", "calgarysun.com",
  "edmontonsun.com", "torontosun.com", "ottawacitizen.com", "theprovince.com", "leaderpost.com",
  "thestarphoenix.com", "lfpress.com", "macleans.ca", "nationalobserver.com", "lapresse.ca",
  "ledevoir.com", "journaldemontreal.com", "eluniversal.com.mx", "milenio.com",
  "elfinanciero.com.mx", "eleconomista.com.mx", "expansion.mx", "excelsior.com.mx",
  "jornada.com.mx", "proceso.com.mx", "informador.mx", "wikipedia.org",
];

const matches = (host: string, list: string[]) => list.some((h) => host === h || host.endsWith(`.${h}`));

export function isNonBusinessHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^www\./, "");
  const labels = host.split(".");
  if (labels.slice(0, -1).some((l) => GOVERNMENT_LABELS.has(l))) return true;
  if (labels[0] === "news" && labels.length > 2) return true;
  return matches(host, GOVERNMENT_HOSTS) || matches(host, NEWS_HOSTS);
}
