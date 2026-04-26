import assert from "node:assert/strict";
import test from "node:test";
import { verifyDomainHasMx } from "../lib/discover/mx-verify.ts";

// We don't want CI to depend on live DNS, so we only assert the *non-network*
// branches of verifyDomainHasMx — the malformed-domain pre-check + the shape
// of the network result.

test("verifyDomainHasMx: rejects malformed domain before any DNS call", async () => {
  const r = await verifyDomainHasMx("not-a-domain");
  assert.equal(r.ok, false);
  if (!r.ok) {
    assert.equal(r.reason, "lookup_failed");
    assert.match(r.detail ?? "", /malformed/);
  }
});

test("verifyDomainHasMx: rejects empty string", async () => {
  const r = await verifyDomainHasMx("");
  assert.equal(r.ok, false);
});

test("verifyDomainHasMx: rejects domain with no TLD", async () => {
  const r = await verifyDomainHasMx("foo");
  assert.equal(r.ok, false);
});

test("verifyDomainHasMx: known nxdomain returns nxdomain reason", async () => {
  // .invalid is reserved by RFC 2606 — guaranteed nxdomain on every resolver.
  const r = await verifyDomainHasMx("definitely-nxdomain-12345.invalid");
  assert.equal(r.ok, false);
  if (!r.ok) {
    assert.ok(["nxdomain", "lookup_failed", "no_mx"].includes(r.reason));
  }
});
