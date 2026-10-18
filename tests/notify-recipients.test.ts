/**
 * The notify list: every alert to Pedro's two addresses, leads to the team too.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { notifyRecipients, parseEmailList } from "../lib/notify/recipients.ts";

test("ops defaults: pedro@runnareach.com and petedv31@gmail.com", () => {
  assert.deepEqual(notifyRecipients("ops", {}), ["pedro@runnareach.com", "petedv31@gmail.com"]);
});

test("lead defaults: the ops list plus nils@runna.com.mx", () => {
  assert.deepEqual(notifyRecipients("lead", {}), ["pedro@runnareach.com", "petedv31@gmail.com", "nils@runna.com.mx"]);
});

test("NOTIFY_EMAILS replaces the ops list; LEAD_NOTIFY_EMAILS replaces the lead extras", () => {
  const env = { NOTIFY_EMAILS: "a@x.com, B@Y.com", LEAD_NOTIFY_EMAILS: "c@z.mx;d@z.mx" };
  assert.deepEqual(notifyRecipients("ops", env), ["a@x.com", "b@y.com"]);
  assert.deepEqual(notifyRecipients("lead", env), ["a@x.com", "b@y.com", "c@z.mx", "d@z.mx"]);
});

test("a blank or invalid override never silences alerts", () => {
  assert.deepEqual(notifyRecipients("ops", { NOTIFY_EMAILS: "" }), ["pedro@runnareach.com", "petedv31@gmail.com"]);
  assert.deepEqual(notifyRecipients("ops", { NOTIFY_EMAILS: "not-an-email, ," }), ["pedro@runnareach.com", "petedv31@gmail.com"]);
  assert.deepEqual(notifyRecipients("lead", { LEAD_NOTIFY_EMAILS: " " }).at(-1), "nils@runna.com.mx");
});

test("duplicates across the lists are sent once", () => {
  const env = { NOTIFY_EMAILS: "pedro@runnareach.com", LEAD_NOTIFY_EMAILS: "PEDRO@runnareach.com, nils@runna.com.mx" };
  assert.deepEqual(notifyRecipients("lead", env), ["pedro@runnareach.com", "nils@runna.com.mx"]);
});

test("parseEmailList drops header-breaking input", () => {
  assert.deepEqual(parseEmailList("a@x.com\r\nBcc: evil@x.com"), ["a@x.com", "evil@x.com"]);
  assert.deepEqual(parseEmailList('"Name" <a@x.com>'), []);
  assert.deepEqual(parseEmailList(undefined), []);
});
