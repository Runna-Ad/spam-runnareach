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
      if (toExemplar({ pitch_id: "x", score: 1 }, { subject, body, ...OTHER })) kept.push(`${s} | ${subject} | ${body.split("\n")[2]}`);
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
