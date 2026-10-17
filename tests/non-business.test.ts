/** Government and news sites never become prospects. */

import assert from "node:assert/strict";
import test from "node:test";
import { isNonBusinessHost } from "../lib/discover/non-business.ts";

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
