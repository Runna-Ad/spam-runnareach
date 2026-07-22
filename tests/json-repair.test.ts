/**
 * LLM JSON repair.
 *
 * A parse failure used to end the call and throw away a finished, already-paid-
 * for generation. On 2026-07-22 Claude wrote a good Spanish pitch — subject
 * "estética orozco: cada cita que entra por whatsapp" — and it was discarded
 * because of a stray quote at position 1317, inside the body. The prospect got
 * the generic fallback template instead, which read as flat and impersonal.
 *
 * The model breaks its own JSON in exactly two ways, both inside string values.
 * These tests cover both, plus the cases the repair must NOT touch.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { repairJsonStrings } from "../lib/anthropic/client.ts";

const parse = (s: string) => JSON.parse(repairJsonStrings(s));

test("leaves already-valid JSON untouched", () => {
  const valid = '{"subject":"hello","body":"line one\\nline two","score":0.8}';
  assert.equal(repairJsonStrings(valid), valid);
  assert.deepEqual(parse(valid), JSON.parse(valid));
});

test("escapes a stray quote inside a string value", () => {
  const broken = '{"body":"he said "no" and walked out"}';
  assert.equal(parse(broken).body, 'he said "no" and walked out');
});

test("escapes a literal newline inside a string value", () => {
  const broken = '{"body":"first line\nsecond line"}';
  assert.equal(parse(broken).body, "first line\nsecond line");
});

test("handles the real shape that failed: quoted term mid-prose", () => {
  // Spanish pitches trip this more often — the model quotes a product or
  // channel name inside otherwise fluent prose.
  const broken =
    '{"subject":"estética orozco: cada cita que entra por whatsapp",' +
    '"body":"Cada cita que llega por "WhatsApp" se contesta a mano.",' +
    '"score":0.7}';
  const out = parse(broken);
  assert.equal(out.subject, "estética orozco: cada cita que entra por whatsapp");
  assert.equal(out.body, 'Cada cita que llega por "WhatsApp" se contesta a mano.');
  assert.equal(out.score, 0.7);
});

test("does not corrupt a legitimately escaped quote", () => {
  const valid = '{"body":"he said \\"yes\\" clearly"}';
  assert.equal(parse(valid).body, 'he said "yes" clearly');
});

test("does not mistake a quote before a colon for prose", () => {
  // The quote closing a KEY is followed by ':' and must stay a terminator.
  const valid = '{"a":"one","b":"two"}';
  assert.deepEqual(parse(valid), { a: "one", b: "two" });
});

test("survives nested structure and arrays", () => {
  const broken = '{"items":["a "quoted" item","plain"],"n":2}';
  const out = parse(broken);
  assert.deepEqual(out.items, ['a "quoted" item', "plain"]);
  assert.equal(out.n, 2);
});

test("leaves genuinely unrepairable JSON to fail", () => {
  // A truncated response (hit max_tokens mid-string) cannot be recovered, and
  // must still throw so the caller falls back rather than using half a pitch.
  const truncated = '{"subject":"fine","body":"cut off mid sen';
  assert.throws(() => parse(truncated));
});

test("preserves accents and emoji untouched", () => {
  const valid = '{"body":"Hola equipo 👉 diagnóstico gratis, sin compromiso."}';
  assert.equal(parse(valid).body, "Hola equipo 👉 diagnóstico gratis, sin compromiso.");
});
