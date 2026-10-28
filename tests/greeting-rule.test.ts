/**
 * greeting-rule (batch 10): a pitch never greets a "name" built from a word in
 * the address. Prod 2026-10-28 wrote "Hola Cursos," (cursos@), "Hi Care,"
 * (care@) and "Hi Nfo,". One rule (greeting-name.ts greetingName) decides the
 * name; the writer uses it and the send gate checks against the same call.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { greetingName } from "../lib/pitches/greeting-name.ts";
import { evaluateSendGate, extractGreetedName, type GateInput } from "../lib/pitches/send-gate.ts";

const TAIL =
  "\n\nHenry from Runna Advertising here. We help clinics answer every enquiry without adding staff.\n\n" +
  "We'd build you a simple assistant that replies to new enquiries right away, so nothing sits overnight.\n\n" +
  "Worth a look?\n\nHenry\nRunna Advertising";

function gateInput(email: string, greeting: string, over: Partial<GateInput> = {}): GateInput {
  const domain = email.split("@")[1] ?? "acme.ca";
  return {
    subject: "evening enquiries",
    body: `${greeting}${TAIL}`,
    lang: "en",
    recipientEmail: email,
    recipientFullName: null,
    recipientSelectedBy: "scraper",
    companyName: "Acme Dental",
    siteName: null,
    domain,
    websiteVerified: true,
    evidenceQuotes: [],
    ...over,
  };
}

/** Greeting codes only: the other rules are not under test here. */
function greetingCodes(input: GateInput): string[] {
  const r = evaluateSendGate(input);
  return r.pass ? [] : r.failures.map((f) => f.code).filter((c) => c.startsWith("greeting"));
}

test("acceptance 1: address words are no name; the gate refuses them as greetings", () => {
  for (const email of ["cursos@acme.mx", "care@acme.ca", "nfo@acme.ca", "reservas2@acme.mx", "hola.mx@acme.mx"]) {
    assert.equal(greetingName(null, email, false), null, email);
  }
  assert.deepEqual(greetingCodes(gateInput("cursos@acme.mx", "Hola Cursos,", { lang: "es" })), ["greeting_not_a_name"]);
  assert.deepEqual(greetingCodes(gateInput("care@acme.ca", "Hi Care,")), ["greeting_not_a_name"]);
  assert.deepEqual(greetingCodes(gateInput("nfo@acme.ca", "Hi Nfo,")), ["greeting_not_a_name"]);
  // The team greeting stays valid on every one of them.
  assert.deepEqual(greetingCodes(gateInput("cursos@acme.mx", "Hola, equipo de Acme Dental,", { lang: "es" })), []);
  assert.deepEqual(greetingCodes(gateInput("care@acme.ca", "Hi Acme Dental team,")), []);
});

test("acceptance 2: the negative set is unchanged", () => {
  assert.equal(greetingName(null, "john.sipos@waglaw.net", false), "John");
  assert.equal(greetingName(null, "miguel@saucedoa.com", false), "Miguel");
  assert.equal(greetingName(null, "ana.lopez@clinica.mx", false), "Ana");
  assert.equal(greetingName(null, "vfournier@julien-cormier.ca", false), null);
  assert.equal(greetingName(null, "manus-sales@acme.com", false), null);
  assert.equal(greetingName(null, "ecof@ecofcabinets.ca", false, "ECOF Cabinets"), null);
  assert.notEqual(greetingName(null, "pparker@acme.com", false), "P");
  // A stored full_name greets its first token exactly as before, any address.
  assert.equal(greetingName("Sarah Lee", "care@acme.ca", true), "Sarah");
  assert.equal(greetingName("Cursos Ruiz", "cursos@acme.mx", false), "Cursos");
  // The gate's stored-name branch: any token of the stored name, nothing else.
  assert.deepEqual(greetingCodes(gateInput("care@acme.ca", "Hi Sarah,", { recipientFullName: "Sarah Lee" })), []);
  assert.deepEqual(greetingCodes(gateInput("care@acme.ca", "Hi Lee,", { recipientFullName: "Sarah Lee" })), []);
  assert.deepEqual(greetingCodes(gateInput("care@acme.ca", "Hi Mark,", { recipientFullName: "Sarah Lee" })), ["greeting_mismatch"]);
  // Writer and gate agree on the negative set.
  assert.deepEqual(greetingCodes(gateInput("john.sipos@waglaw.net", "Hi John,")), []);
  assert.deepEqual(greetingCodes(gateInput("miguel@saucedoa.com", "Hola Miguel,", { lang: "es" })), []);
  assert.deepEqual(greetingCodes(gateInput("ana.lopez@clinica.mx", "Hola Ana,", { lang: "es" })), []);
  assert.deepEqual(greetingCodes(gateInput("vfournier@julien-cormier.ca", "Hi Fournier,")), ["greeting_not_a_name"]);
  assert.deepEqual(greetingCodes(gateInput("manus-sales@acme.com", "Hi Manus,")), ["greeting_not_a_name"]);
  assert.deepEqual(greetingCodes(gateInput("ecof@ecofcabinets.ca", "Hi Ecof,", { companyName: "ECOF Cabinets" })), ["greeting_not_a_name"]);
  assert.deepEqual(greetingCodes(gateInput("pparker@acme.com", "Hi P,")), ["greeting_not_a_name"]);
  // Severities are unchanged: both are review.
  const r = evaluateSendGate(gateInput("care@acme.ca", "Hi Care,"));
  assert.equal(r.pass ? null : r.failures.find((f) => f.code === "greeting_not_a_name")?.severity, "review");
  const m = evaluateSendGate(gateInput("john.sipos@waglaw.net", "Hi Sipos,"));
  assert.equal(m.pass ? null : m.failures.find((f) => f.code === "greeting_mismatch")?.severity, "review");
});

test("listed names greet alone or with a separator; weak word-names never; Mexican short forms are names", () => {
  // Conductor on #65: names a dictionary also carries greet alone too.
  for (const [email, name] of [["juan@acme.mx", "Juan"], ["carmen@cgc.mx", "Carmen"], ["maria@acme.mx", "Maria"], ["pedro@acme.mx", "Pedro"]] as const) {
    assert.equal(greetingName(null, email, false), name, email);
  }
  for (const email of ["cursos@acme.mx", "nfo@acme.ca", "care@acme.ca"]) assert.equal(greetingName(null, email, false), null, email);
  assert.equal(greetingName(null, "juan.perez@acme.mx", false), "Juan");
  assert.equal(greetingName(null, "rosa.flores@acme.mx", false), "Rosa");
  assert.equal(greetingName(null, "carmen.ruiz@cgc.mx", false), "Carmen");
  assert.equal(greetingName(null, "care.team@acme.ca", false), null, "a weak word-name never greets");
  for (const [email, name] of [["memo@acme.mx", "Memo"], ["chema@acme.mx", "Chema"], ["toño@acme.mx", "Toño"]] as const) {
    assert.equal(greetingName(null, email, false), name, email);
  }
  assert.equal(greetingName(null, "tono@acme.mx", false), null, "tono is a word; toño is Antonio");
});

// 30 addresses with no greetable name, then 20 given-name addresses.
const NO_NAME = [
  "cursos@acme.mx", "care@acme.ca", "nfo@acme.ca", "reservas2@acme.mx", "hola.mx@acme.mx", "info@acme.ca",
  "ventas@acme.mx", "manus-sales@acme.com", "ecof@ecofcabinets.ca", "vfournier@julien-cormier.ca",
  "pparker@acme.com", "rgjulien@julien-cormier.ca", "calgauthier@gmail.com", "reginfo@sfu.ca",
  "library@ucw.ca", "customersupport@acme.ca", "servicios@acme.mx", "contabilidad@acme.mx", "recursos@acme.mx",
  "ayudas@acme.mx", "talleres@acme.mx", "pedidos@acme.mx", "citas@acme.mx", "clinica@acme.mx",
  "facturas@acme.mx", "hello@acme.ca", "office@acme.ca", "care.team@acme.ca", "tono@acme.mx", "abc@acme.ca",
];
const GIVEN = [
  "miguel@saucedoa.com", "ana.lopez@clinica.mx", "john.sipos@waglaw.net", "carmen.ruiz@cgc.mx",
  "rosa.flores@acme.mx", "memo@acme.mx", "chema@acme.mx", "toño@acme.mx", "alexandra.ruiz@acme.ca",
  "sergio@acme.ca", "sofia@acme.mx", "javier@acme.mx", "oscar@acme.mx", "lucia.perez@acme.mx",
  "jorge.ramirez@acme.mx", "elena@acme.mx", "emilio@acme.mx", "valeria.cruz@acme.mx", "xin@acme.ca",
  "juan@acme.mx",
];

test("acceptance 3 (property): the gate passes exactly the greeting greetingName produces, or the team", () => {
  assert.equal(NO_NAME.length + GIVEN.length, 50);
  const company = (email: string) => (email.startsWith("ecof@") ? "ECOF Cabinets" : "Acme Dental");
  for (const email of NO_NAME) assert.equal(greetingName(null, email, false, company(email)), null, `no name: ${email}`);
  for (const email of GIVEN) assert.notEqual(greetingName(null, email, false, company(email)), null, `a name: ${email}`);

  const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
  for (const email of [...NO_NAME, ...GIVEN]) {
    const over = { companyName: company(email) };
    const expected = greetingName(null, email, false, company(email));
    // Team greeting: always fine.
    assert.deepEqual(greetingCodes(gateInput(email, `Hi ${company(email)} team,`, over)), [], `team: ${email}`);
    if (expected) assert.deepEqual(greetingCodes(gateInput(email, `Hi ${expected},`, over)), [], `own name: ${email}`);
    // Any other name fails. Candidates are drawn independently of the rule:
    // every piece of the local part (what the old gate's substring check let
    // through), plus fixed names from elsewhere.
    const local = (email.split("@")[0] ?? "").split(/[._\-+]/).filter((p) => /^\p{L}+$/u.test(p));
    for (const other of [...local.map(cap), "Mark", "Sofia", "Cursos"]) {
      if (expected && other.toLowerCase() === expected.toLowerCase()) continue;
      // "Hi Hola," reads as no name at all to the gate's greeting parser.
      if (extractGreetedName(`Hi ${other},`) === null) continue;
      const codes = greetingCodes(gateInput(email, `Hi ${other},`, over));
      assert.equal(codes.length, 1, `${email} greeted "${other}": ${JSON.stringify(codes)}`);
      assert.equal(codes[0], expected ? "greeting_mismatch" : "greeting_not_a_name", `${email} greeted "${other}"`);
    }
  }
});
