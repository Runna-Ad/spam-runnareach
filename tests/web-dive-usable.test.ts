/**
 * The last check before a draft uses a stored web fact (lib/research/web-dive/
 * usable.ts, called by webFactsFor): re-matched to the prospect as it is NOW,
 * kind and recency re-checked, the page still loading. Each rule both ways.
 * No network: the page fetch is injected.
 */

import assert from "node:assert/strict";
import test from "node:test";
import type { FetchOutcome, FetchPage } from "../lib/research/site-crawl/fetch-page.ts";
import type { WebFact } from "../lib/research/web-dive/facts.ts";
import type { MatchProspect } from "../lib/research/web-dive/match.ts";
import { webFactsFor, type WebResearchDb } from "../lib/research/web-dive/store.ts";
import { pageCheckWith, samePage, usableNow, usableWebFacts, type CheckPage } from "../lib/research/web-dive/usable.ts";

const NOW = new Date("2026-11-09T18:00:00Z");
const P: MatchProspect & { id: string } = { id: "p1", company_name: "CrushCamp Inc.", city: "Calgary", domain: "crushcamp.ca", website_url: "https://crushcamp.ca" };

const REVIEW: WebFact = {
  fact: "A reviewer says nobody answered.",
  quote: "CrushCamp in Calgary, but I called three times and nobody ever answered the phone",
  url: "https://www.yelp.ca/biz/crushcamp-calgary",
  title: "CrushCamp - Calgary, AB - Yelp",
  kind: "problem",
  page_date: "2026-10-20",
};
const PROFILE: WebFact = {
  fact: "They are opening a second studio.",
  quote: "Opening our second studio in Bridgeland, see you there",
  url: "https://www.instagram.com/crushcamp/",
  title: "CrushCamp (@crushcamp) • Instagram",
  kind: "opening",
  page_date: "2026-10-19",
};
const why = (f: WebFact, p = P, now = NOW) => {
  const r = usableNow(f, p, now);
  return r.ok ? "ok" : r.reason;
};

// ── 1. Re-matched to the prospect as it is now ───────────────────────────────

test("re-match: a fact stored for the prospect's old name, city or domain is not used after a correction", () => {
  assert.equal(why(REVIEW), "ok");
  assert.equal(why(PROFILE), "ok");
  // The name was corrected (the dive ran on a wrong name): the quote no longer names them.
  assert.equal(why(REVIEW, { ...P, company_name: "Bridgeland Barbell" }), "name_not_in_quote");
  // The city was corrected: the review's Calgary no longer ties it.
  assert.equal(why(REVIEW, { ...P, city: "Edmonton" }), "not_tied_to_business");
  // The domain was corrected: instagram.com/crushcamp is no longer their profile.
  assert.equal(why(PROFILE, { ...P, domain: "bridgelandbarbell.ca", website_url: null }), "name_not_in_quote");
  // The domain is now the page's own host: the crawler's, not the dive's.
  assert.equal(why(REVIEW, { ...P, domain: "yelp.ca", website_url: null }), "own_site");
  // A one-common-word name now: a city alone does not tie it.
  const summit = { ...REVIEW, quote: "Summit in Calgary, but I called three times and nobody ever answered the phone" };
  assert.equal(why(summit, { ...P, company_name: "Summit", domain: "summitfitness.ca" }), "common_name_needs_domain");
});

test("re-match: rows written before the source rules are held to them", () => {
  assert.equal(why({ ...REVIEW, url: "https://ca.indeed.com/cmp/Crushcamp/reviews" }), "employee_reviews");
  assert.equal(why({ ...REVIEW, url: "https://reviews.birdeye.com/crushcamp-123" }), "auto_profile");
});

// ── 2. Kind and recency re-checked ───────────────────────────────────────────

test("recency at draft time: an opening that was fresh at the dive and aged past 180 days is not used; a problem lasts 365", () => {
  const opening = { ...PROFILE, page_date: "2026-05-20" };
  assert.equal(why(opening, P, NOW), "ok", "173 days");
  assert.equal(why(opening, P, new Date("2026-11-20T12:00:00Z")), "stale_or_undated", "184 days");
  assert.equal(why({ ...REVIEW, page_date: "2025-12-01" }), "ok");
  assert.equal(why({ ...REVIEW, page_date: "2025-11-01" }), "stale_or_undated");
  assert.equal(why({ ...REVIEW, page_date: null }), "stale_or_undated");
  // Context needs no date.
  assert.equal(why({ ...REVIEW, kind: "context", page_date: null }), "ok");
});

test("kind at draft time: a stored 'problem' whose quote shows none is used only as context", () => {
  const r = usableNow({ ...REVIEW, quote: "Love the coaches at CrushCamp in Calgary", kind: "problem", page_date: null }, P, NOW);
  assert.ok(r.ok);
  assert.equal(r.fact.kind, "context");
  const kept = usableNow(REVIEW, P, NOW);
  assert.ok(kept.ok);
  assert.equal(kept.fact, REVIEW, "unchanged when it holds");
});

// ── 3. The page still loads ──────────────────────────────────────────────────

const page = (o: Partial<Extract<FetchOutcome, { ok: true }>> = {}): FetchOutcome => ({
  ok: true,
  status: 200,
  finalUrl: REVIEW.url,
  html: "<html><head><title>CrushCamp - Calgary - Yelp</title></head><body>…</body></html>",
  ...o,
});
const fetchOf = (outcome: FetchOutcome | Error): FetchPage => async () => {
  if (outcome instanceof Error) throw outcome;
  return outcome;
};
const check = (outcome: FetchOutcome | Error, url = REVIEW.url) => pageCheckWith(fetchOf(outcome))(url);

test("page check: HTTP 200 on the same page passes; www, case and a trailing slash are the same page", async () => {
  assert.deepEqual(await check(page()), { ok: true });
  assert.deepEqual(await check(page({ finalUrl: "https://yelp.ca/biz/CrushCamp-Calgary/" })), { ok: true });
  assert.ok(samePage("https://www.yelp.ca/biz/x", "https://yelp.ca/biz/x/"));
  assert.ok(!samePage("https://www.yelp.ca/biz/x", "https://www.yelp.com/biz/x"));
  assert.ok(!samePage("https://www.yelp.ca/biz/x", "https://www.yelp.ca/biz/y"));
  // The query is part of which page it is (indeed's job id); click-tracking keys are not.
  assert.ok(!samePage("https://ca.indeed.com/viewjob?jk=1", "https://ca.indeed.com/viewjob?jk=2"));
  assert.ok(!samePage("https://ca.indeed.com/viewjob?jk=1", "https://ca.indeed.com/viewjob"));
  assert.ok(samePage("https://ca.indeed.com/viewjob?jk=1", "https://ca.indeed.com/viewjob?jk=1&utm_source=x&from=serp"));
});

test("page check: a 200 whose visible text says it is gone fails; the same words only inside a script do not", async () => {
  for (const body of [
    "<title>Front Desk Coordinator - Indeed</title><body><h1>This job has expired on Indeed</h1></body>",
    "<title>Instagram</title><body><h2>Sorry, this page isn't available.</h2><p>The link you followed may be broken</p></body>",
    "<title>Vacante</title><body><p>Esta vacante ya no está disponible</p></body>",
  ]) {
    const r = await check(page({ html: body }));
    assert.equal(r.ok, false, body);
  }
  const alive = "<title>CrushCamp - Yelp</title><script>var t={gone:'Sorry, this page isn\\'t available.'}</script><body>Great coaches.</body>";
  assert.deepEqual(await check(page({ html: alive })), { ok: true });
});

test("absence at draft time: a stored fact shaped like an absence is never used", () => {
  assert.equal(why({ ...REVIEW, quote: "CrushCamp in Calgary doesn't offer online booking", kind: "context" }), "absence_claim");
});

test("page check: gone, blocked, moved or unreadable pages fail (closed)", async () => {
  const cases: Array<[FetchOutcome | Error, RegExp]> = [
    [{ ok: false, status: 404, finalUrl: REVIEW.url, error: "http", detail: "HTTP 404" }, /http \(HTTP 404\)/],
    [{ ok: false, status: 403, finalUrl: REVIEW.url, error: "blocked", detail: "bot wall" }, /blocked/],
    [{ ok: false, status: null, finalUrl: null, error: "timeout", detail: "no answer" }, /timeout/],
    [{ ok: false, status: null, finalUrl: null, error: "dns", detail: "gone" }, /dns/],
    [page({ status: 203 }), /HTTP 203/],
    // A closed job post that lands on the jobs list, a login wall, another site.
    [page({ finalUrl: "https://www.yelp.ca/search?find_desc=crushcamp" }), /moved to/],
    [page({ finalUrl: "https://www.instagram.com/accounts/login/?next=%2Fcrushcamp%2F" }), /moved to/],
    [page({ finalUrl: "https://crushcamp.ca/" }), /moved to/],
    // A 200 that says it is gone.
    [page({ html: "<title>Page not found | Yelp</title>" }), /gone/],
    [page({ html: "<title>This job has expired - Indeed</title>" }), /gone/],
    [page({ html: "<title>Página no encontrada</title>" }), /gone/],
    [new Error("socket hang up"), /check failed: socket hang up/],
  ];
  for (const [outcome, detail] of cases) {
    const r = await check(outcome);
    assert.equal(r.ok, false, JSON.stringify(outcome instanceof Error ? outcome.message : outcome));
    if (!r.ok) assert.match(r.detail, detail);
  }
});

test("usableWebFacts: re-match first (no fetch for a fact that already failed), then every page checked; only loading pages are used", async () => {
  const fetched: string[] = [];
  const checkPage: CheckPage = async (url) => {
    fetched.push(url);
    return url === REVIEW.url ? { ok: true } : { ok: false, detail: "http (HTTP 404)" };
  };
  const stale = { ...PROFILE, url: "https://www.instagram.com/crushcamp/p/1", page_date: "2025-01-01", quote: "CrushCamp in Calgary is opening a new studio" };
  const r = await usableWebFacts([REVIEW, PROFILE, stale], P, { now: NOW, checkPage });
  assert.deepEqual(r.usable, [REVIEW]);
  assert.deepEqual(r.dropped.map((d) => [d.reason, d.detail ?? null]), [["stale_or_undated", null], ["page_not_loading", "http (HTTP 404)"]]);
  assert.deepEqual(fetched.sort(), [PROFILE.url, REVIEW.url].sort(), "the stale fact was never fetched");
  // A check that throws is a page that did not load, never a crash.
  const boom = await usableWebFacts([REVIEW], P, { now: NOW, checkPage: async () => { throw new Error("boom"); } });
  assert.deepEqual(boom.usable, []);
  assert.equal(boom.dropped[0]!.reason, "page_not_loading");
  assert.deepEqual(await usableWebFacts([], P, { now: NOW, checkPage }), { usable: [], dropped: [] });
});

// ── webFactsFor: the stored row, then this check ─────────────────────────────

type Res = { data: unknown; error: { message: string } | null };
function db(rows: Array<Record<string, unknown>>, o: { error?: { message: string } } = {}): WebResearchDb {
  const q = {
    select: () => q, eq: () => q, neq: () => q, in: () => q, gt: () => q, gte: () => q, order: () => q, limit: () => q, range: () => q, abortSignal: () => q,
    then: <A, B>(ok?: ((v: Res) => A) | null, bad?: ((e: unknown) => B) | null) =>
      Promise.resolve<Res>(o.error ? { data: null, error: o.error } : { data: rows, error: null }).then(ok, bad),
  };
  return { from: () => q } as unknown as WebResearchDb;
}
const row = (facts: unknown[]) => ({ status: "ok", facts, started_at: new Date(NOW.getTime() - 3 * 86_400_000).toISOString() });

test("webFactsFor: the newest ok row's facts that still hold for the prospect now and whose page loads", async () => {
  const allOk: CheckPage = async () => ({ ok: true });
  assert.deepEqual(await webFactsFor(db([row([REVIEW, PROFILE])]), "t1", P, { now: NOW, checkPage: allOk }), [REVIEW, PROFILE]);
  // The name was corrected since the dive: nothing is used.
  assert.deepEqual(await webFactsFor(db([row([REVIEW, PROFILE])]), "t1", { ...P, company_name: "Bridgeland Barbell", domain: "bbarbell.ca", website_url: null }, { now: NOW, checkPage: allOk }), []);
  // One page is gone.
  const onlyReview: CheckPage = async (u) => (u === REVIEW.url ? { ok: true } : { ok: false, detail: "http (HTTP 404)" });
  assert.deepEqual(await webFactsFor(db([row([REVIEW, PROFILE])]), "t1", P, { now: NOW, checkPage: onlyReview }), [REVIEW]);
});

test("webFactsFor never throws: a read error or a check that throws is []", async () => {
  const allOk: CheckPage = async () => ({ ok: true });
  assert.deepEqual(await webFactsFor(db([row([REVIEW])], { error: { message: "" } }), "t1", P, { now: NOW, checkPage: allOk }), []);
  assert.deepEqual(await webFactsFor(db([]), "t1", P, { now: NOW, checkPage: allOk }), []);
  const throws = (() => { throw new Error("sync boom"); }) as unknown as CheckPage;
  assert.deepEqual(await webFactsFor(db([row([REVIEW])]), "t1", P, { now: NOW, checkPage: throws }), []);
});
