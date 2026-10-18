import assert from "node:assert/strict";
import test from "node:test";
import { __test__ } from "../lib/anthropic/client.ts";
import type { OutcomeEvent } from "../lib/learning/reward.ts";
import type { Segment } from "../lib/learning/segments.ts";
import { composeWithReview } from "../lib/pitches/review.ts";
import type { GeneratorInputs } from "../lib/pitches/generator.ts";
import {
  EXEMPLAR_PROMPT_VERSION,
  criticExemplarSection,
  decisionExemplarFields,
  exemplarLeaks,
  scrubExemplar,
  selectExemplars,
  shortlistCandidates,
  toExemplar,
  writerExemplarSection,
  type ExemplarCandidate,
  type ExemplarTarget,
} from "../lib/pitches/exemplars.ts";

process.env.ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY ?? "test-key";

// ── Selector fixtures ─────────────────────────────────────────────────────────

const NOW = new Date("2026-10-17T12:00:00Z");
const daysAgo = (d: number) => new Date(NOW.getTime() - d * 86_400_000).toISOString();

const LEGAL_CA: Segment = { industry: "legal", market: "ca", size: "small" };
const TARGET: ExemplarTarget = { segment: LEGAL_CA, lang: "en", prospect_id: "p-target" };

const scan = (d: number): OutcomeEvent => ({ type: "audit_scan", at: daysAgo(d), payload: { stage: "scan" } });
const reply = (d: number, intent: string): OutcomeEvent => ({ type: "reply", at: daysAgo(d), payload: { intent } });
const sent = (d: number): OutcomeEvent => ({ type: "sent", at: daysAgo(d), payload: null });

let seq = 0;
function cand(over: Partial<ExemplarCandidate & { events: OutcomeEvent[] }> = {}): ExemplarCandidate & { events: OutcomeEvent[] } {
  seq++;
  const sentDays = 30;
  return {
    pitch_id: `pitch-${seq}`,
    prospect_id: `prospect-${seq}`,
    parent_pitch_id: null,
    status: "sent",
    sent_at: daysAgo(sentDays),
    lang: "en",
    industry: "Law firm",
    market: "CA",
    recipient_email: `owner${seq}@firm${seq}.ca`,
    critic_pass: true,
    gate_overridden: false,
    events: [sent(sentDays), reply(sentDays - 2, "wants_meeting")],
    ...over,
  };
}

const pick = (cs: Array<ExemplarCandidate & { events: OutcomeEvent[] }>, opts = {}) =>
  selectExemplars(cs, TARGET, { now: NOW, ...opts }).map((p) => p.pitch_id);

// ── Selector ──────────────────────────────────────────────────────────────────

test("segment match beats score: a same-market scan outranks an other-market meeting request", () => {
  const otherMarket = cand({ market: "MX" }); // score 1, tier 2
  const sameMarket = cand({ events: [sent(30), scan(25)] }); // score 0.5, tier 1
  const r = selectExemplars([otherMarket, sameMarket], TARGET, { now: NOW, max: 1 });
  assert.deepEqual(r.map((p) => p.pitch_id), [sameMarket.pitch_id]);
  assert.equal(r[0]!.score, 0.5);
  assert.equal(r[0]!.tier, 1);
});

test("score ≥ 0.5 threshold: a scan qualifies, a not-now reply and silence do not", () => {
  const scanned = cand({ events: [sent(30), scan(28)] });
  const notNow = cand({ events: [sent(30), reply(28, "not_now")] });
  const silent = cand({ events: [sent(30)] });
  assert.deepEqual(pick([notNow, silent, scanned]), [scanned.pitch_id]);
});

test("at most 2, best score first, ties newest first", () => {
  const older = cand({ sent_at: daysAgo(60), events: [sent(60), reply(58, "wants_meeting")] });
  const newer = cand({ sent_at: daysAgo(20), events: [sent(20), reply(18, "wants_meeting")] });
  const middle = cand({ sent_at: daysAgo(40), events: [sent(40), reply(38, "wants_meeting")] });
  const lower = cand({ sent_at: daysAgo(15), events: [sent(15), reply(14, "wants_info")] }); // 0.9
  assert.deepEqual(pick([older, lower, newer, middle]), [newer.pitch_id, middle.pitch_id]);
  assert.equal(pick([older, lower, newer, middle], { max: 5 }).length, 4);
});

test("excludes follow-ups, unsettled sends, failed-critic, gate overrides and test addresses", () => {
  const good = cand();
  const followUp = cand({ parent_pitch_id: "root-1" });
  const unsettled = cand({ sent_at: daysAgo(13), events: [sent(13), reply(12, "wants_meeting")] });
  const failedCritic = cand({ critic_pass: false });
  const neverReviewed = cand({ critic_pass: null });
  const overridden = cand({ gate_overridden: true });
  const toTest = cand({ recipient_email: "pedro.jr22+demo@gmail.com" });
  const testEvents = cand({ events: [{ type: "sent", at: daysAgo(30), payload: { test: true } }, reply(28, "wants_meeting")] });
  const draft = cand({ status: "approved" });
  const isTest = (e: string | null) => Boolean(e && e.replace(/\+.*@/, "@").replace(/\./g, "").startsWith("pedrojr22@"));
  const r = pick([followUp, unsettled, failedCritic, overridden, toTest, testEvents, draft, neverReviewed, good], {
    isTestAddress: isTest,
    max: 10,
  });
  assert.deepEqual(r.sort(), [good.pitch_id, neverReviewed.pitch_id].sort());
});

test("excludes bounces, opt-outs, a hard no, and the prospect being pitched", () => {
  const bounced = cand({ events: [sent(30), { type: "bounce", at: daysAgo(30) }] });
  const optOut = cand({ events: [sent(30), scan(29), { type: "unsubscribe", at: daysAgo(28) }] });
  const hardNo = cand({ events: [sent(30), scan(29), reply(28, "hard_no")] });
  const self = cand({ prospect_id: "p-target" });
  assert.deepEqual(pick([bounced, optOut, hardNo, self]), []);
});

test("language never crosses, even in the same industry and market", () => {
  const es = cand({ lang: "es", market: "CA", industry: "abogados" });
  assert.deepEqual(pick([es]), []);
  const esTarget: ExemplarTarget = { segment: LEGAL_CA, lang: "es" };
  assert.deepEqual(selectExemplars([es], esTarget, { now: NOW }).map((p) => p.pitch_id), [es.pitch_id]);
});

test("fallback order: industry + market, then industry in any market, then none", () => {
  const sameBoth = cand();
  const sameIndustry = cand({ market: "MX" });
  const otherIndustry = cand({ industry: "dental clinic" });
  assert.deepEqual(pick([otherIndustry, sameIndustry, sameBoth]), [sameBoth.pitch_id, sameIndustry.pitch_id]);
  assert.deepEqual(pick([otherIndustry, sameIndustry]), [sameIndustry.pitch_id]);
  assert.deepEqual(pick([otherIndustry]), []);
  assert.deepEqual(pick([]), []);
});

test("an unclassified ('other') prospect gets no exemplars", () => {
  const other: ExemplarTarget = { segment: { industry: "other", market: "ca", size: "small" }, lang: "en" };
  const c = cand({ industry: "something unclassifiable" });
  assert.deepEqual(selectExemplars([c], other, { now: NOW }), []);
});

test("one exemplar per business; a pitch from before pitch_events still scores from sent_at", () => {
  const a = cand({ prospect_id: "same" });
  const b = cand({ prospect_id: "same", sent_at: daysAgo(31) });
  assert.equal(pick([a, b]).length, 1);
  const legacy = cand({ events: [scan(25)] }); // no "sent" row
  assert.deepEqual(pick([legacy]), [legacy.pitch_id]);
});

test("shortlist: eligible only, tier 1 first, newest first, capped", () => {
  const t2 = cand({ market: "MX", sent_at: daysAgo(15) });
  const t1old = cand({ sent_at: daysAgo(90) });
  const t1new = cand({ sent_at: daysAgo(20) });
  const fresh = cand({ sent_at: daysAgo(2) });
  const s = shortlistCandidates([t2, t1old, fresh, t1new], TARGET, { now: NOW });
  assert.deepEqual(s.map((c) => c.pitch_id), [t1new.pitch_id, t1old.pitch_id, t2.pitch_id]);
  assert.equal(shortlistCandidates([t2, t1old, t1new], TARGET, { now: NOW, limit: 1 }).length, 1);
});

// ── Scrubber ──────────────────────────────────────────────────────────────────

const WAG = {
  company_name: "Wagner Legal Group Inc.",
  domain: "waglaw.net",
  recipient_name: "John Sipos",
  recipient_email: "john.sipos@waglaw.net",
  city: "Calgary",
};

test("scrubber: name, company, domain and digits are replaced", () => {
  const body =
    "Hi John,\n\nHenry from Runna Advertising here. Wagner Legal Group takes intake by phone, and waglaw.net has a form that asks 14 questions. Firms see 3.5x more consults when someone answers within 5 minutes, John Sipos.\n\nEmail john.sipos@waglaw.net or call 403-555-0199.\n\n👉 Run Wagner Legal Group through our free check, about 30 seconds: https://runna-hunter.vercel.app/?d=waglaw.net&r=ab23cd45\n\nHenry\nRunna Advertising";
  const out = scrubExemplar(body, WAG);
  for (const leak of ["John", "Sipos", "Wagner", "waglaw", "14", "3.5", "403", "555", "30", "ab23", "https://"]) {
    assert.ok(!out.includes(leak), `leaked ${leak}: ${out}`);
  }
  assert.doesNotMatch(out, /\d/);
  assert.match(out, /^Hi \[name\],/);
  assert.match(out, /\[company\] takes intake by phone, and \[site\] has a form that asks \[n\] questions/);
  assert.match(out, /\[n\]x more consults/);
  assert.match(out, /👉 Run \[company\] through our free check, about \[n\] seconds: \{hunter_url\}$/m);
  // Our own sign-off is not the prospect's and stays.
  assert.match(out, /Henry\nRunna Advertising$/);
  assert.equal(scrubExemplar("quick question about wagner legal group's intake", WAG), "quick question about [company]'s intake");
});

test("scrubber: an email with none of them comes back unchanged", () => {
  const clean = "Hi there,\n\nA question about how new clients reach you after hours.\n\nHenry\nRunna Advertising";
  assert.equal(scrubExemplar(clean, WAG), clean);
  assert.equal(scrubExemplar(clean, { company_name: null, domain: null, recipient_name: null }), clean);
});

test("scrubber: Spanish accents survive and name particles never eat prose", () => {
  const p = { company_name: "Clínica Dental Sonrisa S.A. de C.V.", domain: "sonrisa.mx", recipient_name: "José Luis de la Peña" };
  const body =
    "Hola José,\n\nSoy Nils de Runna Advertising. En la Clínica Dental Sonrisa la única forma de agendar es por teléfono, y después de las 8 de la noche nadie contesta. ¿Cuántos pacientes se van así? Jose Luis Peña lo sabrá mejor que nadie.\n\nNils\nRunna Advertising";
  const out = scrubExemplar(body, p);
  assert.match(out, /^Hola \[name\],/);
  assert.ok(out.includes("En la [company] la única forma de agendar es por teléfono"), out);
  assert.ok(out.includes("después de las [n] de la noche nadie contesta. ¿Cuántos pacientes se van así?"), out);
  assert.ok(out.includes("[name] lo sabrá mejor que nadie"), out);
  assert.ok(out.includes("Soy Nils de Runna Advertising"), out);
  assert.doesNotMatch(out, /Jos[eé]|Peña|Sonrisa|\d/);
  // Untouched Spanish keeps every accent byte for byte.
  const plain = "¿Cuántos pacientes llaman fuera de horario? Ahí está la oportunidad.";
  assert.equal(scrubExemplar(plain, p), plain);
});

test("scrubber: a greeting name the contact row did not know still goes; a team greeting stays", () => {
  const anon = { company_name: "Acme", domain: null, recipient_name: null };
  assert.equal(scrubExemplar("Hi Miguel,\n\nText.", anon), "Hi [name],\n\nText.");
  assert.equal(scrubExemplar("Hi team,\n\nText.", anon), "Hi team,\n\nText.");
  assert.equal(scrubExemplar("Hola equipo de Acme,\n\nTexto.", anon), "Hola equipo de [company],\n\nTexto.");
  // A common-word given name is scrubbed as a name, not as a word.
  const will = { company_name: null, domain: null, recipient_name: "Will Turner" };
  assert.equal(scrubExemplar("Hi Will,\n\nThis will take a minute, Will.", will), "Hi [name],\n\nThis will take a minute, [name].");
});

test("scrubber: the past prospect's city goes in any case, even when it is also a word", () => {
  const p = { company_name: null, domain: null, recipient_name: null, city: "Mission" };
  assert.equal(scrubExemplar("Clinics in Mission lose the evening calls. who answers in mission.", p), "Clinics in [city] lose the evening calls. who answers in [city].");
  const q = { company_name: null, domain: null, recipient_name: null, city: "Querétaro" };
  assert.equal(scrubExemplar("Aquí en Queretaro y en Querétaro.", q), "Aquí en [city] y en [city].");
});

test("probe: lower-case subjects with place and brand words are scrubbed (Victoria, Guelph, Surrey, Summit)", () => {
  const city = (c: string) => ({ company_name: null, domain: null, recipient_name: null, city: c });
  assert.equal(scrubExemplar("clinics in victoria after hours", city("Victoria")), "clinics in [city] after hours");
  assert.equal(scrubExemplar("who answers in guelph at night", city("Guelph")), "who answers in [city] at night");
  assert.equal(scrubExemplar("surrey dentists after hours", city("Surrey")), "[city] dentists after hours");
  const summit = { company_name: "Summit Dental", domain: null, recipient_name: null };
  assert.equal(scrubExemplar("who books summit at night", summit), "who books [company] at night");
  // And the fail-closed check sees them in lower case too.
  assert.deepEqual(exemplarLeaks("clinics in victoria after hours", city("Victoria")), ["victoria"]);
  assert.deepEqual(exemplarLeaks("who books summit at night", summit), ["summit"]);
  // A contact's common-word given name stays capital-only: "will" the verb survives.
  const will = { company_name: null, domain: null, recipient_name: "Will Turner" };
  assert.deepEqual(exemplarLeaks("this will help", will), []);
  assert.deepEqual(exemplarLeaks("thanks, Will", will), ["will"]);
});

test("toExemplar scrubs both subject and body", () => {
  const e = toExemplar({ pitch_id: "x", score: 1 }, { subject: "wagner legal group after 5pm", body: "Hi John,\n\nBody.", ...WAG });
  assert.deepEqual(e, { pitch_id: "x", score: 1, subject: "[company] after [n]pm", body: "Hi [name],\n\nBody." });
});

// ── Scrubber: review probes and the fail-closed invariant ─────────────────────

const foldText = (t: string) => t.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
/** Whole-word, case- and accent-insensitive presence of any of `words` in `text`. */
function present(text: string, words: string[]): string[] {
  const f = foldText(text);
  return words.filter((w) => new RegExp(`(?<![\\p{L}\\p{N}])${foldText(w)}(?![\\p{L}\\p{N}])`, "u").test(f));
}

test("probe: company short form and a lower-case city in the subject are scrubbed", () => {
  const p = { company_name: "Wagner Legal Group Inc.", domain: null, recipient_name: null, city: "Toronto" };
  const out = scrubExemplar("who answers at wagner in toronto after hours", p);
  assert.equal(out, "who answers at [company] in [city] after hours");
  assert.equal(scrubExemplar("The team at Wagner picks up by noon. TORONTO firms rarely do.", p), "The team at [company] picks up by noon. [city] firms rarely do.");
  assert.deepEqual(exemplarLeaks(out, p), []);
});

test("probe: hyphenated, ampersand and saint-prefixed company names are scrubbed", () => {
  const sj = { company_name: "Smith-Jones Plumbing & Heating Ltd.", domain: null, recipient_name: null };
  const a = scrubExemplar("Smith-Jones runs two vans. Smith Jones Plumbing answers by phone. smith-jones plumbing & heating is busy.", sj);
  assert.deepEqual(present(a, ["smith", "jones"]), [], a);
  assert.equal(a, "[company] runs two vans. [company] Plumbing answers by phone. [company] is busy.");
  const sb = { company_name: "St Bernard's Group Home Care", domain: null, recipient_name: null };
  const b = scrubExemplar("St. Bernard's has one intake line, and St Bernard’s Group Home Care staff call back.", sb);
  assert.deepEqual(present(b, ["bernard", "bernards"]), [], b);
});

test("probe: accented, hyphenated and apostrophe surnames are scrubbed, with or without an honorific", () => {
  const mj = { company_name: null, domain: null, recipient_name: "María José Núñez-Ruiz" };
  const a = scrubExemplar("Hola María José,\n\nLic. Núñez lo sabe: la agenda de Ruiz se llena. NUNEZ-RUIZ y nunez ruiz también.", mj);
  assert.deepEqual(present(a, ["maria", "jose", "nunez", "ruiz"]), [], a);
  assert.match(a, /^Hola \[name\],/);
  assert.ok(a.includes("Lic. [name] lo sabe: la agenda de [name] se llena."), a);
  const ob = { company_name: null, domain: null, recipient_name: "Sean O'Brien" };
  const b = scrubExemplar("Hi Sean,\n\nMr. O’Brien, your O’Brien Hardware page and OBrien’s team.", ob);
  assert.deepEqual(present(b, ["sean", "brien", "obrien"]), [], b);
});

test("probe: names the contact row did not know (bare greeting, honorifics) are scrubbed", () => {
  const anon = { company_name: null, domain: null, recipient_name: null };
  assert.equal(scrubExemplar("Hi Miguel\n\nText.", anon), "Hi [name]\n\nText.");
  assert.equal(scrubExemplar("Hola Miguel\nTexto.", anon), "Hola [name]\nTexto.");
  assert.equal(
    scrubExemplar("Hi team,\n\nDr. Patel and Dra. Gómez Ruiz see patients; Sra. Hernández books them.", anon),
    "Hi team,\n\nDr. [name] and Dra. [name] see patients; Sra. [name] books them.",
  );
});

test("probe: matching ignores case and accents fully; a common-word name spares the word", () => {
  const p = { company_name: null, domain: null, recipient_name: "April Gómez", city: "Calgary" };
  const out = scrubExemplar("CALGARY, calgary and Calgary. GOMEZ, gómez. In april, April said hi.", p);
  assert.equal(out, "[city], [city] and [city]. [name], [name]. In april, [name] said hi.");
  assert.deepEqual(exemplarLeaks(out, p), []);
});

test("fail closed: exemplarLeaks finds a surviving word, and only distinctive ones", () => {
  const p = { company_name: "Wagner Legal Group Inc.", domain: "waglaw.net", recipient_name: "John Sipos", city: "Toronto" };
  assert.deepEqual(exemplarLeaks("Thanks, wágner team in TORONTO. sipos.", p).sort(), ["sipos", "toronto", "wagner"]);
  assert.deepEqual(exemplarLeaks("Legal groups in the city get calls; waglaw", p), ["waglaw"]);
  assert.deepEqual(exemplarLeaks("Legal groups get calls after hours.", p), []);
});

test("property: 30 generated prospects; no distinctive word survives in a kept exemplar", () => {
  const firsts = ["María José", "Sean", "Priya", "Jean-Luc", "Zoë", "Raúl", "Siobhan", "Thanh", "Ngozi", "Björn"];
  const lasts = ["Núñez-Ruiz", "O’Brien", "Patel", "Tremblay", "Gómez", "Nakamura", "Okafor", "Lefebvre", "Hernández", "Kowalski"];
  const stems = ["Wagner", "Bluefin", "Maplecrest", "Ixtapa", "Tecnoforja", "Northbridge", "Arbutus", "Quetzal", "Halvorsen", "Corvid"];
  const suffixes = [" Legal Group Inc.", " Dental Clinic", " Plumbing & Heating Ltd.", " S.A. de C.V.", " Construction"];
  const cities = ["Toronto", "Saskatoon", "Querétaro", "Guadalajara", "Kelowna", "Trois-Rivières", "Mérida", "Moncton"];
  let kept = 0;
  for (let i = 0; i < 30; i++) {
    const first = firsts[i % firsts.length]!;
    const last = lasts[(i * 3) % lasts.length]!;
    const stem = stems[(i * 7) % stems.length]!;
    const company = stem + suffixes[i % suffixes.length]!;
    const city = cities[(i * 5) % cities.length]!;
    const p = { company_name: company, domain: `${stem.toLowerCase()}.ca`, recipient_name: `${first} ${last}`, city };
    const subject = `${stem.toLowerCase()} in ${city.toLowerCase()} after hours`;
    const body = [
      `Hi ${first.split(" ")[0]},`,
      "",
      `The team at ${stem} in ${city.toUpperCase()} answers ${i + 2} calls by hand. ${company} has a form at www.${stem.toLowerCase()}.ca.`,
      `Dr. ${last} told us ${last}'s desk is busy; ${first} ${last.toUpperCase()} agreed. Write ${first.split(" ")[0]!.toLowerCase()}@${stem.toLowerCase()}.ca.`,
      "",
      `👉 Run ${stem} through our free check, about 30 seconds: https://runna-hunter.vercel.app/?r=a${i}b`,
      "",
      "Henry",
      "Runna Advertising",
    ].join("\n");
    const e = toExemplar({ pitch_id: `p${i}`, score: 1 }, { subject, body, ...p });
    if (!e) continue; // dropped by the fail-closed check: safe by construction
    kept++;
    const words = [first, last, stem, city].flatMap((w) => foldText(w).split(/[^\p{L}\p{N}]+/u)).filter((w) => w.length >= 4);
    const text = `${e.subject}\n${e.body}`;
    assert.deepEqual(present(text, words), [], `case ${i}: ${text}`);
    assert.doesNotMatch(text, /\d/, `case ${i}`);
  }
  // The invariant is a net, not the scrubber: nearly every case must come through.
  assert.ok(kept >= 28, `kept ${kept} of 30`);
});

// ── Prompt injection ──────────────────────────────────────────────────────────

test("prompt sections: empty without exemplars, short instruction with them", () => {
  assert.equal(writerExemplarSection(undefined), "");
  assert.equal(writerExemplarSection([]), "");
  assert.equal(criticExemplarSection(null), "");
  const ex = [{ subject: "s", body: "b" }];
  const words = (s: string) => s.split("--- Past email")[0]!.trim().split(/\s+/).length;
  assert.ok(words(writerExemplarSection(ex)) < 60, `writer: ${words(writerExemplarSection(ex))} words`);
  assert.ok(words(criticExemplarSection(ex)) < 60, `critic: ${words(criticExemplarSection(ex))} words`);
  assert.match(writerExemplarSection(ex), /shape and restraint, never their facts/);
  assert.match(criticExemplarSection(ex), /Judge against this bar/);
});

type Req = { system?: { text: string }[] | string; messages: { content: string }[] };
const sysText = (r: Req) => (typeof r.system === "string" ? r.system : (r.system ?? []).map((b) => b.text).join("\n"));

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

function inputs(over: Partial<GeneratorInputs> = {}): GeneratorInputs {
  return {
    prospect: { id: "p", company_name: "Clinica Sur", industry: "clinic", language: "en", employee_size_estimate: 10, city: "Calgary", market: "CA", what_they_do: "family dental clinic", tech_stack: [] },
    pains: [{ pain_id: "pain-1", pain_label: "Lead response time", evidence_quote: "contact form only, no booking" }],
    contacts: [{ full_name: "Sarah Lee", email: "sarah@clinicasur.ca", email_is_role_based: false, role_title: null }],
    case_studies: [],
    notable_clients: [],
    benchmarks: [],
    sender: { full_name: "Henry", tenant_display_name: "Runna Advertising" },
    deep_pitch_url: "https://runna-hunter.vercel.app/?market=ca",
    ...over,
  };
}

const GOOD =
  "Hi Sarah,\n\nHenry from Runna Advertising here. Right now the only way to reach Clinica Sur online is a contact form, so a patient who wants to book tonight has to wait until morning.\n\n👉 Run Clinica Sur through our free check, about 30 seconds: https://runna-hunter.vercel.app/?market=ca\n\nHenry\nRunna Advertising";
const pitchJson = JSON.stringify({ subject: "who books clinica sur at night", preview_text: "a contact form is the only way in after hours", body: GOOD, pain_id: "pain-1", contact_email: "sarah@clinicasur.ca", measurable_result_included: false, quality_self_score: 0.8, reasoning: "x" });
const isCritic = (r: Req) => sysText(r).includes("You review a cold email");

test("writer and critic see the scrubbed exemplars; no exemplar company, name or digit reaches either prompt", async () => {
  const past = {
    subject: "intake at wagner legal group after 5pm",
    body: "Hi John,\n\nWagner Legal Group answers 12 calls a day by hand; waglaw.net has no booking.\n\n👉 Run Wagner Legal Group through our free check, about 30 seconds: https://runna-hunter.vercel.app/?r=zz99\n\nHenry\nRunna Advertising",
  };
  const exemplar = toExemplar({ pitch_id: "ex-1", score: 1 }, { ...past, ...WAG })!;
  assert.ok(exemplar, "exemplar survives the leak check");
  const calls = install((r) => (isCritic(r) ? JSON.stringify({ score: 0.95, issues: [] }) : pitchJson));
  try {
    const r = await composeWithReview(inputs({ exemplars: [exemplar] }), { deadline: Date.now() + 120_000 });
    assert.ok(r.ok);
    const writer = calls.find((c) => !isCritic(c))!.messages[0]!.content;
    const critic = calls.find(isCritic)!.messages[0]!.content;
    const writerSection = writer.slice(writer.indexOf("Below are our own past emails"));
    const criticSection = critic.slice(critic.indexOf("Judge against this bar"), critic.indexOf("Email to review:"));
    for (const section of [writerSection, criticSection]) {
      assert.ok(section.length > 100, "exemplar section present");
      assert.ok(section.includes("[company] answers [n] calls a day by hand; [site] has no booking."), section);
      for (const leak of ["Wagner", "wagner", "waglaw", "John", "zz99", "12", "5pm", "30"]) assert.ok(!section.includes(leak), `leaked ${leak}`);
      assert.doesNotMatch(section, /\d/);
    }
    // The critic's bar sits outside the payload it judges facts against.
    assert.ok(critic.indexOf("Judge against this bar") > critic.indexOf("```\n"));
    // Exemplars are never part of the writer's fact payload either.
    const json = writer.slice(writer.indexOf("```json"), writer.indexOf("```", writer.indexOf("```json") + 7));
    assert.ok(json.length > 0 && !json.includes("calls a day") && !json.includes("exemplar"));
  } finally {
    __test__.reset();
  }
});

test("no exemplars: prompts are byte-identical to today's, and the system prompt never changes", async () => {
  const run = async (over: Partial<GeneratorInputs>) => {
    const calls = install((r) => (isCritic(r) ? JSON.stringify({ score: 0.95, issues: [] }) : pitchJson));
    try {
      await composeWithReview(inputs(over), { deadline: Date.now() + 120_000 });
      return calls.map((c) => ({ system: sysText(c), user: c.messages[0]!.content }));
    } finally {
      __test__.reset();
    }
  };
  const today = await run({});
  const empty = await run({ exemplars: [] });
  const nul = await run({ exemplars: null });
  assert.deepEqual(empty, today);
  assert.deepEqual(nul, today);
  const withEx = await run({ exemplars: [{ pitch_id: "e", score: 1, subject: "s", body: "Hi [name],\n\nb" }] });
  assert.equal(withEx.length, today.length);
  for (let i = 0; i < today.length; i++) {
    // Cache-safe: exemplars live in the user message only.
    assert.equal(withEx[i]!.system, today[i]!.system);
    assert.notEqual(withEx[i]!.user, today[i]!.user);
  }
});

// ── Decision record ───────────────────────────────────────────────────────────

test("decision record: exemplars_used is filled for an AI pitch and empty otherwise", () => {
  const ex = [{ pitch_id: "a", score: 1 }, { pitch_id: "b", score: 0.5 }];
  assert.deepEqual(decisionExemplarFields("claude", ex), {
    exemplars_used: [{ pitch_id: "a", score: 1 }, { pitch_id: "b", score: 0.5 }],
    exemplar_prompt_version: EXEMPLAR_PROMPT_VERSION,
  });
  assert.deepEqual(decisionExemplarFields("claude", []), { exemplars_used: [], exemplar_prompt_version: null });
  assert.deepEqual(decisionExemplarFields("template", ex), { exemplars_used: [], exemplar_prompt_version: null });
  assert.deepEqual(decisionExemplarFields("website_claude", []), { exemplars_used: [], exemplar_prompt_version: null });
});

// ── Scrubber gaps closed in exemplar-v2: short tokens, lower-case honorifics, city short forms ──

test("gap: three-letter company and domain words are scrubbed and leak-checked", () => {
  const abc = { company_name: "ABC Plumbing Ltd.", domain: "abcplumbing.ca", recipient_name: null };
  assert.equal(scrubExemplar("who answers at abc after hours", abc), "who answers at [company] after hours");
  assert.deepEqual(exemplarLeaks("who answers at abc after hours", abc), ["abc"]);
  const bmo = { company_name: "BMO", domain: null, recipient_name: null };
  assert.equal(scrubExemplar("The BMO branch line rings out.", bmo), "The [company] branch line rings out.");
  const kpi = { company_name: null, domain: "kpi-law.ca", recipient_name: null };
  assert.equal(scrubExemplar("kpi takes intake by phone", kpi), "[company] takes intake by phone");
  assert.deepEqual(exemplarLeaks("kpi takes intake by phone", kpi), ["kpi"]);
  // Generic short words are neither scrubbed alone nor counted.
  assert.deepEqual(exemplarLeaks("plumbing and law offices", abc), []);
});

test("gap: two- and three-letter surnames are scrubbed and leak-checked", () => {
  for (const [name, short] of [["Priya Ng", "ng"], ["Sean Wu", "wu"], ["Raúl Li", "li"], ["Ana Lee", "lee"]] as const) {
    const p = { company_name: null, domain: null, recipient_name: name };
    assert.deepEqual(exemplarLeaks(`thanks, ${short}`, p), [short], name);
    assert.deepEqual(exemplarLeaks(`thanks, ${short.toUpperCase()}`, p), [short], name);
    const e = toExemplar({ pitch_id: "x", score: 1 }, { subject: `${short}'s desk after hours`, body: `Hi there,\n\nMs. ${short} picks up.`, ...p });
    assert.ok(e, name);
    assert.deepEqual(present(`${e.subject}\n${e.body}`, [short]), [], `${name}: ${e.subject} ${e.body}`);
  }
  // A two-letter surname that is also a word stays capital-only, like "Will".
  const to = { company_name: null, domain: null, recipient_name: "Minh To" };
  assert.equal(scrubExemplar("Mr. To wants to talk", to), "Mr. [name] wants to talk");
  assert.deepEqual(exemplarLeaks("a way to book", to), []);
});

test("gap: a lower-case name after a dotted honorific goes, whoever the contact row names", () => {
  const other = { company_name: null, domain: null, recipient_name: "John Sipos" };
  assert.equal(scrubExemplar("dr. patel after hours", other), "dr. [name] after hours");
  assert.equal(scrubExemplar("¿lic. núñez contesta de noche?", other), "¿lic. [name] contesta de noche?");
  assert.equal(scrubExemplar("Ask Dr. patel's desk or prof. dr. gómez.", other), "Ask Dr. [name]'s desk or prof. dr. [name].");
  assert.equal(scrubExemplar("SRA. HERNÁNDEZ books them; ing.ruiz too.", other), "SRA. [name] books them; ing. [name] too.");
  // The words "marketing." or "dr" without a dot are not honorifics.
  assert.equal(scrubExemplar("Better marketing. Patients call.", other), "Better marketing. Patients call.");
  assert.deepEqual(exemplarLeaks("dr. patel after hours", other), ["dr. patel"]);
  assert.equal(toExemplar({ pitch_id: "x", score: 1 }, { subject: "dr. patel after hours", body: "Hi there,\n\nBody.", ...other })?.subject, "dr. [name] after hours");
});

test("gap: a city's short forms and nicknames are scrubbed and leak-checked", () => {
  const city = (c: string) => ({ company_name: null, domain: null, recipient_name: null, city: c });
  assert.equal(scrubExemplar("clínicas en cdmx, en el D.F. y en la CDMX y el df", city("Ciudad de México")), "clínicas en [city], en el [city]. y en la [city] y el [city]");
  assert.deepEqual(exemplarLeaks("clínicas en cdmx", city("Ciudad de México")), ["cdmx"]);
  assert.deepEqual(exemplarLeaks("clínicas en la ciudad de méxico", city("Ciudad de México")), ["ciudad de mexico"]);
  assert.equal(scrubExemplar("dentists in the gta and TO, open to all", city("Toronto")), "dentists in the [city] and [city], open to all");
  assert.deepEqual(exemplarLeaks("open to all in TO", city("Toronto")), ["TO"]);
  assert.deepEqual(exemplarLeaks("To book, reply to this", city("Toronto")), []);
  for (const [c, alias] of [["Guadalajara", "gdl"], ["Monterrey", "MTY"], ["Querétaro", "qro"], ["Vancouver", "YVR"], ["Calgary", "yyc"], ["Edmonton", "YEG"], ["Ottawa", "yow"], ["Montréal", "mtl"], ["Montreal", "YUL"]] as const) {
    assert.equal(scrubExemplar(`firms in ${alias} after hours`, city(c)), "firms in [city] after hours", c);
    assert.deepEqual(exemplarLeaks(`firms in ${alias}`, city(c)), [alias.toLowerCase()], c);
  }
  // Whichever name the row carries, the others are aliases.
  assert.equal(scrubExemplar("clinics in mexico city and cdmx", city("CDMX")), "clinics in [city] and [city]");
});

test("gap: placeholders are never matched by a field word (surname Hunter, company word url)", () => {
  const p = { company_name: "URL Media", domain: null, recipient_name: "Kate Hunter" };
  const out = scrubExemplar("Hi Kate,\n\nHunter, URL Media answers by phone.\n\n👉 Run it: https://runna-hunter.vercel.app/?r=x", p);
  assert.equal(out, "Hi [name],\n\n[name], [company] answers by phone.\n\n👉 Run it: {hunter_url}");
  assert.deepEqual(exemplarLeaks(out, p), []);
});

test("negative set: an all-generic past prospect keeps an exemplar of ordinary text", () => {
  const p = { company_name: "The Art Spa", domain: null, recipient_name: "Will Smith", city: "Toronto" };
  const subject = "who books spas after hours";
  const body =
    "Hi there,\n\nSpas and art studios lose calls at night, and people will go to the next name on the list. It takes a minute to see what a visitor sees.\n\nHenry\nRunna Advertising";
  const e = toExemplar({ pitch_id: "x", score: 1 }, { subject, body, ...p });
  assert.deepEqual(e, { pitch_id: "x", score: 1, subject, body });
});

test("exemplar prompt version is v2", () => {
  assert.equal(EXEMPLAR_PROMPT_VERSION, "exemplar-v2-2026-10-18");
});
