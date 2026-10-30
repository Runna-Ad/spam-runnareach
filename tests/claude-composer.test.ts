import assert from "node:assert/strict";
import test from "node:test";
import { __test__ } from "../lib/anthropic/client.ts";
import { composePitchWithClaude, firstNameGuess, forwardingLineFor, heldBodyForRevision } from "../lib/pitches/claude-composer.ts";
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
  system?: string | { type: string; text: string }[];
  messages: { role: string; content: string }[];
};

// System is now sent as content blocks (for prompt caching) — flatten for assertions.
function systemText(s: MessagesCreateInput["system"]): string {
  if (!s) return "";
  return typeof s === "string" ? s : s.map((b) => b.text).join("\n");
}
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
    benchmarks: [],
    sender: { full_name: "Pedro De Velasco", tenant_display_name: "Runna CA" },
    deep_pitch_url: null,
    ...over,
  };
}

function validResponse(over: Record<string, unknown> = {}) {
  return JSON.stringify({
    subject: "Quick thought on mobile conversion at Calgary Coffee",
    preview_text: "No cart recovery flow, no retargeting — leaving ~25% revenue on the table.",
    body: "Hi Sarah,\n\nSaw \"checkout breaks on iPhone\" — most DTC coffee brands hit this wall.\n\nWe helped DiDi (+47% mobile checkout completion). Same shape as what we're seeing on your end.\n\n👉 See Calgary Coffee's number: https://runna-hunter.vercel.app/\n\nPedro\nPedro De Velasco\nRunna CA",
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
      // Prompt v2 never cites a case study, whatever the model returns.
      assert.equal(r.result.composed.case_study_id, null);
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
    const sys = systemText(call.system);
    assert.match(sys, /cold[- ]email/i);
    assert.match(sys, /JSON/);
    // System prompt: signed by the per-language sender, under the agency name.
    assert.match(sys, /from Henry/);
    assert.match(sys, /Runna Advertising/);
    // User prompt (payload): pain candidate IDs, and NO case studies — client
    // names and metrics are withheld so they cannot leak into a pitch.
    const user = call.messages[0]!.content;
    assert.match(user, new RegExp(PAIN_ID));
    assert.doesNotMatch(user, new RegExp(CASE_ID));
    assert.doesNotMatch(user, /DiDi|47%/);
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

test("composePitchWithClaude: ignores any case_study_id the model returns", async () => {
  for (const case_study_id of ["11111111-1111-1111-1111-111111111111", "not-a-uuid", undefined]) {
    installMock({
      reply: {
        content: [{ type: "text", text: validResponse({ case_study_id }) }],
        usage: { input_tokens: 500, output_tokens: 200 },
      },
    });
    try {
      const r = await composePitchWithClaude(inputs());
      assert.equal(r.ok, true, String(case_study_id));
      if (r.ok) assert.equal(r.result.composed.case_study_id, null);
    } finally {
      teardown();
    }
  }
});

// ── Prompt v2 coherence ─────────────────────────────────────────────────────

test("prompt v2: one rule per topic, examples obey the rules", async () => {
  const variants: Array<Partial<GeneratorInputs["prospect"]>> = [
    { language: "en" },
    { language: "es", employee_size_estimate: 10 },
    { language: "es", employee_size_estimate: 200 },
  ];
  for (const v of variants) {
    const calls: MessagesCreateInput[] = [];
    installMock({
      reply: { content: [{ type: "text", text: validResponse() }], usage: { input_tokens: 1, output_tokens: 1 } },
      calls,
    });
    try {
      const base = inputs();
      await composePitchWithClaude({ ...base, prospect: { ...base.prospect, ...v } });
      const sys = systemText(calls[0]!.system);
      const label = JSON.stringify(v);
      // The only em dash is the one in the rule that bans it.
      assert.equal(sys.split("—").length - 1, 1, `${label}: em dash in an example`);
      // No client or internal product offered as proof.
      assert.doesNotMatch(sys, /SnapPad|S\.P\.A\.M|Did this for|case stud(y|ies) bridge/i, label);
      // The v1 contradictions are gone.
      assert.doesNotMatch(sys, /NO NUMBERS/, label);
      assert.doesNotMatch(sys, /Klaviyo flows|creative refresh|attribution improvement/i, label);
      // The sign-off is the per-language sender.
      assert.match(sys, v.language === "es" ? /"Nils" on one line/ : /"Henry" on one line/, label);
    } finally {
      teardown();
    }
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

// ── firstNameGuess — greeting safety ─────────────────────────────────────────
// A wrong greeting is the same class of failure as a wrong fact: it reads as a
// bot and has already cost a real lead ("Hi Calgauthier,"). Fixtures below are
// REAL addresses seen in production.

test("firstNameGuess: prefers the contact's actual full_name", () => {
  assert.equal(firstNameGuess("Miguel Ángel Ruiz", "info@x.com", false), "Miguel");
  assert.equal(firstNameGuess("Mark Jones", null, false), "Mark");
});

test("firstNameGuess: separator makes the given name unambiguous", () => {
  assert.equal(firstNameGuess(null, "john.sipos@waglaw.net", false), "John");
  assert.equal(firstNameGuess(null, "ana.lopez@x.mx", false), "Ana");
});

test("firstNameGuess: refuses initial+surname locals (real firm addresses)", () => {
  // julien-cormier.ca partners — greeting "Hi Vfournier," would be a bot tell.
  assert.equal(firstNameGuess(null, "vfournier@julien-cormier.ca", false), null);
  assert.equal(firstNameGuess(null, "rgjulien@julien-cormier.ca", false), null);
  assert.equal(firstNameGuess(null, "pjcormier@julien-cormier.ca", false), null);
  // The lead this originally cost.
  assert.equal(firstNameGuess(null, "calgauthier@gmail.com", false), null);
});

test("firstNameGuess: accepts a short unambiguous given name", () => {
  assert.equal(firstNameGuess(null, "miguel@saucedoa.com", false), "Miguel");
  assert.equal(firstNameGuess(null, "carmen@cgc.mx", false), "Carmen");
});

test("firstNameGuess: never greets a role inbox by name", () => {
  assert.equal(firstNameGuess(null, "info@x.com", true), null);
  assert.equal(firstNameGuess(null, "ventas@x.mx", false), null);
  assert.equal(firstNameGuess(null, null, false), null);
});

test("forwarding line: an usted email asks in usted, a tú email in tú (2026-10-29)", async (t) => {
  t.after(teardown);
  const USTED = forwardingLineFor("es", "mid_market");
  const TU = forwardingLineFor("es", "smb");
  assert.match(USTED, /^Si usted no es la persona indicada/);
  assert.doesNotMatch(USTED, /\beres\b|\bte\b|\bpuedas\b/);
  assert.match(TU, /^Si no eres la persona indicada/);
  assert.equal(forwardingLineFor("es", "enterprise"), USTED);
  assert.match(forwardingLineFor("en", "mid_market"), /^If you're not the right person/);

  const es = (employees: number | null): GeneratorInputs =>
    inputs({
      prospect: {
        id: "p2", company_name: "Plásticos del Norte", industry: "fábrica de plásticos", language: "es",
        employee_size_estimate: employees, city: "Monterrey", market: "MX", what_they_do: null, tech_stack: [],
      },
      contacts: [{ full_name: null, email: "ventas@plasticosdelnorte.mx", email_is_role_based: true, role_title: null }],
    });
  installMock({
    reply: {
      content: [{ type: "text", text: validResponse({ body: "Hola, equipo de Plásticos del Norte,\n\nLe escribo desde Runna.\n\n👉 {hunter_url}\n\nNils\nRunna Advertising", contact_email: "ventas@plasticosdelnorte.mx" }) }],
      usage: { input_tokens: 10, output_tokens: 10 },
    },
  });
  const big = await composePitchWithClaude(es(120));
  assert.ok(big.ok);
  assert.ok(big.result.composed.body.endsWith(USTED), big.result.composed.body);
  const small = await composePitchWithClaude(es(5));
  assert.ok(small.ok);
  assert.ok(small.result.composed.body.endsWith(TU), small.result.composed.body);

  // A rewrite still strips either one (it is appended again after the revision).
  assert.ok(!heldBodyForRevision(big.result.composed.body).includes(USTED));
  assert.ok(!heldBodyForRevision(small.result.composed.body).includes(TU));
});
