import { test } from "node:test";
import assert from "node:assert/strict";
import { deriveButtonText } from "../lib/gmail/mime.ts";

// Batch 10 (pitch v3.4): the CTA says "see what our free check finds on [company]'s site".
// A fresh CTA without "the data" keeps the self-serve label instead of the audit fallback.
test("a CTA about our free check gets the self-serve button label", () => {
  assert.equal(deriveButtonText("Worth a look? Our free check reads Acme's site in about 30 seconds, no signup."), "See it for yourself →");
  assert.equal(deriveButtonText("Don't take my word for it, take the data's: see what our free check finds on Acme's site."), "See it for yourself →");
});

test("labels for other CTAs are unchanged", () => {
  assert.equal(deriveButtonText("Run the audit on your store"), "Run my free audit →");
  assert.equal(deriveButtonText("mira lo que nuestra herramienta gratis encuentra", "es"), "Ver diagnóstico gratis →");
});
