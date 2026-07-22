/**
 * Pre-send verification gate.
 *
 * Every fixture is a REAL failure that reached (or nearly reached) a live
 * prospect. If the gate can't catch these, it isn't worth trusting with
 * auto-send.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { evaluateSendGate, extractGreetedName, type GateInput } from "../lib/pitches/send-gate.ts";

/** A pitch that should pass everything — the baseline. */
function goodPitch(over: Partial<GateInput> = {}): GateInput {
  return {
    subject: "waghorn stephens: enquiries you're not catching",
    body:
      "Hi John,\n\n" +
      "Pedro from Runna here, we help Canadian law firms turn inquiry chaos into " +
      "qualified leads without adding headcount.\n\n" +
      "We'd build you a custom AI intake tool that screens and routes enquiries to " +
      "the right lawyer, so nothing sits overnight.\n\n" +
      "Worth a quick chat?\n\nPedro",
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
