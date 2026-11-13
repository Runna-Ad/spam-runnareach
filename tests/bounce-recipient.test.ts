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
import { extractBouncedRecipient, isSenderSideBlock } from "../lib/replies/bounce-parse.ts";

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

// ── Gmail refusing to send our email (2026-11-11) vs a dead address ──────────
// Texts as stored in replies.body_text (addresses swapped for example ones).

const GMAIL_BLOCKED =
  "** Message blocked ** Your message to info@example-hospital.ca has been blocked. See technical details below for more information. Learn more here: https://support.google.com/mail/answer/69585 The response was: Message rejected. For more information, go to https://support.google.com/mail/answer/69585";
const EXCHANGE_DEAD =
  "** Message blocked ** Your message to inf@example-law.ca has been blocked. See technical details below for more information. Learn more here: https://aka.ms/EXOSmtpErrors (Warning: This link will take you to a third-party site) The response from the remote server was: 550 5.4.1 Recipient address rejected: Access denied. For more information see https://aka.ms/EXOSmtpErrors";
const GMAIL_NOT_FOUND =
  "** Address not found ** Your message wasn't delivered to contacto@example.com.mx because the address couldn't be found, or is unable to receive mail. The response from the remote server was: 550 No Such User Here";
const GMAIL_NOT_FOUND_GOOGLE_HOSTED =
  "** Address not found ** Your message wasn't delivered to ana@example.com because the address couldn't be found, or is unable to receive mail. Learn more here: https://support.google.com/mail/?p=NoSuchUser The response was: The email account that you tried to reach does not exist.";
const FORWARDING_REFUSED =
  "Delivery has failed to these recipients or groups: info@example-cpa.com Remote server returned '550 5.7.520 Access denied, Your organization does not allow external forwarding.'";

test("Gmail refusing to send ('The response was: Message rejected', no remote server) is a sender-side block", () => {
  assert.equal(isSenderSideBlock(GMAIL_BLOCKED), true);
  assert.equal(isSenderSideBlock(GMAIL_BLOCKED.replace("** Message blocked ** ", "")), true, "'has been blocked' alone is enough");
});

test("a recipient server's refusal or a dead mailbox is not a sender-side block", () => {
  assert.equal(isSenderSideBlock(EXCHANGE_DEAD), false, "Microsoft 365 dead mailbox, worded 'Message blocked'");
  assert.equal(isSenderSideBlock(GMAIL_NOT_FOUND), false);
  assert.equal(isSenderSideBlock(GMAIL_NOT_FOUND_GOOGLE_HOSTED), false, "Google-hosted dead address also says 'The response was:'");
  assert.equal(isSenderSideBlock(FORWARDING_REFUSED), false);
  assert.equal(isSenderSideBlock(""), false);
  assert.equal(isSenderSideBlock(null), false);
});

test("only the diagnosis counts, not our own email quoted further down", () => {
  const quoted = `${GMAIL_NOT_FOUND}\n${"-".repeat(2100)}\n----- Original message -----\nYour message has been blocked. The response was: Message rejected`;
  assert.equal(isSenderSideBlock(quoted), false);
});
