/**
 * Unit tests for the shared email gate (email-utils.ts).
 *
 * The glued/placeholder cases are pinned to REAL bounces from 2026-07:
 *   - filler@godaddy.comreservacionespedidosmi (run-together page text, NXDOMAIN)
 *   - 66220store@thann.com.mx (postal code fused onto store@, 550 no such user)
 *   - filler@godaddy.com (GoDaddy site-builder placeholder)
 */

import assert from "node:assert/strict";
import test from "node:test";
import {
  hasUsableEmail,
  hasValidTld,
  hasGluedDigitPrefix,
  isRoleBasedEmail,
} from "../lib/research/email-utils.ts";
import { repairGluedTldDomain } from "../lib/research/scraper.ts";

test("repairGluedTldDomain recovers same-domain glue (real prod rows)", () => {
  assert.equal(repairGluedTldDomain("info@neeralta.commonday", "neeralta.com"), "info@neeralta.com");
  assert.equal(repairGluedTldDomain("spa@playalosarcos.combottom", "playalosarcos.com"), "spa@playalosarcos.com");
  assert.equal(repairGluedTldDomain("mfg@drader.comedmonton", "www.drader.com"), "mfg@drader.com");
  // Multi-label TLD (com.mx)
  assert.equal(repairGluedTldDomain("store@thann.com.mxtienda", "thann.com.mx"), "store@thann.com.mx");
  // Clean emails untouched
  assert.equal(repairGluedTldDomain("info@neeralta.com", "neeralta.com"), "info@neeralta.com");
});

test("repairGluedTldDomain refuses foreign-domain glue (third-party addresses)", () => {
  // Scam-comment emails scraped off cpa4it.ca — truncating would produce a
  // stranger's real gmail inbox. Must stay broken (and thus rejected).
  assert.equal(
    repairGluedTldDomain("susanryan3221@gmail.comwhatsapp", "cpa4it.ca"),
    "susanryan3221@gmail.comwhatsapp",
  );
  assert.equal(
    repairGluedTldDomain("filler@godaddy.comquienes", "beautystudio.mx"),
    "filler@godaddy.comquienes",
  );
  assert.equal(repairGluedTldDomain("a@b.comx", null), "a@b.comx");
});

test("hasUsableEmail accepts normal business addresses", () => {
  assert.equal(hasUsableEmail("carmen@cgcbienesraices.com"), true);
  assert.equal(hasUsableEmail("store@thann.com.mx"), true);
  assert.equal(hasUsableEmail("pedro@runna.agency"), true);
  assert.equal(hasUsableEmail("info@example-clinic.ca"), true);
  assert.equal(hasUsableEmail("ventas@empresa.mx"), true);
});

test("hasUsableEmail rejects run-together domain glue (real bounce)", () => {
  assert.equal(hasUsableEmail("filler@godaddy.comreservacionespedidosmi"), false);
  assert.equal(hasUsableEmail("contact@acme.comnextsectiontext"), false);
});

test("hasUsableEmail rejects glued digit prefixes (real bounce)", () => {
  assert.equal(hasUsableEmail("66220store@thann.com.mx"), false);
  assert.equal(hasUsableEmail("12345info@business.mx"), false);
  // Short digit runs are legit brand names, not glue
  assert.equal(hasUsableEmail("24hourplumbing@fixit.ca"), true);
  assert.equal(hasUsableEmail("365fitness@gym.com"), true);
});

test("hasUsableEmail rejects site-builder placeholders (real bounce)", () => {
  assert.equal(hasUsableEmail("filler@godaddy.com"), false);
  assert.equal(hasUsableEmail("anything@secureserver.net"), false);
  assert.equal(hasUsableEmail("user@domain.com"), false);
  assert.equal(hasUsableEmail("ejemplo@ejemplo.com"), false);
});

test("hasValidTld", () => {
  assert.equal(hasValidTld("thann.com.mx"), true);
  assert.equal(hasValidTld("runna.agency"), true);
  assert.equal(hasValidTld("shop.example.ca"), true);
  assert.equal(hasValidTld("godaddy.comreservacionespedidosmi"), false);
  assert.equal(hasValidTld("acme.commx"), false);
});

test("hasGluedDigitPrefix", () => {
  assert.equal(hasGluedDigitPrefix("66220store"), true); // MX postal code glue
  assert.equal(hasGluedDigitPrefix("1800flowers"), false); // 4-digit brand local — keep
  assert.equal(hasGluedDigitPrefix("24hour"), false);
  assert.equal(hasGluedDigitPrefix("carmen"), false);
});

test("role-based detection still intact after refactor", () => {
  assert.equal(isRoleBasedEmail("info@x.com"), true);
  assert.equal(isRoleBasedEmail("carmen@x.com"), false);
});
