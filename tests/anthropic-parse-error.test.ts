/**
 * structuredCall's parse error never carries the model's own text
 * (lib/anthropic/client.ts parseErrorWithoutModelText). Batch 5 found model
 * output, which can quote prospect replies, stored through `call.error`.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { z } from "zod";
import { __test__, parseErrorWithoutModelText, structuredCall } from "../lib/anthropic/client.ts";

function messageOf(text: string): string {
  try {
    JSON.parse(text);
    return "";
  } catch (e) {
    return (e as Error).message;
  }
}

const LEAKY = [
  `{"observations": [{"title": "x", "evidence": Maria Lopez said no}]}`,
  `{"observations": [{"title": "Pedro", "evidence": "a"}, Clinica Sol wrote "no"]}`,
  `No "thanks"`,
  `Here is the review: Maria from Clinica Sol said the audit is too long`,
];

test("parseErrorWithoutModelText keeps the failure kind and drops every quoted snippet", () => {
  for (const text of LEAKY) {
    const raw = messageOf(text);
    assert.ok(raw.length > 0, `fixture must fail to parse: ${text}`);
    const out = parseErrorWithoutModelText(new Error(raw));
    assert.doesNotMatch(out, /Maria|Lopez|Clinica|Pedro|thanks|review/, `leaked: ${out}`);
    assert.doesNotMatch(out, /"/);
    assert.ok(out.length > 0);
  }
  assert.equal(parseErrorWithoutModelText(new Error('"')), "invalid JSON");
  assert.equal(parseErrorWithoutModelText("plain failure"), "plain failure");
});

test("structuredCall: a reply that is not JSON fails as parse with no model text and no Raw:", async () => {
  const text = "Here is the review: Maria from Clinica Sol said the audit is too long";
  __test__.setClient({
    messages: {
      create: async () => ({
        content: [{ type: "text", text }],
        usage: { input_tokens: 10, output_tokens: 10 },
        stop_reason: "end_turn",
      }),
    },
  } as never);
  try {
    const r = await structuredCall({
      system: "Reply with JSON.",
      user: "go",
      max_tokens: 50,
      schema: z.object({ a: z.string() }),
    });
    assert.equal(r.ok, false);
    if (!r.ok) {
      assert.equal(r.reason, "parse");
      assert.match(r.error, /^JSON parse failed: /);
      assert.doesNotMatch(r.error, /Raw:|Maria|Clinica|audit/);
      assert.ok(r.usage, "the paid usage is still returned");
    }
  } finally {
    __test__.reset();
  }
});
