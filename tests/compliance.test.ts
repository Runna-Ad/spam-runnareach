/**
 * CASL compliance: signed unsubscribe tokens, the footer, and the fail-closed
 * outbound config (no mailing address → no send).
 */

import assert from "node:assert/strict";
import test from "node:test";
import { buildComplianceFooter } from "../lib/compliance/footer.ts";
import { getOutboundCompliance } from "../lib/compliance/outbound.ts";
import { signUnsubscribeToken, verifyUnsubscribeToken } from "../lib/compliance/unsubscribe-token.ts";

const SECRET = "test-secret";
const PAYLOAD = {
  tenantId: "11111111-1111-1111-1111-111111111111",
  prospectId: "22222222-2222-2222-2222-222222222222",
  email: "Maria@Acme.MX",
  lang: "es" as const,
};

test("token round-trips and normalizes the email", () => {
  const token = signUnsubscribeToken(PAYLOAD, SECRET);
  assert.deepEqual(verifyUnsubscribeToken(token, SECRET), { ...PAYLOAD, email: "maria@acme.mx" });
});

test("token rejects a wrong secret, a tampered payload and garbage", () => {
  const token = signUnsubscribeToken(PAYLOAD, SECRET);
  assert.equal(verifyUnsubscribeToken(token, "other-secret"), null);

  const [part = "", mac = ""] = token.split(".");
  const forged = Buffer.from(
    JSON.stringify({ v: 1, t: PAYLOAD.tenantId, p: null, e: "someone-else@acme.mx", l: "en" }),
  ).toString("base64url");
  assert.equal(verifyUnsubscribeToken(`${forged}.${mac}`, SECRET), null, "payload swap must fail");
  assert.equal(verifyUnsubscribeToken(`${part}.${mac}x`, SECRET), null);
  assert.equal(verifyUnsubscribeToken("", SECRET), null);
  assert.equal(verifyUnsubscribeToken("a.b.c", SECRET), null);
  assert.equal(verifyUnsubscribeToken("not-a-token", SECRET), null);
});

test("footer: identity + address + unsubscribe, both languages, no em dash", () => {
  const base = {
    senderEntity: "Rünna",
    mailingAddress: "123 Main St SW\nCalgary, AB T2P 1A1",
    unsubscribeUrl: "https://go.example.com/api/unsubscribe?t=abc",
  };
  const en = buildComplianceFooter({ ...base, lang: "en" });
  assert.equal(
    en,
    "Rünna · 123 Main St SW, Calgary, AB T2P 1A1\nTo stop receiving these emails: https://go.example.com/api/unsubscribe?t=abc",
  );
  const es = buildComplianceFooter({ ...base, lang: "es", privacyUrl: "https://runna.mx/privacidad" });
  assert.match(es, /^Rünna · 123 Main St SW, Calgary, AB T2P 1A1\n/);
  assert.match(es, /Para dejar de recibir estos correos: https:\/\/go\.example\.com/);
  assert.match(es, /Aviso de privacidad: https:\/\/runna\.mx\/privacidad$/);
  for (const f of [en, es]) assert.doesNotMatch(f, /—/);
});

test("outbound compliance fails closed without a mailing address", () => {
  const saved = { addr: process.env.RUNNA_MAILING_ADDRESS, key: process.env.TOKEN_ENCRYPTION_KEY };
  try {
    process.env.TOKEN_ENCRYPTION_KEY = "k";
    delete process.env.RUNNA_MAILING_ADDRESS;
    const blocked = getOutboundCompliance(PAYLOAD);
    assert.equal(blocked.ok, false);
    assert.match(blocked.ok ? "" : blocked.error, /RUNNA_MAILING_ADDRESS/);

    process.env.RUNNA_MAILING_ADDRESS = "123 Main St SW, Calgary, AB";
    delete process.env.TOKEN_ENCRYPTION_KEY;
    assert.equal(getOutboundCompliance(PAYLOAD).ok, false, "no signing key → blocked");

    process.env.TOKEN_ENCRYPTION_KEY = "k";
    process.env.UNSUBSCRIBE_BASE_URL = "https://go.example.com/";
    const ok = getOutboundCompliance(PAYLOAD);
    assert.ok(ok.ok);
    if (ok.ok) {
      assert.match(ok.value.listUnsubscribe.url, /^https:\/\/go\.example\.com\/api\/unsubscribe\?t=/);
      assert.ok(ok.value.footer.includes(ok.value.listUnsubscribe.url));
    }
  } finally {
    if (saved.addr === undefined) delete process.env.RUNNA_MAILING_ADDRESS;
    else process.env.RUNNA_MAILING_ADDRESS = saved.addr;
    if (saved.key === undefined) delete process.env.TOKEN_ENCRYPTION_KEY;
    else process.env.TOKEN_ENCRYPTION_KEY = saved.key;
    delete process.env.UNSUBSCRIBE_BASE_URL;
  }
});
