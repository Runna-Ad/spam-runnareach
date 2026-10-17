import assert from "node:assert/strict";
import test from "node:test";
import { isTestAddress, normalizeMailbox } from "../lib/compliance/test-addresses.ts";

test("Pedro's test inbox matches in every Gmail spelling", () => {
  const saved = process.env.RUNNA_TEST_EMAILS;
  delete process.env.RUNNA_TEST_EMAILS;
  try {
    for (const e of ["pedrojr22@gmail.com", "PedroJr22@Gmail.com", "pedrojr22+test1@gmail.com", "pedro.jr22@gmail.com", "pedrojr22@googlemail.com"]) {
      assert.equal(isTestAddress(e), true, e);
    }
    assert.equal(isTestAddress("pedro@runnareach.com"), false);
    assert.equal(isTestAddress("info@gymvmt.com"), false);
    assert.equal(isTestAddress(null), false);
  } finally {
    if (saved === undefined) delete process.env.RUNNA_TEST_EMAILS;
    else process.env.RUNNA_TEST_EMAILS = saved;
  }
});

test("RUNNA_TEST_EMAILS overrides the list; dots only fold for Gmail", () => {
  const saved = process.env.RUNNA_TEST_EMAILS;
  process.env.RUNNA_TEST_EMAILS = "qa@runna.mx, other.person@outlook.com";
  try {
    assert.equal(isTestAddress("qa+1@runna.mx"), true);
    assert.equal(isTestAddress("other.person@outlook.com"), true);
    assert.equal(isTestAddress("otherperson@outlook.com"), false);
    assert.equal(isTestAddress("pedrojr22@gmail.com"), false);
    assert.equal(normalizeMailbox("A.B+x@GMAIL.com"), "ab@gmail.com");
  } finally {
    if (saved === undefined) delete process.env.RUNNA_TEST_EMAILS;
    else process.env.RUNNA_TEST_EMAILS = saved;
  }
});
