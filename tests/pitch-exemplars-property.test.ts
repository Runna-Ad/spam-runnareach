import assert from "node:assert/strict";
import test from "node:test";
import { exemplarLeaks, toExemplar } from "../lib/pitches/exemplars.ts";

// Property test for the exemplar scrubber + fail-closed leak check. For seeded,
// generated past prospects (a company with a three-letter acronym, a domain built
// from it, a city that has short forms, a contact with a two-letter surname) and
// templates that put every field and every alias into the subject and body in
// original, lower and upper case, a kept exemplar never carries any of them.

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const fold = (t: string) => t.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
const parts = (t: string) => fold(t).split(/[^\p{L}\p{N}]+/u).filter(Boolean);
/** Whole-word, accent- and case-insensitive presence of a word or phrase. */
function has(text: string, phrase: string): boolean {
  const ps = parts(phrase);
  if (ps.length === 0) return false;
  return new RegExp(`(?<![\\p{L}\\p{N}])${ps.join("[^\\p{L}\\p{N}\\n]{0,3}")}(?![\\p{L}\\p{N}])`, "u").test(fold(text));
}

// The brief's alias table, written out independently of the implementation.
const CITIES: Array<{ city: string; aliases: string[] }> = [
  { city: "Ciudad de México", aliases: ["CDMX", "DF"] },
  { city: "Guadalajara", aliases: ["GDL"] },
  { city: "Monterrey", aliases: ["MTY"] },
  { city: "Querétaro", aliases: ["QRO"] },
  { city: "Toronto", aliases: ["TO", "GTA", "YYZ"] },
  { city: "Vancouver", aliases: ["YVR"] },
  { city: "Calgary", aliases: ["YYC"] },
  { city: "Edmonton", aliases: ["YEG"] },
  { city: "Ottawa", aliases: ["YOW"] },
  { city: "Montréal", aliases: ["MTL", "YUL"] },
];
/** Only in capitals: "to" is a word. */
const UPPER_ONLY = new Set(["TO"]);
const ACRONYMS = ["ABC", "BMO", "KPI", "JMR", "RBX", "DGM", "QSR", "HVK"];
const STEMS = ["Wagner", "Bluefin", "Maplecrest", "Quetzal", "Corvid", "Arbutus", "Tecnoforja", "Halvorsen"];
const GENERIC_TAILS = ["Plumbing", "Dental", "Legal", "Group", "Clinic", "Construction"];
const LEGAL = ["", " Inc.", " Ltd.", " S.A. de C.V."];
const GIVEN = ["Priya", "Sean", "Raúl", "María José", "Thanh", "Björn", "Ngozi", "Siobhan"];
const SURNAMES = ["Ng", "Wu", "Li", "Xu", "Lu", "Yi"];
/** Someone the contact row does not name, seen only after an honorific. */
const STRANGERS = ["Patel", "Núñez", "Okafor", "Tremblay", "Gómez"];

type Case = {
  prospect: { company_name: string; domain: string; recipient_name: string; city: string };
  forbidden: string[];
  upperOnly: string[];
  inserts: string[];
};

function genCase(rnd: () => number): Case {
  const pick = <T,>(xs: readonly T[]): T => xs[Math.floor(rnd() * xs.length)]!;
  const acronym = pick(ACRONYMS);
  const stem = pick(STEMS);
  const shape = Math.floor(rnd() * 4);
  const words = shape === 0 ? [acronym] : shape === 1 ? [acronym, pick(GENERIC_TAILS)] : shape === 2 ? [acronym, stem, pick(GENERIC_TAILS)] : [stem, acronym];
  const company = words.join(" ") + pick(LEGAL);
  const own = words.filter((w) => !GENERIC_TAILS.includes(w));
  const label = rnd() < 0.5 ? own.join("-").toLowerCase() : own.join("").toLowerCase();
  const domain = `${label}.${rnd() < 0.5 ? "ca" : "com.mx"}`;
  const { city, aliases } = pick(CITIES);
  const given = pick(GIVEN);
  const surname = pick(SURNAMES);
  const name = `${given} ${surname}`;
  const anyCaseAliases = aliases.filter((a) => !UPPER_ONLY.has(a));
  const stranger = pick(STRANGERS);
  return {
    prospect: { company_name: company, domain, recipient_name: name, city },
    forbidden: [...own, label, domain, city, ...anyCaseAliases, given, surname, ...given.split(" "), stranger],
    upperOnly: aliases.filter((a) => UPPER_ONLY.has(a)),
    inserts: [company, words.join(" "), ...own, domain, label, city, ...aliases, given, surname, name, `dr. ${surname}`, `Lic. ${surname}`, `dr. ${stranger}`, `Sra. ${stranger}`],
  };
}

const variants = (s: string) => [s, s.toLowerCase(), s.toUpperCase()];

/** Every insert, in every case, spread across subject and body. */
function adversarial(c: Case, rnd: () => number): { subject: string; body: string } {
  const all = c.inserts.flatMap(variants);
  const subjectBits: string[] = [];
  const lines: string[] = [];
  for (const s of all) (rnd() < 0.3 ? subjectBits : lines).push(s);
  const subject = `quick question: ${subjectBits.join(" and ") || "after hours"}`;
  const body = [
    `Hi ${c.prospect.recipient_name.split(" ")[0]},`,
    "",
    ...lines.map((s, i) => (i % 3 === 0 ? `The team at ${s} answers calls by hand.` : i % 3 === 1 ? `Clinics like ${s}'s lose evening calls.` : `(${s}) has a form.`)),
    "",
    "👉 Run it through our free check: https://runna-hunter.vercel.app/?r=x",
    "",
    "Henry",
    "Runna Advertising",
  ].join("\n");
  return { subject, body };
}

/** The fields as a real email writes them: original case only. */
function natural(c: Case): { subject: string; body: string } {
  const p = c.prospect;
  return {
    subject: `after-hours calls at ${p.company_name.split(" ")[0]!.toLowerCase()}`,
    body: [
      `Hi ${p.recipient_name.split(" ")[0]},`,
      "",
      `Henry from Runna Advertising here. ${p.company_name} in ${p.city} takes intake by phone, and ${p.domain} has a form. Ms. ${p.recipient_name.split(" ").pop()} will know how many calls go unanswered.`,
      "",
      "👉 Run it through our free check: https://runna-hunter.vercel.app/?r=x",
      "",
      "Henry",
      "Runna Advertising",
    ].join("\n"),
  };
}

/** No field at all: only generic prose, with the words the leak check must leave alone. */
function clean(rnd: () => number): { subject: string; body: string } {
  const lines = [
    "Clinics and law offices lose calls after hours, and people will go to the next name on the list.",
    "A spa or an art studio can book online at night; most firms in the area do not.",
    "It takes a minute to see what a visitor sees, and it will show what to fix first.",
    "We help teams answer faster, so new clients do not wait to hear back.",
    "Most dental and legal offices we look at have one intake line and no form.",
  ];
  const body = ["Hi there,", "", ...lines.filter(() => rnd() < 0.8), "", "👉 Run it through our free check: https://runna-hunter.vercel.app/?r=x", "", "Henry", "Runna Advertising"].join("\n");
  return { subject: "who answers after hours", body };
}

function leaksIn(text: string, c: Case): string[] {
  const found = c.forbidden.filter((w) => has(text, w));
  for (const a of c.upperOnly) if (new RegExp(`(?<![\\p{L}\\p{N}])${a}(?![\\p{L}\\p{N}])`, "u").test(text)) found.push(a);
  return found;
}

const N = 240;

test(`property: ${N} seeded prospects; a kept exemplar carries no field, alias or surname`, () => {
  const rnd = mulberry32(20261018);
  let kept = 0;
  for (let i = 0; i < N; i++) {
    const c = genCase(rnd);
    for (const tpl of [adversarial(c, rnd), natural(c)]) {
      const e = toExemplar({ pitch_id: `p${i}`, score: 1 }, { ...tpl, ...c.prospect });
      if (!e) continue; // dropped by the fail-closed check: safe by construction
      kept++;
      const text = `${e.subject}\n${e.body}`;
      assert.deepEqual(leaksIn(text, c), [], `case ${i} ${JSON.stringify(c.prospect)}:\n${text}`);
      assert.doesNotMatch(text, /\d/, `case ${i}`);
      assert.ok(text.includes("{hunter_url}"), `case ${i}: link slot lost\n${text}`);
    }
  }
  console.log(`property: kept ${kept}/${2 * N} (adversarial + natural)`);
  assert.ok(kept >= N, `kept ${kept}/${2 * N}: the scrubber, not the net, must do the work`);
});

test(`property: ${N} seeded prospects; the leak check sees every raw field, alias, surname and honorific name`, () => {
  const rnd = mulberry32(1018);
  for (let i = 0; i < N; i++) {
    const c = genCase(rnd);
    for (const s of c.inserts.flatMap(variants)) {
      // A lower-case "to" is the word, not Toronto.
      if (UPPER_ONLY.has(s.toUpperCase()) && s !== s.toUpperCase()) continue;
      const text = `quick question about ${s} after hours`;
      assert.notDeepEqual(exemplarLeaks(text, c.prospect), [], `case ${i} ${JSON.stringify(c.prospect)}: unseen "${s}"`);
    }
  }
});

test("drop rate: clean and natural templates are almost never dropped (< 5%)", () => {
  const rnd = mulberry32(7);
  let cleanDropped = 0;
  let naturalDropped = 0;
  for (let i = 0; i < N; i++) {
    const c = genCase(rnd);
    const cl = clean(rnd);
    const e = toExemplar({ pitch_id: `c${i}`, score: 1 }, { ...cl, ...c.prospect });
    if (!e) cleanDropped++;
    else assert.equal(e.body, cl.body.replace("https://runna-hunter.vercel.app/?r=x", "{hunter_url}"), `case ${i}: clean text changed`);
    if (!toExemplar({ pitch_id: `n${i}`, score: 1 }, { ...natural(c), ...c.prospect })) naturalDropped++;
  }
  console.log(`drop rate: clean ${cleanDropped}/${N}, natural ${naturalDropped}/${N}`);
  assert.ok(cleanDropped / N < 0.05, `clean dropped ${cleanDropped}/${N}`);
  assert.ok(naturalDropped / N < 0.05, `natural dropped ${naturalDropped}/${N}`);
});
