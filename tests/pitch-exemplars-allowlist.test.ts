import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { exemplarLeaks, scrubExemplar, toExemplar, type ExemplarProspect } from "../lib/pitches/exemplars.ts";
import { renderIndustryTemplate } from "../lib/pitches/industry-templates.ts";
import { buildFollowup1, buildFollowup2 } from "../lib/pitches/followup-templates.ts";

// The allow-list tier of the exemplar leak check (lib/pitches/exemplars.ts):
// tokens it must never let through (scripts, look-alikes, invisible splitters,
// handles), and the share of clean house-style pitches it drops.

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

const OTHER: ExemplarProspect = { company_name: "Bluefin Plumbing", domain: "bluefin.ca", recipient_name: "Sean Ng", city: "Calgary" };
const ZWSP = "​";
const SHY = "­";

test("adversarial: scripts, look-alikes, invisible splitters, full-width, handles and a mid-sentence name drop the exemplar", () => {
  const strangers = [
    "金龍", "Иванов", "Παπαδόπουλος", "محمد", "Pаtel", "Gоmez", "Weiß", "Straße",
    `Pa${ZWSP}tel`, `Pa${SHY}tel`, "Ｐａｔｅｌ", "@drpatelclinic", "patelclinic.com/contact",
  ];
  const kept: string[] = [];
  for (const s of strangers) {
    for (const [subject, body] of [
      [`quick question about ${s}`, "Hi there,\n\nClinics lose calls after hours.\n\nHenry\nRunna Advertising"],
      ["quick question", `Hi there,\n\nClinics like ${s} lose calls after hours.\n\nHenry\nRunna Advertising`],
      ["quick question", `Hi there,\n\n${s} loses calls after hours.\n\nHenry\nRunna Advertising`],
    ] as const) {
      // Dropped, or kept with the stranger blanked ([site] for a handle or domain).
      const e = toExemplar({ pitch_id: "x", score: 1 }, { subject, body, ...OTHER });
      if (e && /pat|金|ив|πα|مح|wei|stra|g\u043em/iu.test(`${e.subject} ${e.body}`.normalize("NFKD"))) kept.push(`${s} | ${e.subject} | ${e.body.split("\n")[2]}`);
    }
  }
  // A capitalized word that is also a name, mid-sentence, is a name.
  if (toExemplar({ pitch_id: "x", score: 1 }, { subject: "quick question", body: "Hi there,\n\nWe spoke with Rosa about the calls.\n\nHenry", ...OTHER })) {
    kept.push("Rosa mid-sentence");
  }
  assert.deepEqual(kept, []);
});

test("adversarial: the leak check names what it saw for each splitter", () => {
  const none: ExemplarProspect = { company_name: null, domain: null, recipient_name: null };
  for (const s of ["Pаtel", `Pa${ZWSP}tel`, `Pa${SHY}tel`, "Ｐａｔｅｌ", "Weiß"]) {
    assert.notDeepEqual(exemplarLeaks(`we asked ${s} today`, none), [], s);
  }
});

test("scrubber: a contact written with a zero-width space, soft hyphen or full-width letters is blanked, not dropped", () => {
  for (const contact of [`Pa${ZWSP}tel`, `Pa${SHY}tel`, "Ｐａｔｅｌ"]) {
    const p: ExemplarProspect = { company_name: "Bluefin Plumbing", domain: "bluefin.ca", recipient_name: `Priya ${contact}` };
    for (const written of [contact, "Patel"]) {
      const body = `Hi Priya,\n\nWe asked ${written} why the desk misses evening calls.\n\nHenry\nRunna Advertising`;
      const e = toExemplar({ pitch_id: "x", score: 1 }, { subject: "evening calls", body, ...p });
      assert.ok(e, `${JSON.stringify(contact)} / ${JSON.stringify(written)}: dropped ${exemplarLeaks(scrubExemplar(body, p), p)}`);
      assert.match(e.body, /We asked \[name\] why/);
    }
  }
});

test("generous tier: words that are also names survive in lower case and at a sentence start", () => {
  const p = OTHER;
  const cases = [
    ["Re: reservas", "Hola,\n\n¿Vale la pena una llamada corta? La pena es perder reservas de noche.\n\nNils\nRunna Advertising"],
    ["un spa con aroma", "Hola,\n\nUn spa con agua de rosa y masajes. Rosa mexicano en la marca.\n\nNils\nRunna Advertising"],
    ["missed calls", "Hi there,\n\nMark the date: the grant program closes soon, and most firms miss the mark.\n\nHenry\nRunna Advertising"],
  ] as const;
  for (const [subject, body] of cases) {
    const e = toExemplar({ pitch_id: "x", score: 1 }, { subject, body, ...p });
    assert.ok(e, `${subject}: ${[...exemplarLeaks(subject, p, { subject: true }), ...exemplarLeaks(body, p)]}`);
  }
});

// ── Drop rate on clean house-style pitches ────────────────────────────────────

/** The sourced benchmarks of 0037: the statistic sentences and who published them. */
function benchmarks(): Array<{ statistic: string; figure: string; publisher: string }> {
  const sql = readFileSync(new URL("../supabase/migrations/0037_seed_benchmarks_sourced_outcomes.sql", import.meta.url), "utf8");
  const str = "'((?:[^']|'')*)'";
  const row = new RegExp(`\\(${str},\\s*${str},\\s*array\\[[^\\]]*\\],\\s*array\\[[^\\]]*\\](?:::text\\[\\])?,\\s*(?:null|'[^']*'),\\s*${str},\\s*${str}`, "g");
  const un = (s: string) => s.replace(/''/g, "'");
  return [...sql.matchAll(row)].map((m) => ({ statistic: un(m[1]!), figure: un(m[2]!), publisher: un(m[4]!) }));
}

const INDUSTRIES = ["dtc skincare", "restaurant", "real estate", "law firm", "retail fashion", "automotive dealer", "dental clinic", "boutique hotel", "beach club", "vacation rental villa", "manufacturing"];
const STEMS = ["Maplecrest", "Bluefin", "Quetzal", "Arbutus", "Tecnoforja", "Halvorsen", "Corvid", "Sierra Alta", "Northgate", "Casa Ámbar", "Kestrel", "Los Olivos", "Pinecove", "Tulum Verde", "Brightwater"];
const TAILS = ["Dental", "Legal", "Group", "Clinic", "Motors", "Realty", "Hotel", "Boutique", "Café", "Studio", "Inc.", "S.A. de C.V.", ""];
const GIVEN = ["Priya", "Sean", "Raúl", "María José", "Thanh", "Rosa", "Mark", "Grant", "Dolores", "Pilar", "Guadalupe", "Will", "Ngozi", "Chloé", "Óscar", "Ximena"];
const SURNAMES = ["Ng", "Patel", "Gómez Ruiz", "Tremblay", "Okafor", "Peña", "Rosales", "Fraser", "Nguyen", "Villarreal", "Kowalski", "Cruz"];
const CITIES = ["Calgary", "Toronto", "Vancouver", "Ciudad de México", "Guadalajara", "Monterrey", "Querétaro", "Mérida", "Halifax", "Oaxaca", "Saskatoon", "Puerto Vallarta"];
const PAINS_EN = ["after-hours calls", "online booking", "slow replies to web enquiries", "abandoned carts", "review requests", "no-shows"];
const PAINS_ES = ["las llamadas fuera de horario", "las reservas en línea", "la respuesta a los mensajes", "los carritos abandonados", "las reseñas", "las citas perdidas"];

/**
 * An AI-written pitch in the house voice, from the example lines the composer's
 * prompt gives the writer (lib/pitches/claude-composer.ts language packs).
 */
const COMPOSED = {
  en: {
    subjects: ["where [company] loses online orders", "what [company]'s website isn't doing", "what slow replies cost [company]", "[company]'s checkout is losing phone shoppers"],
    intro: ["Henry from Runna Advertising here. We help independent businesses grow without burning money on ads.", "Quick note from Henry at Runna Advertising. We work with [industry] businesses on exactly this."],
    hook: ["Checked your store: nothing follows up when someone leaves without buying.", "Checked [company]'s site: there's no way to buy anything online.", "Checked your site: there's no way to book after hours, so every visitor at night just leaves."],
    proof: ["We do this kind of work for clinics that get more calls than the front desk can answer: finding where people slip away, then making sure someone always gets back to them.", "The fix is a few emails that go out on their own to everyone who left something in their cart."],
    stat: ["A Harvard Business Review study found firms that reply within the hour are about 7 times more likely to get a real conversation going, and right now yours wait until morning.", "According to Baymard Institute, about 70% of online carts are abandoned before checkout."],
    cta: ["Don't take my word for it, take the data's: run [company] through our free check and see for yourself where [pain] is costing you. About 30 seconds, no signup, no strings: {link}. See something worth fixing? Reply. If not, no harm done.", "I'd rather the numbers show you than me tell you. {link} is a free check of [company]'s own [pain], about 30 seconds, no signup. If you want to talk after, I'm here."],
    industry: ["dental", "law", "hotel", "restaurant", "real estate"],
  },
  es: {
    subjects: ["dónde pierde [company] ventas en línea", "lo que el sitio de [company] no está haciendo", "lo que le cuestan a [company] las respuestas lentas"],
    intro: ["Soy Nils, de Runna Advertising. Ayudamos a negocios independientes a crecer sin quemar dinero en anuncios.", "Nils, de Runna Advertising. Trabajamos con negocios de [industry] justo en esto."],
    hook: ["Revisé tu tienda: nadie le da seguimiento a quien se va sin comprar.", "Revisé el sitio de [company]: no hay forma de comprar nada en línea.", "Revisé tu sitio: no hay forma de agendar fuera de horario, y quien entra de noche se va."],
    proof: ["Hacemos este trabajo para clínicas que reciben más llamadas de las que la recepción alcanza a contestar: encontrar dónde se pierden los pacientes y asegurar que siempre alguien les responda.", "Son unos correos que le llegan solos a quien dejó algo en el carrito."],
    stat: ["Según un estudio de Harvard Business Review, las empresas que responden en menos de una hora tienen unas 7 veces más probabilidades de lograr una conversación real, y hoy las tuyas esperan hasta el día siguiente.", "De acuerdo con Baymard Institute, cerca del 70% de los carritos en línea se abandonan antes de pagar."],
    cta: ["No me creas a mí, créele a los datos: pasa a [company] por nuestro diagnóstico gratuito y ve dónde te está costando [pain]. Unos 30 segundos, sin registro: {link}. ¿Ves algo que valga la pena arreglar? Responde. Si no, no pasa nada.", "Prefiero que te lo muestren los números. {link} es un diagnóstico gratuito de [pain] en [company], unos 30 segundos, sin registro. Si quieres platicar después, aquí estoy."],
    industry: ["salud", "restaurantes", "hoteles", "bienes raíces", "despachos"],
  },
} as const;

type Pitch = { subject: string; body: string; prospect: ExemplarProspect };

function housePitches(n: number, seed: number): Pitch[] {
  const rnd = mulberry32(seed);
  const pick = <T,>(xs: readonly T[]): T => xs[Math.floor(rnd() * xs.length)]!;
  const bms = benchmarks();
  assert.ok(bms.length >= 40, `parsed ${bms.length} benchmarks from 0037`);
  const out: Pitch[] = [];
  for (let i = 0; i < n; i++) {
    const lang = i % 2 === 0 ? "en" : "es";
    const company = `${pick(STEMS)} ${pick(TAILS)}`.trim();
    const label = company.split(" ")[0]!.toLowerCase().normalize("NFD").replace(/[^a-z]/g, "");
    const domain = `${label}.${lang === "en" ? "ca" : "com.mx"}`;
    const given = pick(GIVEN);
    const contact = `${given} ${pick(SURNAMES)}`;
    const city = pick(CITIES);
    const prospect: ExemplarProspect = { company_name: company, domain, website_url: `https://${domain}`, recipient_name: contact, city };
    const input = {
      prospect: { language: lang, industry: pick(INDUSTRIES), company_name: company, website: `https://${domain}`, city },
      contacts: [{ full_name: contact, email: `${given.split(" ")[0]!.toLowerCase()}@${domain}` }],
      deep_pitch_url: null,
    } as unknown as Parameters<typeof renderIndustryTemplate>[0];
    const t = renderIndustryTemplate(input, "test");
    const signature = lang === "en" ? "Henry\nRunna Advertising" : "Nils\nRunna Advertising";
    const kind = i % 6;
    let subject = t.subject;
    let body = t.body;
    if (kind === 1) {
      // The composer's way of citing a sourced benchmark: publisher in a few words, figure as given.
      const b = pick(bms);
      const pub = b.publisher.split(" (")[0]!;
      const line =
        lang === "en"
          ? pick([`A ${pub} study found this: ${b.statistic}`, `According to ${pub}, ${b.statistic.charAt(0).toLowerCase()}${b.statistic.slice(1)}`])
          : pick([`Según un estudio de ${pub}, ${b.figure} es lo que viven negocios como el suyo.`, `De acuerdo con ${pub}, la cifra es ${b.figure}, y eso cambia cuando se responde rápido.`]);
      body = body.replace("\n\n👉", `\n\n${line}\n\n👉`);
    } else if (kind === 2 || kind === 3) {
      const ctx = {
        prospectName: company,
        contactName: rnd() < 0.8 ? given : null,
        originalSubject: t.subject,
        painLabel: rnd() < 0.7 ? pick(lang === "en" ? PAINS_EN : PAINS_ES) : null,
        lang,
        signature,
      } as const;
      ({ subject, body } = kind === 2 ? buildFollowup1(ctx) : buildFollowup2(ctx));
    } else if (kind >= 4) {
      const c = COMPOSED[lang];
      const pain = pick(lang === "en" ? PAINS_EN : PAINS_ES);
      const fill = (x: string) => x.replace(/\[company\]/g, company).replace(/\[industry\]/g, pick(c.industry)).replace(/\[pain\]/g, pain).replace("{link}", "https://runna-hunter.vercel.app/?r=x");
      subject = fill(pick(c.subjects));
      const hi = lang === "en" ? `Hi ${given.split(" ")[0]},` : `Hola ${given.split(" ")[0]},`;
      body = [hi, "", fill(pick(c.intro)), "", `${fill(pick(c.hook))} ${fill(pick(c.proof))}`, ...(kind === 5 ? ["", fill(pick(c.stat))] : []), "", fill(pick(c.cta)), "", signature].join("\n");
    }
    out.push({ subject, body, prospect });
  }
  return out;
}

const N = 240;

test(`drop rate: ${N} clean house-style pitches (industry and follow-up templates, 0037 benchmarks), EN and ES; ≤ 10% dropped`, () => {
  const pitches = housePitches(N, 20261018);
  let dropped = 0;
  const tokens = new Map<string, number>();
  for (const [i, p] of pitches.entries()) {
    const e = toExemplar({ pitch_id: `h${i}`, score: 1 }, { subject: p.subject, body: p.body, ...p.prospect });
    if (e) continue;
    dropped++;
    const leaks = [
      ...exemplarLeaks(scrubExemplar(p.subject, p.prospect), p.prospect, { subject: true }),
      ...exemplarLeaks(scrubExemplar(p.body, p.prospect), p.prospect),
    ];
    for (const l of new Set(leaks)) tokens.set(l, (tokens.get(l) ?? 0) + 1);
  }
  const top = [...tokens].sort((a, b) => b[1] - a[1]).slice(0, 10);
  console.log(`drop rate: ${dropped}/${N} (${((100 * dropped) / N).toFixed(1)}%); top dropping tokens: ${top.map(([t, c]) => `${t}×${c}`).join(", ") || "none"}`);
  assert.ok(dropped / N <= 0.1, `dropped ${dropped}/${N}: ${top.map(([t, c]) => `${t}×${c}`).join(", ")}`);
});

// ── Round 5: positions, the names net, the address as a name, letter-like symbols ──

const ARBOL: ExemplarProspect = { company_name: "Arbol Rojo Consultores", domain: "arbolrojo.mx", recipient_name: "Ximena Quiroga", city: "Puebla" };
const wrap = (line: string) => `Hi there,\n\n${line}\n\nHenry\nRunna Advertising`;
/** Kept with nothing of `forbidden` left, or dropped: both are safe. */
function keptWith(subject: string, body: string, p: ExemplarProspect, forbidden: readonly string[]): string | null {
  const e = toExemplar({ pitch_id: "x", score: 1 }, { subject, body, ...p });
  if (!e) return null;
  const text = `${e.subject}\n${e.body}`.normalize("NFKD").replace(/\p{M}/gu, "").toLowerCase();
  const hit = forbidden.find((f) => text.includes(f.normalize("NFKD").replace(/\p{M}/gu, "").toLowerCase()));
  return hit ? `${hit} in: ${e.subject} | ${e.body}` : null;
}

test("S1: a name after an initial, a short title or a colon is mid-sentence, and all capitals are strict", () => {
  const kept: string[] = [];
  for (const n of ["M. Peña", "J. Torres", "A. Lee", "R. Flores", "D. Grant", "A.J. Cruz", "M.V.Z. Flores", "Q.F.B. Torres", "Nut. Cruz", "Rev. Grant", "Hon. Lee"]) {
    const r = keptWith("evening calls", wrap(`We heard from ${n} about the evening calls.`), ARBOL, [n.split(" ").pop()!]);
    if (r) kept.push(r);
  }
  for (const [body, name] of [
    [wrap("La recepción de C.D. Torres no contesta de noche."), "Torres"],
    [wrap("Front desk: Grant, every evening."), "Grant"],
    [wrap("ROSA dijo que nadie contesta."), "rosa"],
    [wrap("TORRES runs the front desk."), "torres"],
    [wrap("GRANT HILL answers the phone."), "grant"],
  ] as const) {
    const r = keptWith("evening calls", body, ARBOL, [name]);
    if (r) kept.push(r);
  }
  assert.deepEqual(kept, []);
  // A real sentence start still allows a name that is a common word.
  assert.ok(toExemplar({ pitch_id: "x", score: 1 }, { subject: "evening calls", body: wrap("Calls go unanswered. Mark the date for the change."), ...ARBOL }));
});

test("S2: a given name that is no common word drops at a sentence start; a lower-case real word passes", () => {
  const kept: string[] = [];
  for (const [body, name] of [
    ["Hola,\n\nLas llamadas se pierden de noche. Guadalupe dijo lo mismo la semana pasada.\n\nNils", "guadalupe"],
    [wrap("Amparo contesta el teléfono hasta las seis."), "amparo"],
    [wrap("Jazmín lleva la agenda de la clínica."), "jazmin"],
  ] as const) {
    const r = keptWith("llamadas", body, ARBOL, [name]);
    if (r) kept.push(r);
  }
  assert.deepEqual(kept, []);
});

test("S2: ordinary words from real pitches pass in lower case", () => {
  // The conductor's re-measure on 30 prod pitches: ordinary words that dropped them (round 4).
  const words = ["corresponda", "asesoria", "trabas", "traba", "availability", "spec", "monitoreo", "compiten", "agendaron",
    "armariamos", "asesorando", "calificarlas", "califica", "resolviste", "confiaron", "desktop", "usable", "multi", "storefront",
    "outage", "enthusiasts", "rigging", "fabrication", "skus", "mro", "jobsite", "handrail", "woodworking", "bandsaw", "tutorials",
    "oftalmologia"];
  const none: ExemplarProspect = { company_name: null, domain: null, recipient_name: null };
  assert.deepEqual(words.filter((w) => exemplarLeaks(`we saw ${w} on the site`, none).length > 0), []);
});

test("S2: third-party names, places and acronyms in real pitches still drop", () => {
  const none: ExemplarProspect = { company_name: "Bluefin Plumbing", domain: "bluefin.ca", recipient_name: "Sean Ng", city: null };
  for (const line of ["Clients of Zona Benessere book at night.", "Shops like MEC sell online.", "Brands like Fjällräven ship fast.",
    "Shops in the Bulkley Valley close early.", "The team at IRT answers by phone.", "Most clinics in Monterrey answer by phone."]) {
    assert.equal(toExemplar({ pitch_id: "x", score: 1 }, { subject: "evening calls", body: wrap(line), ...none }), null, line);
  }
});

test("S3: O'Brien and friends are one word, anywhere", () => {
  for (const n of ["O’Brien", "O'Brien", "O’Connor", "O’Neill", "O’Reilly", "O’Hara", "O’Grady", "O’Dell"]) {
    for (const [subject, body] of [[`a note for ${n}`, wrap("Calls go unanswered.")], ["evening calls", wrap(`We spoke with ${n} today.`)], ["evening calls", wrap(`${n} runs the desk.`)]] as const) {
      assert.equal(toExemplar({ pitch_id: "x", score: 1 }, { subject, body, ...ARBOL }), null, `${n}: ${subject} | ${body}`);
    }
  }
});

test("S4: with no contact name, the address's given name is a field: scrubbed, or the exemplar drops", () => {
  const p: ExemplarProspect = { company_name: "Clínica Dental Sonrisa", domain: "sonrisadental.mx", recipient_name: null, recipient_email: "monica@sonrisadental.mx", city: "Puebla" };
  const subject = "lo que le cuestan a Clínica Dental Sonrisa las respuestas lentas";
  for (const last of ["", " Escobar"]) {
    const body = `Hola Monica,\n\nSoy Nils, de Runna Advertising. Revisé tu sitio: no hay forma de agendar fuera de horario.\n\nSi quieres, Monica${last}, lo vemos en una llamada corta.\n\nNils\nRunna Advertising`;
    assert.equal(keptWith(subject, body, p, ["monica", "escobar", "sonrisa"]), null, last);
  }
  assert.equal(scrubExemplar("Si quieres, Monica, lo vemos.", p), "Si quieres, [name], lo vemos.");
  // A role inbox is not a name.
  assert.equal(scrubExemplar("Las citas se agendan por correo.", { ...p, recipient_email: "citas@sonrisadental.mx" }), "Las citas se agendan por correo.");
});

test("S5: letters drawn as symbols and visible in-word separators drop the exemplar", () => {
  const kept: string[] = [];
  const smile: ExemplarProspect = { company_name: "🅢🅜🅘🅛🅔 Dental", domain: "smiledental.ca", recipient_name: "Sean Ng", city: "Calgary" };
  if (toExemplar({ pitch_id: "x", score: 1 }, { subject: "evening calls", body: wrap("The team at 🅢🅜🅘🅛🅔 Dental answers by phone."), ...smile })) kept.push("🅢🅜🅘🅛🅔");
  for (const s of ["🅟🅐🅣🅔🅛", "🅿🅰🆃🅴🅻", "\u{1f1f5}\u{1f1e6}\u{1f1f9}\u{1f1ea}\u{1f1f1}", "⒫⒜⒯⒠⒧", "Wil·son", "Wiŀson", "Pa‧tel", "Pa᠆tel", "Pa⠀tel"]) {
    if (toExemplar({ pitch_id: "x", score: 1 }, { subject: "evening calls", body: wrap(`We spoke with ${s} today.`), ...ARBOL })) kept.push(s);
  }
  assert.deepEqual(kept, []);
});

test("reviewer probes: common names capitalized mid-sentence drop", () => {
  const names = ["Pedro", "Mónica", "Claudia", "Carmen", "Héctor", "Arturo", "Liam", "Emma", "Olivia", "Peter", "Chris", "Graham",
    "Kennedy", "Gordon", "Cameron", "Ferguson", "Sinclair", "Morrison", "Henderson", "Wallace", "Chan", "Huang", "Leung", "Cheung",
    "Lau", "Yip", "Sharma", "Gupta", "Kumar", "Méndez", "Bautista", "Cortés", "Ávila", "Carrillo", "Acosta", "Escobar", "Salinas"];
  const kept = names.filter((n) => toExemplar({ pitch_id: "x", score: 1 }, { subject: "evening calls", body: wrap(`We spoke with ${n} about the evening calls.`), ...ARBOL }));
  assert.deepEqual(kept, []);
});

/**
 * Held out: written for this test from general knowledge of names common in
 * Canada and Mexico, NOT taken from the SSA or Census lists that build the
 * names net (lib/pitches/wordlists/names.ts), and not the reviewer's list.
 */
const HELD_OUT = [
  // Mexican given names.
  "Alejandro", "Fernanda", "Rodrigo", "Itzel", "Valentina", "Santiago", "Regina", "Emiliano", "Renata", "Diego", "Mariana", "Joaquín",
  "Paola", "Leonardo", "Andrea", "Iker", "Camila", "Mateo", "Montserrat", "Sebastián", "Daniela", "Gerardo", "Yolanda", "Rubén",
  "Araceli", "Ignacio", "Verónica", "Eduardo", "Leticia", "Ricardo", "Beatriz", "Fidel", "Graciela", "Octavio", "Rocío", "Xóchitl",
  // Mexican surnames.
  "Hernández", "Martínez", "Ramírez", "Vázquez", "Morales", "Jiménez", "Ruiz", "Domínguez", "Gutiérrez", "Ortega", "Delgado", "Castañeda",
  "Mejía", "Ríos", "Sandoval", "Guerrero", "Cervantes", "Ibarra", "Zamora", "Cárdenas", "Velázquez", "Maldonado", "Fuentes", "Pacheco",
  "Ochoa", "Navarro", "Espinoza", "Valdez", "Contreras", "Lozano", "Barrera", "Arellano", "Zúñiga", "Trujillo", "Galindo", "Saldaña",
  // English-Canadian given names and surnames.
  "Brandon", "Courtney", "Dylan", "Hailey", "Logan", "Madison", "Owen", "Paige", "Tyler", "Brianna", "Connor", "Kayla",
  "MacLeod", "MacKinnon", "McLean", "Campbell", "Stewart", "Robertson", "Thomson", "Fraser", "Gillespie", "Murray", "Douglas", "Bennett",
  "Sutherland", "Matheson", "Chisholm", "Patterson", "Forsyth", "Dunlop", "Lindsay", "Buchanan", "McAllister", "Kerr", "Duncan", "Hamilton",
  // French-Canadian.
  "Gagnon", "Bouchard", "Gauthier", "Lavoie", "Fortin", "Gagné", "Ouellet", "Pelletier", "Bélanger", "Lévesque", "Bergeron", "Leblanc",
  "Girard", "Simard", "Boucher", "Caron", "Beaulieu", "Cloutier", "Poirier", "Fournier", "Lapointe", "Leclerc", "Lefebvre", "Mercier",
  "Thibault", "Dufour", "Lachance", "Desrosiers", "Paquette", "Charbonneau", "Mélanie", "Geneviève", "Sébastien", "Mathieu", "Étienne", "Josée",
  // Chinese-Canadian.
  "Wong", "Chen", "Li", "Zhang", "Liu", "Wang", "Yang", "Zhao", "Wu", "Zhou", "Xu", "Sun",
  "Ma", "Zhu", "Hu", "Guo", "He", "Lin", "Luo", "Liang", "Song", "Tang", "Feng", "Deng",
  "Cheng", "Tsang", "Kwan", "Fong", "Ho", "Tam", "Yuen", "Mok", "Siu", "Chu", "Lo", "Kwok",
  // South Asian Canadian.
  "Singh", "Kaur", "Gill", "Sandhu", "Dhillon", "Grewal", "Sidhu", "Brar", "Sekhon", "Bains", "Mann", "Johal",
  "Patel", "Shah", "Desai", "Mehta", "Joshi", "Rao", "Reddy", "Iyer", "Nair", "Pillai", "Menon", "Krishnan",
  "Banerjee", "Chatterjee", "Mukherjee", "Bose", "Das", "Ghosh", "Khan", "Ahmed", "Hussain", "Malik", "Qureshi", "Siddiqui",
  "Anjali", "Deepak", "Harpreet", "Gurpreet", "Manpreet", "Navdeep", "Rajesh", "Sunita", "Vikram", "Arjun", "Divya", "Pooja",
];

test(`held-out names: ${HELD_OUT.length} names capitalized mid-sentence are dropped or scrubbed (≥ 98%)`, () => {
  const misses = HELD_OUT.filter((n) => keptWith("evening calls", wrap(`We spoke with ${n} about the evening calls.`), ARBOL, [n]));
  console.log(`held-out names: ${HELD_OUT.length - misses.length}/${HELD_OUT.length} caught; misses: ${misses.join(", ") || "none"}`);
  assert.ok(HELD_OUT.length >= 200);
  assert.ok(misses.length / HELD_OUT.length <= 0.02, `misses: ${misses.join(", ")}`);
});

// ── Round 6: the review's probes ──────────────────────────────────────────────

test("R6.1: handles and bare domains are blanked as [site]; any address left drops the exemplar", () => {
  const kept: string[] = [];
  for (const line of ["Escríbeles a @torres o @vega.", "Ver instagram.com/peña.dental para citas.", "Su sitio vega-dental.com no agenda.",
    "Síguelos en @chan.dental hoy.", "La clínica luna.dental no contesta.", "Pregunta por dr_torres en recepción."]) {
    const r = keptWith("llamadas", wrap(line), ARBOL, ["torres", "vega", "pena", "chan", "luna"]);
    if (r) kept.push(r);
  }
  assert.deepEqual(kept, []);
  assert.equal(scrubExemplar("Ver instagram.com/peña.dental.", ARBOL), "Ver [site].");
  assert.equal(scrubExemplar("Escríbeles a @torres o @vega.", ARBOL), "Escríbeles a [site] o [site].");
});

test("R6.2: the name deny beats our vocabulary: Spanish month names, Quintana, title-case acronyms", () => {
  const kept: string[] = [];
  for (const line of ["Los pacientes mencionan a Julio en las reseñas.", "Hola,\n\nAbril contesta el teléfono.", "Lo dijeron Abril y Domingo ayer.",
    "Trabajamos con Quintana y Asociados.", "Habla con Seo sobre las citas.", "Pregúntale a Ota por la recepción."]) {
    if (toExemplar({ pitch_id: "x", score: 1 }, { subject: "llamadas", body: wrap(line), ...ARBOL })) kept.push(line);
  }
  assert.deepEqual(kept, []);
  // The whole phrase, the acronyms in capitals or lower case, and the months that are no name still pass.
  for (const line of ["Hoteles en Quintana Roo pagan comisión a las OTA.", "El SEO de una clínica en marzo.", "Hoteles en Nuevo León y el seo local."]) {
    assert.ok(toExemplar({ pitch_id: "x", score: 1 }, { subject: "comisiones de ota", body: wrap(line), ...ARBOL }), line);
  }
});

test("R6.3: the scrubber blanks the name the greeting reads from the address; the leak check reads any local part", () => {
  for (const [email, name] of [["memo@sonrisadental.mx", "Memo"], ["chema@sonrisadental.mx", "Chema"], ["nacho@sonrisadental.mx", "Nacho"], ["toño@sonrisadental.mx", "Toño"]] as const) {
    const p: ExemplarProspect = { company_name: "Clínica Dental Sonrisa", domain: "sonrisadental.mx", recipient_name: null, recipient_email: email, city: "Puebla" };
    const body = `Hola ${name},\n\nSoy Nils, de Runna Advertising.\n\nSi quieres, ${name}, lo vemos en una llamada corta.\n\nNils\nRunna Advertising`;
    assert.equal(keptWith("una llamada corta", body, p, [name]), null, email);
    assert.equal(scrubExemplar(`Si quieres, ${name}, lo vemos.`, p), "Si quieres, [name], lo vemos.", email);
  }
  // An address the greeting would not use ("vfournier@") is still a name to the leak check.
  const vf: ExemplarProspect = { company_name: null, domain: null, recipient_name: null, recipient_email: "vfournier@julien.ca" };
  assert.notDeepEqual(exemplarLeaks("ask vfournier about it", vf), []);
});

test("R6.4: a title or any capitalized word before a dot never opens a sentence for the next capital", () => {
  const kept: string[] = [];
  for (const line of ["La recepción la lleva la Profa. Torres desde marzo.", "Lo atiende el Fisio. Torres por la tarde.", "Firmó el Notar. Torres.",
    "Lo revisa el Contad. Torres cada mes.", "Lo vimos con Runna. Torres dijo que sí."]) {
    const r = keptWith("llamadas", wrap(line), ARBOL, ["torres"]);
    if (r) kept.push(r);
  }
  assert.deepEqual(kept, []);
});

test("R6.5: everyday words the old dictionaries missed pass in lower case", () => {
  const none: ExemplarProspect = { company_name: null, domain: null, recipient_name: null };
  const words = ["forth", "haga", "vea", "vida", "debo", "cierra", "math", "fallen"];
  assert.deepEqual(words.filter((w) => exemplarLeaks(`and so ${w} again`, none).length > 0), []);
});

test("R6.6: Hispanic and Asian surnames count as strong; weak names are exempt only among the 3,000 most frequent words", () => {
  const names = ["Ding", "Tao", "Kan", "Sen", "Raja", "Pilar", "Serge", "Vega", "Luna", "Mora", "Rivas", "Campos", "Soto", "Toledo", "Parra"];
  const kept = names.filter((n) => toExemplar({ pitch_id: "x", score: 1 }, { subject: "evening calls", body: wrap(`We spoke with ${n} about the evening calls.`), ...ARBOL }));
  assert.deepEqual(kept, []);
});

test("R6.7: lower-case subject words are judged where a name would stand", () => {
  for (const subject of ["una nota para torres", "lo que vega pierde de noche", "a note for okafor"]) {
    assert.equal(toExemplar({ pitch_id: "x", score: 1 }, { subject, body: wrap("Calls go unanswered."), ...ARBOL }), null, subject);
  }
  // Our own template subjects stay ("book", "brand", "cuesta", "worth" are words there).
  for (const subject of ["patients who look but never book", "what a scattered brand is costing [company]", "lo que te cuesta el marketing", "what empty nights are worth"]) {
    assert.ok(toExemplar({ pitch_id: "x", score: 1 }, { subject, body: wrap("Calls go unanswered."), ...ARBOL }), subject);
  }
});

test("optional: odd spaces between letters drop the exemplar", () => {
  for (const s of ["Pa tel", "Pa　tel", "Pa tel"]) {
    assert.equal(toExemplar({ pitch_id: "x", score: 1 }, { subject: "evening calls", body: wrap(`We spoke with ${s} today.`), ...ARBOL }), null, JSON.stringify(s));
  }
});
