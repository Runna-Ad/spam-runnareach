import assert from "node:assert/strict";
import test from "node:test";
import { __test__ } from "../lib/anthropic/client.ts";
import { composePitchWithClaude } from "../lib/pitches/claude-composer.ts";
import type { GeneratorInputs } from "../lib/pitches/generator.ts";

// Set a fake API key so getClient() doesn't refuse to construct.
process.env.ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY ?? "test-key";

// ── Mock SDK helpers ────────────────────────────────────────────────────────
//
// The Anthropic SDK exposes `messages.create(...)`. We satisfy just that
// surface with a stub. Each test installs a mock that returns whatever
// content (or error) the test needs.

type MessagesCreateInput = {
  model: string;
  max_tokens: number;
  system?: string;
  messages: { role: string; content: string }[];
};
type MessagesCreateResponse = {
  content: { type: "text"; text: string }[];
  usage: { input_tokens: number; output_tokens: number; cache_read_input_tokens?: number; cache_creation_input_tokens?: number };
};

function installMock(opts: {
  /** Fake response or () => throw to simulate errors. */
  reply: MessagesCreateResponse | (() => never);
  /** Spy: records every call so tests can assert prompt content. */
  calls?: MessagesCreateInput[];
}) {
  const fakeClient = {
    messages: {
      create: async (input: MessagesCreateInput) => {
        opts.calls?.push(input);
        if (typeof opts.reply === "function") opts.reply();
        return opts.reply;
      },
    },
  };
  __test__.setClient(fakeClient as never);
}

function teardown() {
  __test__.reset();
}

// ── Fixtures ────────────────────────────────────────────────────────────────

const CASE_ID = "00000000-0000-0000-0000-000000000aaa";
const PAIN_ID = "00000000-0000-0000-0000-000000000bbb";
const OTHER_PAIN_ID = "00000000-0000-0000-0000-000000000ccc";

function inputs(over: Partial<GeneratorInputs> = {}): GeneratorInputs {
  return {
    prospect: {
      id: "p1",
      company_name: "Calgary Coffee",
      industry: "DTC coffee",
      language: "en",
      employee_size_estimate: null,
      city: null,
      market: null,
      what_they_do: null,
      tech_stack: [],
    },
    pains: [
      { pain_id: PAIN_ID, pain_label: "Poor mobile conversion", evidence_quote: "checkout breaks on iPhone" },
    ],
    contacts: [{ full_name: "Sarah", email: "sarah@cc.example", email_is_role_based: false, role_title: null }],
    case_studies: [
      {
        id: CASE_ID,
        client_name: "DiDi",
        industry: "DTC marketplace",
        hero_metric_en: "+47% mobile checkout completion",
        hero_metric_es: null,
        result_description_en: null, result_description_es: null, testimonial_quote_en: null, testimonial_quote_es: null, measurable_results: [], pain_strength: 0.9, tier: "smb" as const,
      },
    ],
    notable_clients: [],
    sender: { full_name: "Pedro De Velasco", tenant_display_name: "Runna CA" },
    deep_pitch_url: null,
    ...over,
  };
}

function validResponse(over: Record<string, unknown> = {}) {
  return JSON.stringify({
    subject: "Quick thought on mobile conversion at Calgary Coffee",
    preview_text: "No cart recovery flow, no retargeting — leaving ~25% revenue on the table.",
    body: "Hi Sarah,\n\nSaw \"checkout breaks on iPhone\" — most DTC coffee brands hit this wall.\n\nWe helped DiDi (+47% mobile checkout completion). Same shape as what we're seeing on your end.\n\nI can send a 5-min Loom walking through exactly what I'd change — no call, no commitment.\n\nPedro\nPedro De Velasco\nRunna CA",
    pain_id: PAIN_ID,
    case_study_id: CASE_ID,
    contact_email: "sarah@cc.example",
    measurable_result_included: true,
    quality_self_score: 0.85,
    reasoning: "Strong evidence quote + industry-aligned case + named contact.",
    ...over,
  });
}

// ── Happy path ──────────────────────────────────────────────────────────────

test("composePitchWithClaude: returns parsed pitch on valid response", async () => {
  installMock({
    reply: {
      content: [{ type: "text", text: validResponse() }],
      usage: { input_tokens: 800, output_tokens: 220 },
    },
  });
  try {
    const r = await composePitchWithClaude(inputs());
    assert.equal(r.ok, true);
    if (r.ok) {
      assert.equal(r.result.composed.case_study_id, CASE_ID);
      assert.equal(r.result.composed.pain_id, PAIN_ID);
      assert.match(r.result.composed.body, /^Hi Sarah,/);
      assert.equal(r.result.usage.input_tokens, 800);
      assert.equal(r.result.usage.output_tokens, 220);
      // Sonnet 4.5 pricing: 800/1M * $3 + 220/1M * $15 = 0.0024 + 0.0033 = 0.0057
      assert.ok(Math.abs(r.result.usage.cost_usd - 0.0057) < 0.0001);
    }
  } finally {
    teardown();
  }
});

test("composePitchWithClaude: passes correct system+user prompts", async () => {
  const calls: MessagesCreateInput[] = [];
  installMock({
    reply: {
      content: [{ type: "text", text: validResponse() }],
      usage: { input_tokens: 500, output_tokens: 200 },
    },
    calls,
  });
  try {
    await composePitchWithClaude(inputs());
    assert.equal(calls.length, 1);
    const call = calls[0]!;
    // System prompt: cold-email copywriter + JSON-only instruction
    assert.match(call.system ?? "", /cold[- ]email/i);
    assert.match(call.system ?? "", /JSON/);
    // User prompt (payload): sender agency name + candidate IDs
    assert.match(call.messages[0]!.content, /Runna CA/);
    assert.match(call.messages[0]!.content, new RegExp(CASE_ID));
    assert.match(call.messages[0]!.content, new RegExp(PAIN_ID));
  } finally {
    teardown();
  }
});

// ── Cleans markdown fences ──────────────────────────────────────────────────

test("composePitchWithClaude: strips ```json fences if Claude slips", async () => {
  installMock({
    reply: {
      content: [
        { type: "text", text: "```json\n" + validResponse() + "\n```" },
      ],
      usage: { input_tokens: 500, output_tokens: 200 },
    },
  });
  try {
    const r = await composePitchWithClaude(inputs());
    assert.equal(r.ok, true);
  } finally {
    teardown();
  }
});

// ── Hallucination guards ───────────────────────────────────────────────────

test("composePitchWithClaude: rejects hallucinated case_study_id", async () => {
  installMock({
    reply: {
      content: [
        { type: "text", text: validResponse({ case_study_id: "11111111-1111-1111-1111-111111111111" }) },
      ],
      usage: { input_tokens: 500, output_tokens: 200 },
    },
  });
  try {
    const r = await composePitchWithClaude(inputs());
    assert.equal(r.ok, false);
    if (!r.ok) {
      assert.match(r.error, /unknown case_study_id/);
      assert.equal(r.reason, "hallucinated_case");
      assert.ok(r.usage); // still record cost — tokens were spent
    }
  } finally {
    teardown();
  }
});

test("composePitchWithClaude: rejects hallucinated pain_id", async () => {
  installMock({
    reply: {
      content: [
        { type: "text", text: validResponse({ pain_id: OTHER_PAIN_ID }) }, // not in input.pains
      ],
      usage: { input_tokens: 500, output_tokens: 200 },
    },
  });
  try {
    const r = await composePitchWithClaude(inputs());
    assert.equal(r.ok, false);
    if (!r.ok) {
      assert.equal(r.reason, "hallucinated_pain");
    }
  } finally {
    teardown();
  }
});

test("composePitchWithClaude: accepts pain_id=null when no pains provided", async () => {
  installMock({
    reply: {
      content: [{ type: "text", text: validResponse({ pain_id: null }) }],
      usage: { input_tokens: 500, output_tokens: 200 },
    },
  });
  try {
    const r = await composePitchWithClaude(inputs({ pains: [] }));
    assert.equal(r.ok, true);
  } finally {
    teardown();
  }
});

// ── No case studies → still call Claude (case_study_id=null path) ───────────

test("composePitchWithClaude: calls Claude even when no case studies — empty list is legal now", async () => {
  // case_study_id is nullable: with no case studies but a known pain,
  // Claude can still write a useful pitch using the no-case template.
  const calls: MessagesCreateInput[] = [];
  installMock({
    reply: {
      content: [{ type: "text", text: validResponse({ case_study_id: null }) }],
      usage: { input_tokens: 400, output_tokens: 180 },
    },
    calls,
  });
  try {
    const r = await composePitchWithClaude(inputs({ case_studies: [] }));
    assert.equal(r.ok, true);
    assert.equal(calls.length, 1); // we DO call the API
    if (r.ok) assert.equal(r.result.composed.case_study_id, null);
  } finally {
    teardown();
  }
});

test("composePitchWithClaude: bails before calling Claude when both case_studies AND pains are empty", async () => {
  const calls: MessagesCreateInput[] = [];
  installMock({
    reply: { content: [], usage: { input_tokens: 0, output_tokens: 0 } },
    calls,
  });
  try {
    const r = await composePitchWithClaude(inputs({ case_studies: [], pains: [] }));
    assert.equal(r.ok, false);
    if (!r.ok) assert.equal(r.reason, "no_case_studies");
    assert.equal(calls.length, 0); // didn't call the API
  } finally {
    teardown();
  }
});

// ── Error paths: malformed JSON, schema mismatch ────────────────────────────

test("composePitchWithClaude: returns parse error on malformed JSON", async () => {
  installMock({
    reply: {
      content: [{ type: "text", text: "not json at all{" }],
      usage: { input_tokens: 200, output_tokens: 20 },
    },
  });
  try {
    const r = await composePitchWithClaude(inputs());
    assert.equal(r.ok, false);
    if (!r.ok) {
      assert.equal(r.reason, "parse");
      assert.match(r.error, /JSON parse failed/);
    }
  } finally {
    teardown();
  }
});

test("composePitchWithClaude: returns parse error on schema mismatch", async () => {
  installMock({
    reply: {
      content: [
        { type: "text", text: JSON.stringify({ subject: "x" }) }, // missing required fields
      ],
      usage: { input_tokens: 200, output_tokens: 20 },
    },
  });
  try {
    const r = await composePitchWithClaude(inputs());
    assert.equal(r.ok, false);
    if (!r.ok) assert.equal(r.reason, "parse");
  } finally {
    teardown();
  }
});

// ── Error paths: SDK throws ────────────────────────────────────────────────

test("composePitchWithClaude: classifies 429 as rate_limit", async () => {
  installMock({
    reply: () => {
      throw new Error("HTTP 429: rate limit exceeded");
    },
  });
  try {
    const r = await composePitchWithClaude(inputs());
    assert.equal(r.ok, false);
    if (!r.ok) {
      assert.equal(r.reason, "rate_limit");
      assert.equal(r.usage, null);
    }
  } finally {
    teardown();
  }
});

test("composePitchWithClaude: classifies 401 as auth", async () => {
  installMock({
    reply: () => {
      throw new Error("HTTP 401: invalid api key");
    },
  });
  try {
    const r = await composePitchWithClaude(inputs());
    assert.equal(r.ok, false);
    if (!r.ok) assert.equal(r.reason, "auth");
  } finally {
    teardown();
  }
});

test("composePitchWithClaude: classifies abort as timeout", async () => {
  installMock({
    reply: () => {
      throw new Error("Request timeout: aborted after 15000ms");
    },
  });
  try {
    const r = await composePitchWithClaude(inputs());
    assert.equal(r.ok, false);
    if (!r.ok) assert.equal(r.reason, "timeout");
  } finally {
    teardown();
  }
});
