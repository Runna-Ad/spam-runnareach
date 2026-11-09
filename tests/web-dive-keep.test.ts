/**
 * web-dive keep-check (brief tasks/briefs/web-dive.md, "The keep-check"): a web
 * fact is kept only when code can show the page and the exact words on it,
 * about THIS business. One kept fact and one drop per rule, then a property
 * test whose matching is its own (a letters-only fold, plain digit runs), as
 * the fail-closed rule asks.
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

const P: KeepProspect = { company_name: "CrushCamp Inc.", city: "Calgary", domain: "crushcamp.ca", website_url: "https://crushcamp.ca" };

const YELP = "https://www.yelp.ca/biz/crushcamp-calgary";
const IG = "https://www.instagram.com/crushcamp/";
const OWN = "https://crushcamp.ca/about";
const SUB = "https://shop.crushcamp.ca/classes";
const NEWS = "https://calgaryherald.com/news/gyms-hiring";
const AUSTIN = "https://www.yelp.com/biz/crushcamp-austin";
const JOBS = "https://ca.indeed.com/viewjob?jk=1";

const EVIDENCE = {
  results: [
    { url: YELP, title: "CrushCamp - Calgary, AB - Yelp" },
    { url: IG, title: "Instagram" },
    { url: OWN, title: "About CrushCamp" },
    { url: SUB, title: "Classes" },
    { url: NEWS, title: "Gyms are hiring" },
    { url: AUSTIN, title: "Crush Camp - Austin, TX - Yelp" },
    { url: JOBS, title: "Front Desk Coordinator - CrushCamp - Calgary, AB" },
  ],
  citations: [
    { url: YELP, cited_text: "Love the coaches, but I called three times and nobody ever answered the phone." },
    { url: IG, cited_text: "CrushCamp is opening our second studio in Bridgeland this spring!" },
    { url: OWN, cited_text: "CrushCamp has trained over 500 members since 2019." },
    { url: SUB, cited_text: "CrushCamp classes run 6 days a week for every level." },
    { url: NEWS, cited_text: "Several gyms in the city are hiring front desk staff this fall." },
    { url: AUSTIN, cited_text: "Crush Camp has the best coaches in Austin, nobody beats them." },
    { url: JOBS, cited_text: "We are hiring a Front Desk Coordinator to answer calls and book classes at CrushCamp." },
  ],
};

const REVIEW: WebFactCandidate = {
  fact: "A Yelp reviewer says nobody ever answered the phone.",
  quote: "nobody ever answered the phone",
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
  quote: "We are hiring a Front Desk Coordinator to answer calls and book classes at CrushCamp",
  url: JOBS,
  kind: "opening",
};

const reason = (c: WebFactCandidate, p: KeepProspect = P, ev = EVIDENCE) => {
  const r = keepWebFact(c, ev, p);
  return r.keep ? "kept" : r.reason;
};

test("kept: a review (city in the title), a profile (handle = domain label), a job post; the stored fact is the search result's", () => {
  for (const c of [REVIEW, OPENING, HIRING]) assert.equal(reason(c), "kept", c.url);
  const r = keepWebFact(REVIEW, EVIDENCE, P);
  assert.ok(r.keep);
  assert.deepEqual(r.fact, { fact: REVIEW.fact, quote: REVIEW.quote, url: YELP, title: "CrushCamp - Calgary, AB - Yelp", kind: "problem" });
  // The URL may differ only by a trailing slash or a #fragment (normalizeUrl); the result's own URL is stored.
  const r2 = keepWebFact({ ...OPENING, url: "https://www.instagram.com/crushcamp#top" }, EVIDENCE, P);
  assert.ok(r2.keep);
  assert.equal(r2.fact.url, IG);
});

test("rule 1: a URL the search did not return is dropped", () => {
  assert.equal(reason({ ...REVIEW, url: "https://www.yelp.ca/biz/crushcamp-calgary?page=2" }), "url_not_in_search_results");
  assert.equal(reason({ ...REVIEW, url: "https://example.com/made-up" }), "url_not_in_search_results");
});

test("rule 2: the quote must be 20+ characters and inside a citation from the SAME URL", () => {
  assert.equal(reason({ ...REVIEW, quote: "nobody answered" }), "quote_too_short");
  // A quote that is in no citation at all.
  assert.equal(reason({ ...REVIEW, quote: "the staff never call anyone back" }), "quote_not_in_citation");
  // A real quote, but from another page's citation.
  assert.equal(reason({ ...REVIEW, quote: "opening our second studio in Bridgeland" }), "quote_not_in_citation");
  // An edited quote (ellipsis) is not verbatim.
  assert.equal(reason({ ...REVIEW, quote: "I called three times and ... nobody ever answered" }), "quote_not_in_citation");
});

test("rule 2 fold: case, whitespace and curly quotes are forgiven; accents are not", () => {
  assert.equal(quoteFold("  Nobody\n ever “answered”  "), 'nobody ever "answered"');
  const ev = {
    results: [{ url: YELP, title: "CrushCamp - Calgary, AB - Yelp" }],
    citations: [{ url: YELP, cited_text: "The owner's café is closed on Mondays, which nobody told us." }],
  };
  assert.equal(reason({ ...REVIEW, quote: "THE OWNER’S café is   closed on Mondays" }, P, ev), "kept");
  assert.equal(reason({ ...REVIEW, quote: "the owner's cafe is closed on Mondays" }, P, ev), "quote_not_in_citation");
});

test("rule 3: a number in the fact that the quote does not carry is dropped", () => {
  assert.equal(reason({ ...OPENING, fact: "CrushCamp is opening its 2nd studio in Bridgeland in 2025." }), "number_not_in_quote");
  const ev = {
    results: [{ url: YELP, title: "CrushCamp - Calgary, AB - Yelp" }],
    citations: [{ url: YELP, cited_text: "Waited 45 minutes for a class that never started at CrushCamp." }],
  };
  assert.equal(reason({ ...REVIEW, fact: "A reviewer waited 45 minutes for a class.", quote: "Waited 45 minutes for a class that never started" }, P, ev), "kept");
  assert.equal(reason({ ...REVIEW, fact: "A reviewer waited 50 minutes for a class.", quote: "Waited 45 minutes for a class that never started" }, P, ev), "number_not_in_quote");
});

test("rule 4: their own domain and its subdomains are the crawler's, never the dive's", () => {
  assert.equal(reason({ fact: "CrushCamp has trained over 500 members.", quote: "CrushCamp has trained over 500 members", url: OWN, kind: "context" }), "own_site");
  assert.equal(reason({ fact: "CrushCamp runs classes for every level.", quote: "CrushCamp classes run 6 days a week for every level", url: SUB, kind: "context" }), "own_site");
  // The website's host counts too when the domain field is empty.
  assert.equal(reason({ fact: "CrushCamp has trained over 500 members.", quote: "CrushCamp has trained over 500 members", url: OWN, kind: "context" }, { ...P, domain: null }), "own_site");
});

test("rule 5: the page must name the business", () => {
  assert.equal(reason({ fact: "Gyms in the city are hiring front desk staff.", quote: "Several gyms in the city are hiring front desk staff", url: NEWS, kind: "opening" }), "name_not_found");
  assert.equal(reason(HIRING, { ...P, company_name: "ABC Ltd" }), "name_too_short");
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
    results: [{ url: YS, title: "Summit - Calgary, AB - Yelp" }, { url: IS, title: "Summit (@summitfitness)" }],
    citations: [
      { url: YS, cited_text: "Summit is the friendliest gym in Calgary, highly recommend it. Book at summitfitness.ca today." },
      { url: IS, cited_text: "Summit is hiring two front desk coordinators for our Calgary studio." },
    ],
  };
  assert.equal(reason({ fact: "Summit is a friendly gym.", quote: "Summit is the friendliest gym in Calgary", url: YS, kind: "context" }, S, ev), "common_name_needs_domain");
  // The quote names their domain: tied.
  assert.equal(reason({ fact: "Summit is a friendly gym.", quote: "Summit is the friendliest gym in Calgary, highly recommend it. Book at summitfitness.ca", url: YS, kind: "context" }, S, ev), "kept");
  // A profile named after the domain label: tied.
  assert.equal(reason({ fact: "Summit is hiring front desk coordinators.", quote: "Summit is hiring two front desk coordinators", url: IS, kind: "opening" }, S, ev), "kept");
  // Not common: the city is enough (the review above, for CrushCamp).
  assert.equal(reason(REVIEW), "kept");
});

test("rule 5 tie: the domain label must be a whole path segment, never inside a longer slug or the host", () => {
  assert.deepEqual(urlPathSegments("https://www.tiktok.com/@crush_camp?lang=en"), ["crushcamp"]);
  assert.deepEqual(urlPathSegments(AUSTIN), ["biz", "crushcampaustin"]);
  assert.deepEqual(urlPathSegments("https://crushcamp.com/"), []);
  const ev = {
    results: [{ url: "https://crushcamp.com/news", title: "News" }, { url: "https://www.instagram.com/crushcampyyc", title: "Instagram" }],
    citations: [
      { url: "https://crushcamp.com/news", cited_text: "CrushCamp opens a new studio downtown next month." },
      { url: "https://www.instagram.com/crushcampyyc", cited_text: "CrushCamp opens a new studio downtown next month." },
    ],
  };
  const c = { fact: "CrushCamp opens a new studio downtown.", quote: "CrushCamp opens a new studio downtown", kind: "opening" };
  assert.equal(reason({ ...c, url: "https://crushcamp.com/news" }, P, ev), "not_tied_to_business");
  assert.equal(reason({ ...c, url: "https://www.instagram.com/crushcampyyc" }, P, ev), "not_tied_to_business");
});

test("rule 6: an unknown kind is dropped; malformed candidates are dropped first", () => {
  assert.equal(reason({ ...REVIEW, kind: "news" }), "bad_kind");
  assert.equal(reason({ ...REVIEW, fact: "  " }), "malformed");
  assert.equal(reason({ ...REVIEW, url: "" }), "malformed");
  assert.equal(reason({ ...REVIEW, quote: 7 as unknown as string }), "malformed");
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
  const ev = {
    results: [{ url: "https://www.seccion-amarilla.com.mx/empresas/grupo-ferretero", title: "Grupo Ferretero - Monterrey" }],
    citations: [{ url: "https://www.seccion-amarilla.com.mx/empresas/grupo-ferretero", cited_text: "Grupo Ferretero S.A. de C.V. abrió una nueva sucursal en Monterrey." }],
  };
  const gf: KeepProspect = { company_name: "Grupo Ferretero, S.A. de C.V.", city: "Monterrey", domain: "grupoferretero.mx", website_url: null };
  assert.equal(
    reason({ fact: "Grupo Ferretero abrió una nueva sucursal.", quote: "Grupo Ferretero S.A. de C.V. abrió una nueva sucursal en Monterrey", url: "https://www.seccion-amarilla.com.mx/empresas/grupo-ferretero", kind: "opening" }, gf, ev),
    "kept",
  );
});

test("duplicates and the 6-fact limit; dashes out of our sentence, their quote kept verbatim", () => {
  const long = "Line one about CrushCamp classes. Line two about CrushCamp coaches. Line three about CrushCamp hours. Line four about CrushCamp prices. Line five about CrushCamp parking. Line six about CrushCamp showers. Line seven about CrushCamp towels.";
  const ev = { results: [{ url: YELP, title: "CrushCamp - Calgary, AB - Yelp" }], citations: [{ url: YELP, cited_text: long }] };
  const words = ["one", "two", "three", "four", "five", "six", "seven"];
  const cands = words.map((w) => {
    const q = long.split(". ").find((s) => s.includes(`Line ${w}`))!;
    return { fact: `A reviewer wrote about CrushCamp — line ${w}.`, quote: q, url: YELP, kind: "context" };
  });
  const r = keepWebFacts([...cands.slice(0, 2), cands[0]!, ...cands.slice(2)], ev, P);
  assert.equal(r.kept.length, MAX_WEB_FACTS);
  assert.deepEqual(r.dropped.map((d) => d.reason), ["duplicate", "over_limit"]);
  assert.equal(r.kept[0]!.fact, "A reviewer wrote about CrushCamp, line one.");
  assert.equal(r.kept[0]!.quote, cands[0]!.quote);
});

// ── Property: whatever the model sends, a kept fact passes an independent, coarser check ──

const lettersOnly = (s: string) => s.normalize("NFKD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^a-z]/g, "");
const digitsOf = (s: string): string[] => [...(s.match(/\d+/g) ?? [])];
const trimSlash = (u: string) => u.split("#")[0]!.replace(/\/+$/, "");

test("property: every kept fact comes from a returned page, is inside that page's citation, is off their site, names them, and adds no number", () => {
  let seed = 7;
  const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
  const pick = <T,>(a: readonly T[]): T => a[Math.floor(rnd() * a.length)]!;
  const urls = [...EVIDENCE.results.map((r) => r.url), "https://example.com/x", `${YELP}/`, `${IG}#a`, "not a url"];
  const texts = [...EVIDENCE.citations.map((c) => c.cited_text), "CrushCamp is great in Calgary and everyone loves it", "Random text with 12 numbers"];
  const kinds = ["problem", "opening", "context", "news", ""];
  let kept = 0;
  for (let i = 0; i < 3000; i++) {
    const t = pick(texts);
    const a = Math.floor(rnd() * t.length);
    const quote = rnd() < 0.8 ? t.slice(a, a + 15 + Math.floor(rnd() * 60)) : t;
    const fact = rnd() < 0.5 ? quote : `${pick(["CrushCamp", "A reviewer", "They"])} ${rnd() < 0.3 ? `said ${Math.floor(rnd() * 100)} things` : "said this"}.`;
    const cand = { fact, quote, url: pick(urls), kind: pick(kinds) };
    const r = keepWebFact(cand, EVIDENCE, P);
    if (!r.keep) continue;
    kept++;
    const f = r.fact;
    assert.ok(EVIDENCE.results.some((x) => trimSlash(x.url) === trimSlash(f.url)), `url ${f.url}`);
    assert.ok(
      EVIDENCE.citations.some((c) => trimSlash(c.url) === trimSlash(f.url) && lettersOnly(c.cited_text).includes(lettersOnly(f.quote))),
      `quote "${f.quote}"`,
    );
    assert.ok(lettersOnly(f.quote).length >= 10);
    assert.ok(!new URL(f.url).hostname.endsWith("crushcamp.ca"), f.url);
    const named = lettersOnly(f.quote).includes("crushcamp") || lettersOnly(f.title ?? "").includes("crushcamp");
    assert.ok(named, `${f.quote} / ${f.title}`);
    const tied =
      lettersOnly(`${f.quote} ${f.title ?? ""}`).includes("calgary") ||
      new URL(f.url).pathname.toLowerCase().split("/").includes("crushcamp") ||
      f.quote.toLowerCase().includes("crushcamp.ca");
    assert.ok(tied, `not tied: ${f.url} "${f.quote}"`);
    for (const d of digitsOf(f.fact)) assert.ok(digitsOf(f.quote).includes(d), `${d} in "${f.fact}"`);
    assert.ok(["problem", "opening", "context"].includes(f.kind));
  }
  assert.ok(kept > 20, `the generator should hit kept facts too (kept ${kept})`);
});

// ── The stored shape (read side) ─────────────────────────────────────────────

test("asWebFact / webFactsFromJson: bad entries dropped, at most 6", () => {
  const good = { fact: "f", quote: "q".repeat(20), url: "https://x.test/a", title: null, kind: "context" };
  assert.deepEqual(asWebFact(good), good);
  assert.equal(asWebFact({ ...good, kind: "news" }), null);
  assert.equal(asWebFact({ ...good, quote: "short" }), null);
  assert.equal(asWebFact({ ...good, url: "javascript:alert(1)" }), null);
  assert.equal(asWebFact({ ...good, title: 3 }), null);
  assert.equal(asWebFact({ ...good, fact: "" }), null);
  assert.equal(asWebFact("x"), null);
  assert.deepEqual(asWebFact({ ...good, title: undefined }), { ...good, title: null });
  assert.equal(webFactsFromJson([good, { nope: 1 }, null, ...Array(10).fill(good)]).length, 6);
  assert.deepEqual(webFactsFromJson({ facts: [good] }), []);
});
