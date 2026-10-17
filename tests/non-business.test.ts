/** Government and news sites never become prospects. */

import assert from "node:assert/strict";
import test from "node:test";
import { isListicleTitle, isNonBusinessHost } from "../lib/discover/non-business.ts";

test("numbered list pages are dropped, in English and Spanish", () => {
  for (const t of [
    "LOS 10 MEJORES spas en México (Actualizado 2026)",
    "¡Descubre los 12 mejores spas en Ciudad de México! | Moons",
    "Los 13 mejores spas en CDMX para un día de relax",
    "Top 10 Law Firms in Calgary",
    "15 Best Accounting Firms in Toronto",
    "The 7 best spas in Monterrey",
  ]) {
    assert.equal(isListicleTitle(t), true, t);
  }
  for (const t of ["The Best Pizza in Calgary | Tony's", "Manthra SPA Chapultepec", "Top Notch Plumbing", "24 Hour Fitness"]) {
    assert.equal(isListicleTitle(t), false, t);
  }
});

test("what the first autopilot run found is refused", () => {
  for (const h of [
    "news.gov.bc.ca",
    "edmonton.citynews.ca",
    "vancouver.citynews.ca",
    "www.winnipegfreepress.com",
    "www.canada.ca",
    "www.quebec.ca",
    "www.economie.gouv.qc.ca",
    "www.gob.mx",
    "en.wikipedia.org",
  ]) {
    assert.equal(isNonBusinessHost(h), true, h);
  }
});

test("real businesses pass, including ones with lookalike names", () => {
  for (const h of [
    "furnituremattressdeals.com",
    "travelalberta.ca",
    "goodnewsbakery.ca",
    "news.ca", // a bare domain, not a news.* subdomain
    "gcroofing.ca",
    "www.calgaryplumbing.ca",
  ]) {
    assert.equal(isNonBusinessHost(h), false, h);
  }
});
