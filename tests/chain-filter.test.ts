/**
 * National-chain filter.
 *
 * The chain fixtures are the REAL names Yellow Pages returned for
 * "wholesale / Alberta" against a "Calgary Mid-Market Manufacturers &
 * Distributors" ICP (2026-07-21).
 *
 * The false-positive tests matter more than the true positives: a wrong match
 * here silently deletes a real prospect at discovery, where nobody will ever
 * see it. Every "must survive" case is a plausible Canadian/Mexican SMB.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { isNationalChain, isChainDomain, isChainListing } from "../lib/discover/chain-filter.ts";

test("drops the real chains YP returned for an SMB ICP", () => {
  assert.equal(isNationalChain("Walmart"), true);
  assert.equal(isNationalChain("Shoppers Drug Mart"), true);
  assert.equal(isNationalChain("Loblaw Pharmacy"), true);
  assert.equal(isNationalChain("Rexall"), true);
  assert.equal(isNationalChain("Petro Canada Wholesale Marketing"), true);
});

test("drops chains regardless of casing/accents/punctuation", () => {
  assert.equal(isNationalChain("WAL-MART SUPERCENTRE"), true);
  assert.equal(isNationalChain("Tim Hortons #4821"), true);
  assert.equal(isNationalChain("Farmacias Guadalajara"), true);
  assert.equal(isNationalChain("Cinépolis"), true);
  assert.equal(isNationalChain("OXXO"), true);
});

test("drops obvious branch listings", () => {
  assert.equal(isNationalChain("Some Grocer Store #1182"), true);
  assert.equal(isNationalChain("Ferretería Sucursal Centro"), true);
});

test("MUST NOT drop real SMB prospects (false positives delete silently)", () => {
  // Plausible Calgary / Alberta mid-market businesses.
  assert.equal(isNationalChain("Neeralta Manufacturing Inc."), false);
  assert.equal(isNationalChain("Barda Equipment"), false);
  assert.equal(isNationalChain("Drader Manufacturing Industries Ltd"), false);
  assert.equal(isNationalChain("A-Line Distributors"), false);
  assert.equal(isNationalChain("Westwinds Wholesale Cash & Carry"), false);
  assert.equal(isNationalChain("Avalanche Contracting"), false);
  assert.equal(isNationalChain("Kenco Construction"), false);
  // Names that CONTAIN a common word also used by a chain.
  assert.equal(isNationalChain("Shell Beach Boutique"), false);
  assert.equal(isNationalChain("Bay Street Dental"), false);
  assert.equal(isNationalChain("The Source Metalworks"), false);
  assert.equal(isNationalChain("Marks Welding & Fabrication"), false);
  assert.equal(isNationalChain("Delgado Sol Distribuciones"), false);
  // Word-boundary safety: a brand name embedded in a longer word.
  assert.equal(isNationalChain("Walmartinez Consulting"), false);
  assert.equal(isNationalChain("Essonova Labs"), false);
});

test("chain domains are caught, including subdomains", () => {
  assert.equal(isChainDomain("walmart.ca"), true);
  assert.equal(isChainDomain("www.shoppersdrugmart.ca"), true);
  assert.equal(isChainDomain("careers.walmart.ca"), true);
  assert.equal(isChainDomain("farmaciasguadalajara.com"), true);
  // Real SMB domains must pass.
  assert.equal(isChainDomain("neeralta.com"), false);
  assert.equal(isChainDomain("julien-cormier.ca"), false);
  assert.equal(isChainDomain(null), false);
  assert.equal(isChainDomain(undefined), false);
  // A domain merely CONTAINING a brand string is not the chain.
  assert.equal(isChainDomain("notwalmart.ca"), false);
});

test("isChainListing combines both signals", () => {
  // Local-sounding name, but the site is the national brand.
  assert.equal(isChainListing("Calgary Trail Location", "walmart.ca"), true);
  // Chain name, no domain.
  assert.equal(isChainListing("Costco", null), true);
  // Genuine prospect on both signals.
  assert.equal(isChainListing("Drader Manufacturing Industries Ltd", "drader.com"), false);
});
