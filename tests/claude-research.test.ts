import assert from "node:assert/strict";
import test from "node:test";
import { __test__ } from "../lib/anthropic/client.ts";
import {
  runResearchWithClaude,
  type ClaudeResearchInput,
} from "../lib/research/claude-research.ts";

process.env.ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY ?? "test-key";

// ── Mock SDK helpers ────────────────────────────────────────────────────────

type MessagesCreateInput = {
  model: string;
  max_tokens: number;
  system?: string | { type: string; text: string }[];
  messages: { role: string; content: string }[];
};

// System is now sent as an array of content blocks (for prompt caching) —
// flatten to a single string for assertions.
function systemText(s: MessagesCreateInput["system"]): string {
  if (!s) return "";
  return typeof s === "string" ? s : s.map((b) => b.text).join("\n");
}
type MessagesCreateResponse = {
  content: { type: "text"; text: string }[];
  usage: { input_tokens: number; output_tokens: number; cache_read_input_tokens?: number; cache_creation_input_tokens?: number };
};

function installMock(opts: {
  reply: MessagesCreateResponse | (() => never);
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

const PAIN_MOBILE = "00000000-0000-0000-0000-000000000aa1";
const PAIN_EMAIL = "00000000-0000-0000-0000-000000000aa2";
const PAIN_OTHER = "00000000-0000-0000-0000-000000000aa3";

function inputs(over: Partial<ClaudeResearchInput> = {}): ClaudeResearchInput {
  return {
    what_they_do:
      "DTC pet food brand selling subscription kibble. Mobile site is slow on iPhones.",
    notes:
      "Tech: Shopify, Klaviyo, Recharge.\nContact emails: sarah@quebecpetfood.example.com, info@quebecpetfood.example.com",
    options: [
      {
        id: PAIN_MOBILE,
        code: "poor_mobile_conversion",
        display_name: "Poor mobile conversion",
        evidence_phrases: ["slow on mobile", "checkout breaks"],
      },
      {
        id: PAIN_EMAIL,
        code: "low_email_performance",
        display_name: "Low email performance",
        evidence_phrases: ["email open rate", "weak welcome flow"],
      },
      {
        id: PAIN_OTHER,
        code: "weak_packaging",
        display_name: "Weak packaging",
        evidence_phrases: ["packaging refresh", "label redesign"],
      },
    ],
    existingPainIds: [],
    ...over,
  };
}

function validResponse(over: Record<string, unknown> = {}) {
  return JSON.stringify({
    pain_points: [
      {
        pain_id: PAIN_MOBILE,
        pain_label: "Poor mobile conversion",
        evidence_quote: "Mobile site is slow on iPhones.",
        confidence: 0.9,
      },
    ],
    decision_maker_email: "sarah@quebecpetfood.example.com",
    reasoning: "Mobile slowness directly stated in what_they_do; non-role-based contact preferred.",
    ...over,
  });
}

// ── Happy path ──────────────────────────────────────────────────────────────

test("runResearchWithClaude: returns parsed pains + email on valid response", async () => {
  installMock({
    reply: {
      content: [{ type: "text", text: validResponse() }],
      usage: { input_tokens: 1200, output_tokens: 180 },
    },
  });
  try {
    const r = await runResearchWithClaude(inputs());
    assert.equal(r.ok, true);
    if (r.ok) {
      assert.equal(r.result.pain_points.length, 1);
      assert.equal(r.result.pain_points[0]!.pain_id, PAIN_MOBILE);
      assert.equal(r.result.decision_maker_email, "sarah@quebecpetfood.example.com");
      // Sonnet 4.5 pricing: 1200/1M * $3 + 180/1M * $15 = 0.0036 + 0.0027 = 0.0063
      assert.ok(Math.abs(r.result.usage.cost_usd - 0.0063) < 0.0001);
    }
  } finally {
    teardown();
  }
});

test("runResearchWithClaude: sends Sonnet model + taxonomy in cached system prompt", async () => {
  const calls: MessagesCreateInput[] = [];
  installMock({
    reply: {
      content: [{ type: "text", text: validResponse() }],
      usage: { input_tokens: 1000, output_tokens: 150 },
    },
    calls,
  });
  try {
    await runResearchWithClaude(inputs());
    assert.equal(calls.length, 1);
    const call = calls[0]!;
    assert.equal(call.model, "claude-sonnet-4-5-20250929"); // pain class drives pitch — pay for Sonnet
    const sys = systemText(call.system);
    // System prompt explains the dual job + UUID-from-taxonomy rule
    assert.match(sys, /pain_taxonomy|canonical pain/i);
    assert.match(sys, /UUID/);
    // Candidate IDs now live in the cached system taxonomy block (moved out of
    // the per-prospect user prompt) so Claude can echo them back.
    assert.match(sys, new RegExp(PAIN_MOBILE));
    // System is sent as content blocks with a cache breakpoint.
    assert.ok(Array.isArray(call.system));
  } finally {
    teardown();
  }
});

// ── Hallucination guard ────────────────────────────────────────────────────

test("runResearchWithClaude: rejects pain_id not in taxonomy", async () => {
  installMock({
    reply: {
      content: [
        {
          type: "text",
          text: validResponse({
            pain_points: [
              {
                pain_id: "11111111-1111-1111-1111-111111111111", // not in options
                pain_label: "Hallucinated pain",
                evidence_quote: "x",
                confidence: 0.9,
              },
            ],
          }),
        },
      ],
      usage: { input_tokens: 1000, output_tokens: 150 },
    },
  });
  try {
    const r = await runResearchWithClaude(inputs());
    assert.equal(r.ok, false);
    if (!r.ok) {
      assert.equal(r.reason, "hallucinated_pain");
      assert.match(r.error, /unknown pain_id/);
      assert.ok(r.usage); // tokens were spent
    }
  } finally {
    teardown();
  }
});

// ── existingPainIds dedupe ─────────────────────────────────────────────────

test("runResearchWithClaude: drops pains already in existingPainIds", async () => {
  installMock({
    reply: {
      content: [
        {
          type: "text",
          text: validResponse({
            pain_points: [
              {
                pain_id: PAIN_MOBILE,
                pain_label: "Poor mobile conversion",
                evidence_quote: "Mobile site is slow on iPhones.",
                confidence: 0.9,
              },
              {
                pain_id: PAIN_EMAIL,
                pain_label: "Low email performance",
                evidence_quote: "Klaviyo configured but no welcome flow shown.",
                confidence: 0.6,
              },
            ],
          }),
        },
      ],
      usage: { input_tokens: 1000, output_tokens: 150 },
    },
  });
  try {
    const r = await runResearchWithClaude(inputs({ existingPainIds: [PAIN_MOBILE] }));
    assert.equal(r.ok, true);
    if (r.ok) {
      // PAIN_MOBILE was already tagged → filtered out; only PAIN_EMAIL survives.
      assert.equal(r.result.pain_points.length, 1);
      assert.equal(r.result.pain_points[0]!.pain_id, PAIN_EMAIL);
    }
  } finally {
    teardown();
  }
});

// ── Empty array is legal ────────────────────────────────────────────────────

test("runResearchWithClaude: accepts empty pain_points array (Claude saying 'nothing matches')", async () => {
  installMock({
    reply: {
      content: [
        {
          type: "text",
          text: validResponse({
            pain_points: [],
            decision_maker_email: null,
            reasoning: "Page only describes generic services — no concrete pain evidence.",
          }),
        },
      ],
      usage: { input_tokens: 1000, output_tokens: 100 },
    },
  });
  try {
    const r = await runResearchWithClaude(inputs());
    assert.equal(r.ok, true);
    if (r.ok) {
      assert.equal(r.result.pain_points.length, 0);
      assert.equal(r.result.decision_maker_email, null);
    }
  } finally {
    teardown();
  }
});

// ── Bail paths ─────────────────────────────────────────────────────────────

test("runResearchWithClaude: bails on empty haystack, no API call", async () => {
  const calls: MessagesCreateInput[] = [];
  installMock({
    reply: { content: [], usage: { input_tokens: 0, output_tokens: 0 } },
    calls,
  });
  try {
    const r = await runResearchWithClaude(
      inputs({ what_they_do: null, notes: null }),
    );
    assert.equal(r.ok, false);
    if (!r.ok) {
      assert.equal(r.reason, "empty_input");
      assert.equal(r.usage, null);
    }
    assert.equal(calls.length, 0);
  } finally {
    teardown();
  }
});

test("runResearchWithClaude: bails on empty taxonomy, no API call", async () => {
  const calls: MessagesCreateInput[] = [];
  installMock({
    reply: { content: [], usage: { input_tokens: 0, output_tokens: 0 } },
    calls,
  });
  try {
    const r = await runResearchWithClaude(inputs({ options: [] }));
    assert.equal(r.ok, false);
    if (!r.ok) assert.equal(r.reason, "empty_taxonomy");
    assert.equal(calls.length, 0);
  } finally {
    teardown();
  }
});

// ── Error paths ────────────────────────────────────────────────────────────

test("runResearchWithClaude: parse error on malformed JSON", async () => {
  installMock({
    reply: {
      content: [{ type: "text", text: "not json{" }],
      usage: { input_tokens: 200, output_tokens: 20 },
    },
  });
  try {
    const r = await runResearchWithClaude(inputs());
    assert.equal(r.ok, false);
    if (!r.ok) {
      assert.equal(r.reason, "parse");
      assert.ok(r.usage);
    }
  } finally {
    teardown();
  }
});

test("runResearchWithClaude: parse error on missing required fields", async () => {
  installMock({
    reply: {
      content: [{ type: "text", text: JSON.stringify({ pain_points: [] }) }], // missing decision_maker_email
      usage: { input_tokens: 200, output_tokens: 20 },
    },
  });
  try {
    const r = await runResearchWithClaude(inputs());
    assert.equal(r.ok, false);
    if (!r.ok) assert.equal(r.reason, "parse");
  } finally {
    teardown();
  }
});

test("runResearchWithClaude: classifies 429 as rate_limit", async () => {
  installMock({
    reply: () => {
      throw new Error("HTTP 429: rate limit exceeded");
    },
  });
  try {
    const r = await runResearchWithClaude(inputs());
    assert.equal(r.ok, false);
    if (!r.ok) {
      assert.equal(r.reason, "rate_limit");
      assert.equal(r.usage, null);
    }
  } finally {
    teardown();
  }
});

test("runResearchWithClaude: classifies abort as timeout", async () => {
  installMock({
    reply: () => {
      throw new Error("Request timeout: aborted after 15000ms");
    },
  });
  try {
    const r = await runResearchWithClaude(inputs());
    assert.equal(r.ok, false);
    if (!r.ok) assert.equal(r.reason, "timeout");
  } finally {
    teardown();
  }
});
