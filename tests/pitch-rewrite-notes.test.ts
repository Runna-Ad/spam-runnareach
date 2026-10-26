/**
 * Brief tasks/briefs/pitch-rewrite-notes.md, the composer and review side:
 *   - the writer prompt no longer teaches guesses stated as fact (v3);
 *   - an answer that only lacks pain_id or contact_email is no longer thrown
 *     away for a template, while the strict fields stay strict;
 *   - a rewrite composes fresh (writer-honesty, was: revises the held draft); two rewrites in
 *     one tick each stay inside the 48 s compose deadline (fake clock).
 */

import assert from "node:assert/strict";
import test from "node:test";
import { __test__ } from "../lib/anthropic/client.ts";
import { PITCH_PROMPT_VERSION, composePitchWithClaude, heldBodyForRevision } from "../lib/pitches/claude-composer.ts";
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
  "estás perdiendo ventas",
];

// A fixed cue phrase in the prompt becomes the new verbatim template.
const CUES = ["which usually means", "usually sends", "eso suele"];

test("prompt v3: the retired guess-as-fact lines are gone in every language and register", async () => {
  assert.notEqual(PITCH_PROMPT_VERSION, "pitch-v2-2026-10-16");
  for (const [lang, size] of [["en", 10], ["es", 10], ["es", 200]] as const) {
    const calls = install(() => answer());
    const r = await composePitchWithClaude(inputs(lang, size));
    assert.equal(r.ok, true);
    const sys = sysText(calls[0]!);
    for (const line of RETIRED) assert.ok(!sys.includes(line), `${lang}/${size}: "${line}" is back`);
    // What replaces it: the observation is a fact, the cost is what usually happens.
    for (const cue of CUES) assert.ok(!sys.includes(cue), `${lang}/${size}: fixed cue "${cue}" in the prompt`);
    assert.match(sys, /SAY WHAT YOU SAW, THEN WHAT IT TENDS TO COST/);
    assert.match(sys, /what tends to happen to businesses with this gap in general, never as a fact about their own customers, visitors or sales\. Word that in your own way each time/);
    // Still exactly one em dash: the rule that bans it.
    assert.equal(sys.split("—").length - 1, 1, `${lang}/${size}: em dash in an example`);
  }
});

test("critic prompt: every blocking rule is still there; rule 1 blocks only claims about THIS business", async () => {
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
    "1. A sentence that states, about THIS business (it says you, your, yours or the company's name",
    "2. A statistic that is not one of payload.benchmarks",
    "3. RELEVANCE:",
    "4. LANGUAGE:",
    "5. FIT:",
    "6. TONE:",
    "7. More than about 140 words before the sign-off.",
  ]) assert.ok(critic.includes(rule), `blocking rule missing: ${rule}`);
  // Both halves: in general it is allowed; said about THEM it still blocks.
  assert.match(critic, /a sentence about people or businesses in general \(what tends to happen with this gap\), with or without a hedge/);
  assert.match(critic, /The same goes for a consequence said about this prospect's own customers, visitors, patients or sales \("most of your visitors leave", "you're losing patients"/);
  for (const cue of CUES) assert.ok(!critic.includes(cue), `critic carries the cue "${cue}"`);
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

// ── A rewrite composes fresh (writer-honesty) ──────────────────────────────────

test("the first compose is always fresh: no REVISION block, no held text (writer-honesty: reviseFirst is gone)", async () => {
  const calls = install((r) => (isCritic(r) ? JSON.stringify({ score: 0.9, issues: [] }) : answer()));
  const r = await composeWithReview(inputs(), { deadline: Date.now() + 48_000 });
  assert.equal(r.ok, true);
  assert.doesNotMatch(calls[0]!.messages[0]!.content, /⚑ REVISION/);
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
    const r = await composeWithReview(inputs(), { deadline, now });
    assert.equal(r.ok, true);
    // One compose (the fresh rewrite) and one critic fit; no second compose starts.
    assert.deepEqual(ends.map((e) => e.kind), ["compose", "critic"], `rewrite ${rewrite}`);
    for (const e of ends) assert.ok(e.at <= deadline, `rewrite ${rewrite}: ${e.kind} ended ${e.at - deadline} ms past the deadline`);
  }
});

// ── The held body goes back as the writer wrote it ────────────────────────────

const FWD_EN = "If you're not the right person for this, I'd really appreciate it if you could pass this along to whoever handles it.";
const FWD_ES = "Si no eres la persona indicada para esto, te agradecería mucho que puedas reenviarle este mensaje a quien corresponda.";

test("heldBodyForRevision: the old Hunter link goes back to {hunter_url} (no old r= code), the forwarding line is removed", () => {
  const stored = `Hi Clinica Sur team,\n\nHenry from Runna Advertising here.\n\n👉 Run Clinica Sur through our free check: https://runna-hunter.vercel.app/?market=ca&industry=clinic&r=OLD123.\n\nHenry\nRunna Advertising\n\n${FWD_EN}`;
  const out = heldBodyForRevision(stored);
  assert.ok(out.includes("👉 Run Clinica Sur through our free check: {hunter_url}."), out);
  assert.doesNotMatch(out, /r=|OLD123|runna-hunter/);
  assert.ok(!out.includes(FWD_EN));
  assert.ok(out.endsWith("Henry\nRunna Advertising"));
  assert.ok(!heldBodyForRevision(`Hola,\n\nNils\n\n${FWD_ES}`).includes(FWD_ES));
  // A link that is not ours is left alone.
  assert.ok(heldBodyForRevision("see https://example.com/?r=x").includes("https://example.com/?r=x"));
});

test("revision of a held body: a writer that keeps the 👉 line ends with the NEW link and the forwarding line once", async () => {
  const NEW = "https://runna-hunter.vercel.app/?market=ca&r=NEW999";
  const base = inputs();
  const role: GeneratorInputs = {
    ...base,
    contacts: [{ full_name: null, email: "info@clinicasur.ca", email_is_role_based: true, role_title: null }],
    deep_pitch_url: NEW,
  };
  const held = `Hi Clinica Sur team,\n\nHenry from Runna Advertising here. Right now the only way to reach Clinica Sur online is a contact form.\n\n👉 Run Clinica Sur through our free check, about 30 seconds: https://runna-hunter.vercel.app/?market=ca&r=OLD123\n\nHenry\nRunna Advertising\n\n${FWD_EN}`;
  // The writer echoes the previous draft verbatim: the worst case for both bugs.
  install((r) => {
    const m = /Previous draft:\nSubject: [^\n]*\n([\s\S]*?)\n+```json/.exec(r.messages[0]!.content);
    return answer({ body: m![1]!.trim() });
  });
  const r = await composePitchWithClaude({ ...role, revision: { subject: "s", body: heldBodyForRevision(held), issues: ["fix it"] } });
  assert.equal(r.ok, true, r.ok ? "" : r.error);
  if (!r.ok) return;
  const body = r.result.composed.body;
  assert.ok(body.includes(NEW), body);
  assert.doesNotMatch(body, /OLD123/);
  assert.equal(body.split(FWD_EN).length - 1, 1, "forwarding line exactly once");
});

test("loop revision: a role-inbox draft sent back by the critic keeps the forwarding line once when the writer echoes it", async () => {
  const base = inputs();
  const role: GeneratorInputs = { ...base, contacts: [{ full_name: null, email: "info@clinicasur.ca", email_is_role_based: true, role_title: null }] };
  let reviews = 0;
  install((r) => {
    if (isCritic(r)) return JSON.stringify(reviews++ === 0 ? { score: 0.6, issues: [{ issue: "tighten the hook", blocking: true }] } : { score: 0.95, issues: [] });
    const m = /Previous draft:\nSubject: [^\n]*\n([\s\S]*?)\n+```json/.exec(r.messages[0]!.content);
    return answer({ body: m ? m[1]!.trim() : BODY.replace("Hi Sarah,", "Hi Clinica Sur team,") });
  });
  const r = await composeWithReview(role, { deadline: Date.now() + 120_000 });
  assert.equal(r.ok, true);
  if (!r.ok) return;
  assert.equal(reviews, 2, "one revision happened");
  assert.equal(r.composed.body.split(FWD_EN).length - 1, 1, r.composed.body);
});
