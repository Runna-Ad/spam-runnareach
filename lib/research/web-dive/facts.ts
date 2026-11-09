/**
 * Web facts: what the web dive (migration 0055, lib/research/web-dive/) kept
 * about a prospect from pages OTHER than its own website. Every fact carries
 * the page URL and the exact words on it (`quote`) that show it; the keep-check
 * (keep.ts keepWebFact) proved both against the search results and citations
 * before the fact was stored.
 *
 * This file is the contract the email writers code against. Pure: no imports.
 */

/**
 * problem  something the business or its customers say is not working
 *          (a review saying nobody answers, a post about a booking outage)
 * opening  a change that makes them likely to need help (new location, hiring
 *          front-desk or marketing staff, a launch, an award)
 * context  anything else true and useful (what they offer, where, since when)
 */
export type WebFactKind = "problem" | "opening" | "context";

export type WebFact = { fact: string; quote: string; url: string; title: string | null; kind: WebFactKind };

/** A dive older than this is not read (and the prospect may be dived again). */
export const WEB_FACTS_MAX_AGE_DAYS = 60;

export const WEB_FACT_KINDS: readonly WebFactKind[] = ["problem", "opening", "context"];

/** At most this many facts are kept per prospect. */
export const MAX_WEB_FACTS = 6;

/** A quote shorter than this proves nothing (the keep-check's rule 2). */
export const MIN_QUOTE_CHARS = 20;

export const isWebFactKind = (v: unknown): v is WebFactKind =>
  typeof v === "string" && (WEB_FACT_KINDS as readonly string[]).includes(v);

const nonEmpty = (v: unknown): v is string => typeof v === "string" && v.trim().length > 0;

/**
 * One stored entry re-validated to the WebFact shape, or null. Used on every
 * read: a row written by an older or broken writer never reaches an email in
 * a shape the writer does not expect.
 */
export function asWebFact(raw: unknown): WebFact | null {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  if (!nonEmpty(r.fact) || !nonEmpty(r.quote) || !nonEmpty(r.url) || !isWebFactKind(r.kind)) return null;
  if (r.quote.trim().length < MIN_QUOTE_CHARS) return null;
  if (!/^https?:\/\//i.test(r.url.trim())) return null;
  const title = r.title === null || r.title === undefined ? null : typeof r.title === "string" ? r.title : undefined;
  if (title === undefined) return null;
  return { fact: r.fact, quote: r.quote, url: r.url, title, kind: r.kind };
}

/** A stored facts column (jsonb) as WebFacts: bad entries dropped, at most MAX_WEB_FACTS. */
export function webFactsFromJson(raw: unknown): WebFact[] {
  if (!Array.isArray(raw)) return [];
  const out: WebFact[] = [];
  for (const entry of raw) {
    const f = asWebFact(entry);
    if (f) out.push(f);
    if (out.length >= MAX_WEB_FACTS) break;
  }
  return out;
}
