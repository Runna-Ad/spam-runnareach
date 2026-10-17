import assert from "node:assert/strict";
import test from "node:test";
import {
  detectCitedBenchmark,
  editRatio,
  newAttributionCode,
  recipientSummary,
  registerFor,
  sizeBand,
} from "../lib/pitches/decision.ts";

test("sizeBand / registerFor follow the composer's register thresholds", () => {
  assert.equal(sizeBand(null), "unknown");
  assert.equal(sizeBand(10), "smb");
  assert.equal(sizeBand(200), "mid_market");
  assert.equal(sizeBand(800), "enterprise");
  assert.equal(registerFor("es", "smb"), "tu");
  assert.equal(registerFor("es", "unknown"), "tu");
  assert.equal(registerFor("es", "mid_market"), "usted");
  assert.equal(registerFor("en", "enterprise"), null);
});

test("attribution codes are 8 URL-safe characters with no lookalikes", () => {
  const seen = new Set<string>();
  for (let i = 0; i < 200; i++) {
    const c = newAttributionCode();
    assert.match(c, /^[a-hjkmnp-z2-9]{8}$/);
    seen.add(c);
  }
  assert.ok(seen.size > 195, "codes should not collide in a small sample");
});

test("detectCitedBenchmark: which offered stat did the email actually quote?", () => {
  const offered = [
    { id: "hbr", figure: "7 times" },
    { id: "law", figure: "33%" },
    { id: "gs", figure: "twice" },
    { id: "big", figure: "44K" },
  ];
  assert.deepEqual(detectCitedBenchmark("Firms that reply in an hour are about 7 times more likely…", offered), { id: "hbr", figure: "7 times" });
  assert.deepEqual(detectCitedBenchmark("Only 33% of firms replied to the email.", offered), { id: "law", figure: "33%" });
  assert.deepEqual(detectCitedBenchmark("Buyers are twice as likely to trust a strong site.", offered), { id: "gs", figure: "twice" });
  assert.deepEqual(detectCitedBenchmark("A network serving 44,000 residents.", offered), { id: "big", figure: "44K" });
  assert.equal(detectCitedBenchmark("No numbers here, about 30 seconds only.", offered), null);
  // "17" must not count as quoting "7 times".
  assert.equal(detectCitedBenchmark("We saw 17 enquiries.", [{ id: "hbr", figure: "7 times" }]), null);
});

test("editRatio: 0 untouched, grows with the share of words a person changed", () => {
  assert.equal(editRatio("Hi Sam, short note here.", "Hi Sam, short note here."), 0);
  const one = editRatio("Hi Sam, short note here today.", "Hi Sam, quick note here today.");
  assert.ok(one > 0 && one < 0.3, String(one));
  assert.equal(editRatio("a b c d", "w x y z"), 1);
  assert.equal(editRatio("", ""), 0);
});

test("recipientSummary keeps the shape of the address, never the address", () => {
  const r = recipientSummary({ email: "Ana@Clinica.MX", full_name: "Ana López", selected_by: "scraper", email_is_role_based: false });
  assert.deepEqual(r, { email_domain: "clinica.mx", selected_by: "scraper", role_based: false, named: true });
  assert.equal(JSON.stringify(r).includes("ana@"), false);
  assert.deepEqual(recipientSummary(null), { email_domain: null, selected_by: null, role_based: false, named: false });
});
