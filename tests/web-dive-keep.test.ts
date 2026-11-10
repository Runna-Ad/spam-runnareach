/**
 * web-dive keep-check (brief tasks/briefs/web-dive.md, "The keep-check";
 * tightened 2026-11-09 after Pedro's real sample kept 9 facts and none was fit
 * to send). A web fact is kept only when code can show the page and the exact
 * words on it, about THIS business, from a source we use, as strong as the
 * quote shows and, for a problem or an opening, recent. Each rule both ways,
 * then a property test whose matching is its own (a letters-only fold, plain
 * digit runs), as the fail-closed rule asks.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { asWebFact, MAX_WEB_FACTS, webFactsFromJson } from "../lib/research/web-dive/facts.ts";
import {
  businessNameTokens,
  hasTokenRun,
  isCommonWord,
  keepWebFact,
  keepWebFacts,
  nameTokens,
  quoteFold,
  urlPathSegments,
  type KeepProspect,
  type WebFactCandidate,
} from "../lib/research/web-dive/keep.ts";
import { blockedSource, decodeEntities, isAbsenceShaped, isOwnProfile, kindFromQuote, OPENING_MAX_AGE_DAYS, pageDateFrom, PROBLEM_MAX_AGE_DAYS, recentEnough, SEARCH_BLOCKED_DOMAINS } from "../lib/research/web-dive/match.ts";

const NOW = new Date("2026-11-09T18:00:00Z");
const P: KeepProspect = { company_name: "CrushCamp Inc.", city: "Calgary", domain: "crushcamp.ca", website_url: "https://crushcamp.ca" };

const YELP = "https://www.yelp.ca/biz/crushcamp-calgary";
const IG = "https://www.instagram.com/crushcamp/";
const OWN = "https://crushcamp.ca/about";
const SUB = "https://shop.crushcamp.ca/classes";
const NEWS = "https://calgaryherald.com/news/gyms-hiring";
const AUSTIN = "https://www.yelp.com/biz/crushcamp-austin";
const JOBS = "https://ca.indeed.com/viewjob?jk=1";
const LIST = "https://www.avenuecalgary.com/best-gyms-2026";
const INDEED_CMP = "https://ca.indeed.com/cmp/Crushcamp/reviews";
const GLASSDOOR = "https://www.glassdoor.ca/Reviews/CrushCamp-Reviews-E123.htm";
const WHEREE = "https://ca.wheree.com/crushcamp-calgary";
const OLD = "https://calgaryjournal.ca/2020/03/crushcamp-opens";

type Result = { url: string; title: string; page_age?: string | null };
const RESULTS: Result[] = [
  { url: YELP, title: "CrushCamp - Calgary, AB - Yelp", page_age: "October 20, 2026" },
  { url: IG, title: "CrushCamp (@crushcamp) • Instagram photos and videos", page_age: "3 weeks ago" },
  { url: OWN, title: "About CrushCamp" },
  { url: SUB, title: "Classes" },
  { url: NEWS, title: "Gyms in Calgary are hiring", page_age: "2026-10-01T12:00:00Z" },
  { url: AUSTIN, title: "Crush Camp - Austin, TX - Yelp", page_age: "1 month ago" },
  { url: JOBS, title: "Front Desk Coordinator - CrushCamp - Calgary, AB", page_age: "5 days ago" },
  { url: LIST, title: "The best gyms in Calgary: CrushCamp, Fit Lab, Sweat Society", page_age: "2026-10-15" },
  { url: INDEED_CMP, title: "Working at CrushCamp: Employee Reviews | Indeed.com", page_age: "2 weeks ago" },
  { url: GLASSDOOR, title: "CrushCamp Reviews | Glassdoor", page_age: "2 weeks ago" },
  { url: WHEREE, title: "CrushCamp, Calgary - Wheree", page_age: "2 weeks ago" },
  { url: OLD, title: "CrushCamp opens in Calgary", page_age: "March 3, 2020" },
];
const CITATIONS = [
  { url: YELP, cited_text: "Love the coaches at CrushCamp in Calgary, but I called three times and nobody ever answered the phone." },
  { url: IG, cited_text: "CrushCamp is opening our second studio in Bridgeland this spring! Opening our second studio in Bridgeland, see you there." },
  { url: OWN, cited_text: "CrushCamp has trained over 500 members since 2019." },
  { url: SUB, cited_text: "CrushCamp classes run 6 days a week for every level." },
  { url: NEWS, cited_text: "Several gyms in the city are hiring front desk staff this fall." },
  { url: AUSTIN, cited_text: "Crush Camp has the best coaches in Austin, nobody beats them." },
  { url: JOBS, cited_text: "We are hiring a Front Desk Coordinator to answer calls and book classes at CrushCamp in Calgary." },
  { url: LIST, cited_text: "Fit Lab just opened its second location in Kensington. CrushCamp offers small group classes in Calgary for every level." },
  { url: INDEED_CMP, cited_text: "At CrushCamp in Calgary, management never answers the phone and shifts get cancelled." },
  { url: GLASSDOOR, cited_text: "At CrushCamp in Calgary, management never answers the phone and shifts get cancelled." },
  { url: WHEREE, cited_text: "CrushCamp is a fitness studio in Calgary that offers personalized training programs." },
  { url: OLD, cited_text: "CrushCamp opens its first studio in Calgary this week, with a new class every day." },
];
const EVIDENCE = { results: RESULTS, citations: CITATIONS };

const REVIEW: WebFactCandidate = {
  fact: "A Yelp reviewer says nobody ever answered the phone.",
  quote: "CrushCamp in Calgary, but I called three times and nobody ever answered the phone",
  url: YELP,
  kind: "problem",
};
const OPENING: WebFactCandidate = {
  fact: "CrushCamp is opening a second studio in Bridgeland.",
  quote: "CrushCamp is opening our second studio in Bridgeland",
  url: IG,
  kind: "opening",
};
const HIRING: WebFactCandidate = {
  fact: "CrushCamp is hiring a front desk coordinator to answer calls.",
  quote: "We are hiring a Front Desk Coordinator to answer calls and book classes at CrushCamp in Calgary",
  url: JOBS,
  kind: "opening",
};

const reason = (c: WebFactCandidate, p: KeepProspect = P, ev: { results: Result[]; citations: typeof CITATIONS } = EVIDENCE, now = NOW) => {
  const r = keepWebFact(c, ev, p, [], now);
  return r.keep ? "kept" : r.reason;
};
const keptKind = (c: WebFactCandidate, p: KeepProspect = P, ev = EVIDENCE) => {
  const r = keepWebFact(c, ev, p, [], NOW);
  return r.keep ? r.fact.kind : `dropped: ${r.reason}`;
};

test("kept: a review naming them and their city, their own profile, a job post; the stored fact carries the result's url, title and page date", () => {
  for (const c of [REVIEW, OPENING, HIRING]) assert.equal(reason(c), "kept", c.url);
  const r = keepWebFact(REVIEW, EVIDENCE, P, [], NOW);
  assert.ok(r.keep);
  assert.deepEqual(r.fact, { fact: REVIEW.fact, quote: REVIEW.quote, url: YELP, title: "CrushCamp - Calgary, AB - Yelp", kind: "problem", page_date: "2026-10-20" });
  // The URL may differ only by a trailing slash or a #fragment (normalizeUrl); the result's own URL is stored.
  const r2 = keepWebFact({ ...OPENING, url: "https://www.instagram.com/crushcamp#top" }, EVIDENCE, P, [], NOW);
  assert.ok(r2.keep);
  assert.equal(r2.fact.url, IG);
  assert.equal(r2.fact.page_date, "2026-10-19", "3 weeks before the dive");
});

test("rule 1: a URL the search did not return is dropped", () => {
  assert.equal(reason({ ...REVIEW, url: "https://www.yelp.ca/biz/crushcamp-calgary?page=2" }), "url_not_in_search_results");
  assert.equal(reason({ ...REVIEW, url: "https://example.com/made-up" }), "url_not_in_search_results");
});

test("rule 2: the quote must be 20+ characters and inside a citation from the SAME URL", () => {
  assert.equal(reason({ ...REVIEW, quote: "nobody answered" }), "quote_too_short");
  assert.equal(reason({ ...REVIEW, quote: "the staff at CrushCamp in Calgary never call back" }), "quote_not_in_citation");
  // A real quote, but from another page's citation.
  assert.equal(reason({ ...REVIEW, quote: "CrushCamp is opening our second studio in Bridgeland" }), "quote_not_in_citation");
  // An edited quote (ellipsis) is not verbatim.
  assert.equal(reason({ ...REVIEW, quote: "CrushCamp in Calgary ... nobody ever answered" }), "quote_not_in_citation");
});

test("rule 2 fold: case, whitespace and curly quotes are forgiven; accents are not", () => {
  assert.equal(quoteFold("  Nobody\n ever “answered”  "), 'nobody ever "answered"');
  const ev = {
    results: [{ url: YELP, title: "CrushCamp - Calgary, AB - Yelp", page_age: "2 weeks ago" }],
    citations: [{ url: YELP, cited_text: "CrushCamp's café in Calgary is closed on Mondays, which nobody told us." }],
  };
  const c = { ...REVIEW, kind: "context" };
  assert.equal(reason({ ...c, quote: "CRUSHCAMP’S café in   Calgary is closed on Mondays" }, P, ev), "kept");
  assert.equal(reason({ ...c, quote: "CrushCamp's cafe in Calgary is closed on Mondays" }, P, ev), "quote_not_in_citation");
});

test("rule 3: a number in the fact that the quote does not carry is dropped", () => {
  assert.equal(reason({ ...OPENING, fact: "CrushCamp is opening its 2nd studio in Bridgeland in 2025." }), "number_not_in_quote");
  const ev = {
    results: [{ url: YELP, title: "CrushCamp - Calgary, AB - Yelp", page_age: "2 weeks ago" }],
    citations: [{ url: YELP, cited_text: "Waited 45 minutes for a class that never started at CrushCamp in Calgary." }],
  };
  const quote = "Waited 45 minutes for a class that never started at CrushCamp in Calgary";
  assert.equal(reason({ ...REVIEW, fact: "A reviewer waited 45 minutes for a class.", quote }, P, ev), "kept");
  assert.equal(reason({ ...REVIEW, fact: "A reviewer waited 50 minutes for a class.", quote }, P, ev), "number_not_in_quote");
});

test("rule 4: their own domain and its subdomains are the crawler's, never the dive's", () => {
  assert.equal(reason({ fact: "CrushCamp has trained over 500 members.", quote: "CrushCamp has trained over 500 members", url: OWN, kind: "context" }), "own_site");
  assert.equal(reason({ fact: "CrushCamp runs classes for every level.", quote: "CrushCamp classes run 6 days a week for every level", url: SUB, kind: "context" }), "own_site");
  // The website's host counts too when the domain field is empty.
  assert.equal(reason({ fact: "CrushCamp has trained over 500 members.", quote: "CrushCamp has trained over 500 members", url: OWN, kind: "context" }, { ...P, domain: null }), "own_site");
});

test("rule 4 sources: employee reviews and auto-generated profiles are never kept; a job post and a news page are", () => {
  const staff = { fact: "Staff say management never answers.", quote: "At CrushCamp in Calgary, management never answers the phone", kind: "problem" };
  assert.equal(reason({ ...staff, url: INDEED_CMP }), "employee_reviews");
  assert.equal(reason({ ...staff, url: GLASSDOOR }), "employee_reviews");
  assert.equal(reason({ fact: "CrushCamp offers personalized training.", quote: "CrushCamp is a fitness studio in Calgary that offers personalized training programs", url: WHEREE, kind: "context" }), "auto_profile");
  // Indeed's job posts are fine: only its /cmp/ company pages (reviews, salaries) are blocked.
  assert.equal(reason(HIRING), "kept");
  assert.equal(blockedSource("https://ca.indeed.com/viewjob?jk=1"), null);
  assert.equal(blockedSource("https://www.indeed.com/cmp/Crushcamp"), "employee_reviews");
  assert.equal(blockedSource("https://mx.indeed.com/cmp/Crushcamp/salaries"), "employee_reviews");
  for (const u of [
    "https://www.glassdoor.com/Overview/x.htm", "https://www.comparably.com/companies/x", "https://www.kununu.com/de/x",
  ]) assert.equal(blockedSource(u), "employee_reviews", u);
  for (const u of [
    "https://wheree.com/x", "https://tracxn.com/d/companies/x", "https://www.zoominfo.com/c/x/1", "https://reviews.birdeye.com/x",
    "https://www.cylex.ca/calgary/x.html", "https://www.cylex-canada.ca/x", "https://www.canpages.ca/business/x", "https://www.companiesup.com/x",
    "https://rocketreach.co/x", "https://www.crunchbase.com/organization/x", "https://www.manta.com/c/x",
  ]) assert.equal(blockedSource(u), "auto_profile", u);
  for (const u of ["https://calgaryherald.com/news/x", "https://www.yelp.ca/biz/x", "https://www.instagram.com/x", "https://www.seccion-amarilla.com.mx/x"]) {
    assert.equal(blockedSource(u), null, u);
  }
  assert.equal(blockedSource("not a url"), "auto_profile", "unparseable: blocked");
  // The search is told to skip whole sites (plain hostnames); every one of them is also blocked in code.
  for (const d of SEARCH_BLOCKED_DOMAINS) assert.notEqual(blockedSource(`https://${d}/x`), null, d);
});

test("rule 5: the QUOTE must name the business; a review that only the page title names is dropped", () => {
  assert.equal(reason({ fact: "Gyms in the city are hiring front desk staff.", quote: "Several gyms in the city are hiring front desk staff", url: NEWS, kind: "opening" }), "name_not_in_quote");
  // The old keep: a Yelp review whose quote never says CrushCamp (only the title does).
  assert.equal(reason({ ...REVIEW, quote: "I called three times and nobody ever answered the phone" }), "name_not_in_quote");
  assert.equal(reason(HIRING, { ...P, company_name: "ABC Ltd" }), "name_too_short");
});

test("rule 5: the title alone counts only on their own profile (a whole path segment is their domain label)", () => {
  const noName = { fact: "They are opening a second studio.", quote: "Opening our second studio in Bridgeland, see you there", kind: "opening" };
  assert.equal(reason({ ...noName, url: IG }), "kept", "instagram.com/crushcamp, titled CrushCamp");
  // Same words, the title names them, but the page is not theirs (a directory slug with the city added).
  const ev = {
    results: [...RESULTS, { url: "https://www.yelp.ca/biz/crushcamp-calgary-2", title: "CrushCamp - Calgary, AB - Yelp", page_age: "2 weeks ago" }],
    citations: [...CITATIONS, { url: "https://www.yelp.ca/biz/crushcamp-calgary-2", cited_text: "Opening our second studio in Bridgeland, see you there" }],
  };
  assert.equal(reason({ ...noName, url: "https://www.yelp.ca/biz/crushcamp-calgary-2" }, P, ev), "name_not_in_quote");
});

test("rule 5 probe: a listicle titled '…CrushCamp, Fit Lab…' never gives CrushCamp Fit Lab's news; its line about CrushCamp is kept", () => {
  assert.equal(reason({ fact: "CrushCamp opened a second location.", quote: "Fit Lab just opened its second location in Kensington", url: LIST, kind: "opening" }), "name_not_in_quote");
  assert.equal(keptKind({ fact: "CrushCamp offers small group classes.", quote: "CrushCamp offers small group classes in Calgary for every level", url: LIST, kind: "context" }), "context");
});

test("rule 5: the city counts only from the quote (a title's city is the page's, not theirs)", () => {
  const ev = {
    results: [{ url: NEWS, title: "Gyms in Calgary are hiring", page_age: "2 weeks ago" }],
    citations: [{ url: NEWS, cited_text: "CrushCamp is hiring two coaches for its new studio. CrushCamp is hiring two coaches in Calgary." }],
  };
  const c = { fact: "CrushCamp is hiring coaches.", url: NEWS, kind: "opening" };
  assert.equal(reason({ ...c, quote: "CrushCamp is hiring two coaches for its new studio" }, P, ev), "not_tied_to_business");
  assert.equal(reason({ ...c, quote: "CrushCamp is hiring two coaches in Calgary" }, P, ev), "kept");
});

test("rule 5: a same-name business in another city is dropped (the Yelp slug adds its city, no Calgary, no domain)", () => {
  assert.equal(
    reason({ fact: "Crush Camp has the best coaches.", quote: "Crush Camp has the best coaches in Austin", url: AUSTIN, kind: "context" }),
    "not_tied_to_business",
  );
});

test("rule 5: a one-common-word name needs the domain tie; its city alone is not enough", () => {
  assert.equal(isCommonWord("summit"), true);
  assert.equal(isCommonWord("crushcamp"), false);
  const S: KeepProspect = { company_name: "Summit", city: "Calgary", domain: "summitfitness.ca", website_url: null };
  const YS = "https://www.yelp.ca/biz/summit-calgary";
  const IS = "https://www.instagram.com/summitfitness";
  const ev = {
    results: [{ url: YS, title: "Summit - Calgary, AB - Yelp", page_age: "2 weeks ago" }, { url: IS, title: "Summit (@summitfitness)", page_age: "2 weeks ago" }],
    citations: [
      { url: YS, cited_text: "Summit is the friendliest gym in Calgary, highly recommend it. Book at summitfitness.ca today." },
      { url: IS, cited_text: "Summit is hiring two front desk coordinators for our Calgary studio." },
    ],
  };
  assert.equal(reason({ fact: "Summit is a friendly gym.", quote: "Summit is the friendliest gym in Calgary", url: YS, kind: "context" }, S, ev), "common_name_needs_domain");
  // The quote names their domain: tied.
  assert.equal(reason({ fact: "Summit is a friendly gym.", quote: "Summit is the friendliest gym in Calgary, highly recommend it. Book at summitfitness.ca", url: YS, kind: "context" }, S, ev), "kept");
  // A profile named after the (distinctive) domain label: tied.
  assert.equal(reason({ fact: "Summit is hiring front desk coordinators.", quote: "Summit is hiring two front desk coordinators", url: IS, kind: "opening" }, S, ev), "kept");
});

test("rule 5: a social handle that is itself a common word ties nobody (instagram.com/sweat is anybody called Sweat)", () => {
  const S: KeepProspect = { company_name: "Sweat", city: "Calgary", domain: "sweat.ca", website_url: null };
  const IG_SWEAT = "https://www.instagram.com/sweat";
  const ev = {
    results: [{ url: IG_SWEAT, title: "Sweat (@sweat) • Instagram", page_age: "2 weeks ago" }],
    citations: [{ url: IG_SWEAT, cited_text: "Sweat is opening a new studio downtown. Sweat is opening a new studio, book at sweat.ca now." }],
  };
  const c = { fact: "Sweat is opening a new studio.", url: IG_SWEAT, kind: "opening" };
  assert.equal(reason({ ...c, quote: "Sweat is opening a new studio downtown" }, S, ev), "not_tied_to_business");
  assert.equal(reason({ ...c, quote: "Sweat is opening a new studio, book at sweat.ca now" }, S, ev), "kept");
});

test("rule 5 tie: the domain label must be a whole path segment, and the domain in the quote a whole domain", () => {
  assert.deepEqual(urlPathSegments("https://www.tiktok.com/@crush_camp?lang=en"), ["crushcamp"]);
  assert.deepEqual(urlPathSegments(AUSTIN), ["biz", "crushcampaustin"]);
  assert.deepEqual(urlPathSegments("https://crushcamp.com/"), []);
  const ev = {
    results: [
      { url: "https://crushcamp.com/news", title: "News", page_age: "2 weeks ago" },
      { url: "https://www.instagram.com/crushcampyyc", title: "Instagram", page_age: "2 weeks ago" },
      { url: NEWS, title: "News", page_age: "2 weeks ago" },
    ],
    citations: [
      { url: "https://crushcamp.com/news", cited_text: "CrushCamp opens a new studio downtown next month." },
      { url: "https://www.instagram.com/crushcampyyc", cited_text: "CrushCamp opens a new studio downtown next month." },
      { url: NEWS, cited_text: "CrushCamp opens a new studio, see notcrushcamp.ca for it. CrushCamp opens a new studio, see crushcamp.ca." },
    ],
  };
  const c = { fact: "CrushCamp opens a new studio downtown.", quote: "CrushCamp opens a new studio downtown", kind: "opening" };
  assert.equal(reason({ ...c, url: "https://crushcamp.com/news" }, P, ev), "not_tied_to_business");
  assert.equal(reason({ ...c, url: "https://www.instagram.com/crushcampyyc" }, P, ev), "not_tied_to_business");
  assert.equal(reason({ ...c, quote: "CrushCamp opens a new studio, see notcrushcamp.ca for it", url: NEWS }, P, ev), "not_tied_to_business");
  assert.equal(reason({ ...c, quote: "CrushCamp opens a new studio, see crushcamp.ca", url: NEWS }, P, ev), "kept");
});

test("rule 6: an unknown kind is dropped; malformed candidates are dropped first", () => {
  assert.equal(reason({ ...REVIEW, kind: "news" }), "bad_kind");
  assert.equal(reason({ ...REVIEW, fact: "  " }), "malformed");
  assert.equal(reason({ ...REVIEW, url: "" }), "malformed");
  assert.equal(reason({ ...REVIEW, quote: 7 as unknown as string }), "malformed");
});

test("rule 6 kind: 'problem' and 'opening' only when the quote shows one; otherwise kept as context", () => {
  // The sample's employee review "great team" labelled problem: only context.
  assert.equal(keptKind({ ...REVIEW, quote: "Love the coaches at CrushCamp in Calgary" }), "context");
  assert.equal(keptKind(REVIEW), "problem");
  assert.equal(keptKind({ ...OPENING, quote: "CrushCamp offers small group classes in Calgary for every level", url: LIST }), "context");
  assert.equal(keptKind(OPENING), "opening");
  // Coarse, EN and ES.
  assert.equal(kindFromQuote("problem", "Nadie contesta el teléfono en CrushCamp"), "problem");
  assert.equal(kindFromQuote("problem", "No contestan los correos"), "problem");
  assert.equal(kindFromQuote("problem", "Excelente servicio y muy buena atención"), "context");
  assert.equal(kindFromQuote("opening", "Abrimos nuestra nueva sucursal en Polanco"), "opening");
  assert.equal(kindFromQuote("opening", "Estamos contratando recepcionista"), "opening");
  assert.equal(kindFromQuote("opening", "Clases para todos los niveles"), "context");
  assert.equal(kindFromQuote("problem", "Waited forever on hold, then the line went dead"), "problem");
  assert.equal(kindFromQuote("context", "Nobody ever answered"), "context", "context is never raised");
});

test("rule 7: a problem or an opening needs a recent page date; context does not", () => {
  // The sample's 2020 article on a dead site: an opening, five years old.
  assert.equal(reason({ fact: "CrushCamp opens its first studio.", quote: "CrushCamp opens its first studio in Calgary this week", url: OLD, kind: "opening" }), "stale_or_undated");
  // The same page's words as context are fine (true then, no reason to write now).
  assert.equal(keptKind({ fact: "CrushCamp opened in Calgary.", quote: "CrushCamp opens its first studio in Calgary this week", url: OLD, kind: "context" }), "context");
  // Undated: dropped as a problem.
  const undated = { results: RESULTS.map((r) => (r.url === YELP ? { ...r, page_age: null } : r)), citations: CITATIONS };
  assert.equal(reason(REVIEW, P, undated), "stale_or_undated");
  // A review 300 days old is fine, 400 is not.
  const dated = (age: string) => ({ results: RESULTS.map((r) => (r.url === YELP ? { ...r, page_age: age } : r)), citations: CITATIONS });
  assert.equal(reason(REVIEW, P, dated("2026-01-13")), "kept");
  assert.equal(reason(REVIEW, P, dated("2025-10-05")), "stale_or_undated");
  // An opening 100 days old is fine, 200 is not.
  const igDated = (age: string) => ({ results: RESULTS.map((r) => (r.url === IG ? { ...r, page_age: age } : r)), citations: CITATIONS });
  assert.equal(reason(OPENING, P, igDated("100 days ago")), "kept");
  assert.equal(reason(OPENING, P, igDated("200 days ago")), "stale_or_undated");
});

test("page dates: the forms the search gives are read; anything else is no date (fail closed)", () => {
  assert.equal(pageDateFrom("April 30, 2026", NOW), "2026-04-30");
  assert.equal(pageDateFrom("Apr 30, 2026", NOW), "2026-04-30");
  assert.equal(pageDateFrom("Sept. 3, 2026", NOW), "2026-09-03");
  assert.equal(pageDateFrom("30 April 2026", NOW), "2026-04-30");
  assert.equal(pageDateFrom("2026-04-30T10:00:00Z", NOW), "2026-04-30");
  assert.equal(pageDateFrom("2026-04-30", NOW), "2026-04-30");
  assert.equal(pageDateFrom("3 days ago", NOW), "2026-11-06");
  assert.equal(pageDateFrom("a month ago", NOW), "2026-10-10");
  assert.equal(pageDateFrom("2 years ago", NOW), "2024-11-09");
  assert.equal(pageDateFrom("5 hours ago", NOW), "2026-11-09");
  assert.equal(pageDateFrom("yesterday", NOW), "2026-11-08");
  for (const bad of [null, undefined, "", "sometime last year", "February 30, 2026", "2026-13-01", "Smarch 3, 2026", 20261101, "December 25, 2026"]) {
    assert.equal(pageDateFrom(bad, NOW), null, String(bad));
  }
  assert.equal(PROBLEM_MAX_AGE_DAYS, 365);
  assert.equal(OPENING_MAX_AGE_DAYS, 180);
  assert.equal(recentEnough("context", null, NOW), true);
  assert.equal(recentEnough("problem", null, NOW), false);
  assert.equal(recentEnough("opening", "not a date", NOW), false);
  assert.equal(recentEnough("opening", "2026-05-13", NOW), true);
  assert.equal(recentEnough("opening", "2026-05-12", NOW), false);
});

test("name folds: legal suffixes off the end, punctuation removed, accents stripped, joined compare", () => {
  assert.deepEqual(businessNameTokens("Grupo Ferretero S.A. de C.V."), ["grupo", "ferretero"]);
  assert.deepEqual(businessNameTokens("Acme S. de R.L. de C.V."), ["acme"]);
  assert.deepEqual(businessNameTokens("Clinique Dentaire Ltée"), ["clinique", "dentaire"]);
  assert.deepEqual(businessNameTokens("Smith Professional Corporation"), ["smith"]);
  assert.deepEqual(businessNameTokens("Inc Studio Inc."), ["inc", "studio"], "only from the end");
  assert.deepEqual(nameTokens("Café O'Neil’s"), ["cafe", "oneils"]);
  assert.ok(hasTokenRun(nameTokens("Book at Crush Camp today"), ["crushcamp"]));
  assert.ok(hasTokenRun(nameTokens("Book at CrushCamp today"), ["crush", "camp"]));
  assert.ok(!hasTokenRun(nameTokens("our crushcampaign starts"), ["crushcamp"]));
  // A Mexican legal suffix in the quote does not stop the match.
  const GF = "https://www.seccion-amarilla.com.mx/empresas/grupo-ferretero";
  const ev = {
    results: [{ url: GF, title: "Grupo Ferretero - Monterrey", page_age: "hace 2 semanas" }, { url: `${GF}-2`, title: "Grupo Ferretero - Monterrey", page_age: "2 weeks ago" }],
    citations: [
      { url: GF, cited_text: "Grupo Ferretero S.A. de C.V. abrió una nueva sucursal en Monterrey." },
      { url: `${GF}-2`, cited_text: "Grupo Ferretero S.A. de C.V. abrió una nueva sucursal en Monterrey." },
    ],
  };
  const gf: KeepProspect = { company_name: "Grupo Ferretero, S.A. de C.V.", city: "Monterrey", domain: "grupoferretero.mx", website_url: null };
  const c = { fact: "Grupo Ferretero abrió una nueva sucursal.", quote: "Grupo Ferretero S.A. de C.V. abrió una nueva sucursal en Monterrey", kind: "opening" };
  assert.equal(reason({ ...c, url: `${GF}-2` }, gf, ev), "kept");
  // A Spanish relative date reads too ("hace 2 semanas").
  assert.equal(reason({ ...c, url: GF }, gf, ev), "kept");
});

test("duplicates and the 6-fact limit; dashes out of our sentence, their quote kept verbatim", () => {
  const long = "Line one about CrushCamp classes in Calgary. Line two about CrushCamp coaches in Calgary. Line three about CrushCamp hours in Calgary. Line four about CrushCamp prices in Calgary. Line five about CrushCamp parking in Calgary. Line six about CrushCamp showers in Calgary. Line seven about CrushCamp towels in Calgary.";
  const ev = { results: [{ url: YELP, title: "CrushCamp - Calgary, AB - Yelp" }], citations: [{ url: YELP, cited_text: long }] };
  const words = ["one", "two", "three", "four", "five", "six", "seven"];
  const cands = words.map((w) => {
    const q = long.split(". ").find((s) => s.includes(`Line ${w}`))!;
    return { fact: `A reviewer wrote about CrushCamp — line ${w}.`, quote: q, url: YELP, kind: "context" };
  });
  const r = keepWebFacts([...cands.slice(0, 2), cands[0]!, ...cands.slice(2)], ev, P, NOW);
  assert.equal(r.kept.length, MAX_WEB_FACTS);
  assert.deepEqual(r.dropped.map((d) => d.reason), ["duplicate", "over_limit"]);
  assert.equal(r.kept[0]!.fact, "A reviewer wrote about CrushCamp, line one.");
  assert.equal(r.kept[0]!.quote, cands[0]!.quote);
  assert.equal(r.kept[0]!.page_date, null, "context needs no date");
});

// ── Property: whatever the model sends, a kept fact passes an independent, coarser check ──

const lettersOnly = (s: string) => s.normalize("NFKD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^a-z]/g, "");
const digitsOf = (s: string): string[] => [...(s.match(/\d+/g) ?? [])];
const trimSlash = (u: string) => u.split("#")[0]!.replace(/\/+$/, "");
const firstSegment = (u: string) => new URL(u).pathname.toLowerCase().split("/").filter(Boolean)[0]?.replace(/[^a-z0-9]/g, "") ?? "";
const socialHost = (u: string) => /(^|\.)(instagram|facebook|tiktok|linkedin|youtube|pinterest)\.com$|(^|\.)x\.com$/.test(new URL(u).hostname);

test("property: every kept fact is from a returned, allowed page, inside its citation, off their site, named in the quote (or on their profile), tied, dated when it matters, and adds no number", () => {
  let seed = 7;
  const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
  const pick = <T,>(a: readonly T[]): T => a[Math.floor(rnd() * a.length)]!;
  const urls = [...RESULTS.map((r) => r.url), "https://example.com/x", `${YELP}/`, `${IG}#a`, "not a url"];
  const texts = [...CITATIONS.map((c) => c.cited_text), "CrushCamp is great in Calgary and everyone loves it", "Random text with 12 numbers"];
  const kinds = ["problem", "opening", "context", "news", ""];
  let kept = 0;
  for (let i = 0; i < 4000; i++) {
    const t = pick(texts);
    const a = Math.floor(rnd() * t.length);
    const quote = rnd() < 0.8 ? t.slice(a, a + 15 + Math.floor(rnd() * 70)) : t;
    const fact = rnd() < 0.5 ? quote : `${pick(["CrushCamp", "A reviewer", "They"])} ${rnd() < 0.3 ? `said ${Math.floor(rnd() * 100)} things` : "said this"}.`;
    const cand = { fact, quote, url: pick(urls), kind: pick(kinds) };
    const r = keepWebFact(cand, EVIDENCE, P, [], NOW);
    if (!r.keep) continue;
    kept++;
    const f = r.fact;
    assert.ok(RESULTS.some((x) => trimSlash(x.url) === trimSlash(f.url)), `url ${f.url}`);
    assert.ok(
      CITATIONS.some((c) => trimSlash(c.url) === trimSlash(f.url) && lettersOnly(c.cited_text).includes(lettersOnly(f.quote))),
      `quote "${f.quote}"`,
    );
    assert.ok(lettersOnly(f.quote).length >= 10);
    const host = new URL(f.url).hostname;
    assert.ok(!host.endsWith("crushcamp.ca"), f.url);
    assert.ok(!/glassdoor|wheree/.test(host) && !new URL(f.url).pathname.startsWith("/cmp"), `blocked source ${f.url}`);
    const onProfile = socialHost(f.url) && firstSegment(f.url) === "crushcamp";
    assert.ok(lettersOnly(f.quote).includes("crushcamp") || (onProfile && lettersOnly(f.title ?? "").includes("crushcamp")), `not named: ${f.quote} / ${f.title}`);
    const tied = lettersOnly(f.quote).includes("calgary") || onProfile || f.quote.toLowerCase().includes("crushcamp.ca");
    assert.ok(tied, `not tied: ${f.url} "${f.quote}"`);
    for (const d of digitsOf(f.fact)) assert.ok(digitsOf(f.quote).includes(d), `${d} in "${f.fact}"`);
    assert.ok(["problem", "opening", "context"].includes(f.kind));
    if (f.kind !== "context") {
      assert.ok(f.page_date, `dated: ${f.url}`);
      const days = (NOW.getTime() - Date.parse(`${f.page_date}T00:00:00Z`)) / 86_400_000;
      assert.ok(days <= (f.kind === "problem" ? 365 : 180), `${f.kind} ${f.page_date}`);
    }
  }
  assert.ok(kept > 20, `the generator should hit kept facts too (kept ${kept})`);
});

// ── The stored shape (read side) ─────────────────────────────────────────────

test("asWebFact / webFactsFromJson: bad entries dropped, at most 6; page_date read when it is a day, else null", () => {
  const good = { fact: "f", quote: "q".repeat(20), url: "https://x.test/a", title: null, kind: "context", page_date: "2026-10-01" };
  assert.deepEqual(asWebFact(good), good);
  assert.equal(asWebFact({ ...good, kind: "news" }), null);
  assert.equal(asWebFact({ ...good, quote: "short" }), null);
  assert.equal(asWebFact({ ...good, url: "javascript:alert(1)" }), null);
  assert.equal(asWebFact({ ...good, title: 3 }), null);
  assert.equal(asWebFact({ ...good, fact: "" }), null);
  assert.equal(asWebFact("x"), null);
  assert.deepEqual(asWebFact({ ...good, title: undefined }), { ...good, title: null });
  // A row written before page_date existed, or a bad value: undated.
  const { page_date: _drop, ...old } = good;
  assert.deepEqual(asWebFact(old), { ...good, page_date: null });
  assert.deepEqual(asWebFact({ ...good, page_date: "last week" }), { ...good, page_date: null });
  assert.equal(webFactsFromJson([good, { nope: 1 }, null, ...Array(10).fill(good)]).length, 6);
  assert.deepEqual(webFactsFromJson({ facts: [good] }), []);
});

// ── Review 2026-11-09: own profile pages only, praise is not a problem, absences never ──

test("rule 5 profile: hashtag, tag, explore and search pages collect anyone's posts: never a tie, never a title-only name", () => {
  const anyone = { fact: "They are hiring coaches.", quote: "We are hiring two coaches for our new studio, apply now", kind: "opening" };
  const named = { fact: "CrushCamp is hiring coaches.", quote: "CrushCamp is hiring two coaches for our new studio, apply now", kind: "opening" };
  const pages = [
    "https://www.youtube.com/hashtag/crushcamp", "https://x.com/hashtag/crushcamp", "https://www.reddit.com/search/crushcamp",
    "https://www.pinterest.com/search/pins/crushcamp", "https://www.instagram.com/explore/tags/crushcamp", "https://www.tiktok.com/tag/crushcamp",
    "https://www.facebook.com/hashtag/crushcamp",
  ];
  for (const url of pages) {
    const ev = { results: [{ url, title: "#crushcamp - CrushCamp", page_age: "3 days ago" }], citations: [{ url, cited_text: `${anyone.quote}. ${named.quote}.` }] };
    assert.equal(isOwnProfile(url, P), false, url);
    assert.equal(reason({ ...anyone, url }, P, ev), "name_not_in_quote", url);
    // Named, but neither the page nor the quote ties it to Calgary or crushcamp.ca.
    assert.equal(reason({ ...named, url }, P, ev), "not_tied_to_business", url);
  }
  // Their own profiles still tie, on any of the usual shapes.
  for (const url of [
    "https://www.instagram.com/crushcamp/", "https://www.instagram.com/crushcamp/p/C1x2", "https://www.tiktok.com/@crushcamp",
    "https://x.com/crushcamp/status/1", "https://www.linkedin.com/company/crushcamp", "https://www.facebook.com/pages/crushcamp/123",
    "https://m.facebook.com/crushcamp", "https://www.youtube.com/@crushcamp",
  ]) {
    assert.equal(isOwnProfile(url, P), true, url);
    const ev = { results: [{ url, title: "CrushCamp", page_age: "3 days ago" }], citations: [{ url, cited_text: `${anyone.quote}.` }] };
    assert.equal(reason({ ...anyone, url }, P, ev), "kept", url);
  }
});

test("rule 5 profile: a bare directory slug is whoever took the name first, in any city", () => {
  const url = "https://www.yelp.com/biz/crushcamp";
  assert.equal(isOwnProfile(url, P), false);
  const ev = { results: [{ url, title: "CrushCamp - Austin, TX - Yelp", page_age: "2 weeks ago" }], citations: [{ url, cited_text: "CrushCamp never answers the phone, worst gym. CrushCamp in Calgary never answers the phone." }] };
  assert.equal(reason({ fact: "Nobody answers.", quote: "CrushCamp never answers the phone, worst gym", url, kind: "problem" }, P, ev), "not_tied_to_business");
  assert.equal(reason({ fact: "Nobody answers.", quote: "CrushCamp in Calgary never answers the phone", url, kind: "problem" }, P, ev), "kept");
});

test("rule 6 kind: praise that carries a problem word stays context; a real complaint stays a problem", () => {
  for (const praise of [
    "Can't wait to go back to CrushCamp in Calgary", "No wait at all at CrushCamp in Calgary", "Never disappointed by CrushCamp in Calgary",
    "CrushCamp in Calgary fixed my back issues", "CrushCamp in Calgary is open late", "I can't recommend CrushCamp in Calgary enough",
    "Nunca me decepciona CrushCamp en Calgary", "Sin esperas en CrushCamp en Calgary",
  ]) assert.equal(kindFromQuote("problem", praise), "context", praise);
  for (const complaint of [
    "Nobody at CrushCamp in Calgary ever answered the phone", "CrushCamp in Calgary never called me back",
    "I couldn't get through to CrushCamp in Calgary", "Waited 40 minutes at CrushCamp in Calgary", "The staff at CrushCamp in Calgary were rude",
    "CrushCamp in Calgary cancelled my class twice", "Can't wait to leave: nobody at CrushCamp in Calgary answers the phone",
    "En CrushCamp nadie contesta el teléfono", "Esperamos 2 horas en CrushCamp",
  ]) assert.equal(kindFromQuote("problem", complaint), "problem", complaint);
});

test("rule 6 kind: an opening needs a change; 'second to none', 'new moms', 'won me over' are not one", () => {
  for (const notOne of [
    "CrushCamp in Calgary is second to none", "CrushCamp in Calgary is great for new moms", "CrushCamp in Calgary won me over",
    "CrushCamp in Calgary has new classes every week", "Clases nuevas cada semana en CrushCamp",
  ]) assert.equal(kindFromQuote("opening", notOne), "context", notOne);
  for (const change of [
    "CrushCamp is opening a second studio in Calgary", "CrushCamp in Calgary is now hiring front desk staff", "CrushCamp in Calgary won the best gym award",
    "CrushCamp in Calgary was voted best gym", "CrushCamp is expanding to a new location in Calgary", "CrushCamp abrió una nueva sucursal en Calgary",
    "CrushCamp en Calgary está contratando recepcionista",
  ]) assert.equal(kindFromQuote("opening", change), "opening", change);
});

test("rule 5b: a quote shaped like an absence ('does not offer') is dropped, whatever its kind; a plain statement is kept", () => {
  const url = NEWS;
  const absence = [
    "CrushCamp in Calgary doesn't offer online booking", "CrushCamp in Calgary does not currently accept new members",
    "Online booking is not available at CrushCamp in Calgary", "CrushCamp en Calgary no cuenta con reservaciones en línea",
  ];
  const ev = { results: [{ url, title: "News", page_age: "2 weeks ago" }], citations: [{ url, cited_text: `${absence.join(". ")}. CrushCamp in Calgary offers online booking.` }] };
  for (const quote of absence) {
    assert.equal(isAbsenceShaped(quote), true, quote);
    for (const kind of ["problem", "context"]) assert.equal(reason({ fact: "x", quote, url, kind }, P, ev), "absence_claim", `${kind}: ${quote}`);
  }
  assert.equal(isAbsenceShaped("CrushCamp in Calgary offers online booking"), false);
  assert.equal(reason({ fact: "x", quote: "CrushCamp in Calgary offers online booking", url, kind: "context" }, P, ev), "kept");
});

test("page dates, more forms: times, Spanish, month-year, abbreviations", () => {
  assert.equal(pageDateFrom("Apr 30, 2026 at 10:00 AM", NOW), "2026-04-30");
  assert.equal(pageDateFrom("April 30, 2026, 10:00", NOW), "2026-04-30");
  assert.equal(pageDateFrom("30 de abril de 2026", NOW), "2026-04-30");
  assert.equal(pageDateFrom("30 abr 2026", NOW), "2026-04-30");
  assert.equal(pageDateFrom("Nov 2026", NOW), "2026-11-01");
  assert.equal(pageDateFrom("octubre de 2026", NOW), "2026-10-01");
  assert.equal(pageDateFrom("1 yr ago", NOW), "2025-11-09");
  assert.equal(pageDateFrom("2 mos ago", NOW), "2026-09-10");
  assert.equal(pageDateFrom("3d ago", NOW), "2026-11-06");
  assert.equal(pageDateFrom("2 minutes ago", NOW), "2026-11-09");
  assert.equal(pageDateFrom("hace 2 semanas", NOW), "2026-10-26");
  assert.equal(pageDateFrom("hace un mes", NOW), "2026-10-10");
  assert.equal(pageDateFrom("hace 3 días", NOW), "2026-11-06");
  assert.equal(pageDateFrom("ayer", NOW), "2026-11-08");
  for (const bad of ["hace mucho", "3 blorps ago", "Nov", "2026", "Smarch 2026"]) assert.equal(pageDateFrom(bad, NOW), null, bad);
});

// ── Sample run 2026-11-10 ────────────────────────────────────────────────────

test("sample 2026-11-10: 'Cook Roberts LLP' is 'Cook Roberts' in a quote; other legal endings too", () => {
  assert.deepEqual(businessNameTokens("Cook Roberts LLP"), ["cook", "roberts"]);
  assert.deepEqual(businessNameTokens("Smith & Jones LP"), ["smith", "jones"]);
  assert.deepEqual(businessNameTokens("Acme Holdings S.A.P.I. de C.V."), ["acme", "holdings"]);
  assert.deepEqual(businessNameTokens("Lee Law PC"), ["lee", "law"]);
  const CR: KeepProspect = { company_name: "Cook Roberts LLP", city: "Victoria", domain: "cookroberts.bc.ca", website_url: null };
  const url = "https://www.timescolonist.com/local-news/cook-roberts";
  const ev = { results: [{ url, title: "News", page_age: "2 weeks ago" }], citations: [{ url, cited_text: "Cook Roberts is opening a new office in Victoria this spring." }] };
  assert.equal(reason({ fact: "x", quote: "Cook Roberts is opening a new office in Victoria", url, kind: "opening" }, CR, ev), "kept");
  // Without the name it is still dropped.
  assert.equal(reason({ fact: "x", quote: "is opening a new office in Victoria this spring", url, kind: "opening" }, CR, ev), "name_not_in_quote");
});

test("sample 2026-11-10: HTML entities are the characters they stand for, in names, quotes, titles and what is stored", () => {
  assert.equal(decodeEntities("Allen &amp; Associates &#39;50&#x27; &rsquo;"), "Allen & Associates '50' ’");
  assert.equal(decodeEntities("&bogus; &#0; & alone"), "&bogus; &#0; & alone");
  assert.deepEqual(nameTokens("Allen &amp; Associates"), ["allen", "associates"]);
  const AA: KeepProspect = { company_name: "Allen &amp; Associates", city: "Dawson Creek", domain: "allen-associates.ca", website_url: null };
  const url = "https://www.yellowpages.ca/search/si/1/Real+Estate+Lawyers/Dawson+Creek+BC";
  const ev = {
    results: [{ url, title: "Real Estate Lawyers &amp; Notaries in Dawson Creek BC", page_age: "2025-07-22" }],
    citations: [{ url, cited_text: "Allen &amp; Associates has been servicing the Dawson Creek area for over 50 years." }],
  };
  for (const quote of ["Allen &amp; Associates has been servicing the Dawson Creek area", "Allen & Associates has been servicing the Dawson Creek area"]) {
    const r = keepWebFact({ fact: "Allen &amp; Associates has served Dawson Creek for decades.", quote, url, kind: "context" }, ev, AA, [], NOW);
    assert.ok(r.keep, quote);
    assert.equal(r.fact.quote, "Allen & Associates has been servicing the Dawson Creek area");
    assert.equal(r.fact.fact, "Allen & Associates has served Dawson Creek for decades.");
    assert.equal(r.fact.title, "Real Estate Lawyers & Notaries in Dawson Creek BC");
  }
});

test("sample 2026-11-10: an entity code is no number ('&#39;' never trips the number rule)", () => {
  const ev = { results: [{ url: NEWS, title: "News", page_age: "2 weeks ago" }], citations: [{ url: NEWS, cited_text: "CrushCamp&#39;s coaches in Calgary are the best." }] };
  const r = keepWebFact({ fact: "CrushCamp&#39;s coaches are well liked.", quote: "CrushCamp&#39;s coaches in Calgary are the best", url: NEWS, kind: "context" }, ev, P, [], NOW);
  assert.ok(r.keep, r.keep ? "" : r.reason);
  assert.equal(r.fact.quote, "CrushCamp's coaches in Calgary are the best");
  assert.equal(r.fact.fact, "CrushCamp's coaches are well liked.");
});
