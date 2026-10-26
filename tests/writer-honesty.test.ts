/**
 * Brief tasks/briefs/writer-honesty.md (calibration study of 30 failed v3.2
 * drafts): the writer states as fact only what was seen, the critic blocks
 * only unsupported claims about THIS business, greetings never invent a name
 * or team, a rewrite starts fresh (the stage side of that lives in
 * tests/pitch-rewrite-notes-stage.test.ts, with the normalizePains stage test).
 */

import assert from "node:assert/strict";
import test from "node:test";
import { __test__ } from "../lib/anthropic/client.ts";
import {
  PITCH_PROMPT_VERSION,
  addressContact,
  composePitchWithClaude,
  isAdviceQuote,
  painObserved,
} from "../lib/pitches/claude-composer.ts";
import { composeWithReview, criticVerdict } from "../lib/pitches/review.ts";
import { emailGreetingName, greetingName, isRoleInbox } from "../lib/pitches/greeting-name.ts";
import { scrubExemplar } from "../lib/pitches/exemplars.ts";
import type { GeneratorInputs } from "../lib/pitches/generator.ts";

process.env.ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY ?? "test-key";

type Req = { system?: { text: string }[] | string; messages: { content: string }[] };
const sysText = (r: Req) => (typeof r.system === "string" ? r.system : (r.system ?? []).map((b) => b.text).join("\n"));
const isCritic = (r: Req) => sysText(r).includes("You review a cold email");
const payloadOf = (r: Req) => JSON.parse(/```json\n([\s\S]*?)\n```/.exec(r.messages[0]!.content)![1]!) as Record<string, unknown>;

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

type Contact = GeneratorInputs["contacts"][number];
const person = (email: string, full_name: string | null = null, email_is_role_based = false): Contact => ({ full_name, email, email_is_role_based, role_title: null });

function inputs(over: Partial<GeneratorInputs> = {}, lang: "en" | "es" = "en", size = 10): GeneratorInputs {
  return {
    prospect: { id: "p", company_name: "ECOF Cabinets", industry: "cabinetry", language: lang, employee_size_estimate: size, city: "Calgary", market: "CA", what_they_do: "custom kitchen cabinets", tech_stack: [] },
    pains: [{ pain_id: "pain-1", pain_label: "Lead response time", evidence_quote: "contact form only, no online booking" }],
    contacts: [person("sarah@ecofcabinets.ca", "Sarah Lee")],
    case_studies: [],
    notable_clients: [],
    benchmarks: [],
    sender: { full_name: "Henry", tenant_display_name: "Runna Advertising" },
    deep_pitch_url: "https://runna-hunter.vercel.app/?market=ca",
    ...over,
  };
}

const BODY = "Hi Sarah,\n\nHenry from Runna Advertising here. Right now the only way to reach ECOF Cabinets online is a contact form.\n\n👉 Run ECOF Cabinets through our free check, about 30 seconds: {hunter_url}\n\nHenry\nRunna Advertising";
const answer = () =>
  JSON.stringify({
    subject: "contact form only at ecof",
    preview_text: "a contact form is the only way in after hours",
    body: BODY,
    pain_id: "pain-1",
    contact_email: "sarah@ecofcabinets.ca",
    measurable_result_included: false,
    quality_self_score: 0.8,
    reasoning: "x",
  });
const FWD_EN = "If you're not the right person for this, I'd really appreciate it if you could pass this along to whoever handles it.";

// ── 1. Writer prompt ──────────────────────────────────────────────────────────

test("writer prompt v3.3: the honesty rules are in every language and register", async () => {
  assert.equal(PITCH_PROMPT_VERSION, "pitch-v3.3-2026-10-26");
  for (const [lang, size] of [["en", 10], ["es", 10], ["es", 200]] as const) {
    const calls = install(() => answer());
    const r = await composePitchWithClaude(inputs({}, lang, size));
    assert.equal(r.ok, true);
    const sys = sysText(calls[0]!);
    const label = `${lang}/${size}`;
    // Only what was seen is an observation; observed: false is advice.
    assert.match(sys, /only what is visible on their site, in tech_stack or in what_they_do, and a pain_candidates evidence_quote marked observed: true/, label);
    assert.match(sys, /An evidence_quote marked observed: false reads as advice or opinion from our research/, label);
    assert.match(sys, /never turn it into an observation/, label);
    // Never claim to have checked how they handle enquiries.
    assert.match(sys, /never claim to have checked how they handle enquiries, calls or bookings, or how fast they answer/, label);
    // The cost line is about businesses in general.
    assert.match(sys, /it never says you, your, yours or the company's name \("clinics like yours lose patients"/, label);
    // A benchmark never stretches.
    assert.match(sys, /Never stretch a figure to another industry or past what it measured/, label);
    // The rules that used to be loose ("reads like a real given name") are gone.
    assert.doesNotMatch(sys, /reads like a real given name|parece un nombre real/, label);
    assert.ok(!sys.includes("Checked your store: nothing follows up"), label);
    assert.ok(!sys.includes("nadie le da seguimiento a quien se va sin comprar"), label);
    // The payload carries observed for each pain.
    assert.equal((payloadOf(calls[0]!).pain_candidates as Array<{ observed: unknown }>)[0]!.observed, true, label);
  }
});

test("writer prompt: the salutation is exact, in EN and both ES registers", async () => {
  const en = install(() => answer());
  await composePitchWithClaude(inputs());
  const enSys = sysText(en[0]!);
  assert.match(enSys, /1\. Salutation\. exactly "Hi \[address_contact\.first_name\]," when address_contact\.first_name is set\. When it is null, exactly "Hi \[company\] team," with the company_name\./);
  assert.match(enSys, /Never a name, team or department read from the email address, the full_name or the role \("Hi Manus,", "Hi admissions team,", "Hi Liaisons team,"\), never a single initial, never a bare "Hi,", never "Hi there,"/);

  for (const size of [10, 200]) {
    const es = install(() => answer());
    await composePitchWithClaude(inputs({}, "es", size));
    const sys = sysText(es[0]!);
    assert.match(sys, /Cuando es null, exactamente "Hola, equipo de \[empresa\]," con el company_name\./, `es/${size}`);
    assert.match(sys, /nunca una inicial sola, nunca "Hola," a secas, nunca "Hola there,"/, `es/${size}`);
  }
});

// ── 2. Critic prompt ──────────────────────────────────────────────────────────

async function criticOf(input: GeneratorInputs): Promise<Req> {
  const calls = install((r) => (isCritic(r) ? JSON.stringify({ score: 0.95, issues: [] }) : answer()));
  const r = await composeWithReview(input, { deadline: Date.now() + 48_000 });
  assert.equal(r.ok, true);
  return calls.find(isCritic)!;
}

test("critic prompt: blocks only claims about THIS business; general lines, our offer, benchmarks and house facts are not claims", async () => {
  for (const lang of ["en", "es"] as const) {
    const sys = sysText(await criticOf(inputs({}, lang)));
    // The rule.
    assert.ok(sys.includes("1. A sentence that states, about THIS business (it says you, your, yours or the company's name"), lang);
    assert.ok(sys.includes("A pain_evidence quote marked observed: false is our research's advice"), lang);
    assert.ok(sys.includes("A claim to have checked how they handle enquiries, calls or bookings, or how fast they answer, is always unsupported."), lang);
    // What it is not.
    assert.ok(sys.includes('a sentence about people or businesses in general (what tends to happen with this gap), with or without a hedge like "most" or "usually"'), lang);
    assert.ok(sys.includes("a sentence describing what we would build and what it would do (that is our offer;"), lang);
    assert.ok(sys.includes("a figure from payload.benchmarks cited for one of its for_pains (rule 2 decides that, it is not an inference)"), lang);
    // House facts.
    assert.ok(sys.includes("The one-sentence proof line about the kind of work we do for businesses like theirs is our own."), lang);
    assert.ok(sys.includes("The line asking to pass the email along to the right person is added by our code to role inboxes."), lang);
    assert.ok(sys.includes(lang === "es" ? 'The CTA\'s "dónde [el dolor] te está costando" wording' : 'The CTA\'s "where [the pain] is costing you" wording'), lang);
    // Subject never blocks; greeting; quote + field.
    // Subject: wording is polish, a claim in it is not (review #61, blocking 1).
    assert.ok(sys.includes("Subject wording (tone, phrasing, length, lower case) is polish, never blocking; a claim about this business, a statistic or a client name in the subject is judged by rules 1 and 2 like any body sentence."), lang);
    assert.ok(!sys.includes("Subject wording is always polish"), lang);
    // An offer sentence that also says what their site lacks is judged under rule 1.
    assert.ok(sys.includes(`if the same sentence also says what their site lacks or does today, as in "we'd add the live wait times your site is missing", judge that part under rule 1`), lang);
    // "yours" is about this business.
    assert.ok(sys.includes(`it says you, your, yours or the company's name, "clinics like yours" included`), lang);
    assert.ok(sys.includes('Never suggest "Hi there" or "Hola there".'), lang);
    assert.ok(sys.includes("Who the recipient is (a department inbox, maybe not the decision-maker) is not the writer's issue: never raise it."), lang);
    assert.ok(sys.includes(lang === "es" ? 'with first_name null it is "Hola, equipo de [company],"' : 'with first_name null it is "Hi [company] team,"'), lang);
    assert.ok(sys.includes("A blocking issue quotes the sentence it is about and names the payload field that would have to show it"), lang);
    // Stretching a benchmark is still rule 2.
    assert.ok(sys.includes("stretched past what it measured (a clinic figure presented as true of spas or hotels"), lang);
  }
});

test("critic payload: observed per pain, and the writer's own first_name and role answer for the recipient", async () => {
  const input = inputs({
    pains: [
      { pain_id: "pain-1", pain_label: "Website", evidence_quote: "Replace outdated WordPress with a site that shows live wait times" },
      { pain_id: "pain-2", pain_label: "Lead response time", evidence_quote: "contact form only, no online booking" },
    ],
    contacts: [person("ecof@ecofcabinets.ca")],
  });
  const critic = payloadOf(await criticOf(input));
  assert.deepEqual(
    (critic.pain_evidence as Array<{ pain_id: string; observed: boolean }>).map((p) => [p.pain_id, p.observed]),
    [["pain-1", false], ["pain-2", true]],
  );
  assert.deepEqual(critic.recipient, { name: null, first_name: null, email: "ecof@ecofcabinets.ca", role_based: false });
});

test("criticVerdict is unchanged: any blocking issue fails and caps the score at 0.79 (the governor's reason strings key on pass and score)", () => {
  const v = criticVerdict({ score: 0.9, issues: [{ issue: "'Your site doesn't show live wait times': pain_evidence is observed: false", blocking: true }] });
  assert.equal(v.pass, false);
  assert.equal(v.score, 0.79);
  const ok = criticVerdict({ score: 0.9, issues: [{ issue: "subject could be shorter", blocking: false }] });
  assert.equal(ok.pass, true);
  assert.deepEqual(ok.issues, ["(polish) subject could be shorter"]);
});

// ── 3. Evidence: seen, or advice ──────────────────────────────────────────────

test("isAdviceQuote: recommendation quotes (EN + ES) are advice; real site quotes are not", () => {
  const advice = [
    "Replace outdated WordPress with modern platform featuring live wait times, mobile-optimized",
    "Build chatbots for 24/7 inquiry handling",
    "Implement online booking so patients can self-schedule",
    "Add a live chat widget to the homepage",
    "Create a mobile-friendly landing page for each service",
    "Use automated follow-ups for every web enquiry",
    "Migrate the store to a faster platform",
    "Consider adding online ordering",
    "The site should show prices for each service",
    "Clinic needs to answer enquiries faster",
    "We recommend a booking widget",
    "- Upgrade the contact form to capture phone numbers",
    "Implementar un chatbot para atender consultas 24/7",
    "Agregar reservaciones en línea",
    "Crear una página de servicios para celular",
    "Migrar el sitio a una plataforma más rápida",
    "El sitio debería mostrar los horarios",
    "Se recomienda agregar un botón de WhatsApp",
    "Considere un sistema de citas en línea",
    // Review #61.
    "El sitio debe mostrar precios",
    "Deben agregar un formulario de citas",
    "Sugerimos un botón de WhatsApp",
    "Recomendamos reservaciones en línea",
    "The homepage needs a clear call to action",
    "A booking widget is needed",
    "Offer online booking for new patients",
    "Enable live chat on the contact page",
    "Launch an email newsletter for repeat customers",
    "A faster site would be better for mobile visitors",
    "Online booking would help reduce phone calls",
  ];
  const seen = [
    "contact form only, no online booking",
    "Call us at 403-555-0100 to book your appointment",
    "We are open Monday to Friday, 9 to 5",
    "Add to cart button sits below the fold on mobile",
    "Use of an outdated jQuery version (1.8)",
    "Book now",
    "Start your free trial today",
    "no abandoned cart email flow detected on checkout",
    "Solo formulario de contacto, sin reservaciones en línea",
    "Llámanos al 55 1234 5678 para agendar tu cita",
    "Crea tu cuenta para ver tus pedidos",
    "Horario: lunes a viernes de 9 a 18 h",
    // Review #61: a verb followed by the business itself is the site's own copy.
    "Use our online form to request a quote",
    "Consider us for your next kitchen renovation",
    "Leverage our 30 years of experience",
    "Utilizar nuestro formulario para cotizar",
    "Agregar al carrito",
    "Añadir al carrito",
    "Need a quote? Call us today",
  ];
  // The company's own name after the verb is site copy too.
  assert.equal(isAdviceQuote("Consider ECOF Cabinets for your next kitchen", "ECOF Cabinets"), false);
  assert.equal(isAdviceQuote("Consider ECOF Cabinets for your next kitchen"), true, "without the company name it reads as advice");
  for (const q of advice) assert.equal(isAdviceQuote(q), true, `advice: ${q}`);
  for (const q of seen) assert.equal(isAdviceQuote(q), false, `seen: ${q}`);
  assert.equal(isAdviceQuote(null), false);
  assert.equal(isAdviceQuote(""), false);
});

test("painObserved: the stage's mark wins; an unmarked pain is classified", () => {
  assert.equal(painObserved({ pain_id: "a", pain_label: "x", evidence_quote: "Build chatbots for 24/7 inquiry handling" }), false);
  assert.equal(painObserved({ pain_id: "a", pain_label: "x", evidence_quote: "contact form only" }), true);
  assert.equal(painObserved({ pain_id: "a", pain_label: "x", evidence_quote: "contact form only", observed: false }), false);
});

test("the writer prefers an observed pain for the solution hint, and an advice pain stays in the payload (not dropped)", async () => {
  const calls = install(() => answer());
  await composePitchWithClaude(inputs({
    pains: [
      { pain_id: "pain-web", pain_label: "Outdated website", evidence_quote: "Replace outdated WordPress with a mobile-optimized site" },
      { pain_id: "pain-cart", pain_label: "abandoned_cart recovery", evidence_quote: "no abandoned cart email flow detected on checkout" },
    ],
  }));
  const p = payloadOf(calls[0]!);
  assert.deepEqual((p.pain_candidates as Array<{ pain_id: string; observed: boolean }>).map((c) => [c.pain_id, c.observed]), [["pain-web", false], ["pain-cart", true]]);
  assert.match(String(p.solution_hint), /reaching back out to everyone who added things and left/);
});

// ── 4. Greetings ──────────────────────────────────────────────────────────────

test("greetingName: the study's failures greet no one; real names are unchanged", () => {
  // Study failures.
  assert.equal(greetingName(null, "manus-sales@acme.com", false), null, "manus-sales@ is the sales inbox");
  assert.equal(greetingName(null, "ecof@ecofcabinets.ca", false, "ECOF Cabinets"), null, "ecof@ is the company");
  assert.equal(greetingName(null, "ecof@example.com", false, "ECOF Cabinets"), null, "contained in the company name");
  assert.equal(greetingName(null, "ecof@ecofcabinets.ca", false), null, "contained in the domain's first label");
  assert.notEqual(greetingName(null, "pparker@acme.com", false), "P");
  assert.equal(greetingName(null, "pparker@acme.com", false), null);
  assert.equal(greetingName("P. Parker", "pparker@acme.com", false), null, "an initial is not a name");
  assert.equal(greetingName("P", "p@acme.com", false), null);
  // Department inboxes: role-based, no name.
  for (const e of [
    "reginfo@sfu.ca", "library@ucw.ca", "ucwlibrary@ucw.ca", "customersupport@x.ca", "communications@x.ca",
    "assistance@x.ca", "informes@x.mx", "reservaciones@x.mx", "or.international@x.ca",
    "liaisons_internationales@x.ca", "ceo@x.ca", "admissions@x.ca", "registrar@x.ca",
  ]) {
    assert.equal(isRoleInbox(e), true, `role: ${e}`);
    assert.equal(greetingName(null, e, false), null, `no name: ${e}`);
  }
  // Unchanged.
  assert.equal(greetingName(null, "john.sipos@waglaw.net", false), "John");
  assert.equal(greetingName(null, "miguel@tacos.mx", false), "Miguel");
  assert.equal(greetingName("Sarah Lee", "info@ecofcabinets.ca", true), "Sarah", "a real full_name wins, role inbox or not");
  assert.equal(greetingName("María José Pérez", null, false), "María");
  assert.equal(greetingName("O'Brien", null, false), "O'Brien");
  assert.equal(greetingName(null, "vfournier@law.ca", false), null);
  assert.equal(isRoleInbox("john.sipos@waglaw.net"), false);
  assert.equal(isRoleInbox("pparker@acme.com"), false);
  // Review #61: a full_name that is the company's own name greets no one; a real name inside a company name still greets.
  assert.equal(greetingName("ECOF Cabinets", "ecof@ecofcabinets.ca", false, "ECOF Cabinets"), null);
  assert.equal(greetingName("ECOF", "sales@ecofcabinets.ca", true, "ECOF Cabinets"), null);
  assert.equal(greetingName("Sarah Lee", "sarah@sarahsbakery.ca", false, "Sarah's Bakery"), "Sarah");
  assert.equal(emailGreetingName("ana.lopez@clinica.mx"), "Ana");
});

test("the writer's address_contact and the critic's recipient agree, from the recipient (first usable), with role inboxes flagged", () => {
  const ac = addressContact(inputs({ contacts: [person("not-an-email"), person("reginfo@sfu.ca"), person("john.sipos@sfu.ca", "John Sipos")] }));
  assert.deepEqual(ac, { first_name: null, full_name: null, email: "reginfo@sfu.ca", role_title: null, role_based: true });
});

test("forwarding line: follows the recipient, not 'the first person anywhere in the list'", async () => {
  // info@ is the recipient; a person below it used to suppress the line.
  let calls = install(() => answer());
  let r = await composePitchWithClaude(inputs({ contacts: [person("info@ecofcabinets.ca", null, true), person("sarah@ecofcabinets.ca", "Sarah Lee")] }));
  assert.equal(r.ok && r.result.composed.body.split(FWD_EN).length - 1, 1);
  // A department inbox the contact row did not flag still gets it.
  calls = install(() => answer());
  r = await composePitchWithClaude(inputs({ contacts: [person("reginfo@sfu.ca")] }));
  assert.equal(r.ok && r.result.composed.body.split(FWD_EN).length - 1, 1);
  // A person as the recipient: no line, even with a role inbox listed below.
  calls = install(() => answer());
  r = await composePitchWithClaude(inputs({ contacts: [person("sarah@ecofcabinets.ca", "Sarah Lee"), person("info@ecofcabinets.ca", null, true)] }));
  assert.equal(r.ok && r.result.composed.body.includes(FWD_EN), false);
  // Review #61: ceo@/owner@/director@ … reach the decision-maker: team greeting, no forwarding line.
  for (const e of ["ceo@ecofcabinets.ca", "owner@ecofcabinets.ca", "director@ecofcabinets.ca", "president@ecofcabinets.ca", "manager@ecofcabinets.ca"]) {
    assert.equal(addressContact(inputs({ contacts: [person(e)] }))?.first_name, null, e);
    install(() => answer());
    r = await composePitchWithClaude(inputs({ contacts: [person(e)] }));
    assert.equal(r.ok && r.result.composed.body.includes(FWD_EN), false, e);
  }
  calls = install(() => answer());
  r = await composePitchWithClaude(inputs({ contacts: [person("sarah@ecofcabinets.ca", "Sarah Lee"), person("info@ecofcabinets.ca", null, true)] }));
  assert.equal(r.ok && r.result.composed.body.includes(FWD_EN), false);
  assert.equal(calls.length, 1);
});

test("exemplar scrubber agrees with the greeting: a company-name local part is scrubbed as the company, never left as a greeted name", () => {
  const out = scrubExemplar("Hi ECOF Cabinets team,\n\nWe looked at ECOF's site.", {
    company_name: "ECOF Cabinets", city: null, recipient_name: null, recipient_email: "ecof@ecofcabinets.ca", domain: "ecofcabinets.ca", website_url: null,
  } as Parameters<typeof scrubExemplar>[1]);
  assert.doesNotMatch(out, /ecof/i);
});
