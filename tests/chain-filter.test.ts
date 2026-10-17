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
  assert.equal(isNationalChain("Ferretería Sucursal 214"), true);
  assert.equal(isNationalChain("Abarrotes Tienda No. 1093"), true);
});

test("a small business's second location is NOT a branch of a chain", () => {
  // A two-shop ferretería or bakery is the SMB the ICP wants.
  assert.equal(isNationalChain("Ferretería Sucursal Centro"), false);
  assert.equal(isNationalChain("Panadería La Espiga Sucursal Norte"), false);
  assert.equal(isNationalChain("Kenco Construction Location #2"), false);
  assert.equal(isNationalChain("Mattress Supercentre"), false);
  assert.equal(isNationalChain("Calgary Tire Supercenter"), false);
});

test("the real chain listings in production are still dropped", () => {
  // prospects suppressed by hand on 2026-07-21, name or domain.
  assert.equal(isChainListing("Safeway Pharmacy", "safeway.ca"), true);
  assert.equal(isNationalChain("Safeway Pharmacy"), true);
  assert.equal(isNationalChain("Tarik's No Frills"), true);
  assert.equal(isNationalChain("Hillside Pharmasave"), true);
  assert.equal(isNationalChain("Save-On-Foods Pharmacy"), true);
  assert.equal(isNationalChain("Sobeys Distribution Centre"), true);
  assert.equal(isNationalChain("London Drugs"), true);
});

test("ambiguous brands drop only when the listing is plainly the chain", () => {
  assert.equal(isNationalChain("Safeway"), true);
  assert.equal(isNationalChain("Safeway - Kitsilano"), true);
  assert.equal(isNationalChain("Staples (Macleod Trail)"), true);
  assert.equal(isNationalChain("Staples Print & Marketing"), true);
  assert.equal(isNationalChain("Winners #212"), true);
  assert.equal(isNationalChain("Atmosphere | West Edmonton Mall"), true);
  assert.equal(isNationalChain("McDonald's"), true);
  assert.equal(isNationalChain("McDonald’s Restaurant"), true);
  assert.equal(isNationalChain("Wendy's"), true);
  assert.equal(isNationalChain("RONA Home & Garden"), true);
  assert.equal(isNationalChain("Superstore"), true);
  assert.equal(isNationalChain("Real Canadian Superstore"), true);
  assert.equal(isNationalChain("Caisse Desjardins de Lévis"), true);
  assert.equal(isNationalChain("Liverpool"), true);
  assert.equal(isNationalChain("Tiendas Coppel"), true);
  assert.equal(isNationalChain("Del Sol"), true);
});

test("MUST NOT drop SMBs that share a word with an ambiguous brand", () => {
  // Surnames and first names.
  assert.equal(isNationalChain("McDonald Law Office"), false);
  assert.equal(isNationalChain("McDonald & Sons Plumbing"), false);
  assert.equal(isNationalChain("Wendy's Hair Studio"), false);
  assert.equal(isNationalChain("Harvey's Auto Body"), false);
  assert.equal(isNationalChain("Desjardins Plomberie"), false);
  assert.equal(isNationalChain("Clinique Dentaire Desjardins"), false);
  assert.equal(isNationalChain("Lowes Electric Ltd"), false);
  assert.equal(isNationalChain("Rona-Lee's Bakery"), false);
  assert.equal(isNationalChain("Coppel Arquitectos"), false);
  // Ordinary words.
  assert.equal(isNationalChain("Atmosphere Salon & Spa"), false);
  assert.equal(isNationalChain("Safeway Driving School"), false);
  assert.equal(isNationalChain("Staples & Co. Bakery"), false);
  assert.equal(isNationalChain("Winners Circle Martial Arts"), false);
  assert.equal(isNationalChain("Circle K Ranch"), false);
  assert.equal(isNationalChain("Best Buy Auto Sales"), false);
  assert.equal(isNationalChain("Bob's Tire Superstore"), false);
  assert.equal(isNationalChain("The Real Canadian Plumbing Co"), false);
  assert.equal(isNationalChain("Elektra Hair Salon"), false);
  // Places and very common Spanish phrases.
  assert.equal(isNationalChain("Liverpool Family Pharmacy"), false);
  assert.equal(isNationalChain("Panadería del Sol"), false);
  assert.equal(isNationalChain("Hotel del Sol Mazatlán"), false);
  assert.equal(isNationalChain("Clínica Dental del Sol"), false);
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
