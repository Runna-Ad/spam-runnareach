/**
 * Brief tasks/briefs/site-facts-writer.md, the writer and the critic (pitch
 * v3.4): site_facts reach both, as one list; only a site fact is something
 * seen on their site; an absence only from an absence entry, said as "I didn't
 * see"; no site_facts, no site claim; the CTA and the subject stop claiming a
 * loss. The showcase arm is untouched (its prompts are pinned byte for byte).
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

const writerAnswer = (body: string, subject = "an idea for hidden acres") =>
  JSON.stringify({
    subject,
    preview_text: "a quick idea about the cabins and how guests reach you",
    body,
    pain_id: "pain-1",
    contact_email: "sarah@hiddenacres.test",
    measurable_result_included: false,
    quality_self_score: 0.8,
    reasoning: "x",
  });
const BODY = "Hi Sarah,\n\nHenry from Runna Advertising here. I had a look at Hidden Acres and the treehouse cabins.\n\n👉 See what our free check finds on Hidden Acres' site, about 30 seconds: {hunter_url}\n\nHenry\nRunna Advertising";

async function writerCall(input: GeneratorInputs): Promise<Req> {
  const calls = install(() => writerAnswer(BODY));
  const r = await composePitchWithClaude(input);
  assert.equal(r.ok, true);
  return calls[0]!;
}

async function criticCall(input: GeneratorInputs, body = BODY, subject?: string, verdict = { score: 0.95, issues: [] as unknown[] }) {
  const calls = install((r) => (isCritic(r) ? JSON.stringify(verdict) : writerAnswer(body, subject)));
  const r = await composeWithReview(input, { deadline: Date.now() + 48_000, maxRevisions: 0 });
  assert.equal(r.ok, true);
  return { critic: calls.find(isCritic)!, writer: calls.find((c) => !isCritic(c))!, result: r };
}

const CASES = [["en", 10], ["es", 10], ["es", 200]] as const;

// ── The writer ───────────────────────────────────────────────────────────────

test("writer v3.4: site_facts is the only source for a website claim; absence only from an absence entry, said as 'I didn't see'", async () => {
  assert.equal(PITCH_PROMPT_VERSION, "pitch-v3.4-2026-10-30");
  for (const [lang, size] of CASES) {
    const sys = sysText(await writerCall(inputs({ site_facts: [BOOKING_ENGINE] }, lang, size)));
    const label = `${lang}/${size}`;
    assert.ok(sys.includes("What you may state as something you saw: a site_facts entry, what_they_do, tech_stack, and a pain_candidates evidence_quote marked observed: true."), label);
    assert.ok(sys.includes("It is the ONLY source for anything you say about their website"), label);
    assert.ok(sys.includes(`kind "absence": we read those pages and it was not there; say it as what you didn't see ("I didn't see a way to book online on your site"), never as a fact about them ("you have no online booking", "customers can't book", "there's no way to book")`), label);
    assert.ok(sys.includes("An absence comes ONLY from an absence entry"), label);
    assert.ok(sys.includes(`strength "weak": say it softly`), label);
    assert.ok(sys.includes(`"no tap-to-call link" is not "no phone number"`), label);
    assert.ok(sys.includes("When site_facts is empty, make no claim about their website at all, whatever pain_candidates say: lead with what_they_do and a general pattern about businesses like theirs."), label);
    // The lodge case: a pain about the site that a site fact contradicts loses.
    assert.ok(sys.includes("the site fact wins: lead with another pain"), label);
    // Site-fact figures are not FACTS 2 numbers (the send gate would hold them).
    assert.ok(sys.includes("A number in a site fact (a year, a score, a rating) is not one FACTS 2 allows"), label);
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

test("writer payload: site_facts as given (id, kind, fact, url, strength); the system prompt is the same with or without them (cached)", async () => {
  const withFacts = await writerCall(inputs({ site_facts: [BOOKING_ENGINE, NO_FORM] }));
  assert.deepEqual(payloadOf(withFacts).site_facts, [BOOKING_ENGINE, NO_FORM]);
  assert.ok(userText(withFacts).includes("- site_facts: everything you say about their website comes from these entries"));
  assert.ok(!userText(withFacts).includes("site_facts is empty"));

  for (const over of [{}, { site_facts: [] }, { site_facts: null }] as Array<Partial<GeneratorInputs>>) {
    const none = await writerCall(inputs(over));
    assert.deepEqual(payloadOf(none).site_facts, []);
    assert.ok(userText(none).includes(`- site_facts is empty: say nothing about their website (what it has, lacks or does), and use a neutral subject that claims nothing ("an idea for [company]").`));
    assert.equal(sysText(none), sysText(withFacts), "one system prompt: no per-prospect text in it");
  }
  const es = await writerCall(inputs({}, "es"));
  assert.ok(userText(es).includes(`("una idea para [empresa]")`));
});

// ── The critic ───────────────────────────────────────────────────────────────

test("critic payload: the same site_facts the writer had", async () => {
  const input = inputs({ site_facts: [BOOKING_ENGINE, NO_FORM] });
  const { critic, writer } = await criticCall(input);
  assert.deepEqual(payloadOf(critic).site_facts, payloadOf(writer).site_facts);
  assert.deepEqual(payloadOf(critic).site_facts, [BOOKING_ENGINE, NO_FORM]);
  const { critic: none } = await criticCall(inputs());
  assert.deepEqual(payloadOf(none).site_facts, []);
});

test("critic rule 1: shown includes site_facts; an unsupported site claim, an absence without an absence entry, and a 'what I noticed' subject with no site_facts are blocking", async () => {
  for (const lang of ["en", "es"] as const) {
    const sys = sysText((await criticCall(inputs({ site_facts: [BOOKING_ENGINE] }, lang))).critic);
    assert.ok(sys.includes("Shown means: prospect (what_they_do, tech_stack, industry, city), a site_facts entry, or a pain_evidence quote marked observed: true, said in plain words."), lang);
    assert.ok(sys.includes("that no site_facts entry or prospect field shows is blocking; a pain_evidence quote alone does not show it."), lang);
    assert.ok(sys.includes(`is blocking unless a site_facts entry of kind "absence" (or a seen entry that says "only") supports it`), lang);
    assert.ok(sys.includes(`"I didn't see a way to book online on your site", backed by an absence entry, is fine.`), lang);
    assert.ok(sys.includes("A sentence that contradicts a site_facts entry (no online booking when an entry shows a booking button) is blocking."), lang);
    assert.ok(sys.includes("With site_facts empty, any claim about their website is blocking."), lang);
    assert.ok(sys.includes(`A subject saying we saw or noticed something on their site ("what I noticed on [company]'s site", "lo que vi en el sitio de [empresa]") when site_facts is empty is blocking.`), lang);
    // House facts: the new CTA, the old one gone.
    assert.ok(sys.includes(lang === "es" ? `The CTA's "mira lo que nuestra herramienta gratis encuentra en el sitio de [empresa]" wording is our set ask` : `The CTA's "see what our free check finds on [company]'s site" wording is our set ask`), lang);
    assert.ok(!sys.includes("where [the pain] is costing you") && !sys.includes("dónde [el dolor] te está costando"), lang);
    // Reason strings presend.ts reads are produced by code, not the prompt: unchanged (tests/presend-learning.test.ts).
  }
});

test("fake model: 'you have no online booking' for a prospect whose booking is null (no booking fact) is held by the critic's rule", async () => {
  // Booking null: the crawler could not see, so siteFactsFrom gives no booking fact; other checks did map.
  const input = inputs({ site_facts: [NO_FORM] });
  const claim = "Hi Sarah,\n\nHenry from Runna Advertising here. You have no online booking, so guests who find Hidden Acres at night can't reserve a cabin.\n\n👉 See what our free check finds on Hidden Acres' site, about 30 seconds: {hunter_url}\n\nHenry\nRunna Advertising";
  const { critic, result } = await criticCall(input, claim, "what i noticed on hidden acres' site", {
    score: 0.6,
    issues: [{ issue: "'You have no online booking': no site_facts entry of kind absence shows it", blocking: true }],
  });
  const facts = payloadOf(critic).site_facts as SiteFact[];
  assert.ok(!facts.some((f) => f.id === "booking"), "no booking entry reaches the critic");
  assert.ok(userText(critic).includes("You have no online booking"));
  const sys = sysText(critic);
  assert.ok(sys.includes(`An absence ("no way to book online", "you don't have", "customers can't", "there's only") is blocking unless a site_facts entry of kind "absence"`));
  assert.ok(sys.includes(`stating it as a fact about them ("you have no online booking") instead of what we didn't see is blocking even then`));
  assert.ok(result.ok && result.critic && result.critic.pass === false, "the held verdict is kept");
});

// ── The showcase arm is untouched ────────────────────────────────────────────

// sha256 (first 16 hex) of each showcase system prompt, taken on the base
// branch before this change. A change here needs a SHOWCASE_PROMPT_VERSION bump.
const SHOWCASE_SYSTEM = {
  "en/null": { writer: "628a621f13737279", critic: "7b57bdd9f192f703" },
  "es/10": { writer: "bc086ee266c2257f", critic: "5e83538f516fc92b" },
  "es/300": { writer: "e7be76ec447606cb", critic: "5e83538f516fc92b" },
};
const hash = (s: string) => createHash("sha256").update(s).digest("hex").slice(0, 16);

test("showcase: writer and critic system prompts are byte-identical to before; no site_facts in its payloads", async () => {
  assert.equal(SHOWCASE_PROMPT_VERSION, "showcase-v1-2026-10-29");
  for (const [lang, size] of [["en", null], ["es", 10], ["es", 300]] as const) {
    const calls = install((r) =>
      isCritic(r)
        ? JSON.stringify({ score: 0.95, issues: [] })
        : JSON.stringify({
            subject: "ai at x", preview_text: "a few tools we've built for businesses",
            body: "Hi Dana,\n\nHenry from Runna Advertising here. Most shops we talk to want to use AI but are not sure where it would help them.\n\n👉 {hunter_url}\n\nHenry\nRunna Advertising",
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
  }
});

// ── Review fixes (#71): hook example, CTA naming, exemplars, template subject ─

test("writer: the hook example ends at 'on your site' (no 'only a phone number'); the CTA names '[company]'s site', never 'your site'", async () => {
  for (const [lang, size] of CASES) {
    const sys = sysText(await writerCall(inputs({}, lang, size)));
    const label = `${lang}/${size}`;
    assert.ok(sys.includes(lang === "en" ? `"I didn't see a way to book online on your site" beats` : `"No vi forma de agendar en línea en tu sitio" beats`), label);
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
