/**
 * The email-link address serves email links only (Safe Browsing flag on
 * runna-check.vercel.app, 2026-11-10): no sign-in page, no dashboard.
 */

import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import test from "node:test";
import { allowedOnLinkHost, isLinkOnlyHost, SEARCH_CONSOLE_FILE } from "../lib/compliance/link-host.ts";
import { UNSUBSCRIBE_PATH } from "../lib/compliance/outbound.ts";
import { TRACKED_LINK_PATH } from "../lib/pitches/tracked-links.ts";

test("only the email-link address is locked, never the app's own host", () => {
  assert.equal(isLinkOnlyHost("runna-check.vercel.app"), true);
  assert.equal(isLinkOnlyHost("RUNNA-CHECK.vercel.app"), true);
  assert.equal(isLinkOnlyHost("runna-check.vercel.app:443"), true);
  assert.equal(isLinkOnlyHost("runna-check.vercel.app."), true);
  assert.equal(isLinkOnlyHost("spam-runnareach.vercel.app"), false);
  assert.equal(isLinkOnlyHost("spam-runnareach-git-fix-link-host-lock-runna.vercel.app"), false);
  assert.equal(isLinkOnlyHost("localhost:3000"), false);
  assert.equal(isLinkOnlyHost("evil-runna-check.vercel.app"), false);
  assert.equal(isLinkOnlyHost(null), false);
});

test("the links every email carries still work on it", () => {
  assert.equal(allowedOnLinkHost(`${TRACKED_LINK_PATH}yhyxyr8r`), true);
  assert.equal(allowedOnLinkHost("/r/not-a-real-code"), true, "an unknown code still redirects to the free check");
  assert.equal(allowedOnLinkHost(UNSUBSCRIBE_PATH), true);
  assert.equal(allowedOnLinkHost(SEARCH_CONSOLE_FILE), true);
});

test("the sign-in page and the app answer 404 on it", () => {
  for (const path of ["/", "/sign-in", "/sign-up", "/invite", "/dashboard", "/settings/sending", "/pitches", "/r", "/r/", "/r/abc/def", "/api/unsubscribe/x", "/api/replies/poll"]) {
    assert.equal(allowedOnLinkHost(path), false, path);
  }
});

test("Search Console's ownership file is in public/ with Google's exact content", () => {
  const file = new URL(`../public${SEARCH_CONSOLE_FILE}`, import.meta.url);
  assert.ok(existsSync(file));
  assert.equal(readFileSync(file, "utf8").trim(), `google-site-verification: ${SEARCH_CONSOLE_FILE.slice(1)}`);
});
