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
  const html = `<html><body>
    <p>These Terms are governed by the laws of Ontario. Questions:
       legal@weeksconstruction.ca</p>
  </body></html>`;
  const emails = extractContactEmails(html, cheerio.load(html), "weeksconstruction.ca");
  assert.deepEqual(emails, ["legal@weeksconstruction.ca"]);
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
