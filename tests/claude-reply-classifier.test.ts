import assert from "node:assert/strict";
import test from "node:test";
import { __test__ } from "../lib/anthropic/client.ts";
import { classifyReplyWithClaude } from "../lib/replies/claude-classifier.ts";

// Fake API key so getClient() doesn't refuse to construct.
process.env.ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY ?? "test-key";

// ── Mock SDK helpers (mirror tests/claude-composer.test.ts) ────────────────

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

function input(over: Partial<{ subject: string | null; body_text: string | null; from_email: string }> = {}) {
  return {
    subject: "Re: quick question on mobile checkout",
    body_text: "Sounds interesting. Happy to jump on a call next Tuesday.",
    from_email: "sarah@example.com",
    ...over,
  };
}

function validResponse(over: Record<string, unknown> = {}) {
  return JSON.stringify({
    intent: "wants_meeting",
    urgency: "hot",
    sentiment: "positive",
    reasoning: "Sender explicitly offers to jump on a call next Tuesday.",
    ...over,
  });
}

// ── Happy path ──────────────────────────────────────────────────────────────

test("classifyReplyWithClaude: returns parsed classification on valid response", async () => {
  installMock({
    reply: {
      content: [{ type: "text", text: validResponse() }],
      usage: { input_tokens: 220, output_tokens: 40 },
    },
  });
  try {
    const r = await classifyReplyWithClaude(input());
    assert.equal(r.ok, true);
    if (r.ok) {
      assert.equal(r.result.classification.intent, "wants_meeting");
      assert.equal(r.result.classification.urgency, "hot");
      assert.equal(r.result.classification.sentiment, "positive");
      assert.match(r.result.classification.reasoning, /jump on a call/);
      // Haiku 4.5 pricing: 220/1M * $1 + 40/1M * $5 = 0.00022 + 0.0002 = 0.00042
      assert.ok(Math.abs(r.result.usage.cost_usd - 0.00042) < 0.000001);
    }
  } finally {
    teardown();
  }
});

test("classifyReplyWithClaude: passes Haiku model + classification taxonomy in prompt", async () => {
  const calls: MessagesCreateInput[] = [];
  installMock({
    reply: {
      content: [{ type: "text", text: validResponse() }],
      usage: { input_tokens: 200, output_tokens: 40 },
    },
    calls,
  });
  try {
    await classifyReplyWithClaude(input());
    assert.equal(calls.length, 1);
    const call = calls[0]!;
    // Routes to Haiku (cost-sensitive simple classification)
    assert.equal(call.model, "claude-haiku-4-5");
    // System prompt enumerates all 7 intents
    assert.match(call.system ?? "", /wants_meeting/);
    assert.match(call.system ?? "", /hard_no/);
    assert.match(call.system ?? "", /auto_reply/);
    // User prompt includes the from address + subject + body
    assert.match(call.messages[0]!.content, /sarah@example\.com/);
    assert.match(call.messages[0]!.content, /quick question on mobile checkout/);
  } finally {
    teardown();
  }
});

// ── Schema-tolerant: missing reasoning still parses ────────────────────────

test("classifyReplyWithClaude: accepts response with reasoning omitted (defaults)", async () => {
  installMock({
    reply: {
      content: [
        {
          type: "text",
          text: JSON.stringify({
            intent: "auto_reply",
            urgency: "cold",
            sentiment: "neutral",
            // reasoning intentionally omitted — Zod schema is lenient
          }),
        },
      ],
      usage: { input_tokens: 200, output_tokens: 30 },
    },
  });
  try {
    const r = await classifyReplyWithClaude(input());
    assert.equal(r.ok, true);
    if (r.ok) {
      assert.equal(r.result.classification.intent, "auto_reply");
      assert.equal(r.result.classification.reasoning, "(no reasoning provided)");
    }
  } finally {
    teardown();
  }
});

// ── Cleans markdown fences ──────────────────────────────────────────────────

test("classifyReplyWithClaude: strips ```json fences", async () => {
  installMock({
    reply: {
      content: [{ type: "text", text: "```json\n" + validResponse() + "\n```" }],
      usage: { input_tokens: 200, output_tokens: 40 },
    },
  });
  try {
    const r = await classifyReplyWithClaude(input());
    assert.equal(r.ok, true);
  } finally {
    teardown();
  }
});

// ── Empty input → bail before calling Claude ────────────────────────────────

test("classifyReplyWithClaude: bails on empty subject AND empty body, no API call", async () => {
  const calls: MessagesCreateInput[] = [];
  installMock({
    reply: { content: [], usage: { input_tokens: 0, output_tokens: 0 } },
    calls,
  });
  try {
    const r = await classifyReplyWithClaude(input({ subject: "", body_text: "" }));
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

test("classifyReplyWithClaude: bails on null subject AND null body", async () => {
  const calls: MessagesCreateInput[] = [];
  installMock({
    reply: { content: [], usage: { input_tokens: 0, output_tokens: 0 } },
    calls,
  });
  try {
    const r = await classifyReplyWithClaude(input({ subject: null, body_text: null }));
    assert.equal(r.ok, false);
    if (!r.ok) assert.equal(r.reason, "empty_input");
    assert.equal(calls.length, 0);
  } finally {
    teardown();
  }
});

test("classifyReplyWithClaude: classifies when only subject present (body empty)", async () => {
  installMock({
    reply: {
      content: [
        { type: "text", text: validResponse({ intent: "auto_reply", urgency: "cold", sentiment: "neutral" }) },
      ],
      usage: { input_tokens: 100, output_tokens: 30 },
    },
  });
  try {
    const r = await classifyReplyWithClaude(input({ subject: "Out of office", body_text: "" }));
    assert.equal(r.ok, true);
  } finally {
    teardown();
  }
});

// ── Error paths: malformed JSON, schema mismatch ────────────────────────────

test("classifyReplyWithClaude: returns parse error on malformed JSON", async () => {
  installMock({
    reply: {
      content: [{ type: "text", text: "not json{" }],
      usage: { input_tokens: 200, output_tokens: 20 },
    },
  });
  try {
    const r = await classifyReplyWithClaude(input());
    assert.equal(r.ok, false);
    if (!r.ok) {
      assert.equal(r.reason, "parse");
      assert.match(r.error, /JSON parse failed/);
      // Usage is recorded even on parse failure — tokens were spent.
      assert.ok(r.usage);
    }
  } finally {
    teardown();
  }
});

test("classifyReplyWithClaude: returns parse error on bad intent enum", async () => {
  installMock({
    reply: {
      content: [
        {
          type: "text",
          text: JSON.stringify({
            intent: "totally_made_up_intent",
            urgency: "warm",
            sentiment: "positive",
            reasoning: "x",
          }),
        },
      ],
      usage: { input_tokens: 200, output_tokens: 30 },
    },
  });
  try {
    const r = await classifyReplyWithClaude(input());
    assert.equal(r.ok, false);
    if (!r.ok) assert.equal(r.reason, "parse");
  } finally {
    teardown();
  }
});

// ── Error paths: SDK throws ────────────────────────────────────────────────

test("classifyReplyWithClaude: classifies 429 as rate_limit", async () => {
  installMock({
    reply: () => {
      throw new Error("HTTP 429: rate limit exceeded");
    },
  });
  try {
    const r = await classifyReplyWithClaude(input());
    assert.equal(r.ok, false);
    if (!r.ok) {
      assert.equal(r.reason, "rate_limit");
      assert.equal(r.usage, null);
    }
  } finally {
    teardown();
  }
});

test("classifyReplyWithClaude: classifies abort as timeout", async () => {
  installMock({
    reply: () => {
      throw new Error("Request timeout: aborted after 15000ms");
    },
  });
  try {
    const r = await classifyReplyWithClaude(input());
    assert.equal(r.ok, false);
    if (!r.ok) assert.equal(r.reason, "timeout");
  } finally {
    teardown();
  }
});

test("classifyReplyWithClaude: classifies 401 as auth", async () => {
  installMock({
    reply: () => {
      throw new Error("HTTP 401: invalid api key");
    },
  });
  try {
    const r = await classifyReplyWithClaude(input());
    assert.equal(r.ok, false);
    if (!r.ok) assert.equal(r.reason, "auth");
  } finally {
    teardown();
  }
});
