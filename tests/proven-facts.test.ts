/**
 * Proven facts (lib/pitches/proven-facts.ts): the only things an email may say
 * about a prospect. The fixture is CrushCamp's stored crawl and research from
 * prod (2026-11-09), the email that got a hard no.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { cleanWhatTheyDo, hasProvenHook, provenFacts, proveInputs, type WebFactInput } from "../lib/pitches/proven-facts.ts";
import type { GeneratorInputs } from "../lib/pitches/generator.ts";
import { siteFactsFor, type SiteFact } from "../lib/pitches/site-facts.ts";

const HOME = "https://www.crushcamp.com/";
const e = (url: string, text?: string, href?: string) => [{ url, ...(text ? { text } : {}), ...(href ? { href } : {}) }];

// The checks as stored in site_observations for CrushCamp (crawled 2026-11-02), trimmed to what the facts read.
const CRUSHCAMP_ROW = {
  url: "https://www.crushcamp.com",
  final_url: HOME,
  status: "ok",
  psi_status: "no_key",
  pages: [
    { url: HOME, role: "home" }, { url: "https://www.crushcamp.com/connect", role: "contact" },
    { url: "https://www.crushcamp.com/schedule", role: "booking" }, { url: "https://www.crushcamp.com/pricing", role: "pricing" },
  ],
  checks: {
    tel: { found: true, evidence: e(HOME, "403-455-4880", "tel:403-455-4880") },
    mailto: { found: true, evidence: e(HOME, "sweat@crushcamp.com", "mailto:sweat@crushcamp.com") },
    social: { found: true, values: ["instagram", "youtube"], evidence: e(HOME, "FOLLOW THE PACK", "https://instagram.com/crushcamp") },
    booking: {
      found: true, online: true, channel: "external_engine", strength: "strong",
      evidence: e("https://www.crushcamp.com/schedule", "Send us an email", "https://clients.mindbodyonline.com/classic/ws?sLoc=0&sView=week&studioid=132470&stype=-7"),
    },
    builder: { found: true, value: "Squarespace", evidence: e(HOME, "Squarespace", "static1.squarespace.com") },
    ecommerce: { found: true, evidence: e("https://www.crushcamp.com/pricing", "BUY NOW", "https://momence.com/CrushCamp/membership/Single-Drop-In/760238") },
    contact_form: { found: false, fields: null, evidence: [] },
    jsonld_rating: { found: false, value: null, count: null, evidence: [] },
    jsonld_opening_hours: { found: false, evidence: [] },
    copyright_year: { found: true, year: 2026, evidence: e(HOME, "SHCAMP 2026 ALL RIGHTS RESERVED") },
    mobile_viewport: { found: false, evidence: e(HOME, "viewport: initial-scale=1") },
  },
};
const SITE = { website_url: "https://www.crushcamp.com", domain: "crushcamp.com" };

const CRUSHCAMP_WHAT_THEY_DO =
  "Boutique fitness studio in Calgary (East Village); offers HIIT, Yoga, Strength, HYROX classes; likely single-location independent; Squarespace site suggests small operator No visible agency relationships detected Tech: Squarespace, Google Analytics, Meta Pixel";

test("CrushCamp: no absence, no 'no phone setting', nothing mobile-negative; every fact has its page", () => {
  const site = siteFactsFor(CRUSHCAMP_ROW, SITE);
  assert.ok(site.some((f) => f.kind === "absence"), "the crawl does carry absences (contact form, hours, rating)");
  const proven = provenFacts({ site_facts: site });
  assert.ok(proven.length > 0);
  for (const f of proven) {
    assert.equal(f.source, "site");
    assert.match(f.url, /^https:\/\/www\.crushcamp\.com\//);
    assert.doesNotMatch(f.fact, /\bno\b|\bnot\b|only way/i, f.fact);
  }
  // The stored false viewport is re-read with today's rule: phone-ready, seen.
  const vp = proven.find((f) => f.id === "mobile_viewport");
  assert.ok(vp, JSON.stringify(proven));
  assert.match(vp.fact, /fit a phone screen/);
  // Nothing on their site is a problem we can show: the capability email goes out.
  assert.equal(hasProvenHook(proven), false);
});

test("absences and 'only … we saw' facts never become proven; weak facts neither", () => {
  const facts: SiteFact[] = [
    { id: "contact_form", kind: "absence", fact: "No contact form was found on the pages we read (home)", url: "https://a.test/", strength: "strong" },
    { id: "booking", kind: "seen", fact: "The only way to book we saw is by phone (Call to book), on the pages we read (home)", url: "https://a.test/", strength: "strong" },
    { id: "booking", kind: "seen", fact: "It looks like you can book from the home page", url: "https://a.test/", strength: "weak" },
    { id: "tel", kind: "seen", fact: "Their phone number is a tap-to-call link", url: "https://a.test/", strength: "strong" },
  ];
  assert.deepEqual(provenFacts({ site_facts: facts }).map((f) => f.id), ["tel"]);
});

test("a PageSpeed score Google rates as poor is a problem hook; 'needs improvement' is context", () => {
  const psi = (band: string): SiteFact => ({ id: "psi", kind: "seen", fact: `Google's mobile speed test (PageSpeed Insights) scored the home page 31/100 for performance, which Google rates as ${band}`, url: "https://a.test/", strength: "strong" });
  assert.equal(provenFacts({ site_facts: [psi("poor")] })[0]?.hook, "problem");
  assert.equal(provenFacts({ site_facts: [psi("needs improvement")] })[0]?.hook, "context");
});

test("web facts keep their quote, page and kind; malformed ones are dropped", () => {
  const ok: WebFactInput = { fact: "They opened a second studio in Inglewood in 2026", quote: "CrushCamp opens its second Calgary studio in Inglewood this spring", url: "https://calgarynews.test/crushcamp-inglewood", title: "CrushCamp expands", kind: "opening" };
  const proven = provenFacts({
    web_facts: [
      ok,
      { ...ok, quote: "  " },
      { ...ok, url: "javascript:alert(1)" },
      { ...ok, kind: "rumour" as unknown as WebFactInput["kind"] },
    ],
  });
  assert.equal(proven.length, 1);
  assert.deepEqual(proven[0], { source: "web", id: "web", fact: ok.fact, url: ok.url, quote: ok.quote, hook: "opening" });
  assert.equal(hasProvenHook(proven), true);
});

test("what_they_do: a judgment about their site is cut (looks, dated, aging, clunky); a place called Old Town stays", () => {
  assert.equal(cleanWhatTheyDo("Law firm with 3 locations. Website looks dated."), "Law firm with 3 locations");
  assert.equal(cleanWhatTheyDo("Bakery in Old Town; aging Wix site; clunky checkout"), "Bakery in Old Town");
});

// Second review (2026-11-09): the cleaner fails closed. Each clause below is
// what the research step wrote; none is something we can show they do.
const NOT_WHAT_THEY_DO = [
  "Website has no online booking",
  "bookings by phone only, no online scheduling",
  "website not mobile friendly",
  "Doesn't offer online booking",
  "Doesn’t offer online booking",
  "Sin reservaciones en línea; solo por teléfono",
  "Pain: missed calls after hours",
  "would benefit from automated reminders",
  "around 5 staff (estimated)",
  "Approx. 10 employees",
  "Growth opportunity in online sales",
  "Should add a booking widget",
  "Podría usar un chatbot",
  "Nunca contestan después de las 6",
  "Without a contact form",
  "Never answers after hours",
];
const WHAT_THEY_DO = [
  "Boutique fitness studio in Calgary (East Village); offers HIIT, Yoga, Strength, HYROX classes",
  "Family dental clinic in Guadalajara offering cleanings and implants",
  "Despacho contable en Monterrey; Ofrece contabilidad y nómina para pymes",
  "Spa offering massages, facials; Owner-operated, 2 staff",
  "Clínica dental en Puebla con 3 consultorios",
];

test("what_they_do (property): every negation, limiter, pain, opportunity, estimate or would/should clause is removed; plain descriptions are kept", () => {
  for (const bad of NOT_WHAT_THEY_DO) {
    assert.equal(cleanWhatTheyDo(bad), null, bad);
    for (const good of WHAT_THEY_DO) {
      assert.equal(cleanWhatTheyDo(`${good}; ${bad}`), good, `${good} + ${bad}`);
      assert.equal(cleanWhatTheyDo(`${bad}. ${good}`), good, `${bad} + ${good}`);
    }
  }
  for (const good of WHAT_THEY_DO) assert.equal(cleanWhatTheyDo(good), good, good);
  // CrushCamp's stored read still keeps what they do.
  assert.equal(cleanWhatTheyDo(CRUSHCAMP_WHAT_THEY_DO), WHAT_THEY_DO[0]);
});

test("proveInputs: no pain, no benchmarks (a figure is only cited for the pain the email leads with); a chosen angle keeps them", () => {
  const benchmark = { id: "b1", statistic: "About 70% of online carts are abandoned.", figure: "70%", publisher: "Baymard Institute", source_url: "https://baymard.com", caveat: null, for_pains: [{ code: "abandoned_cart_loss", label: "Cart recovery", pain_id: "pain-cart" }] };
  const inputs: GeneratorInputs = {
    prospect: { id: "p", company_name: "Boutique Sol", industry: "boutique", language: "en", employee_size_estimate: 5, city: "Calgary", market: "CA", what_they_do: "women's clothing boutique", tech_stack: [] },
    pains: [{ pain_id: "pain-cart", pain_label: "Cart recovery", evidence_quote: "no abandoned cart email flow detected" }],
    contacts: [], case_studies: [], notable_clients: [], benchmarks: [benchmark],
    sender: { full_name: "Henry", tenant_display_name: "Runna Advertising" },
  };
  const first = proveInputs(inputs, null);
  assert.deepEqual(first.pains, []);
  assert.deepEqual(first.benchmarks, []);
  const angled = proveInputs({ ...inputs, forced_angle: { pain_label: "Cart recovery", pain_id: "pain-cart", case_study_id: null, capability: null } }, null);
  assert.deepEqual(angled.pains.map((p) => [p.pain_id, p.evidence_quote]), [["pain-cart", null]]);
  assert.deepEqual(angled.benchmarks, [benchmark]);
});

test("what_they_do: CrushCamp's research guesses are cut, what they do stays", () => {
  assert.equal(cleanWhatTheyDo(CRUSHCAMP_WHAT_THEY_DO), "Boutique fitness studio in Calgary (East Village); offers HIIT, Yoga, Strength, HYROX classes");
});

test("what_they_do: Spanish guesses are cut; all-guess text is null; plain text passes unchanged", () => {
  assert.equal(
    cleanWhatTheyDo("Despacho contable en Monterrey. Ofrece contabilidad y nómina para pymes. Probablemente opera con un equipo pequeño."),
    "Despacho contable en Monterrey; Ofrece contabilidad y nómina para pymes",
  );
  assert.equal(cleanWhatTheyDo("Likely a small team; website appears outdated"), null);
  assert.equal(cleanWhatTheyDo("Family dental clinic in Guadalajara offering cleanings and implants"), "Family dental clinic in Guadalajara offering cleanings and implants");
  assert.equal(cleanWhatTheyDo(null), null);
});
