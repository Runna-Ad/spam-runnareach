/**
 * Legal-page email mining.
 *
 * Pedro, 2026-07-22: "a lot of the times websites have contact emails on their
 * privacy policy or terms and conditions sections."
 *
 * Two things had to be true for that to pay off, and neither was:
 *   1. /privacy and /terms were not in KEY_PAGE_PATHS, so their URLs were never
 *      even collected.
 *   2. Sub-pages were fetched for BODY TEXT only — extractMainText drops
 *      `mailto:` hrefs with every other attribute — so no sub-page contributed
 *      addresses. Not even /contact, which WAS being fetched.
 *
 * These tests cover the pure halves: URL discovery, and extraction off a legal
 * page's markup. The fetch loop itself is network code and stays untested here.
 */

import assert from "node:assert/strict";
import test from "node:test";
import * as cheerio from "cheerio";
import {
  extractContactEmails,
  extractKeyPages,
  parseSite,
  redirectedOffsite,
  siteOwnership,
} from "../lib/research/scraper.ts";

const BASE = "https://weeksconstruction.ca";

function keyPagesOf(html: string, base = BASE): Record<string, string> {
  const $ = cheerio.load(html);
  return Object.fromEntries(extractKeyPages($, base).map((p) => [p.label, p.url]));
}

// ── URL discovery ─────────────────────────────────────────────────────────────

test("discovers /privacy-policy and /terms links", () => {
  const pages = keyPagesOf(`
    <a href="/about">About</a>
    <a href="/privacy-policy">Privacy Policy</a>
    <a href="/terms">Terms of Service</a>
  `);
  assert.equal(pages.Privacy, `${BASE}/privacy-policy`);
  assert.equal(pages.Terms, `${BASE}/terms`);
});

test("discovers Spanish legal paths (MX prospects)", () => {
  const pages = keyPagesOf(`
    <a href="/aviso-de-privacidad">Aviso de Privacidad</a>
    <a href="/terminos">Términos y Condiciones</a>
  `);
  assert.equal(pages.Privacy, `${BASE}/aviso-de-privacidad`);
  assert.equal(pages.Terms, `${BASE}/terminos`);
});

test("discovers Shopify /pages/* legal paths", () => {
  const pages = keyPagesOf(`
    <a href="/pages/privacy-policy">Privacy</a>
    <a href="/pages/terms-of-service">Terms</a>
  `);
  assert.equal(pages.Privacy, `${BASE}/pages/privacy-policy`);
  assert.equal(pages.Terms, `${BASE}/pages/terms-of-service`);
});

test("/legal counts as Terms", () => {
  assert.equal(keyPagesOf('<a href="/legal">Legal</a>').Terms, `${BASE}/legal`);
});

test("ignores legal links on OTHER domains", () => {
  // Sites routinely link a platform's policy (Shopify, Wix). Mining those would
  // hand us shopify.com addresses and pitch the wrong company.
  const pages = keyPagesOf('<a href="https://www.shopify.com/legal/privacy">Privacy</a>');
  assert.equal(pages.Privacy, undefined);
});

test("does not mistake /privacy-training or /termination for legal pages", () => {
  const pages = keyPagesOf(`
    <a href="/services/privacy-training">Privacy Training</a>
    <a href="/termination-services">Termination</a>
  `);
  assert.equal(pages.Privacy, undefined);
  assert.equal(pages.Terms, undefined);
});

// ── Extraction off legal-page markup ──────────────────────────────────────────

test("pulls the address out of privacy-policy boilerplate", () => {
  const html = `<html><body><main>
    <h1>Privacy Policy</h1>
    <p>If you have questions about this policy, contact us at
       <a href="mailto:info@weeksconstruction.ca">info@weeksconstruction.ca</a>.</p>
  </main></body></html>`;
  const emails = extractContactEmails(html, cheerio.load(html), "weeksconstruction.ca");
  assert.deepEqual(emails, ["info@weeksconstruction.ca"]);
});

test("pulls a plaintext address out of terms boilerplate (no mailto:)", () => {
  // Note the address: legal@ would be correct to find and then DROP (see the
  // never-pitch tests below), so the fixture uses a pitchable inbox to keep
  // this test about extraction rather than filtering.
  const html = `<html><body>
    <p>These Terms are governed by the laws of Ontario. Questions:
       office@weeksconstruction.ca</p>
  </body></html>`;
  const emails = extractContactEmails(html, cheerio.load(html), "weeksconstruction.ca");
  assert.deepEqual(emails, ["office@weeksconstruction.ca"]);
});

test("the element-boundary guard still applies on legal pages", () => {
  // Regression: `.text()` concatenates adjacent nodes with no separator, which
  // once produced "emailsrgjulien@x.ca" and reached a live draft pitch. The
  // harvest reuses extractContactEmails precisely so this guard travels with it.
  const html = `<html><body>
    <p>Emails:</p><a href="/x">rgjulien@julien-cormier.ca</a>
  </body></html>`;
  const emails = extractContactEmails(html, cheerio.load(html), "julien-cormier.ca");
  assert.ok(
    emails.includes("rgjulien@julien-cormier.ca"),
    `expected the clean address, got ${JSON.stringify(emails)}`,
  );
  assert.ok(!emails.some((e) => e.startsWith("emails")), "glued prefix leaked through");
});

test("privacy-page placeholders are still rejected", () => {
  // Theme boilerplate ships example addresses. Pitching one is worse than
  // finding nothing, because it looks like a real contact.
  const html = `<html><body>
    <p>Contact us at you@example.com or name@company.com</p>
  </body></html>`;
  const emails = extractContactEmails(html, cheerio.load(html), "weeksconstruction.ca");
  assert.deepEqual(emails, []);
});

// ── Never-pitch inboxes ───────────────────────────────────────────────────────
//
// Mining /privacy and /terms preferentially finds privacy officers. The first
// live sweep surfaced privacy@nygh.on.ca, privacyofficer@stegh.on.ca,
// hrweb@uhn.ca and patientrelations@gbgh.on.ca — all deliverable, all the wrong
// person to pitch a website to, and the privacy ones are exactly who files a
// CASL complaint about unsolicited marketing.

function emailsFrom(html: string, domain = "nygh.on.ca"): string[] {
  return extractContactEmails(html, cheerio.load(html), domain);
}

for (const local of [
  "privacy", "privacyofficer", "dpo", "legal", "compliance",
  "hr", "hrweb", "careers", "jobs", "abuse", "unsubscribe",
  "patientrelations", "recursoshumanos",
]) {
  test(`drops ${local}@ — deliverable but never a pitch recipient`, () => {
    const html = `<a href="mailto:${local}@nygh.on.ca">contact</a>`;
    assert.deepEqual(emailsFrom(html), []);
  });
}

test("drops punctuated variants (privacy.officer@, privacy-officer@)", () => {
  assert.deepEqual(emailsFrom('<a href="mailto:privacy.officer@nygh.on.ca">x</a>'), []);
  assert.deepEqual(emailsFrom('<a href="mailto:privacy-officer@nygh.on.ca">x</a>'), []);
});

test("still KEEPS the role inboxes we do pitch", () => {
  // isRoleBasedEmail deprioritises these to rank 5; it must not drop them.
  for (const local of ["info", "hello", "contact", "sales", "admin", "ventas"]) {
    assert.deepEqual(
      emailsFrom(`<a href="mailto:${local}@nygh.on.ca">x</a>`),
      [`${local}@nygh.on.ca`],
      `${local}@ should survive`,
    );
  }
});

test("does not drop a person whose name merely contains a blocked word", () => {
  // "hrishikesh" starts with "hr"; the check is whole-local, not prefix.
  assert.deepEqual(
    emailsFrom('<a href="mailto:hrishikesh@nygh.on.ca">x</a>'),
    ["hrishikesh@nygh.on.ca"],
  );
});

// ── Regulators must never become contacts ─────────────────────────────────────
//
// A live incident, not a hypothetical. The first sweep wrote
// generalinfo@oipc.ab.ca (Information & Privacy Commissioner of Alberta) as a
// wholesaler's contact, and info@privcom.gc.ca (Privacy Commissioner of Canada)
// for a hotel spa — because Canadian privacy policies must tell you how to
// complain to the regulator. Note the local parts: "generalinfo", "info", a
// surname. No local-part blocklist could ever have caught these.

for (const addr of [
  "generalinfo@oipc.ab.ca",
  "eschiman@oipc.ab.ca",
  "info@privcom.gc.ca",
  "info@priv.gc.ca",
  "contact@ipc.on.ca",
  "someone@canada.gc.ca",
  "info@cai.gouv.qc.ca",
  "contacto@sat.gob.mx",
]) {
  test(`drops regulator/government address ${addr}`, () => {
    assert.deepEqual(emailsFrom(`<a href="mailto:${addr}">complain here</a>`), []);
  });
}

test("a private business on a normal domain is not mistaken for a regulator", () => {
  // The pattern must anchor on the domain's tail — "ipcanada.com" is not "ipc".
  assert.deepEqual(
    emailsFrom('<a href="mailto:info@ipcanada.com">x</a>'),
    ["info@ipcanada.com"],
  );
  assert.deepEqual(
    emailsFrom('<a href="mailto:sales@govan-industries.ca">x</a>'),
    ["sales@govan-industries.ca"],
  );
});

test("institution-prefixed function inboxes are dropped", () => {
  // Both reached prospect_contacts in the first sweep: a whole-local check
  // missed them because the function name is a suffix, not the whole local.
  assert.deepEqual(emailsFrom('<a href="mailto:rvh.privacy@nygh.on.ca">x</a>'), []);
  assert.deepEqual(emailsFrom('<a href="mailto:hr.recruitment@nygh.on.ca">x</a>'), []);
});

// ── Off-site redirect guard ───────────────────────────────────────────────────
//
// Caught by running the new scraper against real prospects: gluo.mx 301s to
// orium.com/gluo (Gluo was acquired), and the sub-page mining dutifully
// returned hello@orium.com. Deliverable, real — and the wrong company. Before
// this change those prospects found nothing and were suppressed, which is the
// correct outcome; mining harder turned a safe miss into a mis-addressed pitch.

test("cross-domain redirect is off-site (the gluo.mx -> orium.com case)", () => {
  assert.equal(redirectedOffsite("https://gluo.mx", "https://orium.com/gluo"), true);
});

test("www and protocol changes are NOT off-site", () => {
  assert.equal(redirectedOffsite("http://acme.ca", "https://www.acme.ca/"), false);
  assert.equal(redirectedOffsite("https://www.acme.ca", "https://acme.ca/home"), false);
});

test("subdomains are NOT off-site", () => {
  assert.equal(redirectedOffsite("https://acme.ca", "https://shop.acme.ca/"), false);
  assert.equal(redirectedOffsite("https://shop.acme.ca", "https://acme.ca/"), false);
});

test("multi-part TLDs are handled without a public-suffix list", () => {
  assert.equal(redirectedOffsite("https://acme.com.mx", "https://www.acme.com.mx/"), false);
  // Two unrelated businesses that merely share a suffix must stay off-site.
  assert.equal(redirectedOffsite("https://acme.com.mx", "https://otra.com.mx/"), true);
});

test("unparseable URLs never fabricate an off-site verdict", () => {
  assert.equal(redirectedOffsite("not a url", "https://acme.ca"), false);
});

// ── Homepage behaviour is unchanged ───────────────────────────────────────────

test("parseSite still mines the homepage itself", () => {
  const html = `<html><body>
    <a href="mailto:hello@weeksconstruction.ca">Email us</a>
    <a href="/privacy">Privacy</a>
  </body></html>`;
  const parsed = parseSite(html, BASE);
  assert.deepEqual(parsed.contact_emails, ["hello@weeksconstruction.ca"]);
  // The legal URL is collected for the hunt even when the homepage succeeded;
  // the hunt itself is what's skipped in that case.
  assert.ok(parsed.key_pages.some((p) => p.label === "Privacy"));
});

// ── siteOwnership: does the scraped site belong to this prospect? ─────────────
//
// Discovery attaches wrong domains. "Corvex Manufacturing" was stored against
// linamar.com (its parent), so scraping produced a real, deliverable address
// for a Linamar employee. Three-valued on purpose: two attempts at a boolean
// failed in OPPOSITE directions, which is what "unsure" exists to absorb.

test("siteOwnership: matching name is a confident yes", () => {
  assert.equal(siteOwnership("Grant Marion Construction", "Grant Marion Construction", "grantmarionconstruction.com"), "yes");
});

test("siteOwnership: Ltd vs Limited still matches (the boolean-attempt-1 failure)", () => {
  assert.equal(siteOwnership("Brewers Distributor Ltd", "Brewers Distributor Limited", "bdl.ca"), "yes");
});

test("siteOwnership: acronym domain with a self-naming site matches", () => {
  // sbghc.on.ca IS South Bruce Grey Health Centre — domain-token matching alone
  // rejected ~30 legitimate prospects like this.
  assert.equal(siteOwnership("South Bruce Grey Health Centre", "South Bruce Grey Health Centre", "sbghc.on.ca"), "yes");
});

test("siteOwnership: shared GENERIC word is not a match (the boolean-attempt-2 failure)", () => {
  // Both contain "Manufacturing" and nothing else — different companies.
  assert.notEqual(siteOwnership("Arctic Spas Manufacturing", "Blue Falls Manufacturing", "bluefallsbrands.com"), "yes");
});

test("siteOwnership: the Corvex case is not a yes", () => {
  assert.notEqual(siteOwnership("Corvex Manufacturing", "Linamar", "linamar.com"), "yes");
  assert.notEqual(siteOwnership("Holiday Inn Niagara Falls", "IHG Hotels & Resorts", "ihg.com"), "yes");
  assert.notEqual(siteOwnership("Canweld Group", "Symposium Cafe Restaurants", "symposiumcafe.com"), "yes");
});

test("siteOwnership: a tagline title still passes via the domain", () => {
  // <title> is often a tagline that names nothing. The domain rescues it.
  assert.equal(siteOwnership("Jones & O'Connell LLP", "Chartered Professional Accountants", "jonesoconnell.ca"), "yes");
});

test("siteOwnership: parked domains are their own verdict", () => {
  assert.equal(siteOwnership("Perry's Tackle Wholesale", "HugeDomains", "perrystackle.com"), "parked");
  assert.equal(siteOwnership("NR Accounting", "Coming Soon", "nraccounting.ca"), "parked");
});

test("siteOwnership: no distinctive tokens is unsure, never a false yes", () => {
  // Every token is generic — there is nothing to match on either way.
  assert.equal(siteOwnership("Canada Services Ltd", null, "example.com"), "unsure");
});
