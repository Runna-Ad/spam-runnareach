/**
 * Pre-send verification gate.
 *
 * Every fixture is a REAL failure that reached (or nearly reached) a live
 * prospect. If the gate can't catch these, it isn't worth trusting with
 * auto-send.
 */

import assert from "node:assert/strict";
import test from "node:test";
import {
  GATE_SEVERITY,
  evaluateSendGate,
  namesAgree,
  extractGreetedName,
  gateAllows,
  type GateInput,
} from "../lib/pitches/send-gate.ts";
import { renderIndustryTemplate } from "../lib/pitches/industry-templates.ts";
import { buildFollowup1, buildFollowup2 } from "../lib/pitches/followup-templates.ts";
import { senderForGenerator, senderSignature } from "../lib/pitches/sender-identity.ts";
import type { GeneratorInputs } from "../lib/pitches/generator.ts";

/** A pitch that should pass everything — the baseline. */
function goodPitch(over: Partial<GateInput> = {}): GateInput {
  return {
    subject: "who answers waghorn stephens at night?",
    body:
      "Hi John,\n\n" +
      "Henry from Runna Advertising here. We help Canadian law firms answer every " +
      "enquiry without adding staff.\n\n" +
      "We'd build you a simple assistant that replies to new enquiries right away and " +
      "passes each one to the right lawyer, so nothing sits overnight.\n\n" +
      "Worth a chat?\n\nHenry\nRunna Advertising",
    lang: "en",
    recipientEmail: "john.sipos@waglaw.net",
    recipientFullName: null,
    recipientSelectedBy: "scraper",
    companyName: "Waghorn Stephens",
    siteName: "Waghorn Stephens Sipos and Poulton",
    domain: "waglaw.net",
    websiteVerified: true,
    evidenceQuotes: ["Small practice in St. Marys accepting walk-ins, no appointment needed"],
    ...over,
  };
}

const codes = (r: ReturnType<typeof evaluateSendGate>) =>
  r.pass ? [] : r.failures.map((f) => f.code);

test("passes a clean, fully-grounded pitch", () => {
  assert.equal(evaluateSendGate(goodPitch()).pass, true);
});

test("holds the Waghorn bug: greets a different person than the recipient", () => {
  const r = evaluateSendGate(
    goodPitch({ body: goodPitch().body.replace("Hi John,", "Hi Mark,") }),
  );
  assert.equal(r.pass, false);
  assert.ok(codes(r).includes("greeting_mismatch"));
});

test("holds a greeting that contradicts a KNOWN recipient name", () => {
  const r = evaluateSendGate(
    goodPitch({
      recipientFullName: "John Sipos",
      body: goodPitch().body.replace("Hi John,", "Hi Mark,"),
    }),
  );
  assert.ok(codes(r).includes("greeting_mismatch"));
});

test("holds the Acadian bug: asserts a website we never fetched", () => {
  const r = evaluateSendGate(
    goodPitch({
      websiteVerified: false,
      domain: null,
      body:
        "Hi John,\n\nChecked your website and it looks like it's down, which means " +
        "every enquiry is going nowhere. We'd rebuild it properly.\n\nPedro",
    }),
  );
  assert.equal(r.pass, false);
  assert.ok(codes(r).includes("unverifiable_website_claim"));
});

test("allows a website claim when the site WAS verified", () => {
  const r = evaluateSendGate(
    goodPitch({
      websiteVerified: true,
      body:
        "Hi John,\n\nChecked your website, the contact form takes three screens on " +
        "a phone. We'd cut that to one so enquiries actually land.\n\nPedro",
    }),
  );
  assert.equal(r.pass, true);
});

test("holds an unusable recipient (glued-domain address)", () => {
  const r = evaluateSendGate(
    goodPitch({ recipientEmail: "julien-cormier.cavfournier@julien-cormier.ca" }),
  );
  assert.ok(codes(r).includes("unusable_email"));
});

test("holds a guessed catch-all address — never auto-send a guess", () => {
  const r = evaluateSendGate(
    goodPitch({ recipientSelectedBy: "snapverify_catchall_guess" }),
  );
  assert.equal(r.pass, false);
  assert.ok(codes(r).includes("unverified_recipient"));
});

test("holds a name greeting sent to a role inbox", () => {
  const r = evaluateSendGate(
    goodPitch({
      recipientEmail: "info@waglaw.net",
      recipientSelectedBy: "hunter",
      body: goodPitch().body.replace("Hi John,", "Hi Miguel,"),
    }),
  );
  assert.ok(codes(r).includes("greeting_not_a_name"));
});

test("holds when the stored company name contradicts the site's own name", () => {
  const r = evaluateSendGate(
    goodPitch({ companyName: "Acadianlogworks", siteName: "Northern Timber Homes" }),
  );
  assert.ok(codes(r).includes("company_name_unverified"));
});

test("tolerates benign company-name variants", () => {
  assert.equal(
    evaluateSendGate(goodPitch({ companyName: "Waghorn Stephens", siteName: "Waghorn Stephens Inc." })).pass,
    true,
  );
});

test("holds an invented metric with no supporting evidence", () => {
  const r = evaluateSendGate(
    goodPitch({
      body:
        "Hi John,\n\nWe did this for another Ontario firm and cut their no-shows by 40% " +
        "in six weeks. Same playbook would work here.\n\nWorth a chat?\n\nPedro",
    }),
  );
  assert.equal(r.pass, false);
  assert.ok(codes(r).includes("unsourced_metric"));
});

test("allows a metric that appears in stored evidence", () => {
  const r = evaluateSendGate(
    goodPitch({
      evidenceQuotes: ["Their booking page reports a 40% no-show rate"],
      body:
        "Hi John,\n\nYour booking page is running a 40% no-show rate, which is pure lost " +
        "billable time. We'd automate the reminders.\n\nWorth a chat?\n\nPedro",
    }),
  );
  assert.equal(r.pass, true);
});

test("team greetings are not treated as a person's name", () => {
  assert.equal(extractGreetedName("Hi Waghorn Stephens team,\n\nBody here."), null);
  assert.equal(extractGreetedName("Hola equipo de Julien & Cormier,\n\nCuerpo."), null);
  assert.equal(extractGreetedName("Hi there,\n\nBody."), null);
  assert.equal(extractGreetedName("Hi John,\n\nBody."), "John");
  assert.equal(extractGreetedName("Hola Miguel,\n\nCuerpo."), "Miguel");
});

test("a team greeting passes the gate (always safe)", () => {
  const r = evaluateSendGate(
    goodPitch({
      recipientEmail: "vfournier@julien-cormier.ca",
      recipientSelectedBy: "scraper",
      companyName: "Julien & Cormier",
      siteName: "Julien & Cormier",
      domain: "julien-cormier.ca",
      body: goodPitch().body.replace("Hi John,", "Hi Julien & Cormier team,"),
    }),
  );
  assert.equal(r.pass, true);
});

test("reports EVERY reason, not just the first", () => {
  const r = evaluateSendGate(
    goodPitch({
      recipientEmail: "filler@godaddy.com",
      websiteVerified: false,
      domain: null,
      body: "Hi Mark,\n\nChecked your website and it's clearly costing you 30% of enquiries. " +
        "We'd rebuild it.\n\nPedro",
    }),
  );
  assert.equal(r.pass, false);
  const c = codes(r);
  assert.ok(c.includes("unusable_email"));
  assert.ok(c.includes("unverifiable_website_claim"));
  assert.ok(c.length >= 2, "gate must surface all problems so one review fixes everything");
});

// ── Benchmarks make rule 5 enforceable rather than absolute ─────────────────
//
// Rule 5 holds any number not found in stored evidence. Before the benchmark
// library existed, nothing was a legitimate source for a statistic, so the rule
// was a blanket ban on numbers — which is why the composer's invented "20-30%
// lifts" had nowhere legitimate to come from in the first place.

test("holds a number that matches neither evidence nor a benchmark", () => {
  const r = evaluateSendGate(goodPitch({
    body: "Hi Waghorn Stephens team,\n\nCasino properties that differentiate see 20-30% lifts in visit intent.\n\nPedro",
    evidenceQuotes: [],
    benchmarkFigures: [],
  }));
  assert.equal(r.pass, false);
  assert.ok(!r.pass && r.failures.some((f) => f.code === "unsourced_metric"));
});

test("allows a number backed by a verified benchmark", () => {
  const r = evaluateSendGate(goodPitch({
    body: "Hi Waghorn Stephens team,\n\nRoughly 70% of online carts are abandoned before checkout, and nothing follows up.\n\nPedro",
    evidenceQuotes: [],
    benchmarkFigures: ["70%"],
  }));
  assert.ok(!(!r.pass && r.failures.some((f) => f.code === "unsourced_metric")));
});

test("a benchmark for a DIFFERENT figure does not launder an invented one", () => {
  // The allowlist is per-figure, not a blanket "numbers are fine now".
  const r = evaluateSendGate(goodPitch({
    body: "Hi Waghorn Stephens team,\n\nBusinesses like yours see 45% more repeat orders.\n\nPedro",
    evidenceQuotes: [],
    benchmarkFigures: ["70%"],
  }));
  assert.equal(r.pass, false);
  assert.ok(!r.pass && r.failures.some((f) => f.code === "unsourced_metric"));
});

test("omitting benchmarkFigures entirely still works (back-compat)", () => {
  const r = evaluateSendGate(goodPitch({
    body: "Hi Waghorn Stephens team,\n\nA clean note with no numbers at all.\n\nPedro",
    evidenceQuotes: [],
  }));
  assert.ok(!(!r.pass && r.failures.some((f) => f.code === "unsourced_metric")));
});

// ── Gate v2 (2026-10-16) ─────────────────────────────────────────────────────

const has = (r: ReturnType<typeof evaluateSendGate>, code: string) => (codes(r) as string[]).includes(code);
const withBody = (body: string, over: Partial<GateInput> = {}) =>
  evaluateSendGate(goodPitch({ body, ...over }));
const BODY_TAIL = "\n\nWorth a chat?\n\nHenry\nRunna Advertising";

test("v2: checks EVERY number, not just the first (v1's blind spot)", () => {
  // v1 matched only the first number: a sourced "3" let "20-30%" through.
  const r = withBody(
    "Hi John,\n\nYour contact form takes 3 screens on a phone, and that's probably costing you 20-30% of inbound requests." + BODY_TAIL,
    { evidenceQuotes: ["contact form takes 3 screens on mobile"] },
  );
  assert.ok(has(r, "unsourced_metric"));
  assert.match(JSON.stringify(r), /20/);
});

test("v2: numbers in the SUBJECT are checked too", () => {
  const r = evaluateSendGate(goodPitch({ subject: "waghorn stephens: 3 things i'd fix this week" }));
  assert.ok(has(r, "unsourced_metric"));
});

test("v2: spelled-out multiples need a source", () => {
  assert.ok(has(withBody("Hi John,\n\nFirms that answer first are seven times more likely to win the client." + BODY_TAIL), "unsourced_metric"));
  assert.ok(has(withBody("Hola Juan,\n\nSiete de cada diez clientes se van sin respuesta, y eso cuesta." + BODY_TAIL, { lang: "es" }), "unsourced_metric"));
});

test("v2: Rünna's own facts, the CTA link and the company name are not claims", () => {
  const r = withBody(
    "Hi John,\n\nWe've spent 12 years on this. The free check takes about 30 seconds, no signup, and a 20-minute chat after is optional.\n\n" +
      "👉 See it for yourself: https://runna-hunter.vercel.app/?market=ca&v=1&size=25\n\nHenry\nRunna Advertising",
    { companyName: "43 North Waghorn", siteName: null },
  );
  assert.ok(!has(r, "unsourced_metric"), JSON.stringify(r));
  const named = withBody("Hi John,\n\nAt 43 North Waghorn the phones ring after hours and nobody picks up." + BODY_TAIL, {
    companyName: "43 North Waghorn",
    siteName: null,
  });
  assert.ok(!has(named, "unsourced_metric"));
});

test("v2: a verified benchmark's statistic text is a source", () => {
  const r = withBody(
    "Hi John,\n\nWhen researchers contacted 500 law firms, only 33% replied to the email. Most enquiries just wait." + BODY_TAIL,
    { benchmarkFigures: ["33%", "When researchers posed as prospective clients and contacted 500 law firms, only 33% replied to the email"] },
  );
  assert.ok(!has(r, "unsourced_metric"), JSON.stringify(r));
});

test("v2: never a client name (block), matched case-sensitively", () => {
  const clientNames = ["DiDi", "El Club", "Lila", "Ford", "SnapPad"];
  const named = withBody("Hi John,\n\nWe did exactly this for DiDi and it worked." + BODY_TAIL, { clientNames });
  assert.ok(has(named, "client_name"));
  assert.equal(GATE_SEVERITY.client_name, "block");
  // Ordinary words and first names that happen to be client names.
  const ordinary = withBody(
    "Hola Lila,\n\nVi que el club de golf tiene reservas solo por teléfono, y muchos se quedan sin respuesta." + BODY_TAIL.replace("Worth a chat?", "¿Platicamos?"),
    { clientNames, lang: "es", recipientEmail: "lila@club.mx", recipientFullName: "Lila Ortiz" },
  );
  assert.ok(!has(ordinary, "client_name"), JSON.stringify(ordinary));
  // A Ford dealer talking about Ford is about them, not a client brag.
  const dealer = withBody("Hi John,\n\nYour Ford customers book service by phone only, and the line is busy at lunch." + BODY_TAIL, {
    clientNames,
    companyName: "Calgary Ford Dealers",
    siteName: null,
  });
  assert.ok(!has(dealer, "client_name"));
  // "afford" is not "Ford".
  assert.ok(!has(withBody("Hi John,\n\nMost firms can't afford to miss an enquiry at night." + BODY_TAIL, { clientNames }), "client_name"));
});

test("v2: internal product names are blocked", () => {
  const r = withBody("Hi John,\n\nWe built S.P.A.M., an AI prospecting platform, for ourselves." + BODY_TAIL);
  assert.ok(has(r, "internal_name"));
});

test("v2: jargon and em dashes are review-level flags", () => {
  const r = withBody("Hi John,\n\nWe'd build an intake tool that sends you qualified leads — automatically." + BODY_TAIL);
  assert.ok(has(r, "banned_jargon"));
  assert.ok(has(r, "em_dash"));
  assert.equal(GATE_SEVERITY.banned_jargon, "review");
  assert.equal(GATE_SEVERITY.em_dash, "review");
});

test("v2: bracket placeholders copied from the prompt are blocked", () => {
  assert.ok(has(withBody("Hi John,\n\nRun [company] through our free check and see where [the pain] is costing you." + BODY_TAIL), "unresolved_placeholder"));
  assert.ok(has(withBody("Hola,\n\nCorre [empresa] en la herramienta y mira dónde [el dolor] te cuesta." + BODY_TAIL, { lang: "es" }), "unresolved_placeholder"));
});

test("v2: formal Spanish greetings are checked (v1 never saw them)", () => {
  assert.equal(extractGreetedName("Estimado Lic. García,\n\nCuerpo."), "García");
  assert.equal(extractGreetedName("Estimada Dra. Ana Ruiz,\n\nCuerpo."), "Ana Ruiz");
  assert.equal(extractGreetedName("Dear Ms. Lee,\n\nBody."), "Lee");
  assert.equal(extractGreetedName("Hola, equipo de Clínica Sur,\n\nCuerpo."), null);
  const es = { lang: "es" as const, recipientEmail: "jgarcia@despacho.mx", recipientSelectedBy: "scraper" };
  const ok = withBody("Estimado Lic. García,\n\nSoy Nils, de Runna Advertising. Vi que su despacho solo recibe consultas por teléfono." + BODY_TAIL, {
    ...es,
    recipientFullName: "Juan García",
  });
  assert.ok(!has(ok, "greeting_mismatch"), JSON.stringify(ok));
  const wrong = withBody("Estimado Lic. García,\n\nSoy Nils, de Runna Advertising. Vi que su despacho solo recibe consultas por teléfono." + BODY_TAIL, {
    ...es,
    recipientFullName: "Juan Pérez",
  });
  assert.ok(has(wrong, "greeting_mismatch"));
  const merge = withBody("Estimado/a Juan,\n\nSoy Nils, de Runna Advertising, con una idea para su despacho." + BODY_TAIL, {
    ...es,
    recipientFullName: "Juan García",
  });
  assert.ok(has(merge, "greeting_mismatch"));
});

test("v2: 'Checked acme.com' is a website claim (v1 missed the domain form)", () => {
  const r = withBody("Hi John,\n\nChecked waglaw.net: there's no way to book a consult online." + BODY_TAIL, {
    websiteVerified: false,
  });
  assert.ok(has(r, "unverifiable_website_claim"));
});

test("v2: follow-ups skip provenance but not the usable-email check", () => {
  const r = evaluateSendGate(goodPitch({ recipientSelectedBy: "snapverify_catchall_guess", checkRecipientSource: false }));
  assert.ok(!has(r, "unverified_recipient"));
  const bad = evaluateSendGate(goodPitch({ recipientEmail: "nobody", checkRecipientSource: false }));
  assert.ok(has(bad, "unusable_email"));
});

test("gateAllows: block never passes; review passes only for accepted codes", () => {
  const review = evaluateSendGate(goodPitch({ recipientSelectedBy: "snapverify_catchall_guess" }));
  assert.equal(gateAllows(review).ok, false);
  assert.equal(gateAllows(review, ["unverified_recipient"]).ok, true);
  // Accepting one flag doesn't accept a different one that appeared later.
  const twoFlags = evaluateSendGate(
    goodPitch({ recipientSelectedBy: "snapverify_catchall_guess", body: goodPitch().body.replace("right away", "right away — fast") }),
  );
  assert.equal(gateAllows(twoFlags, ["unverified_recipient"]).ok, false);
  // A block-level code can't be accepted, even if someone sends it.
  const block = withBody("Hi John,\n\nWe did this for DiDi." + BODY_TAIL, { clientNames: ["DiDi"] });
  assert.equal(gateAllows(block, ["client_name"]).ok, false);
  assert.equal(gateAllows(evaluateSendGate(goodPitch())).ok, true);
});

test("every gate code has a severity", () => {
  const all = Object.keys(GATE_SEVERITY);
  assert.ok(all.length >= 15);
  for (const sev of Object.values(GATE_SEVERITY)) assert.ok(sev === "block" || sev === "review");
});

// ── Our own templates must pass the gate ──────────────────────────────────────
// If a template we wrote fails, every fallback pitch is held. Rendered for
// every industry bucket in both languages.

test("industry fallback templates pass the content rules in both languages", () => {
  const industries = ["hotel", "beach club", "villa", "ecommerce", "restaurant", "real estate", "law", "retail", "automotive", "dental", "plumbing"];
  for (const lang of ["en", "es"] as const) {
    for (const industry of industries) {
      const input: GeneratorInputs = {
        prospect: { id: "p", company_name: "Casa Norte", industry, language: lang, employee_size_estimate: null, city: null, market: null, what_they_do: null, tech_stack: [] },
        pains: [], contacts: [], case_studies: [], notable_clients: [], benchmarks: [],
        sender: senderForGenerator(lang),
        deep_pitch_url: `https://runna-hunter.vercel.app/?market=${lang === "es" ? "mx" : "ca"}`,
      };
      const p = renderIndustryTemplate(input, "test");
      const r = evaluateSendGate({
        subject: p.subject, body: p.body, lang,
        recipientEmail: "info@casanorte.mx", recipientFullName: null, recipientSelectedBy: "scraper",
        companyName: "Casa Norte", siteName: null, domain: "casanorte.mx", websiteVerified: true,
        evidenceQuotes: [], benchmarkFigures: [], clientNames: ["DiDi", "El Club", "Lila", "Ford"],
      });
      assert.ok(r.pass, `${lang}/${industry}: ${JSON.stringify(r)}`);
    }
  }
});

test("follow-up fallback templates pass the content rules in both languages", () => {
  for (const lang of ["en", "es"] as const) {
    for (const painLabel of [null, "online booking"]) {
      for (const build of [buildFollowup1, buildFollowup2]) {
        const e = build({
          prospectName: "Casa Norte", contactName: "Ana", originalSubject: "una idea para casa norte",
          painLabel: lang === "en" ? painLabel : null, lang, signature: senderSignature(lang),
        });
        const r = evaluateSendGate({
          subject: e.subject, body: e.body, lang,
          recipientEmail: "ana@casanorte.mx", recipientFullName: "Ana López", recipientSelectedBy: null,
          companyName: "Casa Norte", siteName: null, domain: "casanorte.mx", websiteVerified: true,
          evidenceQuotes: [], benchmarkFigures: [], clientNames: ["DiDi"], checkRecipientSource: false,
        });
        assert.ok(r.pass, `${lang}/${build.name}/${painLabel}: ${JSON.stringify(r)}`);
      }
    }
  }
});

// ── False positives found replaying 60 real sent emails (2026-10-16) ────────

test("v2: times of day, B2B-style codes and ordinals are not quantity claims", () => {
  const r = withBody(
    "Hi John,\n\nSomeone looking for help at 10pm, or after 6 p.m. on a Friday, finds only a B2B contact form on your 2nd page." + BODY_TAIL,
  );
  assert.ok(!has(r, "unsourced_metric"), JSON.stringify(r));
  // "copy-pasted three times" is a count of something seen, not a multiplier.
  assert.ok(!has(withBody("Hi John,\n\nThe same contact form is copy-pasted three times on the page." + BODY_TAIL), "unsourced_metric"));
  // …while an invented multiplier still is.
  assert.ok(has(withBody("Hi John,\n\nFirms like yours are three times more likely to win when they answer fast." + BODY_TAIL), "unsourced_metric"));
});

test("v2: research-summary facts count as sources, whatever the number format", () => {
  const r = withBody(
    "Hi John,\n\nFor a 4-site network serving 44,000 residents, a phone-only front door is a lot of missed calls." + BODY_TAIL,
    { evidenceQuotes: ["Multi-site rural hospital network serving 4 communities; ~400 staff serving 44K residents"] },
  );
  assert.ok(!has(r, "unsourced_metric"), JSON.stringify(r));
});

test("v2: company-name check compares distinctive words", () => {
  assert.equal(namesAgree("Woodbine Hotel & Suites", "Welcome to Woodbine"), true);
  assert.equal(namesAgree("Amsted Design-Build", "amsted.ca"), true);
  assert.equal(namesAgree("Estética Orozco Hermanos", "OrozcoHnos"), true);
  assert.equal(namesAgree("Hospitals", "Rural Roads Health Services"), false);
  assert.equal(namesAgree("Dynamic Source Manufacturing", "Contract Electronics Manufacturing"), false);
  assert.equal(namesAgree("Acadianlogworks", "Northern Timber Homes"), false);
});


// ── Sourced benchmarks (Pedro, 2026-10-16) ───────────────────────────────────

test("a pitch quoting a seeded benchmark passes; a near-miss figure does not", () => {
  const bench = [
    "42 hours",
    "Among companies that did reply to a web enquiry, the average first response took 42 hours (Harvard Business Review audit of 2,241 US companies).",
    "Harvard Business Review (Oldroyd, McElheran, Elkington)",
  ];
  const ok = withBody(
    "Hi John,\n\nA Harvard Business Review audit of 2,241 companies found the average reply to a web enquiry took 42 hours. Yours sit until Monday." + BODY_TAIL,
    { benchmarkFigures: bench },
  );
  assert.ok(!has(ok, "unsourced_metric"), JSON.stringify(ok));
  const drift = withBody("Hi John,\n\nThe average reply to a web enquiry takes 48 hours, and yours sit until Monday." + BODY_TAIL, { benchmarkFigures: bench });
  assert.ok(has(drift, "unsourced_metric"));
});

test("a number from the prospect's own name passes even when the name is shortened", () => {
  const r = evaluateSendGate(goodPitch({
    subject: "43 north: who answers after close",
    body: "Hi 43 North team,\n\nHenry from Runna Advertising here. Reservations at your venues go by phone only, so late requests wait until morning." + BODY_TAIL,
    companyName: "43 North Restaurant Group",
    siteName: null,
  }));
  assert.ok(!has(r, "unsourced_metric"), JSON.stringify(r));
});
