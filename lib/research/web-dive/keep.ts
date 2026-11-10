/**
 * The keep-check of the web dive: a web fact survives only when code can show
 * where it came from (the page URL and the exact words on it) and that it is
 * about THIS business. Pure, fail closed, one reason per drop (brief
 * tasks/briefs/web-dive.md, "The keep-check"; tightened 2026-11-09, see match.ts).
 *
 * Search result content comes back encrypted, so the only page text we can
 * read is what the model cites. A fact is kept when:
 *   1. its URL is one the search returned (normalizeUrl, lib/benchmarks/research.ts);
 *   2. a citation from that same URL contains the quote (20+ characters), both
 *      lowercased, accents kept, whitespace collapsed, curly quotes straightened;
 *   3. every number in the fact is in the quote (numbersCovered, plus the send
 *      gate's own rule, findUnsourcedNumbers);
 *   4. the page is not on the prospect's own domain (the crawler reads that),
 *      and not a source we never use: employee reviews (Indeed company pages,
 *      Glassdoor) or auto-generated profiles (match.ts blockedSource);
 *   5. the QUOTE names the business (the title alone only on its own social
 *      profile) and the page is tied to it: its own profile, its domain in the
 *      quote, or its city in the QUOTE; a one-common-word name needs the
 *      profile or domain tie (match.ts tieToBusiness); and the quote is not
 *      shaped like an absence ("X does not offer Y", match.ts isAbsenceShaped);
 *   6. its kind is one of the three, and stays "problem"/"opening" only when
 *      the quote shows one (else it is kept as "context": match.ts kindFromQuote);
 *   7. a problem or an opening has a recent page date from the search result
 *      (match.ts recentEnough): undated or old, it is dropped.
 * Its matching is its own (token runs over a folded copy), not the model's.
 */

import { normalizeUrl, numbersCovered, type ResponseEvidence } from "../../benchmarks/research.ts";
import { findUnsourcedNumbers } from "../../pitches/content-rules.ts";
import { isWebFactKind, MAX_WEB_FACTS, MIN_QUOTE_CHARS, type WebFact } from "./facts.ts";
import { blockedSource, decodeEntities, hostOf, isAbsenceShaped, isOwnSite, kindFromQuote, pageDateFrom, quoteFold, recentEnough, tieToBusiness, type MatchProspect, type TieReason } from "./match.ts";

// The folds and the name/URL helpers live in match.ts (shared with the read before a draft).
export { businessNameTokens, domainLabel, hasTokenRun, isCommonWord, nameTokens, quoteFold, urlPathSegments } from "./match.ts";

export type WebFactCandidate = { fact: string; quote: string; url: string; kind: string };

export type KeepProspect = MatchProspect;

export type WebFactDropReason =
  | "malformed"
  | "url_not_in_search_results"
  | "quote_too_short"
  | "quote_not_in_citation"
  | "number_not_in_quote"
  | "bad_url"
  | "own_site"
  | "employee_reviews"
  | "auto_profile"
  | TieReason
  | "absence_claim"
  | "bad_kind"
  | "stale_or_undated"
  | "duplicate"
  | "over_limit";

export type KeepResult = { keep: true; fact: WebFact } | { keep: false; reason: WebFactDropReason };

// ── The check ────────────────────────────────────────────────────────────────

/**
 * Rules 1-7 for one candidate. Every branch that cannot confirm returns
 * keep: false with the first rule it failed. `kept` are the facts already kept
 * for this prospect (duplicates and the 6-fact limit).
 */
export function keepWebFact(
  candidate: WebFactCandidate,
  evidence: Pick<ResponseEvidence, "results" | "citations">,
  prospect: KeepProspect,
  kept: readonly WebFact[] = [],
  now: Date = new Date(),
): KeepResult {
  const { url, kind } = candidate;
  if (typeof candidate.fact !== "string" || typeof candidate.quote !== "string" || typeof url !== "string" || typeof kind !== "string") {
    return { keep: false, reason: "malformed" };
  }
  // HTML entities decoded once, first ("&amp;" is "&"; "&#39;" is no number): every rule reads, and we store, the plain text.
  const fact = decodeEntities(candidate.fact);
  const quote = decodeEntities(candidate.quote);
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

  // 4. Not their own site, not a source we never use.
  if (!hostOf(result.url)) return { keep: false, reason: "bad_url" };
  if (isOwnSite(result.url, prospect)) return { keep: false, reason: "own_site" };
  const blocked = blockedSource(result.url);
  if (blocked) return { keep: false, reason: blocked };

  // 5. About this business: named in the quote, tied to it.
  const title = result.title?.trim() ? decodeEntities(result.title.trim()) : null;
  const tie = tieToBusiness({ quote, url: result.url, title }, prospect);
  if (tie) return { keep: false, reason: tie };
  // An absence is never said, whoever wrote it (profile and FAQ templates do).
  if (isAbsenceShaped(quote)) return { keep: false, reason: "absence_claim" };

  // 6. A kind the writers know, and only as strong as the quote shows.
  if (!isWebFactKind(kind)) return { keep: false, reason: "bad_kind" };
  const shownKind = kindFromQuote(kind, quote);

  // 7. A problem or an opening from a recently dated page.
  const page_date = pageDateFrom(result.page_age, now);
  if (!recentEnough(shownKind, page_date, now)) return { keep: false, reason: "stale_or_undated" };

  if (kept.some((k) => normalizeUrl(k.url) === nurl && quoteFold(k.quote) === q)) return { keep: false, reason: "duplicate" };
  if (kept.length >= MAX_WEB_FACTS) return { keep: false, reason: "over_limit" };

  return {
    keep: true,
    fact: {
      // Our sentence: banned dashes out (they read corporate and trip spam filters).
      fact: fact.replace(/\s*[—–]\s*/g, ", ").trim(),
      // Their words, exactly as checked against the citation (HTML entities decoded: "&amp;" is "&").
      quote: quote.trim(),
      url: result.url,
      title,
      kind: shownKind,
      page_date,
    },
  };
}

export type DroppedCandidate = { candidate: WebFactCandidate; reason: WebFactDropReason };

/** Runs the check over every candidate in order: what is kept (≤ 6) and every drop with its reason. */
export function keepWebFacts(
  candidates: readonly WebFactCandidate[],
  evidence: Pick<ResponseEvidence, "results" | "citations">,
  prospect: KeepProspect,
  now: Date = new Date(),
): { kept: WebFact[]; dropped: DroppedCandidate[] } {
  const kept: WebFact[] = [];
  const dropped: DroppedCandidate[] = [];
  for (const c of candidates) {
    const r = keepWebFact(c, evidence, prospect, kept, now);
    if (r.keep) kept.push(r.fact);
    else dropped.push({ candidate: c, reason: r.reason });
  }
  return { kept, dropped };
}
