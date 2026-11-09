/**
 * The keep-check of the web dive: a web fact survives only when code can show
 * where it came from (the page URL and the exact words on it) and that it is
 * about THIS business. Pure, fail closed, one reason per drop (brief
 * tasks/briefs/web-dive.md, "The keep-check").
 *
 * Search result content comes back encrypted, so the only page text we can
 * read is what the model cites. A fact is kept when:
 *   1. its URL is one the search returned (normalizeUrl, lib/benchmarks/research.ts);
 *   2. a citation from that same URL contains the quote (20+ characters), both
 *      lowercased, accents kept, whitespace collapsed, curly quotes straightened;
 *   3. every number in the fact is in the quote (numbersCovered, plus the send
 *      gate's own rule, findUnsourcedNumbers: the writer may quote the fact);
 *   4. the page is not on the prospect's own domain (the crawler reads that);
 *   5. the quote or the result title names the business, AND the page is tied
 *      to it: a whole path segment of the URL is its domain label
 *      (instagram.com/crushcamp), or the quote/title names its city, or the
 *      quote names its domain. A one-common-word name needs the domain tie (a
 *      city is not enough: "Elevate" in Calgary is many places);
 *   6. its kind is one of the three.
 * Its matching is its own (token runs over a folded copy), not the model's.
 */

import { normalizeUrl, numbersCovered, type ResponseEvidence } from "../../benchmarks/research.ts";
import { findUnsourcedNumbers } from "../../pitches/content-rules.ts";
import { EN_WORDS } from "../../pitches/wordlists/en.ts";
import { ES_WORDS } from "../../pitches/wordlists/es.ts";
import { isWebFactKind, MAX_WEB_FACTS, MIN_QUOTE_CHARS, type WebFact } from "./facts.ts";

export type WebFactCandidate = { fact: string; quote: string; url: string; kind: string };

export type KeepProspect = {
  company_name: string;
  city: string | null;
  domain: string | null;
  website_url: string | null;
};

export type WebFactDropReason =
  | "malformed"
  | "url_not_in_search_results"
  | "quote_too_short"
  | "quote_not_in_citation"
  | "number_not_in_quote"
  | "bad_url"
  | "own_site"
  | "name_too_short"
  | "name_not_found"
  | "not_tied_to_business"
  | "common_name_needs_domain"
  | "bad_kind"
  | "duplicate"
  | "over_limit";

export type KeepResult = { keep: true; fact: WebFact } | { keep: false; reason: WebFactDropReason };

// ── Text folds (each rule's own) ─────────────────────────────────────────────

/** Rule 2: lowercase, accents KEPT, whitespace collapsed, curly quotes straightened. */
export function quoteFold(s: string): string {
  return s
    .replace(/[‘’‚‛′]/g, "'")
    .replace(/[“”„‟″]/g, '"')
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

/** Rule 5: lowercase, accents stripped, punctuation removed ("S.A." → "sa", "O'Neil" → "oneil"), tokens. */
export function nameTokens(s: string): string[] {
  return s
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[.'‘’`]/g, "")
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
}

/** Legal suffixes, longest first; dropped from the END of the business name only, repeatedly. */
const LEGAL_SUFFIXES: readonly string[][] = [
  "s de rl de cv", "professional corporation", "sa de cv", "s de rl",
  "corporation", "corp", "inc", "ltd", "ltee", "llc", "sc", "sa",
].map((s) => s.split(" "));

/** The business name as rule 5 compares it: folded tokens, legal suffixes dropped. */
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

let commonWords: ReadonlySet<string> | null = null;
/** The 20,000 most frequent English and Spanish words (lib/pitches/wordlists, the exemplar check's strict tier). */
export function isCommonWord(word: string): boolean {
  if (!commonWords) {
    const lines = (s: string) => s.split("\n").map((w) => w.trim()).filter(Boolean);
    commonWords = new Set([...lines(EN_WORDS).slice(0, 20_000), ...lines(ES_WORDS).slice(0, 20_000)]);
  }
  return commonWords.has(word);
}

const bareHost = (h: string): string => h.trim().toLowerCase().replace(/^www\./, "").replace(/\.$/, "");

function hostOf(url: string): string | null {
  try {
    const u = new URL(url.trim());
    if (u.protocol !== "http:" && u.protocol !== "https:") return null;
    return bareHost(u.hostname);
  } catch {
    return null;
  }
}

/** The prospect's own hosts: its domain and its website's host. */
function ownHosts(p: KeepProspect): string[] {
  const out = new Set<string>();
  if (p.domain && p.domain.trim()) out.add(bareHost(hostOf(`https://${p.domain.trim()}`) ?? p.domain));
  if (p.website_url && p.website_url.trim()) {
    const h = hostOf(p.website_url) ?? hostOf(`https://${p.website_url.trim()}`);
    if (h) out.add(h);
  }
  return [...out].filter(Boolean);
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

/** "crushcamp" of crushcamp.ca: the first label of the bare domain. */
export function domainLabel(p: KeepProspect): string | null {
  const host = ownHosts(p)[0];
  const label = host?.split(".")[0] ?? "";
  const folded = nameTokens(label).join("");
  return folded.length >= 4 ? folded : null;
}

// ── The check ────────────────────────────────────────────────────────────────

/**
 * Rules 1-6 for one candidate. Every branch that cannot confirm returns
 * keep: false with the first rule it failed. `kept` are the facts already kept
 * for this prospect (duplicates and the 6-fact limit).
 */
export function keepWebFact(
  candidate: WebFactCandidate,
  evidence: Pick<ResponseEvidence, "results" | "citations">,
  prospect: KeepProspect,
  kept: readonly WebFact[] = [],
): KeepResult {
  const { fact, quote, url, kind } = candidate;
  if (typeof fact !== "string" || typeof quote !== "string" || typeof url !== "string" || typeof kind !== "string") {
    return { keep: false, reason: "malformed" };
  }
  if (!fact.trim() || !quote.trim() || !url.trim()) return { keep: false, reason: "malformed" };

  // 1. A URL the search returned.
  const nurl = normalizeUrl(url);
  const result = nurl ? evidence.results.find((r) => normalizeUrl(r.url) === nurl) : undefined;
  if (!result) return { keep: false, reason: "url_not_in_search_results" };

  // 2. Quoted on that page, as a citation shows it.
  const q = quoteFold(quote);
  if (q.length < MIN_QUOTE_CHARS) return { keep: false, reason: "quote_too_short" };
  const cited = evidence.citations.some((c) => normalizeUrl(c.url) === nurl && quoteFold(c.cited_text).includes(q));
  if (!cited) return { keep: false, reason: "quote_not_in_citation" };

  // 3. No number the quote does not carry (our scan, and the send gate's rule).
  if (!numbersCovered(fact, quote) || findUnsourcedNumbers(fact, { sources: [quote], companyName: prospect.company_name }).length > 0) {
    return { keep: false, reason: "number_not_in_quote" };
  }

  // 4. Not their own site.
  const host = hostOf(result.url);
  if (!host) return { keep: false, reason: "bad_url" };
  if (ownHosts(prospect).some((own) => host === own || host.endsWith(`.${own}`))) return { keep: false, reason: "own_site" };

  // 5. About this business.
  const name = businessNameTokens(prospect.company_name);
  if (name.join("").length < 4) return { keep: false, reason: "name_too_short" };
  const quoteTokens = nameTokens(quote);
  const titleTokens = nameTokens(result.title ?? "");
  if (!hasTokenRun(quoteTokens, name) && !hasTokenRun(titleTokens, name)) return { keep: false, reason: "name_not_found" };
  const label = domainLabel(prospect);
  const bareDomain = ownHosts(prospect)[0] ?? null;
  const domainTie = (label !== null && urlPathSegments(result.url).includes(label)) || (bareDomain !== null && q.includes(bareDomain));
  const city = prospect.city ? nameTokens(prospect.city) : [];
  const cityTie = city.length > 0 && (hasTokenRun(quoteTokens, city) || hasTokenRun(titleTokens, city));
  const oneCommonWord = name.length === 1 && isCommonWord(name[0]!);
  if (oneCommonWord && !domainTie) return { keep: false, reason: cityTie ? "common_name_needs_domain" : "not_tied_to_business" };
  if (!domainTie && !cityTie) return { keep: false, reason: "not_tied_to_business" };

  // 6. A kind the writers know.
  if (!isWebFactKind(kind)) return { keep: false, reason: "bad_kind" };

  if (kept.some((k) => normalizeUrl(k.url) === nurl && quoteFold(k.quote) === q)) return { keep: false, reason: "duplicate" };
  if (kept.length >= MAX_WEB_FACTS) return { keep: false, reason: "over_limit" };

  return {
    keep: true,
    fact: {
      // Our sentence: banned dashes out (they read corporate and trip spam filters).
      fact: fact.replace(/\s*[—–]\s*/g, ", ").trim(),
      // Their words, exactly as checked against the citation.
      quote: quote.trim(),
      url: result.url,
      title: result.title?.trim() ? result.title.trim() : null,
      kind,
    },
  };
}

export type DroppedCandidate = { candidate: WebFactCandidate; reason: WebFactDropReason };

/** Runs the check over every candidate in order: what is kept (≤ 6) and every drop with its reason. */
export function keepWebFacts(
  candidates: readonly WebFactCandidate[],
  evidence: Pick<ResponseEvidence, "results" | "citations">,
  prospect: KeepProspect,
): { kept: WebFact[]; dropped: DroppedCandidate[] } {
  const kept: WebFact[] = [];
  const dropped: DroppedCandidate[] = [];
  for (const c of candidates) {
    const r = keepWebFact(c, evidence, prospect, kept);
    if (r.keep) kept.push(r.fact);
    else dropped.push({ candidate: c, reason: r.reason });
  }
  return { kept, dropped };
}
