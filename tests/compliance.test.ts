/**
 * CASL compliance: signed unsubscribe tokens, the footer, and the fail-closed
 * outbound config (no mailing address → no send).
 */

import assert from "node:assert/strict";
import test from "node:test";
import { buildComplianceFooter, buildComplianceFooterHtml } from "../lib/compliance/footer.ts";
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

test("footer: sign-off line, address, unsubscribe, both languages, no em dash", () => {
  const base = {
    senderEntity: "Runna Advertising",
    mailingAddress: "123 Main St SW\nCalgary, AB T2P 1A1",
    unsubscribeUrl: "https://go.example.com/api/unsubscribe?t=abc",
  };
  const en = buildComplianceFooter({ ...base, lang: "en" });
  assert.equal(
    en,
    "Runna Advertising\n123 Main St SW, Calgary, AB T2P 1A1\nTo stop receiving these emails: https://go.example.com/api/unsubscribe?t=abc",
  );
  const es = buildComplianceFooter({ ...base, lang: "es", privacyUrl: "https://runna.mx/privacidad" });
  assert.match(es, /^Runna Advertising\n123 Main St SW, Calgary, AB T2P 1A1\n/);
  assert.match(es, /Para dejar de recibir estos correos: https:\/\/go\.example\.com/);
  assert.match(es, /Aviso de privacidad: https:\/\/runna\.mx\/privacidad$/);
  for (const f of [en, es]) assert.doesNotMatch(f, /—/);
});

test("footer sign-off line: name · locations · website; email only when there is no website", () => {
  const base = {
    lang: "en" as const,
    senderEntity: "Runna Advertising",
    locations: "Mexico · Canada",
    mailingAddress: "Tizapán San Ángel, 01090 Mexico City, Mexico",
    contactEmail: "hola@runna.mx",
    unsubscribeUrl: "https://x/u",
    privacyUrl: "https://runna.com.mx/avisop",
  };
  assert.equal(
    buildComplianceFooter({ ...base, website: "runnik.ca" }),
    "Runna Advertising · Mexico · Canada · runnik.ca\nTizapán San Ángel, 01090 Mexico City, Mexico\nTo stop receiving these emails: https://x/u",
    "English: no Spanish privacy notice, no email next to the website",
  );
  // CASL needs one contact method: with no website the email takes its place.
  assert.match(buildComplianceFooter({ ...base, website: null }), /^Runna Advertising · Mexico · Canada · hola@runna\.mx\n/);
  const html = buildComplianceFooterHtml({ ...base, website: "runnik.ca" });
  assert.match(html, /^<p style="margin: 0;">Runna Advertising · Mexico · Canada · <a href="https:\/\/runnik\.ca"/);
  assert.doesNotMatch(html, /mailto:/);
});

test("outbound compliance: an English (Canadian) address is used on English emails only", () => {
  const keys = ["RUNNA_MAILING_ADDRESS", "RUNNA_MAILING_ADDRESS_EN", "TOKEN_ENCRYPTION_KEY"] as const;
  const saved = Object.fromEntries(keys.map((k) => [k, process.env[k]]));
  try {
    for (const k of keys) delete process.env[k];
    process.env.TOKEN_ENCRYPTION_KEY = "k";
    // Not set yet: English emails keep the Mexico City address (never no address).
    const before = getOutboundCompliance({ ...PAYLOAD, lang: "en" });
    assert.ok(before.ok && before.value.footer.text.includes("\nTizapán San Ángel"));

    process.env.RUNNA_MAILING_ADDRESS_EN = "100 Example Ave SW, Calgary, AB T2P 0A1, Canada";
    const en = getOutboundCompliance({ ...PAYLOAD, lang: "en" });
    assert.ok(en.ok);
    if (en.ok) {
      assert.ok(en.value.footer.text.startsWith("Runna Advertising · Mexico · Canada · runnik.ca\n100 Example Ave SW, Calgary"));
      assert.doesNotMatch(en.value.footer.text, /Tizapán/);
    }
    const es = getOutboundCompliance(PAYLOAD);
    assert.ok(es.ok && es.value.footer.text.includes("\nTizapán San Ángel"), "Spanish emails keep the Mexico City address");
    assert.ok(es.ok && !es.value.footer.text.includes("Calgary"));
  } finally {
    for (const k of keys) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  }
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
      const { text, html } = es.value.footer;
      assert.ok(text.includes(es.value.listUnsubscribe.url));
      assert.ok(
        text.startsWith(
          "Runna Advertising · México · Canadá · runna.com.mx\nTizapán San Ángel, Loreto y Campamento, Álvaro Obregón, 01090 Mexico City, Mexico\n",
        ),
      );
      assert.match(text, /Aviso de privacidad: https:\/\/runna\.com\.mx\/avisop$/);

      // HTML: labelled links, no URL in the visible text.
      assert.match(html, />darse de baja<\/a>/);
      assert.match(html, /href="https:\/\/runna\.com\.mx"/);
      assert.match(html, />Aviso de privacidad<\/a>/);
      const visible = html.replace(/<[^>]+>/g, "");
      assert.doesNotMatch(visible, /https?:\/\//, "no raw URL shown");
      assert.doesNotMatch(visible, /spam-runnareach/);
    }

    process.env.RUNNA_WEBSITE_EN = "example.ca";
    const en = getOutboundCompliance({ ...PAYLOAD, lang: "en" });
    assert.ok(en.ok && en.value.footer.text.startsWith("Runna Advertising · Mexico · Canada · example.ca\n"), "env override wins");
    assert.ok(en.ok && !en.value.footer.text.includes("Aviso"), "no Spanish notice on English emails");
    assert.ok(en.ok && />unsubscribe<\/a>/.test(en.value.footer.html));
  } finally {
    for (const k of keys) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  }
});
