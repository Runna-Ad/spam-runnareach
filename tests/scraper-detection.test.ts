/**
 * Unit tests for detectLanguage() and detectMarket() in scraper.ts.
 * Pure functions — no network needed.
 */

import assert from "node:assert/strict";
import test from "node:test";
import * as cheerio from "cheerio";
import { detectLanguage, detectMarket } from "../lib/research/scraper.ts";

// ── detectLanguage ────────────────────────────────────────────────────────────

test("detectLanguage: html[lang=es] → es", () => {
  const $ = cheerio.load('<html lang="es"><body>hola mundo</body></html>');
  assert.equal(detectLanguage($, "", "https://example.com"), "es");
});

test("detectLanguage: html[lang=es-MX] → es", () => {
  const $ = cheerio.load('<html lang="es-MX"><body>hola</body></html>');
  assert.equal(detectLanguage($, "", "https://example.mx"), "es");
});

test("detectLanguage: html[lang=en] → en", () => {
  const $ = cheerio.load('<html lang="en"><body>hello world</body></html>');
  assert.equal(detectLanguage($, "", "https://example.com"), "en");
});

test("detectLanguage: .mx TLD with no lang attr → es", () => {
  const $ = cheerio.load("<html><body>content</body></html>");
  assert.equal(detectLanguage($, "", "https://example.mx"), "es");
});

test("detectLanguage: .com.mx TLD → es", () => {
  const $ = cheerio.load("<html><body>content</body></html>");
  assert.equal(detectLanguage($, "", "https://tienda.example.com.mx"), "es");
});

test("detectLanguage: Spanish stopword majority → es", () => {
  const bodyText = Array(30).fill("de la el en y con por para que del los las una es").join(" ");
  const $ = cheerio.load(`<html><body>${bodyText}</body></html>`);
  assert.equal(detectLanguage($, "", "https://example.com"), "es");
});

test("detectLanguage: English stopword majority → en", () => {
  const bodyText = Array(30).fill("the and for with our your we are is this that from have not").join(" ");
  const $ = cheerio.load(`<html><body>${bodyText}</body></html>`);
  assert.equal(detectLanguage($, "", "https://example.com"), "en");
});

test("detectLanguage: no signal → defaults en", () => {
  const $ = cheerio.load("<html><body>xzqq lmnop</body></html>");
  assert.equal(detectLanguage($, "", "https://example.io"), "en");
});

// ── detectMarket ──────────────────────────────────────────────────────────────

test("detectMarket: .mx TLD → MX", () => {
  const $ = cheerio.load("<html><body></body></html>");
  assert.equal(detectMarket("https://example.mx", "", $), "MX");
});

test("detectMarket: .com.mx TLD → MX", () => {
  const $ = cheerio.load("<html><body></body></html>");
  assert.equal(detectMarket("https://tienda.example.com.mx", "", $), "MX");
});

test("detectMarket: .ca TLD → CA", () => {
  const $ = cheerio.load("<html><body></body></html>");
  assert.equal(detectMarket("https://example.ca", "", $), "CA");
});

test("detectMarket: .us TLD → US", () => {
  const $ = cheerio.load("<html><body></body></html>");
  assert.equal(detectMarket("https://example.us", "", $), "US");
});

test("detectMarket: CAD in HTML → CA", () => {
  const $ = cheerio.load("<html><body>Price: CAD 99</body></html>");
  assert.equal(detectMarket("https://example.com", "Price: CAD 99", $), "CA");
});

test("detectMarket: MXN in HTML → MX", () => {
  const $ = cheerio.load("<html><body>Precio: MXN 999</body></html>");
  assert.equal(detectMarket("https://example.com", "Precio: MXN 999", $), "MX");
});

test("detectMarket: Canadian province in body text → CA", () => {
  const $ = cheerio.load("<html><body>We serve clients in Calgary and Edmonton, Alberta.</body></html>");
  assert.equal(detectMarket("https://example.com", "", $), "CA");
});

test("detectMarket: Mexican city in body text → MX", () => {
  const $ = cheerio.load("<html><body>Somos una marca de CDMX con presencia en Monterrey.</body></html>");
  assert.equal(detectMarket("https://example.com", "", $), "MX");
});

test("detectMarket: .com with no geographic signal → null", () => {
  const $ = cheerio.load("<html><body>hello world</body></html>");
  assert.equal(detectMarket("https://example.com", "hello world", $), null);
});

test("detectMarket: .io with no geographic signal → null", () => {
  const $ = cheerio.load("<html><body>hello world</body></html>");
  assert.equal(detectMarket("https://example.io", "hello world", $), null);
});
