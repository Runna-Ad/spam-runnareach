/**
 * crawlSite (lib/research/site-crawl/crawl.ts) with a fake network: which pages
 * it opens, one request at a time, inside the site budget, robots.txt, redirects
 * off the site, and how failures turn into "could not see".
 */

import assert from "node:assert/strict";
import test from "node:test";
import { crawlSite, normalizeSiteUrl } from "../lib/research/site-crawl/crawl.ts";
import { isBlockedResponse, type FetchOutcome, type FetchPage } from "../lib/research/site-crawl/fetch-page.ts";
import { ALLOW_ALL, parseRobots, robotsAllows } from "../lib/research/site-crawl/robots.ts";
import { MAX_SUBPAGES, selectPages } from "../lib/research/site-crawl/select-pages.ts";
import { parsePage } from "../lib/research/site-crawl/parse.ts";

const FILLER = `<p>${"Family lodge on the lake since 1998, open all year for guests. ".repeat(6)}</p>`;
const html = (body: string) => `<html lang="en"><head><meta name="viewport" content="width=device-width"></head><body>${FILLER}${body}</body></html>`;
const HOME_LINKS = [
  '<a href="/contact-us/">Contact</a>',
  '<a href="/rooms/">Rooms</a>',
  '<a href="/book/">Book now</a>',
  '<a href="/menu/">Menu</a>',
  '<a href="/about/">About us</a>',
  '<a href="/pricing/">Rates</a>',
  '<a href="/services/">Services</a>',
  '<a href="/shop/">Shop</a>',
  '<a href="/gallery/">Gallery</a>',
  '<a href="https://other.test/x">Partner</a>',
  '<a href="/brochure.pdf">Brochure</a>',
].join("");

type Route = FetchOutcome | ((t: number) => Promise<FetchOutcome>);
const ok = (url: string, body: string): FetchOutcome => ({ ok: true, status: 200, finalUrl: url, html: html(body) });

/** A fake network: routes by URL, records order and concurrency, advances a fake clock. */
function net(routes: Record<string, Route>, msPerRequest = 100) {
  let clock = 0;
  let inFlight = 0;
  let maxInFlight = 0;
  const calls: Array<{ url: string; timeout: number }> = [];
  const fetchPage: FetchPage = async (url, timeout) => {
    calls.push({ url, timeout });
    inFlight++;
    maxInFlight = Math.max(maxInFlight, inFlight);
    await new Promise((r) => setImmediate(r));
    clock += msPerRequest;
    inFlight--;
    const r = routes[url];
    if (!r) return { ok: false, status: 404, finalUrl: url, error: "http", detail: "HTTP 404" };
    return typeof r === "function" ? r(timeout) : r;
  };
  return { fetchPage, calls, now: () => clock, tick: (ms: number) => (clock += ms), maxInFlight: () => maxInFlight };
}

const SITE = "https://lodge.test/";
const sub = (path: string, body = '<a href="/">Home</a><a href="/about/">About</a><a href="/contact-us/">Contact</a>') => ({ [`${SITE}${path}`]: ok(`${SITE}${path}`, body) });

test("normalizeSiteUrl adds https and rejects junk", () => {
  assert.equal(normalizeSiteUrl("lodge.test"), "https://lodge.test/");
  assert.equal(normalizeSiteUrl("http://lodge.test/a#b"), "http://lodge.test/a");
  assert.equal(normalizeSiteUrl("not a url"), null);
  assert.equal(normalizeSiteUrl(""), null);
});

test("selectPages: one page per kind first, same site only, no PDFs, at most 7", () => {
  const p = parsePage(html(HOME_LINKS), SITE);
  const chosen = selectPages(p.links, SITE);
  assert.equal(chosen.length, MAX_SUBPAGES);
  assert.deepEqual(
    chosen.map((c) => c.role),
    ["contact", "booking", "menu", "services", "pricing", "shop", "about"],
  );
  assert.ok(chosen.every((c) => c.url.startsWith(SITE)));
  assert.ok(!chosen.some((c) => c.url.endsWith(".pdf")));
});

test("crawl: home + up to 7 sub-pages, ONE request at a time, every fetch inside the site budget", async () => {
  const n = net({
    [SITE]: ok(SITE, HOME_LINKS),
    ...sub("contact-us/"), ...sub("rooms/"), ...sub("book/"), ...sub("menu/"), ...sub("about/"), ...sub("pricing/"), ...sub("services/"), ...sub("shop/"),
  });
  const obs = await crawlSite("lodge.test", { fetchPage: n.fetchPage, fetchRobots: async () => ALLOW_ALL, now: n.now, siteBudgetMs: 25_000, pageTimeoutMs: 8_000 });
  assert.equal(obs.status, "ok");
  assert.equal(obs.pages.length, 1 + MAX_SUBPAGES);
  assert.equal(n.maxInFlight(), 1, "never two requests to the site at once");
  assert.ok(n.calls.every((c) => c.timeout > 0 && c.timeout <= 8_000));
  assert.deepEqual(obs.readable, { html: true, text: true, links: true });
  assert.equal(obs.checks.booking.channel, "on_site");
});

test("crawl: when the site budget runs out, the pages left are recorded unreadable and absences become null", async () => {
  const n = net({ [SITE]: ok(SITE, HOME_LINKS), ...sub("contact-us/"), ...sub("book/") }, 4_000);
  const obs = await crawlSite(SITE, { fetchPage: n.fetchPage, fetchRobots: async () => ALLOW_ALL, now: n.now, siteBudgetMs: 10_000 });
  const spent = obs.pages.filter((p) => p.error === "site budget spent");
  assert.ok(spent.length > 0, JSON.stringify(obs.pages.map((p) => p.error)));
  assert.ok(n.calls.length <= 3, `stopped fetching: ${n.calls.length}`);
  assert.equal(obs.readable.links, false);
  assert.notEqual(obs.checks.tel.found, false, "no tel link seen, but not every page was read");
  assert.notEqual(obs.checks.contact_form.found, false);
});

test("crawl: a timed-out sub-page makes absences null; a 404 sub-page counts as read (nothing is hidden there)", async () => {
  const timeout: FetchOutcome = { ok: false, status: null, finalUrl: null, error: "timeout", detail: "no answer" };
  const home = '<a href="/about/">About</a><a href="/contact-us/">Contact</a><a href="/gallery/">Gallery</a>';
  const withTimeout = net({ [SITE]: ok(SITE, home), [`${SITE}about/`]: timeout, ...sub("contact-us/") });
  const a = await crawlSite(SITE, { fetchPage: withTimeout.fetchPage, fetchRobots: async () => ALLOW_ALL, now: withTimeout.now });
  assert.equal(a.checks.booking.found, null);
  assert.equal(a.checks.tel.found, null);

  const with404 = net({ [SITE]: ok(SITE, home), ...sub("contact-us/") }); // /about/ answers 404
  const b = await crawlSite(SITE, { fetchPage: with404.fetchPage, fetchRobots: async () => ALLOW_ALL, now: with404.now });
  assert.equal(b.pages.find((p) => p.url.endsWith("/about/"))?.http_status, 404);
  assert.equal(b.checks.booking.found, false);
  assert.equal(b.checks.tel.found, false);
});

test("fetch: any 403 or 429 is the site refusing us (blocked), WAF header or not; a 500 is not", () => {
  const h = new Headers({ server: "nginx" });
  assert.equal(isBlockedResponse(403, h, "<html><title>Forbidden</title>"), true);
  assert.equal(isBlockedResponse(429, h, ""), true);
  assert.equal(isBlockedResponse(500, h, "<html><title>Error</title>"), false);
  assert.equal(isBlockedResponse(200, h, "<html><head><title>Just a moment...</title>"), true);
});

test("crawl: unreachable, blocked, not_html and too_large homes store every check as null", async () => {
  const cases: Array<[FetchOutcome, string]> = [
    [{ ok: false, status: null, finalUrl: null, error: "dns", detail: "domain does not resolve" }, "unreachable"],
    [{ ok: false, status: 503, finalUrl: SITE, error: "blocked", detail: "HTTP 503 bot challenge" }, "blocked"],
    [{ ok: false, status: 200, finalUrl: SITE, error: "not_html", detail: "application/pdf" }, "not_html"],
    [{ ok: false, status: 500, finalUrl: SITE, error: "http", detail: "HTTP 500" }, "unreachable"],
    [{ ok: false, status: 200, finalUrl: SITE, error: "too_large", detail: "over 1500000 bytes" }, "too_large"],
  ];
  for (const [home, status] of cases) {
    const n = net({ [SITE]: home });
    const obs = await crawlSite(SITE, { fetchPage: n.fetchPage, fetchRobots: async () => ALLOW_ALL, now: n.now });
    assert.equal(obs.status, status);
    assert.equal(obs.pages.length, 1);
    assert.ok(obs.pages[0]?.error);
    for (const [k, c] of Object.entries(obs.checks)) assert.equal((c as { found: unknown }).found, null, `${status} ${k}`);
  }
});

test("crawl: a home that redirects to another company's domain is 'offsite' and describes nothing", async () => {
  const n = net({ [SITE]: { ok: true, status: 200, finalUrl: "https://acquirer.test/lodge", html: html('<a href="tel:+1">Call</a>') } });
  const obs = await crawlSite(SITE, { fetchPage: n.fetchPage, fetchRobots: async () => ALLOW_ALL, now: n.now });
  assert.equal(obs.status, "offsite");
  assert.equal(obs.checks.tel.found, null);
});

test("crawl: a same-site 'Book' link that redirects to an engine is booking found (external)", async () => {
  const n = net({
    [SITE]: ok(SITE, '<a href="/book/">Book now</a><a href="/about/">About</a><a href="/x/">X</a>'),
    [`${SITE}book/`]: { ok: true, status: 200, finalUrl: "https://lodge.resnexus.com/resnexus/reservations/book/1", html: html("") },
    ...sub("about/"),
  });
  const obs = await crawlSite(SITE, { fetchPage: n.fetchPage, fetchRobots: async () => ALLOW_ALL, now: n.now });
  assert.equal(obs.checks.booking.channel, "external_engine");
  assert.ok(obs.checks.booking.evidence.some((e) => e.href?.includes("resnexus.com")));
});

test("robots.txt: a disallowed home is 'blocked' and never fetched; disallowed sub-pages are never chosen", async () => {
  const n = net({ [SITE]: ok(SITE, HOME_LINKS) });
  const blockedAll = await crawlSite(SITE, { fetchPage: n.fetchPage, fetchRobots: async () => parseRobots("User-agent: *\nDisallow: /"), now: n.now });
  assert.equal(blockedAll.status, "blocked");
  assert.match(blockedAll.pages[0]?.error ?? "", /robots/);
  assert.equal(n.calls.length, 0);

  const m = net({ [SITE]: ok(SITE, HOME_LINKS), ...sub("contact-us/"), ...sub("menu/") });
  const partial = await crawlSite(SITE, { fetchPage: m.fetchPage, fetchRobots: async () => parseRobots("User-agent: *\nDisallow: /book/\nDisallow: /shop"), now: m.now });
  assert.ok(!m.calls.some((c) => c.url.includes("/book/") || c.url.includes("/shop/")));
  assert.equal(partial.status, "ok");
});

test("robots.txt parsing: our group beats *, longest match wins, Allow overrides, wildcards", () => {
  const txt = [
    "User-agent: *",
    "Disallow: /",
    "",
    "User-agent: RunnaSiteCheck",
    "Disallow: /private/",
    "Allow: /private/menu",
    "Disallow: /*.json$",
  ].join("\n");
  const r = parseRobots(txt);
  assert.equal(robotsAllows(r, "https://x.test/"), true);
  assert.equal(robotsAllows(r, "https://x.test/private/a"), false);
  assert.equal(robotsAllows(r, "https://x.test/private/menu"), true);
  assert.equal(robotsAllows(r, "https://x.test/data.json"), false);
  assert.equal(robotsAllows(r, "https://x.test/data.json?x=1"), true);
  assert.equal(robotsAllows(parseRobots("User-agent: *\nDisallow:"), "https://x.test/a"), true);
  assert.equal(robotsAllows(parseRobots("User-agent: Googlebot\nDisallow: /"), "https://x.test/a"), true);
});
