import assert from "node:assert/strict";
import test from "node:test";
import { exemplarLeaks, toExemplar } from "../lib/pitches/exemplars.ts";

// Property tests for the exemplar scrubber + fail-closed leak check.
//
// The checker here is INDEPENDENT of lib/pitches/exemplars.ts: its own fold,
// letters-only chunks, substring search for long words, and an allow-list of
// generic words. It never calls the implementation's matchers, so it can see
// what both the scrubber and exemplarLeaks miss.

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

// ── The independent checker ───────────────────────────────────────────────────

const tfold = (t: string) =>
  t
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .replace(/[łŁ]/g, "l")
    .replace(/[đĐ]/g, "d")
    .replace(/[øØ]/g, "o")
    .toLowerCase();
const lettersOnly = (t: string) => tfold(t).replace(/[^\p{L}\p{N}]/gu, "");
const unblank = (t: string) => t.replace(/\[(?:name|company|site|city|n)\]|\{hunter_url\}/g, " ");
/** Whitespace chunks, and inside each the letter runs once dots between single letters are gone ("C.D.M.X." → "CDMX"). */
function runsOf(text: string): string[] {
  return unblank(text)
    .split(/\s+/)
    .flatMap((c) => c.replace(/(?<!\p{L})(\p{L})\.(?=\p{L}(?!\p{L}))/gu, "$1").split(/[^\p{L}\p{N}]+/u))
    .filter(Boolean);
}

/** Generic words: never a leak on their own. Test-side list, written independently. */
const ALLOW = new Set([
  "plumbing", "dental", "legal", "law", "group", "clinic", "construction", "inc", "ltd", "sa", "de", "cv", "the",
  "ciudad", "mexico", "city", "north", "san", "santiago", "garza", "irving", "s", "a", "c", "v", "la",
]);

type Forbidden = { word: string; how: "any" | "capital" | "upper" };

/** Every forbidden thing found in `text`, by this file's own rules. */
function found(text: string, forbidden: readonly Forbidden[]): string[] {
  const runs = runsOf(text);
  const chunks = unblank(text).split(/\s+/).map(lettersOnly);
  const whole = lettersOnly(unblank(text));
  const hits: string[] = [];
  for (const { word, how } of forbidden) {
    const words = word.split(/\s+/);
    if (words.length > 1) {
      // A phrase: its letters joined, anywhere in the text's letters.
      if (whole.includes(lettersOnly(word))) hits.push(word);
      continue;
    }
    const w = tfold(word);
    if (how === "upper") {
      if (runs.some((r) => r === word.toUpperCase())) hits.push(word);
    } else if (how === "capital") {
      if (runs.some((r) => tfold(r) === w && /^\p{Lu}/u.test(r))) hits.push(word);
    } else if (w.length >= 5) {
      if (chunks.some((c) => c.includes(w))) hits.push(word);
    } else if (runs.some((r) => tfold(r) === w)) hits.push(word);
  }
  return hits;
}

// ── The generator ─────────────────────────────────────────────────────────────

const CITIES: Array<{ city: string; aliases: string[] }> = [
  { city: "Ciudad de México", aliases: ["CDMX", "C.D.M.X.", "DF", "D.F.", "Cd. de México"] },
  { city: "Guadalajara", aliases: ["GDL"] },
  { city: "Zapopan", aliases: ["GDL", "Guadalajara"] },
  { city: "Monterrey", aliases: ["MTY"] },
  { city: "Querétaro", aliases: ["QRO", "Qro.", "Q.R.O."] },
  { city: "Santiago de Querétaro", aliases: ["QRO", "Qro."] },
  { city: "Toronto", aliases: ["TO", "T.O.", "T.O", "GTA", "YYZ"] },
  { city: "North York", aliases: ["Toronto", "GTA"] },
  { city: "Vancouver", aliases: ["YVR"] },
  { city: "Calgary", aliases: ["YYC"] },
  { city: "Edmonton", aliases: ["YEG"] },
  { city: "Ottawa", aliases: ["YOW"] },
  { city: "Montréal", aliases: ["MTL", "YUL"] },
];
const ACRONYMS = ["ABC", "BMO", "KPI", "JMR", "RBX", "DGM", "QSR", "HVK"];
const INITIALS = ["KP", "A.B.C.", "J.D.", "RX", "T.M."];
const STEMS = ["Wagner", "Bluefin", "Maplecrest", "Quetzal", "Corvid", "Arbutus", "Tecnoforja", "Halvorsen"];
const GENERIC_TAILS = ["Plumbing", "Dental", "Legal", "Group", "Clinic", "Construction"];
const LEGAL = ["", " Inc.", " Ltd.", " S.A. de C.V."];
const GIVEN = ["Priya", "Sean", "Raúl", "María José", "Thanh", "Björn", "Ngozi", "Siobhan", "Łukasz"];
const SURNAMES = ["Ng", "Wu", "Li", "Xu", "Lu", "Yi", "Le", "Du"];
/** Last names that are also particles: only a capitalized one is the name. */
const PARTICLE_SURNAMES = new Set(["Le", "Du"]);
/** Someone the contact row does not name, seen only after an honorific. */
const STRANGERS = ["Patel", "Núñez", "Okafor", "Tremblay", "Gómez Ruiz", "Pérez"];
const HONORIFIC_FORMS = ["dr. ", "dr ", "Dr. J. ", "dr. j ", "lcda. ", "c.p. ", "Sra. de la ", "sra. de la ", "Lic. ", "DRA. "];

type Case = {
  prospect: { company_name: string; domain: string; recipient_name: string; city: string };
  forbidden: Forbidden[];
  inserts: string[];
};

function genCase(rnd: () => number): Case {
  const pick = <T,>(xs: readonly T[]): T => xs[Math.floor(rnd() * xs.length)]!;
  const stem = pick(STEMS);
  const shape = Math.floor(rnd() * 5);
  const lead = shape === 4 ? pick(INITIALS) : pick(ACRONYMS);
  const words = shape === 0 ? [lead] : shape === 1 ? [lead, pick(GENERIC_TAILS)] : shape === 2 ? [lead, stem, pick(GENERIC_TAILS)] : shape === 3 ? [stem, lead] : [lead, stem, pick(GENERIC_TAILS)];
  const company = words.join(" ") + pick(LEGAL);
  const own = words.filter((w) => !GENERIC_TAILS.includes(w));
  const ownLetters = own.map((w) => w.replace(/\./g, ""));
  const label = rnd() < 0.5 ? ownLetters.join("-").toLowerCase() : ownLetters.join("").toLowerCase();
  const domain = `${label}.${rnd() < 0.5 ? "ca" : "com.mx"}`;
  const { city, aliases } = pick(CITIES);
  const given = pick(GIVEN);
  const surname = pick(SURNAMES);
  const stranger = pick(STRANGERS);
  const honorific = pick(HONORIFIC_FORMS);

  const forbidden: Forbidden[] = [];
  for (const w of own) {
    const letters = w.replace(/\./g, "");
    // Initials ("KP", "A.B.C.") are the company only in capitals; acronyms and stems in any case.
    forbidden.push({ word: letters, how: INITIALS.includes(w) ? "upper" : "any" });
  }
  forbidden.push({ word: label.replace(/-/g, ""), how: "any" });
  // A one- or two-letter label piece ("rx" in rx-halvorsen.ca) is the company only in capitals, like initials.
  for (const w of label.split("-")) if (!ALLOW.has(w)) forbidden.push({ word: w, how: w.length <= 2 ? "upper" : "any" });
  forbidden.push({ word: city, how: "any" });
  for (const w of city.split(/\s+/)) if (!ALLOW.has(tfold(w))) forbidden.push({ word: w, how: "any" });
  for (const a of aliases) {
    const letters = a.includes(" ") ? a : a.replace(/\./g, "");
    forbidden.push({ word: letters, how: letters === "TO" ? "upper" : "any" });
  }
  for (const w of given.split(" ")) forbidden.push({ word: w, how: "any" });
  forbidden.push({ word: surname, how: PARTICLE_SURNAMES.has(surname) ? "capital" : "any" });
  for (const w of stranger.split(" ")) forbidden.push({ word: w, how: "any" });

  const stemInserts = own.includes(stem) ? [`@${label}`, `${stem}s`, `facebook.com/${stem}LawTO`] : [];
  return {
    prospect: { company_name: company, domain, recipient_name: `${given} ${surname}`, city },
    forbidden,
    inserts: [company, words.join(" "), ...own, domain, label, ...stemInserts, city, ...aliases, given, surname, `${given} ${surname}`, `Ms. ${surname}`, `${honorific}${stranger}`],
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
    ...lines.map((s, i) => (i % 3 === 0 ? `The team at ${s} and the desk answer calls.` : i % 3 === 1 ? `Clinics like ${s}'s lose evening calls.` : `(${s}) has a form.`)),
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
    "To book a visit, most people still call; the ones who get voicemail rarely call twice.",
  ];
  const body = ["Hi there,", "", ...lines.filter(() => rnd() < 0.8), "", "👉 Run it through our free check: https://runna-hunter.vercel.app/?r=x", "", "Henry", "Runna Advertising"].join("\n");
  return { subject: "who answers after hours", body };
}

const N = 240;

test(`property: ${N} seeded prospects; a kept exemplar carries nothing the independent checker finds`, () => {
  const rnd = mulberry32(20261018);
  let keptAdversarial = 0;
  let keptNatural = 0;
  for (let i = 0; i < N; i++) {
    const c = genCase(rnd);
    for (const [kind, tpl] of [["adversarial", adversarial(c, rnd)], ["natural", natural(c)]] as const) {
      const e = toExemplar({ pitch_id: `p${i}`, score: 1 }, { ...tpl, ...c.prospect });
      if (!e) {
        if (kind === "natural" && process.env.SHOW_DROPS) console.log("DROP", JSON.stringify(c.prospect), exemplarLeaks(`${tpl.subject}\n${tpl.body}`, c.prospect));
        continue; // dropped by the fail-closed check: safe by construction
      }
      if (kind === "adversarial") keptAdversarial++;
      else keptNatural++;
      const text = `${e.subject}\n${e.body}`;
      assert.deepEqual(found(text, c.forbidden), [], `case ${i} ${kind} ${JSON.stringify(c.prospect)}:\n${text}`);
      assert.doesNotMatch(text, /\d/, `case ${i}`);
      assert.ok(text.includes("{hunter_url}"), `case ${i}: link slot lost\n${text}`);
    }
  }
  console.log(`property: kept adversarial ${keptAdversarial}/${N}, natural ${keptNatural}/${N}`);
  assert.equal(keptNatural, N, "a real email with the fields in their own case is scrubbed, not dropped");
});

test(`property: ${N} seeded prospects; whatever the independent checker finds in a raw insert, the leak check finds too`, () => {
  const rnd = mulberry32(1018);
  for (let i = 0; i < N; i++) {
    const c = genCase(rnd);
    for (const s of c.inserts.flatMap(variants)) {
      const text = `quick question about ${s} after hours`;
      if (found(text, c.forbidden).length === 0) continue; // e.g. a lower-case "to" or "kp": not the prospect
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
