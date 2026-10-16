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

test("footer contact line: website and email between identity and unsubscribe", () => {
  const f = buildComplianceFooter({
    lang: "en",
    senderEntity: "Rünna",
    mailingAddress: "Tizapán San Ángel, 01090 Mexico City, Mexico",
    website: "runnik.ca",
    contactEmail: "hola@runna.mx",
    unsubscribeUrl: "https://x/u",
    privacyUrl: "https://runna.com.mx/avisop",
  });
  assert.equal(
    f,
    "Rünna · Tizapán San Ángel, 01090 Mexico City, Mexico\nrunnik.ca · hola@runna.mx\nTo stop receiving these emails: https://x/u",
    "English: no Spanish privacy notice",
  );
});

test("outbound compliance: Pedro's details by default, env overrides, fails closed without a signing key", () => {
  const keys = ["RUNNA_MAILING_ADDRESS", "TOKEN_ENCRYPTION_KEY", "UNSUBSCRIBE_BASE_URL", "RUNNA_WEBSITE_EN"] as const;
  const saved = Object.fromEntries(keys.map((k) => [k, process.env[k]]));
  try {
    for (const k of keys) delete process.env[k];

    // No signing key → nothing may be sent.
    const blocked = getOutboundCompliance(PAYLOAD);
    assert.equal(blocked.ok, false);
    assert.match(blocked.ok ? "" : blocked.error, /TOKEN_ENCRYPTION_KEY/);

    process.env.TOKEN_ENCRYPTION_KEY = "k";
    process.env.UNSUBSCRIBE_BASE_URL = "https://go.example.com/";
    const es = getOutboundCompliance(PAYLOAD);
    assert.ok(es.ok);
    if (es.ok) {
      assert.match(es.value.listUnsubscribe.url, /^https:\/\/go\.example\.com\/api\/unsubscribe\?t=/);
      assert.ok(es.value.footer.includes(es.value.listUnsubscribe.url));
      assert.ok(es.value.footer.startsWith("Rünna · Tizapán San Ángel, Loreto y Campamento, Álvaro Obregón, 01090 Mexico City, Mexico\n"));
      assert.match(es.value.footer, /\nrunna\.com\.mx · hola@runna\.mx\n/);
      assert.match(es.value.footer, /Aviso de privacidad: https:\/\/runna\.com\.mx\/avisop$/);
    }

    process.env.RUNNA_WEBSITE_EN = "example.ca";
    const en = getOutboundCompliance({ ...PAYLOAD, lang: "en" });
    assert.ok(en.ok && en.value.footer.includes("\nexample.ca · hola@runna.mx\n"), "env override wins");
    assert.ok(en.ok && !en.value.footer.includes("Aviso"), "no Spanish notice on English emails");
  } finally {
    for (const k of keys) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  }
});
