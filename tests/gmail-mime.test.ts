/**
 * Unit tests for lib/gmail/mime.ts — the outbound message builder.
 *
 * The quoted-printable regression: the old encoder cut every 75 characters even
 * inside an "=C3=BA" escape, so "según" decoded to "seg=C3�n" on about a
 * third of long Spanish lines (reproduced 2026-10-16). The strict decoder below
 * rejects exactly that, plus overlong lines and unencoded trailing whitespace.
 */

import assert from "node:assert/strict";
import test from "node:test";
import {
  buildHtmlBody,
  buildRfc2822,
  encodeHeaderValue,
  encodeQuotedPrintable,
  formatAddress,
} from "../lib/gmail/mime.ts";

/** RFC 2045 decoder that throws on anything a lenient decoder would paper over. */
function strictQpDecode(encoded: string): string {
  const bytes: number[] = [];
  const lines = encoded.split("\r\n");
  lines.forEach((line, idx) => {
    assert.ok(line.length <= 76, `line ${idx} is ${line.length} chars: ${line}`);
    assert.ok(!/[ \t]$/.test(line), `line ${idx} ends in raw whitespace`);
    const soft = line.endsWith("=");
    const content = soft ? line.slice(0, -1) : line;
    for (let i = 0; i < content.length; i++) {
      const ch = content.charAt(i);
      if (ch === "=") {
        const hex = content.slice(i + 1, i + 3);
        assert.match(hex, /^[0-9A-F]{2}$/, `broken escape "=${hex}" on line ${idx}`);
        bytes.push(parseInt(hex, 16));
        i += 2;
      } else {
        bytes.push(ch.charCodeAt(0));
      }
    }
    if (!soft && idx < lines.length - 1) bytes.push(0x0d, 0x0a);
  });
  return Buffer.from(bytes).toString("utf8").replace(/\r\n/g, "\n");
}

const SPANISH =
  "y según los datos la solución está en móvil, revisé tu sitio y también la página de contacto.";
const FRENCH = "Bonjour, j'ai regardé votre site: la réservation en ligne n'est pas évidente à trouver.";

test("QP round-trips accented text at every line offset (the old encoder broke ~1/3)", () => {
  for (const sample of [SPANISH, FRENCH, "ñ".repeat(60), "🎯 emoji 👉 " + SPANISH]) {
    for (let pad = 0; pad < 80; pad++) {
      const text = "x".repeat(pad) + sample;
      assert.equal(strictQpDecode(encodeQuotedPrintable(text)), text, `pad ${pad}`);
    }
  }
});

test("QP keeps hard line breaks and encodes trailing whitespace", () => {
  const text = "Hola Andrés, \nlínea dos\t\n\nfin ";
  const encoded = encodeQuotedPrintable(text);
  assert.equal(strictQpDecode(encoded), text);
  assert.ok(encoded.includes("=20\r\n"), "trailing space must be =20");
  assert.ok(encoded.includes("=09\r\n"), "trailing tab must be =09");
});

test("QP encodes '=' itself and leaves plain ASCII alone", () => {
  assert.equal(encodeQuotedPrintable("a=b"), "a=3Db");
  assert.equal(encodeQuotedPrintable("plain ascii line"), "plain ascii line");
});

test("header values: CR/LF cannot inject a header", () => {
  assert.equal(encodeHeaderValue("hello\r\nBcc: victim@example.com"), "hello Bcc: victim@example.com");
  const raw = buildRfc2822({
    fromEmail: "pedro@runnareach.com",
    fromName: "Pedro",
    to: "a@b.com\r\nBcc: x@y.com",
    subject: "hi\nBcc: x@y.com",
    body: "body",
  });
  const headerBlock = raw.split("\r\n\r\n")[0] ?? "";
  assert.ok(!/^Bcc:/m.test(headerBlock), "no injected Bcc header line");
});

test("non-ASCII subject becomes ≤75-char encoded-words that decode back", () => {
  const subject = "¿Cuántas reservaciones se pierden cuando nadie contesta después de las 6pm en Cancún?";
  const encoded = encodeHeaderValue(subject);
  const words = encoded.split("\r\n ");
  assert.ok(words.length > 1, "long subject is split");
  let decoded = "";
  for (const w of words) {
    assert.ok(w.length <= 75, `encoded-word too long: ${w.length}`);
    const m = w.match(/^=\?UTF-8\?B\?([A-Za-z0-9+/=]+)\?=$/);
    assert.ok(m, `not an encoded-word: ${w}`);
    decoded += Buffer.from(m[1] ?? "", "base64").toString("utf8");
  }
  assert.equal(decoded, subject);
});

test("display names: ASCII quoted, non-ASCII RFC 2047-encoded", () => {
  assert.equal(formatAddress("Pedro De Velasco", "pedro@runnareach.com"), `"Pedro De Velasco" <pedro@runnareach.com>`);
  assert.match(formatAddress("Rünna", "pedro@runnareach.com"), /^=\?UTF-8\?B\?.+\?= <pedro@runnareach\.com>$/);
  assert.equal(formatAddress("", "pedro@runnareach.com"), "pedro@runnareach.com");
});

test("List-Unsubscribe + one-click header only with an https URL", () => {
  const base = { fromEmail: "pedro@runnareach.com", fromName: "Pedro", to: "a@b.com", subject: "s", body: "b" };
  const both = buildRfc2822({
    ...base,
    listUnsubscribe: { url: "https://go.example.com/u?t=abc", mailto: "pedro@runnareach.com?subject=unsubscribe" },
  });
  assert.match(both, /^List-Unsubscribe: <mailto:pedro@runnareach\.com\?subject=unsubscribe>, <https:\/\/go\.example\.com\/u\?t=abc>$/m);
  assert.match(both, /^List-Unsubscribe-Post: List-Unsubscribe=One-Click$/m);

  const mailtoOnly = buildRfc2822({ ...base, listUnsubscribe: { mailto: "pedro@runnareach.com" } });
  assert.match(mailtoOnly, /^List-Unsubscribe: <mailto:pedro@runnareach\.com>$/m);
  assert.doesNotMatch(mailtoOnly, /List-Unsubscribe-Post/);

  assert.doesNotMatch(buildRfc2822(base), /List-Unsubscribe/);
});

test("footer lands in both parts; its URL is a link in HTML", () => {
  const footer = "Rünna, 123 Main St, Calgary AB\nUnsubscribe: https://go.example.com/u?t=abc";
  const raw = buildRfc2822({
    fromEmail: "pedro@runnareach.com",
    fromName: "Pedro",
    to: "a@b.com",
    subject: "s",
    body: "Hola Andrés,\n\n👉 https://hunter.example.com/?x=1",
    lang: "es",
    footer,
    boundary: "BOUNDARY",
  });
  const [, textPart = "", htmlPart = ""] = raw.split("--BOUNDARY");
  const text = strictQpDecode(textPart.split("\r\n\r\n").slice(1).join("\r\n\r\n").trim());
  const html = strictQpDecode(htmlPart.split("\r\n\r\n").slice(1).join("\r\n\r\n").trim());
  assert.ok(text.endsWith(footer), "text part ends with the footer");
  assert.ok(html.includes(`<a href="https://go.example.com/u?t=abc"`), "unsubscribe URL is a link");
  assert.ok(html.includes("Ver diagnóstico gratis →"), "Spanish CTA label");
  assert.ok(html.includes(`<html lang="es">`));
});

test("HTML body without footer has no footer block", () => {
  assert.doesNotMatch(buildHtmlBody("Hi there", "en"), /border-top/);
});
