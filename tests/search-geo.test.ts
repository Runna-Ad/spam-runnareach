/** Every source searches the region the scout chose. */

import assert from "node:assert/strict";
import test from "node:test";
import { searchGeo } from "../lib/discover/search-geo.ts";

const MX = { "Nuevo León": "19", Monterrey: "19", "Ciudad de México": "09" };

test("a Mexican cell searches its state: Places gets the INEGI code (text + bias), Brave the name", () => {
  assert.deepEqual(searchGeo("MX", ["Nuevo León"], "Nuevo León", MX), { yp: "Canada", places: "19", brave: "Nuevo León" });
  assert.equal(searchGeo("MX", ["Monterrey"], "Monterrey", MX).places, "19");
  assert.equal(searchGeo("MX", ["Puebla"], "Puebla", MX).places, "Puebla, Mexico");
});

test("a manual Mexican run still searches the whole country", () => {
  assert.deepEqual(searchGeo("MX", ["Ciudad de México", "Monterrey"], null, MX), { yp: "Canada", places: "Mexico", brave: "Mexico" });
});

test("a Canadian city cell: Places and Brave get the city, Yellow Pages its province", () => {
  assert.deepEqual(searchGeo("CA", ["Calgary"], "Calgary", MX), { yp: "Alberta", places: "Calgary, Canada", brave: "Calgary" });
  assert.deepEqual(searchGeo("CA", ["Alberta"], "Alberta", MX), { yp: "Alberta", places: "Alberta, Canada", brave: "Alberta" });
});

test("a manual Canadian run uses the ICP's first province, as before", () => {
  assert.deepEqual(searchGeo("CA", ["Calgary", "Alberta", "Ontario"], null, MX), { yp: "Alberta", places: "Alberta, Canada", brave: "Alberta" });
  assert.deepEqual(searchGeo("CA", ["Calgary"], null, MX), { yp: "Canada", places: "Canada", brave: "Canada" });
});
