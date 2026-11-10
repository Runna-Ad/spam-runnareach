/**
 * The last check before a draft uses a stored web fact. A dive is cached 60
 * days, and in that time the prospect's name or domain may be corrected, a
 * job post may close and a page may go away. So right before each draft:
 *   1. the fact is re-matched to the prospect as it is NOW (own site, sources
 *      we never use, named in the quote and tied to it: match.ts);
 *   2. its kind is re-checked against the quote, and a problem or an opening
 *      must still be recent;
 *   3. the page must still load: HTTP 200, the same page (no redirect to
 *      another site, another path or another query, which is how a closed
 *      job post or a login wall shows), and no "page not found" or "this job
 *      has expired" in its title or its visible text.
 * Fails closed: a page we cannot load is not used (a site that blocks robots
 * included). Never throws.
 */

import { fetchPage as defaultFetchPage, type FetchPage } from "../site-crawl/fetch-page.ts";
import type { WebFact } from "./facts.ts";
import { blockedSource, hostOf, isAbsenceShaped, isOwnSite, kindFromQuote, recentEnough, tieToBusiness, type MatchProspect } from "./match.ts";

export type UnusableReason =
  | "own_site"
  | "employee_reviews"
  | "auto_profile"
  | "name_too_short"
  | "name_not_in_quote"
  | "not_tied_to_business"
  | "common_name_needs_domain"
  | "absence_claim"
  | "stale_or_undated"
  | "page_not_loading";

export type PageCheck = { ok: true } | { ok: false; detail: string };
export type CheckPage = (url: string) => Promise<PageCheck>;

/** Each page gets this long to answer (they are checked in parallel). */
export const PAGE_CHECK_TIMEOUT_MS = 5_000;

/** A 200 page whose title says it is gone. */
const GONE_TITLE =
  /<title[^>]*>[^<]*(page not found|not found|\b404\b|no longer available|doesn'?t exist|does not exist|has expired|job expired|p[aá]gina no encontrada|no encontrad[oa]|ya no est[aá] disponible)[^<]*<\/title>/i;
/** The same, said in the page's visible text (a closed job post, a deleted post, a removed listing). */
const GONE_TEXT =
  /(this job has expired|this job (posting )?is no longer available|no longer accepting applications|this (page|content|post|listing) (isn'?t|is not|is no longer) available|sorry, this page isn'?t available|the link you followed may be broken|esta vacante (ya )?no est[aá] disponible|esta p[aá]gina no est[aá] disponible)/i;

/** The page's visible text, roughly: scripts, styles and tags out (a bundle's error strings are not the page). */
const visibleText = (html: string): string =>
  html
    .slice(0, 400_000)
    .replace(/<script\b[\s\S]*?<\/script>/gi, " ")
    .replace(/<style\b[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&#39;|&rsquo;|&#x27;/g, "'")
    .replace(/\s+/g, " ");

/** Query keys that only track a click; any other key is part of which page it is (indeed.com/viewjob?jk=…). */
const TRACKING_PARAMS = /^(utm_\w+|fbclid|gclid|igshid|mc_cid|mc_eid|ref|ref_src|from|hl|lang|locale)$/i;

const pageKey = (url: string): string | null => {
  try {
    const u = new URL(url.trim());
    const path = u.pathname.toLowerCase().replace(/\/+$/, "") || "/";
    const query = [...u.searchParams.entries()]
      .filter(([k]) => !TRACKING_PARAMS.test(k))
      .map(([k, v]) => `${k.toLowerCase()}=${v}`)
      .sort()
      .join("&");
    return `${path}?${query}`;
  } catch {
    return null;
  }
};

/** The same page: same bare host (www ignored), same path (case and trailing slash ignored), same query (tracking keys ignored). */
export function samePage(a: string, b: string): boolean {
  const ha = hostOf(a);
  const ka = pageKey(a);
  return ha !== null && ka !== null && ha === hostOf(b) && ka === pageKey(b);
}

/** The live check, built on the crawler's honest fetch (its user agent, its size cap, its bot-wall detection). */
export function pageCheckWith(fetchPage: FetchPage, timeoutMs: number = PAGE_CHECK_TIMEOUT_MS): CheckPage {
  return async (url) => {
    try {
      const r = await fetchPage(url, timeoutMs);
      if (!r.ok) return { ok: false, detail: `${r.error}${r.status ? ` (HTTP ${r.status})` : ""}` };
      if (r.status !== 200) return { ok: false, detail: `HTTP ${r.status}` };
      if (!samePage(url, r.finalUrl)) return { ok: false, detail: `moved to ${r.finalUrl.slice(0, 200)}` };
      if (GONE_TITLE.test(r.html.slice(0, 30_000)) || GONE_TEXT.test(visibleText(r.html))) return { ok: false, detail: "the page says it is gone" };
      return { ok: true };
    } catch (e) {
      return { ok: false, detail: `check failed: ${e instanceof Error ? e.message : String(e)}`.slice(0, 200) };
    }
  };
}

export const checkPageLive: CheckPage = pageCheckWith(defaultFetchPage);

/** Steps 1 and 2 for one stored fact: the fact as a draft may use it (kind re-checked), or why not. Pure. */
export function usableNow(f: WebFact, p: MatchProspect, now: Date): { ok: true; fact: WebFact } | { ok: false; reason: UnusableReason } {
  if (isOwnSite(f.url, p)) return { ok: false, reason: "own_site" };
  const blocked = blockedSource(f.url);
  if (blocked) return { ok: false, reason: blocked };
  const tie = tieToBusiness({ quote: f.quote, url: f.url, title: f.title }, p);
  if (tie) return { ok: false, reason: tie };
  if (isAbsenceShaped(f.quote)) return { ok: false, reason: "absence_claim" };
  const kind = kindFromQuote(f.kind, f.quote);
  if (!recentEnough(kind, f.page_date, now)) return { ok: false, reason: "stale_or_undated" };
  return { ok: true, fact: kind === f.kind ? f : { ...f, kind } };
}

export type UsableResult = { usable: WebFact[]; dropped: Array<{ fact: WebFact; reason: UnusableReason; detail?: string }> };

/** All three steps over a prospect's stored facts. Pages are checked in parallel. Never throws. */
export async function usableWebFacts(
  facts: readonly WebFact[],
  prospect: MatchProspect,
  opts: { now?: Date; checkPage?: CheckPage } = {},
): Promise<UsableResult> {
  const now = opts.now ?? new Date();
  const checkPage = opts.checkPage ?? checkPageLive;
  const dropped: UsableResult["dropped"] = [];
  const candidates: WebFact[] = [];
  for (const f of facts) {
    const r = usableNow(f, prospect, now);
    if (r.ok) candidates.push(r.fact);
    else dropped.push({ fact: f, reason: r.reason });
  }
  const checks = await Promise.all(
    candidates.map((f) => checkPage(f.url).catch((e: unknown): PageCheck => ({ ok: false, detail: String(e).slice(0, 200) }))),
  );
  const usable: WebFact[] = [];
  candidates.forEach((f, i) => {
    const c = checks[i]!;
    if (c.ok) usable.push(f);
    else dropped.push({ fact: f, reason: "page_not_loading", detail: c.detail });
  });
  return { usable, dropped };
}
