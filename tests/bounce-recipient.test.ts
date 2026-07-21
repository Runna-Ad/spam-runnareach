/**
 * Unit tests for extractBouncedRecipient() — pulls the dead mailbox out of a
 * non-delivery report so it can be added to the do-not-contact list.
 *
 * Fixtures are Pedro's REAL bounces from 2026-07 (Gmail NDRs), plus the RFC
 * 3464 machine field and an Exchange phrasing.
 *
 * The critical property: it must NEVER return our own sender address or a
 * daemon address, and must return null rather than guess — a wrong entry here
 * permanently blocks a valid contact.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { extractBouncedRecipient } from "../lib/replies/bounce-parse.ts";

const SENDER = "pedro@runnareach.com";

test("Gmail 'wasn't delivered to' phrasing (real bounce: Thann)", () => {
  const body = `** Address not found **

Your message wasn't delivered to 66220store@thann.com.mx because the address couldn't be found, or is unable to receive mail.

The response from the remote server was:
550 No Such User Here`;
  assert.equal(extractBouncedRecipient(body, SENDER), "66220store@thann.com.mx");
});

test("Gmail bad-domain phrasing (real bounce: Beauty Studio)", () => {
  const body = `** Address not found **

Your message wasn't delivered to filler@godaddy.comreservacionespedidosmi because the domain godaddy.comreservacionespedidosmi couldn't be found. Check for typos or unnecessary spaces and try again.`;
  assert.equal(
    extractBouncedRecipient(body, SENDER),
    "filler@godaddy.comreservacionespedidosmi",
  );
});

test("RFC 3464 Final-Recipient field wins", () => {
  const body = `This is the mail system at host mx.example.com.

Final-Recipient: rfc822; carlos@empresa.com.mx
Action: failed
Status: 5.1.1`;
  assert.equal(extractBouncedRecipient(body, SENDER), "carlos@empresa.com.mx");
});

test("Exchange/Office 365 phrasing", () => {
  const body = `Your message to info@contoso.ca couldn't be delivered.
info@contoso.ca wasn't found at contoso.ca.`;
  assert.equal(extractBouncedRecipient(body, SENDER), "info@contoso.ca");
});

test("never returns our own sender address", () => {
  const body = `Final-Recipient: rfc822; ${SENDER}
Action: failed`;
  assert.equal(extractBouncedRecipient(body, SENDER), null);
});

test("never returns a daemon address", () => {
  const body = `Final-Recipient: rfc822; mailer-daemon@googlemail.com`;
  assert.equal(extractBouncedRecipient(body, SENDER), null);
});

test("returns null rather than guessing", () => {
  assert.equal(extractBouncedRecipient("Delivery failed. Please try again.", SENDER), null);
  assert.equal(extractBouncedRecipient(null, SENDER), null);
  assert.equal(extractBouncedRecipient("", SENDER), null);
});

test("strips trailing punctuation from the parsed address", () => {
  const body = "Your message wasn't delivered to ana@clinica.mx, because the address couldn't be found.";
  assert.equal(extractBouncedRecipient(body, SENDER), "ana@clinica.mx");
});
