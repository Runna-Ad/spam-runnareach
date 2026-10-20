/**
 * Brief tasks/briefs/pitch-rewrite-notes.md, the composer and review side:
 *   - the writer prompt no longer teaches guesses stated as fact (v3);
 *   - an answer that only lacks pain_id or contact_email is no longer thrown
 *     away for a template, while the strict fields stay strict;
 *   - a rewrite's first compose revises the held draft, and two rewrites in
 *     one tick each stay inside the 48 s compose deadline (fake clock).
 */

import assert from "node:assert/strict";
import test from "node:test";
import { __test__ } from "../lib/anthropic/client.ts";
import { PITCH_PROMPT_VERSION, composePitchWithClaude } from "../lib/pitches/claude-composer.ts";
import { composeWithReview } from "../lib/pitches/review.ts";
import type { GeneratorInputs } from "../lib/pitches/generator.ts";

process.env.ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY ?? "test-key";

type Req = { system?: { text: string }[] | string; messages: { content: string }[] };
const sysText = (r: Req) => (typeof r.system === "string" ? r.system : (r.system ?? []).map((b) => b.text).join("\n"));
const isCritic = (r: Req) => sysText(r).includes("You review a cold email");

function install(handler: (r: Req) => string) {
  const calls: Req[] = [];
  __test__.setClient({
    messages: {
      create: async (r: Req) => {
        calls.push(r);
        return { content: [{ type: "text", text: handler(r) }], usage: { input_tokens: 100, output_tokens: 50 } };
      },
    },
  } as never);
  return calls;
}

function inputs(lang: "en" | "es" = "en", size = 10): GeneratorInputs {
  return {
    prospect: { id: "p", company_name: "Clinica Sur", industry: "clinic", language: lang, employee_size_estimate: size, city: "Calgary", market: "CA", what_they_do: "family dental clinic", tech_stack: [] },
    pains: [{ pain_id: "pain-1", pain_label: "Lead response time", evidence_quote: "contact form only, no booking" }],
    contacts: [{ full_name: "Sarah Lee", email: "sarah@clinicasur.ca", email_is_role_based: false, role_title: null }],
    case_studies: [],
    notable_clients: [],
    benchmarks: [],
    sender: { full_name: "Henry", tenant_display_name: "Runna Advertising" },
    deep_pitch_url: "https://runna-hunter.vercel.app/?market=ca",
  };
}

const BODY = "Hi Sarah,\n\nHenry from Runna Advertising here. Right now the only way to reach Clinica Sur online is a contact form, which usually means people who want to book tonight wait until morning.\n\n👉 Run Clinica Sur through our free check, about 30 seconds: https://runna-hunter.vercel.app/?market=ca\n\nHenry\nRunna Advertising";

function answer(over: Record<string, unknown> = {}, drop: string[] = []): string {
  const o: Record<string, unknown> = {
    subject: "who books clinica sur at night",
    preview_text: "a contact form is the only way in after hours",
    body: BODY,
    pain_id: "pain-1",
    contact_email: "sarah@clinicasur.ca",
    measurable_result_included: false,
    quality_self_score: 0.8,
    reasoning: "x",
    ...over,
  };
  for (const k of drop) delete o[k];
  return JSON.stringify(o);
}

// ── Prompt ────────────────────────────────────────────────────────────────────

// The lines the critic kept blocking, copied nearly verbatim from the prompt's
// own examples (lesson llm-examples-become-templates). They must not come back.
const RETIRED = [
  "the business consequence, not the symptom",
  "every visitor after hours just leaves",
  "That translation is your hook",
  "the leak, stated as fact",
  "and right now yours wait until morning",
  "cada visita fuera de horario se va",
  "y hoy las tuyas esperan hasta el día siguiente",
  "la fuga, dicha como hecho",
];

test("prompt v3: the retired guess-as-fact lines are gone in every language and register", async () => {
  assert.notEqual(PITCH_PROMPT_VERSION, "pitch-v2-2026-10-16");
  for (const [lang, size] of [["en", 10], ["es", 10], ["es", 200]] as const) {
    const calls = install(() => answer());
    const r = await composePitchWithClaude(inputs(lang, size));
    assert.equal(r.ok, true);
    const sys = sysText(calls[0]!);
    for (const line of RETIRED) assert.ok(!sys.includes(line), `${lang}/${size}: "${line}" is back`);
    // What replaces it: the observation is a fact, the cost is what usually happens.
    assert.match(sys, /SAY WHAT YOU SAW, THEN WHAT USUALLY HAPPENS/);
    assert.match(sys, /never as a fact about them/);
    // Still exactly one em dash: the rule that bans it.
    assert.equal(sys.split("—").length - 1, 1, `${lang}/${size}: em dash in an example`);
  }
});

test("critic prompt: every blocking rule is still there, plus the one framing sentence", async () => {
  let critic = "";
  install((r) => {
    if (isCritic(r)) {
      critic = sysText(r);
      return JSON.stringify({ score: 0.95, issues: [] });
    }
    return answer();
  });
  const r = await composeWithReview(inputs(), { deadline: Date.now() + 48_000 });
  assert.equal(r.ok, true);
  for (const rule of [
    "1. A claim about the prospect (what they do, how they work, their customers, their problem) that the payload does not support, or an inference stated as fact.",
    "2. A statistic that is not one of payload.benchmarks",
    "3. RELEVANCE:",
    "4. LANGUAGE:",
    "5. FIT:",
    "6. TONE:",
    "7. More than about 140 words before the sign-off.",
  ]) assert.ok(critic.includes(rule), `blocking rule missing: ${rule}`);
  assert.match(critic, /is not an inference stated as fact\.\n/);
});

// ── Missing fields ────────────────────────────────────────────────────────────

test("an answer missing pain_id parses with pain_id null (was 4 of 5 template fallbacks)", async () => {
  install(() => answer({}, ["pain_id"]));
  const r = await composePitchWithClaude(inputs());
  assert.equal(r.ok, true, r.ok ? "" : r.error);
  if (r.ok) assert.equal(r.result.composed.pain_id, null);
});

test("an answer missing contact_email parses with null", async () => {
  install(() => answer({}, ["contact_email"]));
  const r = await composePitchWithClaude(inputs());
  assert.equal(r.ok, true, r.ok ? "" : r.error);
  if (r.ok) assert.equal(r.result.composed.contact_used, null);
});

test("the strict fields stay strict: missing quality_self_score or measurable_result_included fails, a made-up pain_id fails", async () => {
  for (const field of ["quality_self_score", "measurable_result_included"]) {
    install(() => answer({}, [field]));
    const r = await composePitchWithClaude(inputs());
    assert.equal(r.ok, false, field);
    if (!r.ok) assert.equal(r.reason, "parse", field);
  }
  install(() => answer({ pain_id: "not-a-real-pain" }));
  const h = await composePitchWithClaude(inputs());
  assert.equal(h.ok, false);
  if (!h.ok) assert.equal(h.reason, "hallucinated_pain");
  // An invalid address is still not accepted as one.
  install(() => answer({ contact_email: "not an email" }));
  assert.equal((await composePitchWithClaude(inputs())).ok, false);
});

// ── Revise the held draft first ───────────────────────────────────────────────

const HELD = {
  subject: "clinica sur loses patients at night",
  body: "Hi Sarah,\n\nEveryone who finds you on their phone after hours just leaves.\n\nHenry\nRunna Advertising",
  issues: ["Unsourced number: 3 seconds", "Inference stated as fact: 'everyone who finds you after hours just leaves'", "(polish) subject is long"],
};

test("reviseFirst: the first composer call carries the held draft and its notes; no reviseFirst composes fresh", async () => {
  const calls = install((r) => (isCritic(r) ? JSON.stringify({ score: 0.9, issues: [] }) : answer()));
  const r = await composeWithReview(inputs(), { deadline: Date.now() + 48_000, reviseFirst: HELD });
  assert.equal(r.ok, true);
  const firstUser = calls[0]!.messages[0]!.content;
  assert.match(firstUser, /⚑ REVISION/);
  assert.ok(firstUser.includes(`Subject: ${HELD.subject}`));
  assert.ok(firstUser.includes(HELD.body));
  for (const i of HELD.issues) assert.ok(firstUser.includes(`- ${i}`), i);

  const fresh = install((r2) => (isCritic(r2) ? JSON.stringify({ score: 0.9, issues: [] }) : answer()));
  await composeWithReview(inputs(), { deadline: Date.now() + 48_000 });
  assert.doesNotMatch(fresh[0]!.messages[0]!.content, /⚑ REVISION/);
});

test("reviseFirst: a later revision in the loop uses the new draft's notes, not the held draft", async () => {
  let n = 0;
  const calls = install((r) => {
    if (isCritic(r)) return JSON.stringify({ score: 0.6, issues: [{ issue: `note ${n}`, blocking: true }] });
    n++;
    return answer({ subject: `draft number ${n}` });
  });
  const r = await composeWithReview(inputs(), { deadline: Date.now() + 120_000, reviseFirst: HELD });
  assert.equal(r.ok, true);
  const composes = calls.filter((c) => !isCritic(c));
  assert.equal(composes.length, 3); // revise-held + MAX_REVISIONS (2)
  const second = composes[1]!.messages[0]!.content;
  assert.ok(second.includes("Subject: draft number 1"));
  assert.ok(!second.includes(HELD.body));
});

test("deadline: two rewrites in one tick each stay inside their 48 s compose deadline (fake clock)", async () => {
  // Worst realistic timing: a slow writer (30 s) and a slow critic (12 s),
  // both always unhappy, so the loop would revise as long as time allows.
  let clock = 1_000_000;
  const now = () => clock;
  const ends: Array<{ kind: string; at: number }> = [];
  install((r) => {
    const critic = isCritic(r);
    clock += critic ? 12_000 : 30_000;
    ends.push({ kind: critic ? "critic" : "compose", at: clock });
    return critic ? JSON.stringify({ score: 0.6, issues: [{ issue: "still a guess", blocking: true }] }) : answer();
  });
  for (let rewrite = 0; rewrite < 2; rewrite++) {
    const startedAt = clock;
    const deadline = startedAt + 48_000;
    ends.length = 0;
    const r = await composeWithReview(inputs(), { deadline, now, reviseFirst: HELD });
    assert.equal(r.ok, true);
    // One compose (the revision of the held draft) and one critic fit; no second compose starts.
    assert.deepEqual(ends.map((e) => e.kind), ["compose", "critic"], `rewrite ${rewrite}`);
    for (const e of ends) assert.ok(e.at <= deadline, `rewrite ${rewrite}: ${e.kind} ended ${e.at - deadline} ms past the deadline`);
  }
});
