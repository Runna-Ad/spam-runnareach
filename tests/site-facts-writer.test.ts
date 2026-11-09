/**
 * Brief tasks/briefs/site-facts-writer.md, the writer and the critic: site_facts
 * reach both, as one list; no site_facts, no site claim; the CTA and the
 * subject stop claiming a loss. Pitch v3.5 (proven facts, 2026-11-09, after
 * CrushCamp's hard no): only "seen" site facts and web facts reach them
 * (lib/pitches/proven-facts.ts proveInputs), an absence is never said, not
 * even as "I didn't see", and the critic blocks any. The showcase arm is
 * untouched (its prompts are pinned byte for byte).
 */

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import test from "node:test";
import { __test__ } from "../lib/anthropic/client.ts";
import { PITCH_PROMPT_VERSION, SHOWCASE_PROMPT_VERSION, composePitchWithClaude } from "../lib/pitches/claude-composer.ts";
import { composeWithReview } from "../lib/pitches/review.ts";
import type { GeneratorInputs } from "../lib/pitches/generator.ts";
import type { SiteFact } from "../lib/pitches/site-facts.ts";
import { proveInputs, type WebFactInput } from "../lib/pitches/proven-facts.ts";
import { findAbsenceClaims, findTrackRecordClaims } from "../lib/pitches/content-rules.ts";

process.env.ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY ?? "test-key";

type Req = { system?: { text: string }[] | string; messages: { content: string }[] };
const sysText = (r: Req) => (typeof r.system === "string" ? r.system : (r.system ?? []).map((b) => b.text).join("\n"));
const isCritic = (r: Req) => sysText(r).includes("You review a cold email");
const userText = (r: Req) => r.messages[0]!.content;
const payloadOf = (r: Req) => JSON.parse(/```json\n([\s\S]*?)\n```/.exec(userText(r))![1]!) as Record<string, unknown>;

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

const BOOKING_ENGINE: SiteFact = { id: "booking", kind: "seen", fact: "Their 'Book Now' button goes to an outside booking engine (secure.webrez.com)", url: "https://www.hiddenacres.test/", strength: "strong" };
const NO_FORM: SiteFact = { id: "contact_form", kind: "absence", fact: "No contact form was found on the pages we read (home, contact)", url: "https://www.hiddenacres.test/", strength: "strong" };
const JOB_POST: WebFactInput = { fact: "They are hiring a second front-desk person", quote: "Hidden Acres is hiring a second front desk host for the summer", url: "https://jobs.example/hidden-acres-front-desk", title: "Front desk host", kind: "opening" };
// What the writer and the critic are shown for a site fact: the entry plus its hook (lib/pitches/proven-facts.ts).
const shown = (f: SiteFact, hook = "context") => ({ ...f, hook });

function inputs(over: Partial<GeneratorInputs> = {}, lang: "en" | "es" = "en", size = 10): GeneratorInputs {
  return {
    prospect: { id: "p", company_name: "Hidden Acres", industry: "lodging", language: lang, employee_size_estimate: size, city: "Kamloops", market: "CA", what_they_do: "treehouse cabins", tech_stack: [] },
    pains: [{ pain_id: "pain-1", pain_label: "No online booking", evidence_quote: "no easy way to book a cabin" }],
    contacts: [{ full_name: "Sarah Lee", email: "sarah@hiddenacres.test", email_is_role_based: false, role_title: null }],
    case_studies: [],
    notable_clients: [],
    benchmarks: [],
    sender: { full_name: "Henry", tenant_display_name: "Runna Advertising" },
    deep_pitch_url: "https://runna-hunter.vercel.app/?market=ca",
    ...over,
  };
}

// pain_id: the first pain the writer was offered (proveInputs leaves a first draft none).
const offeredPain = (r: Req) => (payloadOf(r).pain_candidates as Array<{ pain_id: string | null }> | undefined)?.[0]?.pain_id ?? null;
const writerAnswer = (body: string, subject = "an idea for hidden acres", painId: string | null = "pain-1") =>
  JSON.stringify({
    subject,
    preview_text: "a quick idea about the cabins and how guests reach you",
    body,
    pain_id: painId,
    contact_email: "sarah@hiddenacres.test",
    measurable_result_included: false,
    quality_self_score: 0.8,
    reasoning: "x",
  });
const BODY = "Hi Sarah,\n\nHenry from Runna Advertising here. I had a look at Hidden Acres and the treehouse cabins.\n\n👉 See what our free check finds on Hidden Acres' site, about 30 seconds: {hunter_url}\n\nHenry\nRunna Advertising";

async function writerCall(input: GeneratorInputs): Promise<Req> {
  const calls = install((r) => writerAnswer(BODY, undefined, offeredPain(r)));
  const r = await composePitchWithClaude(input);
  assert.equal(r.ok, true);
  return calls[0]!;
}

async function criticCall(input: GeneratorInputs, body = BODY, subject?: string, verdict = { score: 0.95, issues: [] as unknown[] }) {
  const calls = install((r) => (isCritic(r) ? JSON.stringify(verdict) : writerAnswer(body, subject, offeredPain(r))));
  const r = await composeWithReview(input, { deadline: Date.now() + 48_000, maxRevisions: 0 });
  assert.equal(r.ok, true);
  return { critic: calls.find(isCritic)!, writer: calls.find((c) => !isCritic(c))!, result: r };
}

const CASES = [["en", 10], ["es", 10], ["es", 200]] as const;

// ── The writer ───────────────────────────────────────────────────────────────

test("writer v3.5: site_facts and web_facts are the only source for a claim about them; no absence is ever said, not even as 'I didn't see'", async () => {
  assert.equal(PITCH_PROMPT_VERSION, "pitch-v3.5-2026-11-09");
  for (const [lang, size] of CASES) {
    const sys = sysText(await writerCall(inputs({ site_facts: [BOOKING_ENGINE] }, lang, size)));
    const label = `${lang}/${size}`;
    assert.ok(sys.includes("About the prospect, say only what the payload proves: company_name, industry, city, what_they_do, tech_stack, site_facts and web_facts. Every claim about them must be one of those, said as it is written there and no more."), label);
    assert.ok(sys.includes("site_facts is what our crawler saw on their own site, each entry with its page (url). web_facts is what another web page says about them"), label);
    assert.ok(sys.includes(`Each entry has a hook: "problem" (something not working), "opening" (a change, like a new location or a hire), "context" (true, but no reason to write on its own).`), label);
    assert.ok(sys.includes(`Never write what you did not see, did not find or think is missing, not even softly: no "I didn't see", "I couldn't find", "there's no", "you don't have", "your site doesn't", "without a way to". If it is not an entry, it is not in the email.`), label);
    assert.ok(sys.includes(`3. Hook: one proven fact about THIS business, a site_facts or web_facts entry whose hook is "problem" or "opening"`), label);
    // The v3.4 absence rules (an absence entry said as "I didn't see", weak facts said softly) are gone.
    assert.ok(!sys.includes(`kind "absence"`), label);
    assert.ok(!sys.includes("say it as what you didn't see"), label);
    assert.ok(!sys.includes("An absence comes ONLY from an absence entry"), label);
    assert.ok(!sys.includes(`strength "weak": say it softly`), label);
    // Site-fact and web-fact figures are not FACTS 2 numbers (the send gate would hold them).
    assert.ok(sys.includes("A number in a site fact or a web fact (a year, a score, a rating, a count) is not one FACTS 2 allows"), label);
    // The examples no longer teach "there's no way to…" as a fact.
    assert.ok(!sys.includes("Checked your site: the only way to book is to call during office hours"), label);
    assert.ok(!sys.includes("there's no way to buy anything online"), label);
    assert.ok(!sys.includes("no hay forma de comprar nada en línea"), label);
  }
});

test("writer: the new CTA in EN and ES; the old 'where [the pain] is costing you' and every quiet-loss subject are gone", async () => {
  for (const [lang, size] of CASES) {
    const sys = sysText(await writerCall(inputs({}, lang, size)));
    const label = `${lang}/${size}`;
    if (lang === "en") {
      assert.ok(sys.includes("see what our free check finds on [company]'s site. About 30 seconds, no signup, no strings: {hunter_url}. See something worth fixing? Reply."), label);
      assert.ok(sys.includes(`"what I noticed on [company]'s site"`), label);
      assert.ok(sys.includes(`"an idea for [company]"`), label);
    } else {
      assert.ok(sys.includes("mira lo que nuestra herramienta gratis encuentra en el sitio de [empresa]. Unos 30 segundos, sin registro, sin compromiso: {hunter_url}."), label);
      assert.ok(sys.includes(`"lo que vi en el sitio de [empresa]"`), label);
      assert.ok(sys.includes(`"una idea para [empresa]"`), label);
    }
    assert.ok(sys.includes("they'll see what our free check finds on [company]'s site"), label);
    assert.ok(sys.includes("Never say where they are losing or what something is costing them"), label);
    // The subject rule is tied to non-empty site_facts.
    assert.match(sys, /ONLY when site_facts is not empty|SOLO cuando site_facts no está vacío/, label);
    assert.ok(sys.includes("A subject that says you saw or noticed something on their site only when site_facts is not empty; with site_facts empty, a neutral subject that claims nothing."), label);
    assert.ok(sys.includes("Never a loss or a cost"), label);
    for (const old of [
      "is costing you", "te está costando", "where [this email's pain] is costing them", "quiet loss", "pérdida silenciosa", "loses online orders",
      "leaks customers", "what a slow reply costs [company]", "dónde pierde clientes [empresa]", "[company]'s own [pain]", "revisa gratis [el dolor]",
    ]) {
      assert.ok(!sys.includes(old), `${label}: "${old}" still in the prompt`);
    }
  }
});

test("writer payload: proven site_facts (id, kind, fact, url, strength, hook) and web_facts (fact, quote, url, hook); an absence never reaches it; the system prompt is the same with or without them (cached)", async () => {
  // The stage's one door (proveInputs): the absence is dropped, the seen fact and the web fact stay.
  const withFacts = await writerCall(proveInputs(inputs({ site_facts: [BOOKING_ENGINE, NO_FORM] }), [JOB_POST]));
  assert.deepEqual(payloadOf(withFacts).site_facts, [shown(BOOKING_ENGINE)]);
  assert.deepEqual(payloadOf(withFacts).web_facts, [{ fact: JOB_POST.fact, quote: JOB_POST.quote, url: JOB_POST.url, hook: "opening" }]);
  assert.ok(!userText(withFacts).includes(NO_FORM.fact), "the absence never reaches the writer");
  assert.ok(!userText(withFacts).includes("no easy way to book a cabin"), "nor the research pain's evidence");
  assert.deepEqual(payloadOf(withFacts).pain_candidates, []);
  assert.ok(userText(withFacts).includes("- site_facts: everything you say about their website comes from these entries"));
  assert.ok(!userText(withFacts).includes("site_facts is empty"));

  for (const over of [{}, { site_facts: [] }, { site_facts: null }] as Array<Partial<GeneratorInputs>>) {
    const none = await writerCall(inputs(over));
    assert.deepEqual(payloadOf(none).site_facts, []);
    assert.deepEqual(payloadOf(none).web_facts, []);
    assert.ok(userText(none).includes(`- site_facts is empty: say nothing about their website (what it has, lacks or does), and use a neutral subject that claims nothing ("an idea for [company]").`));
    assert.equal(sysText(none), sysText(withFacts), "one system prompt: no per-prospect text in it");
  }
  const es = await writerCall(inputs({}, "es"));
  assert.ok(userText(es).includes(`("una idea para [empresa]")`));
});

// ── The critic ───────────────────────────────────────────────────────────────

test("critic payload: the same proven site_facts and web_facts the writer had; the absence and the research evidence reach neither", async () => {
  const input = proveInputs(inputs({ site_facts: [BOOKING_ENGINE, NO_FORM] }), [JOB_POST]);
  const { critic, writer } = await criticCall(input);
  assert.deepEqual(payloadOf(critic).site_facts, payloadOf(writer).site_facts);
  assert.deepEqual(payloadOf(critic).web_facts, payloadOf(writer).web_facts);
  assert.deepEqual(payloadOf(critic).site_facts, [shown(BOOKING_ENGINE)]);
  assert.deepEqual(payloadOf(critic).pain_evidence, []);
  assert.ok(!userText(critic).includes(NO_FORM.fact) && !userText(critic).includes("no easy way to book a cabin"));
  const { critic: none } = await criticCall(inputs());
  assert.deepEqual(payloadOf(none).site_facts, []);
  assert.deepEqual(payloadOf(none).web_facts, []);
});

test("critic rule 1 (v3.5): shown is site_facts and web_facts; an unsupported claim, ANY absence however soft, a track-record line, and a 'what I noticed' subject with no site_facts are blocking", async () => {
  for (const lang of ["en", "es"] as const) {
    const sys = sysText((await criticCall(inputs({ site_facts: [BOOKING_ENGINE] }, lang))).critic);
    assert.ok(sys.includes("Shown means: prospect (what_they_do, tech_stack, industry, city), a site_facts entry or a web_facts entry, said in plain words."), lang);
    assert.ok(sys.includes(`"checked your site") that no site_facts entry or prospect field shows is blocking.`), lang);
    assert.ok(sys.includes("A sentence about them from anywhere else (reviews, news, hiring, a new location) that no web_facts entry shows is blocking."), lang);
    assert.ok(sys.includes(`ANY absence or lack is blocking, however softly said: "I didn't see", "I couldn't find", "no way to book online", "you don't have", "customers can't", "there's only", "without a way to".`), lang);
    assert.ok(sys.includes("Saying more than an entry says is blocking. A sentence that contradicts an entry is blocking."), lang);
    assert.ok(sys.includes("With site_facts and web_facts empty, any claim about them beyond prospect is blocking."), lang);
    assert.ok(sys.includes(`OUR TRACK RECORD: a sentence that says we work with, or have worked with, businesses of their kind ("we work with independent fitness studios", "we do this kind of work for clinics", "trabajamos con negocios de tu industria") is blocking`), lang);
    // The v3.4 allowance for a soft absence is gone.
    assert.ok(!sys.includes(`backed by an absence entry, is fine`), lang);
    assert.ok(!sys.includes(`of kind "absence"`), lang);
    assert.ok(sys.includes(`A subject saying we saw or noticed something on their site ("what I noticed on [company]'s site", "lo que vi en el sitio de [empresa]") when site_facts is empty is blocking.`), lang);
    // House facts: the new CTA, the old one gone.
    assert.ok(sys.includes(lang === "es" ? `The CTA's "mira lo que nuestra herramienta gratis encuentra en el sitio de [empresa]" wording is our set ask` : `The CTA's "see what our free check finds on [company]'s site" wording is our set ask`), lang);
    assert.ok(!sys.includes("where [the pain] is costing you") && !sys.includes("dónde [el dolor] te está costando"), lang);
    // Reason strings presend.ts reads are produced by code, not the prompt: unchanged (tests/presend-learning.test.ts).
  }
});

test("fake model: an absence, said flat ('you have no online booking') or soft ('I didn't see…'), is held by the critic's rule; the absence entry never reaches it", async () => {
  // Booking null: the crawler could not see, so siteFactsFrom gives no booking fact; the contact-form absence and the tap-to-call link did map.
  const TEL: SiteFact = { id: "tel", kind: "seen", fact: "Their phone number is a tap-to-call link", url: "https://www.hiddenacres.test/", strength: "strong" };
  const input = proveInputs(inputs({ site_facts: [NO_FORM, TEL] }), null);
  const claims = [
    "You have no online booking, so guests who find Hidden Acres at night can't reserve a cabin.",
    // The v3.4 soft wording, once allowed with an absence entry: blocking now.
    "I didn't see a way to book online on your site, so guests who find Hidden Acres at night may give up.",
  ];
  for (const line of claims) {
    const claim = `Hi Sarah,\n\nHenry from Runna Advertising here. ${line}\n\n👉 See what our free check finds on Hidden Acres' site, about 30 seconds: {hunter_url}\n\nHenry\nRunna Advertising`;
    const { critic, result } = await criticCall(input, claim, "an idea for hidden acres", {
      score: 0.6,
      issues: [{ issue: `'${line.split(",")[0]}': an absence, which no site_facts entry can show`, blocking: true }],
    });
    assert.deepEqual(payloadOf(critic).site_facts, [shown(TEL)], "neither a booking entry nor the absence reaches the critic");
    assert.ok(userText(critic).includes(line.split(",")[0]!));
    assert.ok(sysText(critic).includes(`ANY absence or lack is blocking, however softly said`));
    assert.ok(result.ok && result.critic && result.critic.pass === false, "the held verdict is kept");
  }
  // The send gate holds the soft wording in code too (absence_claim, tests/proven-claims-gate.test.ts).
  assert.notDeepEqual(findAbsenceClaims(claims[1]!), []);
});

// ── The showcase arm is pinned ───────────────────────────────────────────────

// sha256 (first 16 hex) of each showcase system prompt. A change here needs a
// SHOWCASE_PROMPT_VERSION bump.
// Re-pinned on purpose 2026-11-09 for showcase-v2 (proven facts): the opener
// "Most [industry] owners we talk to want to use AI…" claimed conversations we
// can't show and became "Small teams get a lot more done when the repetitive
// work runs on its own." The critic changed with it (its set framing, and no
// owner quotes as set wording), and its shared rules lost the research-quote
// "observed" wording and the "kind of work we do for businesses like theirs"
// house line. v1 pins: en 628a621f13737279/7b57bdd9f192f703, es/10
// bc086ee266c2257f/5e83538f516fc92b, es/300 e7be76ec447606cb/5e83538f516fc92b.
const SHOWCASE_SYSTEM = {
  "en/null": { writer: "bad197a670b8b595", critic: "74178657544df936" },
  "es/10": { writer: "0748b0ce8254379f", critic: "87d87357c6fe9d26" },
  "es/300": { writer: "2346529d71f68c8d", critic: "87d87357c6fe9d26" },
};
const hash = (s: string) => createHash("sha256").update(s).digest("hex").slice(0, 16);

test("showcase: writer and critic system prompts match their v2 pins; the opener claims no conversations; no site_facts in its payloads", async () => {
  assert.equal(SHOWCASE_PROMPT_VERSION, "showcase-v2-2026-11-09");
  for (const [lang, size] of [["en", null], ["es", 10], ["es", 300]] as const) {
    const calls = install((r) =>
      isCritic(r)
        ? JSON.stringify({ score: 0.95, issues: [] })
        : JSON.stringify({
            subject: "ai at x", preview_text: "a few tools we've built for businesses",
            body: "Hi Dana,\n\nHenry from Runna Advertising here. Small teams get a lot more done when the repetitive work runs on its own.\n\n👉 {hunter_url}\n\nHenry\nRunna Advertising",
            builds_used: ["b1"], pain_id: null, contact_email: "dana@x.ca", measurable_result_included: false, quality_self_score: 0.8, reasoning: "x", wanted_fact: null,
          }),
    );
    const r = await composeWithReview({
      prospect: { id: "p", company_name: "X", industry: "x", language: lang, employee_size_estimate: size, city: null, market: "CA", what_they_do: "x", tech_stack: [] },
      pains: [], contacts: [{ full_name: "Dana Reyes", email: "dana@x.ca", email_is_role_based: false, role_title: null }], case_studies: [], notable_clients: [], benchmarks: [],
      sender: { full_name: "Henry", tenant_display_name: "Runna" }, deep_pitch_url: "https://h/?r=a",
      showcase_builds: [{ id: "b1", for_whom: "a shop", does: "a map", how_it_works: "x", learns: false, universal: true }],
      site_facts: [BOOKING_ENGINE],
    } as GeneratorInputs, { deadline: Date.now() + 48_000 });
    assert.equal(r.ok, true);
    const key = `${lang}/${size}` as keyof typeof SHOWCASE_SYSTEM;
    const writer = calls.find((c) => !isCritic(c))!;
    const critic = calls.find(isCritic)!;
    assert.equal(hash(sysText(writer)), SHOWCASE_SYSTEM[key].writer, `${key} writer`);
    assert.equal(hash(sysText(critic)), SHOWCASE_SYSTEM[key].critic, `${key} critic`);
    assert.equal(payloadOf(writer).site_facts, undefined);
    assert.equal(payloadOf(critic).site_facts, undefined);
    // The opener it teaches claims nothing about conversations; the old one is held by the gate.
    const sys = sysText(writer);
    assert.ok(sys.includes(lang === "es" ? "Un equipo pequeño rinde mucho más cuando el trabajo repetitivo se hace solo." : "Small teams get a lot more done when the repetitive work runs on its own."), key);
    assert.deepEqual(findTrackRecordClaims(sys.split("FACTS: EVERYTHING COMES FROM THE PAYLOAD")[1]!.split("WORDS")[0]!), [], key);
    assert.ok(!sys.includes("we talk to") && !sys.includes("con los que hablamos") && !sys.includes("something you hear from owners"), key);
  }
  assert.notDeepEqual(findTrackRecordClaims("Most [industry] owners we talk to want to use AI but aren't sure where it would actually help."), []);
  assert.notDeepEqual(findTrackRecordClaims("La mayoría de los dueños de [industria] con los que hablamos quieren usar IA, pero no saben dónde les ayudaría de verdad."), []);
});

// ── Review fixes (#71): hook example, CTA naming, exemplars, template subject ─

test("writer: the hook example is a proven fact (a job post), an absence only as a NOT example; no 'only a phone number'; the CTA names '[company]'s site', never 'your site'", async () => {
  for (const [lang, size] of CASES) {
    const sys = sysText(await writerCall(inputs({}, lang, size)));
    const label = `${lang}/${size}`;
    // v3.5: the absence example that used to be the good hook is now what not to write.
    if (lang === "en") {
      assert.ok(sys.includes(`"I saw the job post for a second front-desk person" beats "I noticed an opportunity"`), label);
      assert.ok(sys.includes("NOT: I didn't see a way to book online on your site.\n  OK:  I saw the job post for a second front-desk person at [company]."), label);
    } else {
      assert.ok(sys.includes(`"Vi que están buscando una segunda persona para recepción" beats "Vi una oportunidad"`), label);
      assert.ok(sys.includes("NOT: No vi forma de agendar en línea en tu sitio.\n  OK:  Vi que [empresa] está buscando una segunda persona para recepción."), label);
    }
    assert.ok(!sys.includes(`"I didn't see a way to book online on your site" beats`) && !sys.includes(`"No vi forma de agendar en línea en tu sitio" beats`), label);
    assert.ok(!sys.includes("only a phone number") && !sys.includes("solo un teléfono"), label);
    assert.ok(sys.includes(`In the CTA, name the site as "[company]'s site" ("el sitio de [empresa]"), never "your site" / "tu sitio" / "su sitio"`), label);
  }
});

test("exemplars: their CTA, subject and site claims never carry over, for the writer and the critic", async () => {
  const exemplars = [{ pitch_id: "x1", score: 0.95, subject: "where [company] loses bookings", body: "Hi [name],\n\nYour site has no booking.\n\n👉 See where [the pain] is costing you: [link]\n\n[name]" }];
  const { critic, writer } = await criticCall(inputs({ exemplars, site_facts: [BOOKING_ENGINE] }));
  assert.ok(userText(writer).includes("Their CTA, subject and site claims never carry over."));
  assert.ok(userText(critic).includes("Their CTA and subject are no bar."));
});

test("industry template: the retail subject claims no loss", () => {
  const src = readFileSync(new URL("../lib/pitches/industry-templates.ts", import.meta.url), "utf8");
  assert.ok(!src.includes("what a scattered brand is costing {company}"));
  assert.ok(src.includes(`subject: "an idea for {company}",`));
});
