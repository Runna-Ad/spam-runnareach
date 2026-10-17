/**
 * Contact source URL: every scraped address records the page it was mined from,
 * so a just-in-time freshness check can re-read that page before a send.
 *
 * The end-to-end cases stub global fetch with a tiny fake site and run the real
 * scrapeSite, so the URL is proven to survive the whole homepage → sub-page →
 * legal-page path, not just the pure helper.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { attributeEmailSources, scrapeSite } from "../lib/research/scraper.ts";

const BASE = "https://weeksconstruction.ca";

const NAV = `
  <nav>
    <a href="/about">About</a>
    <a href="/contact">Contact</a>
    <a href="/privacy-policy">Privacy Policy</a>
  </nav>`;

function page(body: string): string {
  return `<!doctype html><html><head><title>Weeks Construction</title></head>
    <body>${NAV}<main>${body}</main></body></html>`;
}

async function withFakeSite<T>(pages: Record<string, string>, run: () => Promise<T>): Promise<T> {
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const path = new URL(url).pathname.replace(/\/$/, "") || "/";
    const html = pages[path];
    const res = new Response(html ?? "not found", {
      status: html === undefined ? 404 : 200,
      headers: { "content-type": "text/html; charset=utf-8" },
    });
    Object.defineProperty(res, "url", { value: url });
    return res;
  }) as typeof fetch;
  try {
    return await run();
  } finally {
    globalThis.fetch = realFetch;
  }
}

// ── Pure attribution ─────────────────────────────────────────────────────────

test("attributeEmailSources: first page in fetch order wins", () => {
  const sources = attributeEmailSources(
    ["hello@weeksconstruction.ca"],
    [
      { url: `${BASE}/`, label: "Home", emails: ["hello@weeksconstruction.ca"] },
      { url: `${BASE}/about`, label: "About", emails: ["hello@weeksconstruction.ca"] },
    ],
  );
  assert.deepEqual(sources, { "hello@weeksconstruction.ca": `${BASE}/` });
});

test("attributeEmailSources: a Contact page outranks pages fetched before it", () => {
  const sources = attributeEmailSources(
    ["ray@weeksconstruction.ca"],
    [
      { url: `${BASE}/about`, label: "About", emails: ["ray@weeksconstruction.ca"] },
      { url: `${BASE}/contact`, label: "Contact", emails: ["ray@weeksconstruction.ca"] },
    ],
  );
  assert.deepEqual(sources, { "ray@weeksconstruction.ca": `${BASE}/contact` });
});

test("attributeEmailSources: an address with no mined page is left out, not guessed", () => {
  const sources = attributeEmailSources(["ghost@weeksconstruction.ca"], [
    { url: `${BASE}/`, label: "Home", emails: [] },
  ]);
  assert.deepEqual(sources, {});
});

// ── End to end through scrapeSite ────────────────────────────────────────────

test("scrapeSite: address on /contact and /about records the absolute /contact URL", async () => {
  const result = await withFakeSite(
    {
      "/": page("<p>Custom homes in Moncton.</p>"),
      "/about": page("<p>Family-run since 1987. Write to ray@weeksconstruction.ca.</p>"),
      "/contact": page("<p>Email ray@weeksconstruction.ca</p>"),
    },
    () => scrapeSite(BASE),
  );
  assert.ok(result.ok);
  assert.deepEqual(result.site.contact_emails, ["ray@weeksconstruction.ca"]);
  assert.equal(result.site.contact_email_sources["ray@weeksconstruction.ca"], `${BASE}/contact`);
});

test("scrapeSite: mailto and plaintext addresses both carry a source URL", async () => {
  const result = await withFakeSite(
    {
      "/": page(`<a href="mailto:Hello@WeeksConstruction.ca?subject=Quote">Email us</a>`),
      "/about": page("<p>Our estimator: estimates@weeksconstruction.ca</p>"),
      "/contact": page("<p>Call 506-555-0101</p>"),
    },
    () => scrapeSite(BASE),
  );
  assert.ok(result.ok);
  assert.deepEqual(result.site.contact_emails, [
    "hello@weeksconstruction.ca",
    "estimates@weeksconstruction.ca",
  ]);
  assert.deepEqual(result.site.contact_email_sources, {
    "hello@weeksconstruction.ca": `${BASE}/`,
    "estimates@weeksconstruction.ca": `${BASE}/about`,
  });
});

test("scrapeSite: an address only on the privacy page records the privacy URL", async () => {
  const result = await withFakeSite(
    {
      "/": page("<p>Custom homes in Moncton.</p>"),
      "/about": page("<p>Family-run since 1987.</p>"),
      "/contact": page("<p>Use the form below.</p>"),
      "/privacy-policy": page("<p>Questions about this policy? office@weeksconstruction.ca</p>"),
    },
    () => scrapeSite(BASE),
  );
  assert.ok(result.ok);
  assert.deepEqual(result.site.contact_emails, ["office@weeksconstruction.ca"]);
  assert.deepEqual(result.site.contact_email_sources, {
    "office@weeksconstruction.ca": `${BASE}/privacy-policy`,
  });
});
