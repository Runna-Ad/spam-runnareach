import assert from "node:assert/strict";
import test from "node:test";
import { __test__ } from "../lib/anthropic/client.ts";
import { asReaderSees, better, composeWithReview, criticVerdict, revisionIssues, writingFailures } from "../lib/pitches/review.ts";
import type { GeneratorInputs } from "../lib/pitches/generator.ts";

process.env.ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY ?? "test-key";

type Req = { system?: { text: string }[] | string; messages: { content: string }[] };
const sysText = (r: Req) => (typeof r.system === "string" ? r.system : (r.system ?? []).map((b) => b.text).join("\n"));

function inputs(): GeneratorInputs {
  return {
    prospect: { id: "p", company_name: "Clinica Sur", industry: "clinic", language: "en", employee_size_estimate: 10, city: "Calgary", market: "CA", what_they_do: "family dental clinic", tech_stack: [] },
    pains: [{ pain_id: "pain-1", pain_label: "Lead response time", evidence_quote: "contact form only, no booking" }],
    contacts: [{ full_name: "Sarah Lee", email: "sarah@clinicasur.ca", email_is_role_based: false, role_title: null }],
    case_studies: [{ id: "00000000-0000-0000-0000-000000000aaa", client_name: "DiDi", industry: "x", hero_metric_en: null, hero_metric_es: null, result_description_en: null, result_description_es: null, testimonial_quote_en: null, testimonial_quote_es: null, measurable_results: [], pain_strength: 1, tier: "smb" }],
    notable_clients: [],
    benchmarks: [],
    sender: { full_name: "Henry", tenant_display_name: "Runna Advertising" },
    deep_pitch_url: "https://runna-hunter.vercel.app/?market=ca",
  };
}

const TAIL = "\n\n👉 Run Clinica Sur through our free check, about 30 seconds: https://runna-hunter.vercel.app/?market=ca\n\nHenry\nRunna Advertising";
const BAD = "Hi Sarah,\n\nHenry from Runna Advertising here. Clinics like yours lose 20-30% of new patients when the only way in is a contact form." + TAIL;
const GOOD = "Hi Sarah,\n\nHenry from Runna Advertising here. Right now the only way to reach Clinica Sur online is a contact form, so a patient who wants to book tonight has to wait until morning." + TAIL;

function pitchJson(body: string) {
  return JSON.stringify({ subject: "who books clinica sur at night", preview_text: "a contact form is the only way in after hours", body, pain_id: "pain-1", contact_email: "sarah@clinicasur.ca", measurable_result_included: false, quality_self_score: 0.8, reasoning: "x" });
}

function install(handler: (r: Req, i: number) => string) {
  let i = 0;
  const calls: Req[] = [];
  __test__.setClient({
    messages: {
      create: async (r: Req) => {
        calls.push(r);
        const text = handler(r, i++);
        return { content: [{ type: "text", text }], usage: { input_tokens: 100, output_tokens: 50 } };
      },
    },
  } as never);
  return calls;
}

test("writingFailures catches what a revision can fix, and only that", () => {
  const f = writingFailures(inputs(), { subject: "x subject", body: BAD });
  assert.ok(f.some((x) => x.code === "unsourced_metric"));
  assert.deepEqual(writingFailures(inputs(), { subject: "who books clinica sur at night", body: GOOD }), []);
  // Recipient provenance is the real gate's job, not the writer's.
  assert.ok(!f.some((x) => x.code === "unverified_recipient"));
});

test("an invented number goes back to the writer with the exact issue, and the clean revision wins", async () => {
  const calls = install((r) => {
    if (sysText(r).includes("You review a cold email")) {
      // Critic: fail the bad draft, pass the good one.
      return r.messages[0]!.content.includes("20-30%")
        ? JSON.stringify({ pass: false, score: 0.3, issues: ["Remove the 20-30% figure; it is not in the payload."] })
        : JSON.stringify({ pass: true, score: 0.9, issues: [] });
    }
    return r.messages[0]!.content.includes("⚑ REVISION") ? pitchJson(GOOD) : pitchJson(BAD);
  });
  try {
    const r = await composeWithReview(inputs(), { deadline: Date.now() + 120_000 });
    assert.equal(r.ok, true);
    if (!r.ok) return;
    assert.equal(r.composed.body.includes("20-30%"), false);
    assert.deepEqual(r.writing, []);
    assert.equal(r.critic?.pass, true);
    assert.equal(r.critic?.revisions, 1);
    assert.equal(r.critic?.history.length, 2);
    // The revision request carried the gate's finding and the critic's.
    const revisionCall = calls.find((c) => c.messages[0]!.content.includes("⚑ REVISION"))!;
    assert.match(revisionCall.messages[0]!.content, /20-30%|"20"/);
    assert.match(revisionCall.messages[0]!.content, /not in the payload/);
    // 2 compose + 2 critic calls, all recorded for cost tracking.
    assert.equal(r.calls.length, 4);
    assert.deepEqual(r.calls.map((c) => c.kind).sort(), ["compose", "compose", "critic", "critic"]);
  } finally {
    __test__.reset();
  }
});

test("no revision when the first draft is clean; at most MAX_REVISIONS otherwise", async () => {
  install((r) => (sysText(r).includes("You review a cold email") ? JSON.stringify({ pass: true, score: 0.95, issues: [] }) : pitchJson(GOOD)));
  try {
    const r = await composeWithReview(inputs(), { deadline: Date.now() + 120_000 });
    assert.ok(r.ok && r.critic?.revisions === 0 && r.calls.length === 2);
  } finally {
    __test__.reset();
  }
  install((r) => (sysText(r).includes("You review a cold email") ? JSON.stringify({ pass: false, score: 0.2, issues: ["Too generic."] }) : pitchJson(BAD)));
  try {
    const r = await composeWithReview(inputs(), { deadline: Date.now() + 120_000 });
    assert.ok(r.ok);
    if (r.ok) {
      assert.equal(r.critic?.revisions, 2);
      assert.equal(r.critic?.pass, false);
      assert.ok((r.critic?.issues.length ?? 0) > 0);
    }
  } finally {
    __test__.reset();
  }
});

test("near the deadline: no critic, no revision, the draft still comes back", async () => {
  install(() => pitchJson(GOOD));
  try {
    const r = await composeWithReview(inputs(), { deadline: Date.now() + 3_000 });
    assert.ok(r.ok);
    if (r.ok) {
      assert.equal(r.critic, null);
      assert.equal(r.calls.length, 1);
    }
  } finally {
    __test__.reset();
  }
});

test("a critic that fails to answer doesn't block or vote", async () => {
  install((r) => (sysText(r).includes("You review a cold email") ? "not json at all" : pitchJson(GOOD)));
  try {
    const r = await composeWithReview(inputs(), { deadline: Date.now() + 120_000 });
    assert.ok(r.ok);
    if (r.ok) {
      assert.equal(r.critic, null);
      assert.equal(r.composed.body, GOOD);
    }
  } finally {
    __test__.reset();
  }
});

test("better() prefers fewer block failures, then a passing review, then a higher score", () => {
  const base = { composed: {} as never, model: "m" };
  const block = { code: "unsourced_metric", severity: "block", detail: "x" } as const;
  const a = { ...base, writing: [block], review: { pass: true, score: 0.9, issues: [] } };
  const b = { ...base, writing: [], review: { pass: false, score: 0.4, issues: ["y"] } };
  assert.equal(better(a, b), b);
  const c = { ...base, writing: [], review: { pass: true, score: 0.6, issues: [] } };
  assert.equal(better(b, c), c);
  assert.deepEqual(revisionIssues({ writing: [block], review: { pass: false, score: 0, issues: ["z"] } }), ["x", "z"]);
});

test("the reviewer sees the CTA as the button the reader gets, not the tracking URL", () => {
  const body = [
    "Hola, equipo de Manthra:",
    "Revisé manthraspa.com desde el celular.",
    "👉 Revisa tu sitio gratis: https://runna-hunter.vercel.app/?market=mx&industry=fitness&r=q8zuu73j&v=1.",
    "Nils · Runna Advertising",
  ].join("\n");
  const seen = asReaderSees(body);
  assert.ok(seen.includes("👉 Revisa tu sitio gratis: [button]."));
  assert.ok(!seen.includes("runna-hunter"));
  assert.ok(seen.includes("manthraspa.com"), "only the 👉 line changes");
});

test("only blocking issues hold a draft; polish rides along, marked, and blocking caps the score", () => {
  const polish = criticVerdict({ score: 0.84, issues: [{ issue: "Say 'book' instead of 'schedule'.", blocking: false }] });
  assert.deepEqual(polish, { pass: true, score: 0.84, issues: ["(polish) Say 'book' instead of 'schedule'."] });

  const held = criticVerdict({
    score: 0.85,
    issues: [
      { issue: "Tighten the subject.", blocking: false },
      { issue: "The 53% figure is from 2016; it is presented as current.", blocking: true },
    ],
  });
  assert.equal(held.pass, false);
  assert.equal(held.score, 0.79);
  assert.equal(held.issues[0], "The 53% figure is from 2016; it is presented as current.");
});

test("a draft with only polish notes passes without a rewrite", async () => {
  const calls = install((r) =>
    sysText(r).includes("You review a cold email")
      ? JSON.stringify({ score: 0.85, issues: [{ issue: "Shorter subject.", blocking: false }] })
      : pitchJson(GOOD),
  );
  try {
    const r = await composeWithReview(inputs(), { deadline: Date.now() + 120_000 });
    assert.ok(r.ok);
    assert.equal(r.ok && r.critic?.pass, true);
    assert.equal(r.ok && r.critic?.revisions, 0);
    assert.equal(calls.length, 2); // one draft, one review
  } finally {
    __test__.setClient(null);
  }
});
