/**
 * The web dive's own checks on a fact's page and words, shared by the
 * keep-check (keep.ts, when the dive runs) and the read before a draft
 * (usable.ts usableWebFacts, against the prospect as it is NOW). Pure: imports
 * only the word lists, so the readers load no Claude client.
 *
 * Tightened 2026-11-09 after Pedro's real sample (10 prospects, 9 facts kept,
 * 0 fit to send): employee reviews labelled "problem", an auto-written
 * aggregator summary, two dead pages, a 2020 article, Birdeye template text,
 * and a listicle titled "…CrushCamp, Fit Lab…" that handed CrushCamp Fit
 * Lab's news. So:
 *   - the business name must be in the QUOTE (the title alone only on its own
 *     profile page), and its city counts only from the quote;
 *   - never employee reviews, never auto-generated profiles or aggregators;
 *   - "problem" and "opening" need a word in the quote that shows one, and a
 *     recent page date from the search result.
 */

import { EN_WORDS } from "../../pitches/wordlists/en.ts";
import { ES_WORDS } from "../../pitches/wordlists/es.ts";
import type { WebFactKind } from "./facts.ts";

export type MatchProspect = {
  company_name: string;
  city: string | null;
  domain: string | null;
  website_url: string | null;
};

// ── Text folds ───────────────────────────────────────────────────────────────

const ENTITIES: Record<string, string> = {
  amp: "&", quot: '"', apos: "'", lt: "<", gt: ">", nbsp: " ", rsquo: "’", lsquo: "‘", ldquo: "“", rdquo: "”", ndash: "–", mdash: "—", hellip: "…",
};

/**
 * HTML entities as the characters they stand for. Search results and some
 * prospect names come back HTML-escaped ("Allen &amp; Associates", "Spas
 * &amp; Wellness": the 2026-11-10 sample): compared and stored decoded, so
 * "&" and "&amp;" are the same text and a writer never sees "&amp;".
 */
export function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]{1,6}|#\d{1,7}|[a-z]{2,8});/gi, (whole, code: string) => {
    if (code[0] === "#") {
      const n = code[1] === "x" || code[1] === "X" ? parseInt(code.slice(2), 16) : parseInt(code.slice(1), 10);
      return Number.isFinite(n) && n > 0 && n <= 0x10ffff ? String.fromCodePoint(n) : whole;
    }
    return ENTITIES[code.toLowerCase()] ?? whole;
  });
}

/** Quotes: entities decoded, lowercase, accents KEPT, whitespace collapsed, curly quotes straightened. */
export function quoteFold(s: string): string {
  return decodeEntities(s)
    .replace(/[‘’‚‛′]/g, "'")
    .replace(/[“”„‟″]/g, '"')
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

/** Names: lowercase, accents stripped, punctuation removed ("S.A." → "sa", "O'Neil" → "oneil"), tokens. */
export function nameTokens(s: string): string[] {
  return decodeEntities(s)
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[.'‘’`]/g, "")
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
}

/** Legal suffixes, longest first; dropped from the END of the business name only, repeatedly. */
const LEGAL_SUFFIXES: readonly string[][] = [
  "s de rl de cv", "sapi de cv", "sab de cv", "sas de cv", "professional corporation", "sa de cv", "s de rl",
  // LLP and the rest: "Cook Roberts LLP" is "Cook Roberts" in a quote (sample, 2026-11-10).
  "corporation", "corp", "inc", "ltd", "ltee", "llc", "llp", "pllc", "lp", "pc", "plc", "sc", "sa",
].map((s) => s.split(" "));

/** The business name as compared: folded tokens, legal suffixes dropped. */
export function businessNameTokens(name: string): string[] {
  const t = nameTokens(name);
  for (let changed = true; changed; ) {
    changed = false;
    for (const suffix of LEGAL_SUFFIXES) {
      if (t.length > suffix.length && suffix.every((w, i) => t[t.length - suffix.length + i] === w)) {
        t.splice(t.length - suffix.length, suffix.length);
        changed = true;
        break;
      }
    }
  }
  return t;
}

/**
 * Does `needle` occur in `hay` as a run of whole tokens? Compared joined, so
 * "CrushCamp" and "Crush Camp" match each other, but never inside a longer
 * word ("crushcamp" is not in "crushcampaign").
 */
export function hasTokenRun(hay: readonly string[], needle: readonly string[]): boolean {
  const want = needle.join("");
  if (!want) return false;
  for (let i = 0; i < hay.length; i++) {
    let acc = "";
    for (let j = i; j < hay.length && acc.length < want.length; j++) {
      acc += hay[j];
      if (acc === want) return true;
    }
  }
  return false;
}

/**
 * Does the quote name these tokens? Read twice: as written, and with English
 * possessives dropped, so "CrushCamp's coaches" names CrushCamp while
 * "O'Neil's" still matches a business called O'Neil's.
 */
export function quoteNames(quote: string, needle: readonly string[]): boolean {
  return hasTokenRun(nameTokens(quote), needle) || hasTokenRun(nameTokens(quote.replace(/['’]s\b/gi, "")), needle);
}

let commonWords: ReadonlySet<string> | null = null;
/** The 20,000 most frequent English and Spanish words (lib/pitches/wordlists, the exemplar check's strict tier). */
export function isCommonWord(word: string): boolean {
  if (!commonWords) {
    const lines = (s: string) => s.split("\n").map((w) => w.trim()).filter(Boolean);
    commonWords = new Set([...lines(EN_WORDS).slice(0, 20_000), ...lines(ES_WORDS).slice(0, 20_000)]);
  }
  return commonWords.has(word);
}

// ── Hosts and paths ──────────────────────────────────────────────────────────

export const bareHost = (h: string): string => h.trim().toLowerCase().replace(/^www\./, "").replace(/\.$/, "");

/** The bare host of an http(s) URL, or null. */
export function hostOf(url: string): string | null {
  try {
    const u = new URL(url.trim());
    if (u.protocol !== "http:" && u.protocol !== "https:") return null;
    return bareHost(u.hostname);
  } catch {
    return null;
  }
}

/** The prospect's own hosts: its domain and its website's host. */
export function ownHosts(p: MatchProspect): string[] {
  const out = new Set<string>();
  if (p.domain && p.domain.trim()) out.add(bareHost(hostOf(`https://${p.domain.trim()}`) ?? p.domain));
  if (p.website_url && p.website_url.trim()) {
    const h = hostOf(p.website_url) ?? hostOf(`https://${p.website_url.trim()}`);
    if (h) out.add(h);
  }
  return [...out].filter(Boolean);
}

/** The page is on their own domain or a subdomain of it (the crawler reads those, never the dive). */
export function isOwnSite(url: string, p: MatchProspect): boolean {
  const host = hostOf(url);
  return host !== null && ownHosts(p).some((own) => host === own || host.endsWith(`.${own}`));
}

/**
 * The page's path segments, each folded to letters and digits:
 * instagram.com/crushcamp/ → ["crushcamp"], tiktok.com/@crush_camp → ["crushcamp"],
 * yelp.com/biz/crushcamp-austin → ["biz", "crushcampaustin"]. The domain label
 * ties a page only as a WHOLE segment (a profile named after it): a directory
 * slug that adds another city is the same name somewhere else, and "camp" is
 * not tied to instagram.com/campingworld. The host never ties (crushcamp.com
 * is another domain, maybe another business).
 */
export function urlPathSegments(url: string): string[] {
  try {
    const u = new URL(url.trim());
    return u.pathname
      .split("/")
      .map((seg) => {
        let s = seg;
        try {
          s = decodeURIComponent(seg);
        } catch {
          // A malformed escape: compare the raw segment.
        }
        return nameTokens(s).join("");
      })
      .filter(Boolean);
  } catch {
    return [];
  }
}

/** "crushcamp" of crushcamp.ca: the first label of the bare domain, folded; null under 4 characters. */
export function domainLabel(p: MatchProspect): string | null {
  const host = ownHosts(p)[0];
  const label = host?.split(".")[0] ?? "";
  const folded = nameTokens(label).join("");
  return folded.length >= 4 ? folded : null;
}

/** `host` written in the quote as a whole domain ("book at crushcamp.ca", not "notcrushcamp.ca" or "crushcamp.cafe"). */
function quoteNamesHost(foldedQuote: string, host: string): boolean {
  let from = 0;
  for (;;) {
    const i = foldedQuote.indexOf(host, from);
    if (i < 0) return false;
    const before = foldedQuote[i - 1];
    const after = foldedQuote[i + host.length];
    const okBefore = before === undefined || !/[a-z0-9.-]/.test(before);
    const okAfter = after === undefined || !/[a-z0-9-]/.test(after) && !(after === "." && /[a-z0-9]/.test(foldedQuote[i + host.length + 1] ?? ""));
    if (okBefore && okAfter) return true;
    from = i + 1;
  }
}

// ── Rule: about THIS business ────────────────────────────────────────────────

export type TieReason = "name_too_short" | "name_not_in_quote" | "not_tied_to_business" | "common_name_needs_domain";

/** Sites where a business runs its own profile: only there can the URL say whose page it is. */
const PROFILE_HOSTS = [
  "instagram.com", "facebook.com", "fb.com", "tiktok.com", "x.com", "twitter.com", "linkedin.com",
  "youtube.com", "pinterest.com", "pinterest.ca", "threads.net", "threads.com",
];
/** Path words before a profile name on those sites (linkedin.com/company/x, facebook.com/pages/x, youtube.com/c/x). */
const PROFILE_PREFIXES: ReadonlySet<string> = new Set(["company", "school", "pages", "c", "user"]);

/**
 * The page is the business's own profile: a social site whose path STARTS
 * with the domain label (instagram.com/crushcamp/…, tiktok.com/@crushcamp,
 * x.com/crushcamp/status/…), or has it right after a profile word
 * (linkedin.com/company/crushcamp). Never a tag, hashtag, explore or search
 * page (instagram.com/explore/tags/crushcamp, youtube.com/hashtag/crushcamp,
 * reddit.com/search/crushcamp): those collect posts by anyone (review
 * 2026-11-09). Never a directory slug (yelp.com/biz/crushcamp is whichever
 * business took the name first, in any city). The label must not be a common
 * word: instagram.com/sweat is anybody called Sweat.
 */
export function isOwnProfile(url: string, p: MatchProspect): boolean {
  const label = domainLabel(p);
  if (label === null || isCommonWord(label)) return false;
  const host = hostOf(url);
  if (!host || !PROFILE_HOSTS.some((h) => host === h || host.endsWith(`.${h}`))) return false;
  const segs = urlPathSegments(url);
  return segs[0] === label || (segs.length > 1 && PROFILE_PREFIXES.has(segs[0]!) && segs[1] === label);
}

/**
 * Is this page about this business? Fails closed.
 *   - The QUOTE names the business. The result title alone counts only on the
 *     business's own profile (isOwnProfile): a listicle titled "…CrushCamp,
 *     Fit Lab…" names many businesses, and its quote may be about any of them.
 *   - And the page is tied to it: its own profile, or the quote names its
 *     domain, or the QUOTE names its city (a title's city is the listicle's,
 *     not the business's).
 *   - A one-common-word name ("Summit", "Elevate") needs the profile or domain
 *     tie: its city is not enough, there are many of those in one city.
 */
export function tieToBusiness(f: { quote: string; url: string; title: string | null }, p: MatchProspect): TieReason | null {
  const name = businessNameTokens(p.company_name);
  if (name.join("").length < 4) return "name_too_short";
  const profile = isOwnProfile(f.url, p);
  const nameInQuote = quoteNames(f.quote, name);
  if (!nameInQuote && !(profile && hasTokenRun(nameTokens(f.title ?? ""), name))) return "name_not_in_quote";
  const host = ownHosts(p)[0] ?? null;
  const domainTie = profile || (host !== null && quoteNamesHost(quoteFold(f.quote), host));
  const city = p.city ? nameTokens(p.city) : [];
  const cityTie = city.length > 0 && quoteNames(f.quote, city);
  const oneCommonWord = name.length === 1 && isCommonWord(name[0]!);
  if (oneCommonWord && !domainTie) return cityTie ? "common_name_needs_domain" : "not_tied_to_business";
  if (!domainTie && !cityTie) return "not_tied_to_business";
  return null;
}

// ── Rule: sources we never use ───────────────────────────────────────────────

export type BlockedSource = "employee_reviews" | "auto_profile";

/** Sites whose every page is about working there (reviews by staff, salaries): never a fact about the business. */
const EMPLOYEE_REVIEW_BRANDS = ["glassdoor", "comparably", "kununu"];

/**
 * Pages written by a machine from scraped data (profiles, "about this
 * company" summaries, FAQ templates): the words are nobody's, so quoting them
 * proves nothing. The sample run kept Wheree and Birdeye text; the rest are
 * the same kind of site.
 */
const AUTO_PROFILE_BRANDS = [
  "wheree", "tracxn", "zoominfo", "birdeye", "cylex", "canpages", "companiesup",
  "rocketreach", "signalhire", "owler", "crunchbase", "manta", "bizapedia", "hotfrog", "brownbook", "cybo",
];

const hasBrand = (host: string, brands: readonly string[]): boolean =>
  host.split(".").some((label) => brands.some((b) => label === b || label.startsWith(`${b}-`)));

/** Why this page may never be a source, or null. Unparseable URLs are blocked (fail closed). */
export function blockedSource(url: string): BlockedSource | null {
  const host = hostOf(url);
  if (!host) return "auto_profile";
  if (hasBrand(host, EMPLOYEE_REVIEW_BRANDS)) return "employee_reviews";
  // Indeed: job posts (/viewjob, /job/) are fine; /cmp/ is the company page, its employee reviews and salaries.
  if (hasBrand(host, ["indeed"])) {
    let path = "";
    try {
      path = new URL(url.trim()).pathname.toLowerCase();
    } catch {
      return "employee_reviews";
    }
    if (path === "/cmp" || path.startsWith("/cmp/")) return "employee_reviews";
  }
  if (hasBrand(host, AUTO_PROFILE_BRANDS)) return "auto_profile";
  return null;
}

/**
 * Plain hostnames passed to the web search tool's blocked_domains so the dive
 * does not spend its searches on them (subdomains are covered by the API).
 * blockedSource is the rule; this list only saves searches, so a host missing
 * here is still dropped in code.
 */
export const SEARCH_BLOCKED_DOMAINS: readonly string[] = [
  "glassdoor.com", "glassdoor.ca", "comparably.com", "kununu.com",
  "wheree.com", "tracxn.com", "zoominfo.com", "birdeye.com", "cylex.ca", "cylex-canada.ca", "canpages.ca",
  "rocketreach.co", "signalhire.com", "owler.com", "crunchbase.com", "manta.com", "bizapedia.com",
];

// ── Rule: the kind must show in the quote ────────────────────────────────────

const fold = (s: string) => s.normalize("NFKD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[‘’]/g, "'");

/**
 * A quote shaped like "X does not offer Y". Profile and FAQ templates state
 * absences ("CrushCamp doesn't offer online booking"), and an email never
 * says one (CrushCamp's hard no, 2026-11-09): such a fact is dropped, not
 * kept as context, whatever its kind.
 */
const ABSENCE_SHAPE = new RegExp(
  [
    String.raw`\b(does not|doesn't|doesnt|do not|don't|dont|is not|isn't|isnt|are not|aren't|arent)( currently| yet)? (offer|provide|accept|have|support|list|take)\b`,
    String.raw`\bnot (currently |yet )?(available|offered|provided|listed|accepted|supported)\b`,
    String.raw`\b(no ofrece\w*|no cuenta con|no tiene\w*|no acepta\w*|no dispone de|no esta disponible|no disponible)\b`,
  ].join("|"),
  "u",
);

export function isAbsenceShaped(quote: string): boolean {
  return ABSENCE_SHAPE.test(fold(quote));
}

/**
 * Praise that carries a problem word ("can't wait to go back", "no wait at
 * all", "never disappointed", "fixed my back issues"): removed before the
 * problem check, so the check reads only what is left (review 2026-11-09).
 */
const PRAISE = new RegExp(
  [
    String.raw`\b(can't|cant|cannot) wait\b`,
    String.raw`\b(can't|cant|cannot|couldn't|couldnt) (recommend|say enough|praise|thank)[^.!?]{0,40}`,
    String.raw`\bcouldn't (be happier|ask for more)\b`,
    String.raw`\b(never|not once|not ever) (disappoint\w*|had (a|any) (problem|issue|complaint)s?|fails?|failed)\b`,
    String.raw`\bno (problems?|issues?|complaints?|wait\w*|hassle)\b`,
    String.raw`\bwithout (a|any) (problem|issue|wait|hassle)s?\b`,
    String.raw`\b(fixed|solved|helped( me)?( with)?|resolved|cured)[^.!?]{0,30}\b(issues?|problems?|pain)\b`,
    String.raw`\b(nunca|jamas) (me |nos )?(decepciona\w*|falla\w*)\b`,
    String.raw`\bsin (problemas?|esperas?|quejas?)\b`,
    String.raw`\bno (me |nos )?(arrepiento|decepciona\w*)\b`,
  ].join("|"),
  "gu",
);

/** Phrases that show something not working (EN + ES, accents stripped). Phrases, not bare words: "late", "slow" and "never" alone are as often praise. */
const PROBLEM_CUE = new RegExp(
  [
    String.raw`\b(nobody|no one|no-one)\b[^.!?]{0,30}\b(answer\w*|pick\w* up|call\w*|respond\w*|repl\w*|got back|gets back|showed up|shows up|help\w*)\b`,
    String.raw`\bnever\b[^.!?]{0,20}\b(answer\w*|call\w* (me |us )?back|respond\w*|repl\w*|got back|showed up|shows up|returned|refund\w*|honou?r\w*|arrived|came)\b`,
    String.raw`\b(didn't|didnt|did not|doesn't|doesnt|does not|won't|wont|will not|wouldn't|couldn't|can't|cant|cannot|unable to)\b[^.!?]{0,15}\b(answer|call (me |us )?back|respond|reply|get through|reach (anyone|them|someone|a person)|refund|show up|honou?r|pick up)\b`,
    String.raw`\bno (answer|response|reply|call ?back|show)\b`,
    String.raw`\b(unanswered|voicemail|on hold)\b`,
    String.raw`\b(waited|waiting|wait)\b[^.!?]{0,15}\b(\d+|forever|hours?|days?|weeks?|ages)\b`,
    String.raw`\b(rude|terrible|awful|horrible|worst|unprofessional|ignored|scam|overcharg\w*|double[- ]charg\w*)\b`,
    String.raw`\b(disappoint(ed|ing|ment)|frustrat(ed|ing|ion)|complain\w*)\b`,
    String.raw`\b(outage|glitch\w*|crash(ed|es|ing)|went down|is down|was down|kept failing)\b`,
    String.raw`\bcancel+(ed|ing|s)?\b[^.!?]{0,20}\b(my|our|the|a)\b[^.!?]{0,15}\b(class|appointment|booking|session|order|reservation)s?\b`,
    String.raw`\b(nadie)\b[^.!?]{0,30}\b(contesta\w*|responde\w*|atiende\w*|regres\w*)\b`,
    String.raw`\bnunca\b[^.!?]{0,20}\b(contesta\w*|responde\w*|llega\w*|regres\w*|devuelv\w*)\b`,
    String.raw`\bno (contestan?|responden?|atienden?|funciona|sirve|llego|regresan)\b`,
    String.raw`\b(pesim\w*|malisim\w*|terrible|horrible|groser\w*|estafa|fraude)\b`,
    String.raw`\b(decepcion\w*|quejas?)\b`,
    String.raw`\b(tardan?|tardaron|espere|esperamos|esperaron)\b[^.!?]{0,15}\b(\d+|horas?|dias?|semanas?)\b`,
  ].join("|"),
  "u",
);

/** Phrases that show a change: a new place, a launch, a hire, an award (EN + ES, accents stripped). "new" or "second" alone is not one ("second to none", "great for new moms"). */
const OPENING_CUE = new RegExp(
  [
    String.raw`\b(new|newest|second|third|another)\b[^.!?]{0,20}\b(location|studio|store|shop|clinic|office|branch|space|facility|restaurant|site|gym|salon|warehouse)s?\b`,
    String.raw`\b(now open|grand opening|coming soon|ribbon cutting|opening (soon|day|our|a|an|its|their|in|on|this|next)|opened (our|a|an|its|their|in|on)|opens (our|a|an|its|their|in|on|this|next))\b`,
    String.raw`\b(launch(ed|es|ing)?|expand(ed|ing|s)?|expansion|relocat\w*|moving to|moved to|renovat\w*|rebrand\w*)\b`,
    String.raw`\b(hiring|we're hiring|now hiring|join our team|is looking for an?|are looking for an?|seeking an?|apply now|job (opening|posting)|open positions?|vacanc(y|ies))\b`,
    String.raw`\b(award\w*|winner|won (the|a|an|best|first|gold)|finalist|nominat\w*|named (to|one of|the|best)|voted (best|one of|#?1))\b`,
    String.raw`\b(nuev[oa]s?|segund[oa]|otra)\b[^.!?]{0,20}\b(sucursal|ubicacion|tienda|clinica|oficina|local|sede|estudio|restaurante|planta|gimnasio)\b`,
    String.raw`\b(abrimos|abrio|abre (sus|su|una|un|nuestra|nuestro)|apertura|inaugur\w*|proximamente|lanz(a|o|amos|amiento)\b|expansion|nos mudamos|mudanza|renov\w*)`,
    String.raw`\b(contratando|estamos contratando|buscamos|vacantes?|unete a nuestro equipo|unete al equipo|solicitamos)\b`,
    String.raw`\b(premi(o|ado|ados|ada)|ganador\w*|gano (el|un|una)|reconocimiento\w*|nominad\w*)\b`,
  ].join("|"),
  "u",
);

/**
 * The kind, checked coarsely against the quote: "problem" stays a problem only
 * when the quote has a phrase that shows one (praise removed first), "opening"
 * likewise; otherwise the fact is only "context" (true, but no reason to
 * write). The model's label is never trusted on its own: the sample's
 * employee review "great team, good pay" was labelled "problem".
 */
export function kindFromQuote(kind: WebFactKind, quote: string): WebFactKind {
  const q = fold(quote);
  if (kind === "problem") return PROBLEM_CUE.test(q.replace(PRAISE, " ")) ? "problem" : "context";
  if (kind === "opening") return OPENING_CUE.test(q) ? "opening" : "context";
  return kind;
}

// ── Rule: problems and openings must be recent ───────────────────────────────

/** A problem older than this is no reason to write today (a review from last spring is still fair). */
export const PROBLEM_MAX_AGE_DAYS = 365;
/** An opening older than this is over (the hire is made, the new studio is the studio). */
export const OPENING_MAX_AGE_DAYS = 180;
const DAY_MS = 86_400_000;

const MONTHS = ["january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december"];
const MESES = ["enero", "febrero", "marzo", "abril", "mayo", "junio", "julio", "agosto", "septiembre", "octubre", "noviembre", "diciembre"];
const monthOf = (s: string): number => {
  const w = s === "sept" ? "sep" : s === "setiembre" ? "septiembre" : s;
  if (w.length < 3) return -1;
  const en = MONTHS.findIndex((m) => m === w || m.startsWith(w));
  return en >= 0 ? en : MESES.findIndex((m) => m === w || m.startsWith(w));
};
/** Units as the search writes them, in days (EN, abbreviations, ES). */
const UNIT_DAYS: Record<string, number> = {
  minute: 0, min: 0, hour: 0, hr: 0, h: 0, day: 1, d: 1, week: 7, wk: 7, w: 7, month: 30, mo: 30, year: 365, yr: 365, y: 365,
  minuto: 0, hora: 0, dia: 1, semana: 7, mes: 30, meses: 30, ano: 365,
};
// "minutes" → "minute", "semanas" → "semana", "meses" is listed as is.
const unitDays = (u: string): number | undefined => UNIT_DAYS[u] ?? UNIT_DAYS[u.replace(/s$/, "")];

const isoDay = (y: number, m: number, d: number): string | null => {
  const t = Date.UTC(y, m, d);
  const back = new Date(t);
  if (back.getUTCFullYear() !== y || back.getUTCMonth() !== m || back.getUTCDate() !== d) return null;
  return back.toISOString().slice(0, 10);
};

/**
 * The search result's page_age as a calendar day (YYYY-MM-DD, UTC), or null
 * when it is missing or in a form we do not read (fail closed: no date, no
 * problem or opening). Reads "April 30, 2025", "Apr 30, 2025 at 10:00 AM",
 * "30 April 2025", "30 de abril de 2025", "2025-04-30…", "Nov 2025" (the 1st,
 * the older reading), "3 days ago", "1 yr ago", "a month ago", "hace 2
 * semanas", "yesterday", "ayer". A date more than 2 days in the future is null.
 */
export function pageDateFrom(pageAge: unknown, now: Date): string | null {
  if (typeof pageAge !== "string") return null;
  const s = fold(pageAge)
    .trim()
    .replace(/\s+/g, " ")
    // A time after the date says nothing about the day: "…, 2025 at 10:00 am", "…, 2025, 10:00".
    .replace(/,? (at |a las )?\d{1,2}:\d{2}( ?[ap]\.?m\.?)?( [a-z]{2,4})?$/, "");
  if (!s) return null;
  const daysAgo = (n: number) => new Date(now.getTime() - n * DAY_MS).toISOString().slice(0, 10);
  let day: string | null = null;
  let m: RegExpMatchArray | null;
  if ((m = s.match(/^(\d{4})-(\d{2})-(\d{2})(?:$|[t ])/))) day = isoDay(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  else if ((m = s.match(/^([a-z]+)\.? (\d{1,2}),? (\d{4})$/)) && monthOf(m[1]!) >= 0) day = isoDay(Number(m[3]), monthOf(m[1]!), Number(m[2]));
  else if ((m = s.match(/^(\d{1,2}) (?:de )?([a-z]+)\.?,? (?:de )?(\d{4})$/)) && monthOf(m[2]!) >= 0) day = isoDay(Number(m[3]), monthOf(m[2]!), Number(m[1]));
  else if ((m = s.match(/^([a-z]+)\.?,? (?:de )?(\d{4})$/)) && monthOf(m[1]!) >= 0) day = isoDay(Number(m[2]), monthOf(m[1]!), 1);
  else if (s === "today" || s === "just now" || s === "hoy") day = daysAgo(0);
  else if (s === "yesterday" || s === "ayer") day = daysAgo(1);
  else if ((m = s.match(/^(\d+|a|an|one) ?([a-z]+) ago$/)) && unitDays(m[2]!) !== undefined) {
    day = daysAgo((/^\d+$/.test(m[1]!) ? Number(m[1]) : 1) * unitDays(m[2]!)!);
  } else if ((m = s.match(/^hace (\d+|un|una) ([a-z]+)$/)) && unitDays(m[2]!) !== undefined) {
    day = daysAgo((/^\d+$/.test(m[1]!) ? Number(m[1]) : 1) * unitDays(m[2]!)!);
  }
  if (!day) return null;
  if (Date.parse(`${day}T00:00:00Z`) > now.getTime() + 2 * DAY_MS) return null;
  return day;
}

/** Context needs no date; a problem or an opening needs a page date this recent (whole calendar days, UTC, before `now`'s day). */
export function recentEnough(kind: WebFactKind, pageDate: string | null, now: Date): boolean {
  if (kind === "context") return true;
  if (!pageDate || !/^\d{4}-\d{2}-\d{2}$/.test(pageDate)) return false;
  const at = Date.parse(`${pageDate}T00:00:00Z`);
  if (!Number.isFinite(at)) return false;
  const today = Date.parse(`${now.toISOString().slice(0, 10)}T00:00:00Z`);
  const days = Math.round((today - at) / DAY_MS);
  const maxDays = kind === "problem" ? PROBLEM_MAX_AGE_DAYS : OPENING_MAX_AGE_DAYS;
  return days <= maxDays && days >= -2;
}
