/**
 * Content rules shared by the pitch composer (score) and the send gate (hold).
 *
 * One list, two consumers: the composer docks its self-score for each hit so a
 * bad draft sorts low, and the gate holds the email so it can't go out. They
 * used to be separate lists that drifted (the prompt banned words the backstop
 * never checked).
 *
 * Pure — no imports beyond the language. Tested in tests/send-gate.test.ts.
 */

/**
 * Words and phrases a prospect-facing email in that language must not contain:
 * jargon a business owner doesn't speak, hype, stock openers, and the other
 * language bleeding in. Matched as lower-cased substrings, so every entry is
 * chosen not to hide inside an ordinary word (" leads" keeps its space so it
 * doesn't match "liderazgo").
 */
export const BANNED_TERMS: Record<"en" | "es", readonly string[]> = {
  es: [
    // Language mixing / template openers
    "hola there",
    "i hope",
    "best regards",
    "dear ",
    // English jargon in Spanish emails (each is jargon AND language-mixing)
    "abandonment",
    "retention automation",
    "default setup",
    "meta pixel",
    "woocommerce",
    "shopify",
    "funnel",
    " leads",
    "engagement",
    "intake",
    "triage",
    "workflow",
    "pipeline",
    "onboarding",
    "lead capture",
    "smart intake",
    // Agency labels (Pedro, 2026-07-24)
    "el fix aquí",
    "el fix aqui",
    "diagnosticar el patrón",
    "lo que mueve la aguja",
    "me permito contactarle",
  ],
  en: [
    // Spanish bleed-through
    "vale la pena",
    "marca",
    "tienda",
    // Corporate / American hype
    "synergy",
    "leverage",
    "best-in-class",
    "circle back",
    "thought leader",
    "unlock ",
    "supercharge",
    "game-changer",
    "game changer",
    // Stock openers
    "i hope this finds you",
    "just reaching out",
    "quick question",
    // Marketing/tech jargon a business owner doesn't speak (Pedro, 2026-07-24:
    // "write to people who know nothing about marketing").
    "intake",
    "triage",
    "workflow",
    "routing",
    " leads",
    "lead capture",
    "lead-gen",
    "lead gen",
    "qualified lead",
    "bandwidth",
    "streamline",
    "seamless",
    "optimize",
    "optimization",
    "conversion",
    "systems problem",
    "funnel",
    "pipeline",
  ],
};

/**
 * Every banned term present in `text` (subject or body), in list order. The
 * prospect's own company name is ignored ("Tienda Norte" is not Spanish bleed).
 */
export function findBannedTerms(text: string, lang: "en" | "es", companyName?: string | null): string[] {
  let lower = text.toLowerCase();
  const company = companyName?.trim().toLowerCase();
  if (company && company.length >= 2) lower = lower.split(company).join(" ");
  const hits = BANNED_TERMS[lang].filter((term) => lower.includes(term));
  // "hola" needs a word boundary in English — includes("hola") false-positives
  // on company names like "HolaFly" or "Shola".
  if (lang === "en" && /\bhola\b/.test(lower)) hits.push("hola");
  return hits;
}

/**
 * Numbers that are TRUE facts about Rünna or the offer, so they may appear in
 * any email without a per-prospect source:
 *   - the Inefficiency Hunter takes about 30 seconds;
 *   - Rünna has been doing this for 12 years (Pedro's template copy);
 *   - a website pitch promises 2–3 weeks and a site that works 24/7;
 *   - the ask is a 20-minute call (follow-up templates).
 * Anything else with a digit in it must trace to the prospect's own evidence or
 * an active, human-verified benchmark. Add a phrase here only when it is a fact
 * we would defend to the reader.
 */
export const RUNNA_FACT_PHRASES: readonly RegExp[] = [
  /\b30[\s-]*(?:seconds?|segundos?|second|sec)\b/gi,
  /\b12\s*(?:years|años)\b/gi,
  /\b2\s*(?:[–-]|to|o|a)\s*3\s*(?:weeks|semanas)\b/gi,
  /\b24\/7\b/g,
  /\b20[\s-]*(?:minutes?|minutos?|min)\b/gi,
];

/** Spelled-out multiples and percentages: claims a digit scan would miss. */
const SPELLED_CLAIMS: readonly RegExp[] = [
  // "three times more likely", not "copy-pasted three times".
  /\b(?:two|three|four|five|six|seven|eight|nine|ten)\s+times\s+(?:more|less|as|higher|lower|faster|the)\b/gi,
  /\b(?:two|three|four|five|six|seven|eight|nine|ten)\s+in\s+(?:ten|10)\b/gi,
  /\b(?:twice|double|triple)\s+(?:as|the)\b/gi,
  /\b\w+\s+percent\b/gi,
  /\b(?:dos|tres|cuatro|cinco|seis|siete|ocho|nueve|diez)\s+(?:veces\s+(?:m[aá]s|menos)|de\s+cada\s+(?:diez|10))\b/gi,
  /\b(?:el\s+doble|el\s+triple)\b/gi,
  /\bpor\s+ciento\b/gi,
];

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Lower-case and strip accents so "Más" matches "mas". */
export function fold(s: string): string {
  return s.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "");
}

/**
 * Every number-like claim in `text` that no source backs.
 *
 * Removed before scanning: URLs and email addresses (the CTA link carries
 * parameters like v=1), the company's own name ("43 North Restaurant Group"),
 * and RUNNA_FACT_PHRASES. Each remaining digit run is sourced only when the same
 * standalone number appears in a source string (evidence quote or benchmark).
 * Spelled-out multiples ("seven times", "siete de cada diez") are sourced only
 * when the phrase itself appears in a source.
 *
 * v1 of the gate checked only the FIRST number in the body and never the
 * subject, so "20–30% of inbound requests" passed whenever an earlier number
 * happened to be sourced.
 */
/**
 * Write numbers one way so "44K", "44,000" and "44000" compare equal:
 * thousands separators dropped, a k/K suffix expanded.
 */
export function normalizeNumbers(s: string): string {
  return s
    .replace(/\b\d{1,3}(?:,\d{3})+\b/g, (m) => m.replace(/,/g, ""))
    .replace(/\b(\d+(?:\.\d+)?)\s?[kK]\b/g, (_, n: string) => String(Math.round(Number(n) * 1000)));
}

export function findUnsourcedNumbers(
  text: string,
  opts: { sources: readonly string[]; companyName?: string | null },
): string[] {
  let scrubbed = normalizeNumbers(text)
    .replace(/https?:\/\/\S+/gi, " ")
    .replace(/[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g, " ");
  if (opts.companyName && opts.companyName.trim().length >= 2) {
    scrubbed = scrubbed.replace(new RegExp(escapeRegExp(opts.companyName.trim()), "gi"), " ");
  }
  for (const re of RUNNA_FACT_PHRASES) scrubbed = scrubbed.replace(re, " ");
  // Times of day ("at 10pm", "después de las 6 p.m.") describe when, not how much.
  scrubbed = scrubbed.replace(/\b\d{1,2}(?::\d{2})?\s?(?:am|pm|a\.\s?m\.|p\.\s?m\.|hrs|h)(?![a-z])/gi, " ");

  // The company's own name is a source too: "Hi 43 North team" shortens
  // "43 North Restaurant Group", so whole-name scrubbing alone misses it.
  const haystack = fold(normalizeNumbers([...opts.sources, opts.companyName ?? ""].join(" \n ")));
  const unsourced: string[] = [];

  // A digit glued to a letter on its left is part of a name or code (B2B,
  // H2O, Q3), and 1st/2nd/3rd are ordinals; neither is a quantity claim.
  for (const m of scrubbed.matchAll(/(?<![\p{L}\d])\d+(?:[.,]\d+)?(?!st\b|nd\b|rd\b|th\b)/gu)) {
    const num = m[0];
    // A bare year ("in 2026") dates a sentence; it isn't a statistic.
    const after = scrubbed.slice((m.index ?? 0) + num.length, (m.index ?? 0) + num.length + 3);
    if (/^(?:199\d|20\d\d)$/.test(num) && !/^\s?(?:%|x\b|k\b)/i.test(after)) continue;
    // The bare number must appear standalone in a source: "3" in "takes 3
    // screens" counts, the "3" inside "2023" does not.
    const standalone = new RegExp(`(^|[^\\d.,])${escapeRegExp(num)}(?![\\d]|[.,]\\d)`);
    if (!standalone.test(haystack)) {
      // Report it with its unit ("25%", "$4", "3x") so the detail is readable.
      const start = m.index ?? 0;
      const around = scrubbed.slice(Math.max(0, start - 1), start + num.length + 8);
      const label = around.match(/\$?\s?\d+(?:[.,]\d+)?\s?(?:%|x\b|k\b|times|veces|percent)?/i)?.[0] ?? num;
      unsourced.push(label.trim());
    }
  }

  const foldedText = fold(scrubbed);
  for (const re of SPELLED_CLAIMS) {
    for (const m of foldedText.matchAll(re)) {
      if (!haystack.includes(m[0])) unsourced.push(m[0]);
    }
  }

  return Array.from(new Set(unsourced));
}

/**
 * Names that must never appear in a cold email: clients (Pedro, 2026-07-22) and
 * Rünna's internal products ("S.P.A.M." in a cold email is self-referential and
 * a spam-filter word in its own right).
 */
export const INTERNAL_NAMES: readonly RegExp[] = [
  /\bS\.\s?P\.\s?A\.\s?M\.?/i,
  /\bsnap\s?pad\b/i,
  // The builds the showcase email describes (lib/runna/builds.ts), by their
  // product names: the email says what each one does, never what it's called.
  /\bgreenlight\b/i,
  /\bbrook\s?book\b/i,
  /\bsnap\s?track\b/i,
  /\bmatch\s?bot\b/i,
  /\bcommand\s+cent(?:er|re)\b/i,
  /\bbarcode\s+studio\b/i,
  /\bHÜE\b/,
  /\bR[üu]nna\s+Social\b/i,
];

/**
 * Internal product names present in `text`. The prospect's own words are
 * removed first (company name, site name, evidence quotes): "Greenlight
 * Dental" is a business, not our portal, and must not hold its every email.
 */
export function findInternalNames(text: string, context: ReadonlyArray<string | null | undefined> = []): string[] {
  let scrubbed = text;
  // Whole words, 3+ characters: a company called "Snap" must not cut "SnapTrack" in half.
  for (const c of context) {
    const t = c?.trim();
    if (t && t.length >= 3) scrubbed = scrubbed.replace(new RegExp(`(?<![\\p{L}\\d])${escapeRegExp(t)}(?![\\p{L}\\d])`, "giu"), " ");
  }
  return INTERNAL_NAMES.map((re) => scrubbed.match(re)?.[0]).filter((x): x is string => Boolean(x));
}

/** Strip accents but keep case: "Aeroméxico" → "Aeromexico". */
function deaccent(s: string): string {
  return s.normalize("NFD").replace(/[\u0300-\u036f]/g, "");
}

/**
 * Client names present in `text`, matched whole-word, accent-insensitive and
 * CASE-SENSITIVE as the name is written. Several client names are ordinary
 * words or first names (Lila, Niki, Ford, "El Club"), so a case-insensitive
 * match would hold "el club de golf" or a contact called Lila. A model naming
 * a client writes it the way the brand does, which is what this catches.
 *
 * Skipped: names that appear in `context` — the prospect's own company name,
 * site name, evidence and recipient name. A Ford dealer's own site says "Ford";
 * that is about them, not a client brag.
 */
export function findClientNames(
  text: string,
  clientNames: readonly string[],
  context: readonly (string | null | undefined)[] = [],
): string[] {
  const hay = deaccent(text);
  const ctx = fold(context.filter(Boolean).join(" \n "));
  const hits: string[] = [];
  for (const raw of clientNames) {
    const name = raw.trim();
    if (name.length < 2) continue;
    if (ctx.includes(fold(name))) continue;
    const re = new RegExp(`(^|[^\\p{L}\\p{N}])${escapeRegExp(deaccent(name))}(?![\\p{L}\\p{N}])`, "u");
    if (re.test(hay)) hits.push(name);
  }
  return hits;
}

// ── Claims we can't prove (CrushCamp, 2026-11-09) ───────────────────────────
// The writer is never given an absence (lib/pitches/proven-facts.ts), so any
// "I didn't see…" is invented, and "we work with [studios]" claims clients we
// may not have. Code holds both: two AI review passes let CrushCamp's through.

// Spanish words end where no letter follows (\b only knows ASCII letters).
const ES_END = String.raw`(?![\p{L}])`;

// What a site or a listing has, so "there's no…" / "no hay…" claims they lack
// it. A noun list, never "anything but…": "There's no rush / fee / contract",
// "you have no setup to do", "no hay ningún compromiso", "no hay nada que
// instalar" and "no tienen nada que perder" reassure, they claim nothing.
const FEATURE_NOUNS_EN = String.raw`(?:(?:booking|way|option|button|form|link|page|place|cart|shop|store|chat|website|site|menu|schedule|calendar|contact)s?|online|price(?:s|ing)?|hours)`;
const FEATURE_NOUNS_ES = String.raw`(?:reservas|reservaciones|citas|formas?|maneras?|opci(?:[óo]n|ones)|bot(?:[óo]n|ones)|formularios?|p[áa]ginas?|sitios?|tiendas?|carritos?|chat|precios|horarios?|calendarios?|contacto)`;
// Up to two of these may sit in between: "there's no easy way", "no hay ningún botón", "no hay en línea una forma".
const FEATURE_LEAD_EN = String.raw`(?:(?:a|an|any|easy|simple|quick|clear|obvious|direct|real|single|online|mobile)\s+){0,2}`;
const FEATURE_LEAD_ES = String.raw`(?:(?:un|una|ning[úu]n|ninguna|alg[úu]n|alguna|otra|otro|sola|solo|en\s+l[íi]nea)\s+){0,2}`;

type ClaimRule = {
  re: RegExp;
  /**
   * A clause opened by "when / if / cuando / si…" says what tends to happen
   * ("When customers can't book online after hours, most try somewhere
   * else", "Si un negocio no cuenta con reservas en línea…"), so it is no
   * claim, unless it names them ("Cuando entré a su sitio no hay forma…").
   */
  generalOk?: boolean;
};

const ABSENCE_CLAIMS: readonly ClaimRule[] = [
  { re: /\bI (?:didn'?t|did not|couldn'?t|could not|wasn'?t able to|was not able to) (?:see|find|spot|notice)\b/i },
  { re: new RegExp(String.raw`\b(?:there'?s|there is|there are) no\s+${FEATURE_LEAD_EN}${FEATURE_NOUNS_EN}\b`, "i"), generalOk: true },
  { re: new RegExp(String.raw`\byou have no\s+${FEATURE_LEAD_EN}${FEATURE_NOUNS_EN}\b`, "i") },
  { re: new RegExp(String.raw`\bthere (?:isn'?t|is not|aren'?t|are not)\s+${FEATURE_LEAD_EN}${FEATURE_NOUNS_EN}\b`, "i") },
  { re: /\byou (?:don'?t|do not) (?:have|offer|show|list)\b(?! to\b)/i },
  { re: /\byou'?re missing\b/i },
  // Their customers ("your customers can't book"), never customers in general
  // ("most customers can't wait"); the company name joins in findAbsenceClaims.
  { re: /\b(?:your|tus|sus) (?:customers|clients|people|visitors) (?:can'?t|cannot) (?:book|buy|pay|order|reach)\b/i, generalOk: true },
  // "Your Google listing doesn't show a website" too: discovery can miss a site for many reasons (website-v3).
  { re: /\byour (?:site|website|page|home ?page|(?:google )?listing) (?:doesn'?t|does not|isn'?t|is not|lacks|has no)\b/i },
  // No trailing \b: it only knows ASCII letters, so "encontré" never ended a word.
  { re: /\bno (?:vi|veo|encontr[ée]|encuentro|logr[ée] (?:ver|encontrar))(?![a-záéíóúñü])/i },
  { re: /\bno pude (?:ver|encontrar)(?![a-záéíóúñü])/i },
  { re: /\bno se ven?(?![a-záéíóúñü])/i },
  { re: /\bno cuenta[ns]? con(?![a-záéíóúñü])/i, generalOk: true },
  { re: new RegExp(String.raw`\bno (?:tienes|tiene|tienen)\s+${FEATURE_LEAD_ES}${FEATURE_NOUNS_ES}${ES_END}`, "iu") },
  { re: new RegExp(String.raw`\bles faltan?${ES_END}`, "iu") },
  { re: new RegExp(String.raw`\bno pueden (?:agendar|reservar|comprar|pagar)${ES_END}`, "iu"), generalOk: true },
  { re: new RegExp(String.raw`\bno hay\s+${FEATURE_LEAD_ES}${FEATURE_NOUNS_ES}${ES_END}`, "iu"), generalOk: true },
  // "Su sitio no muestra precios"; never the conditional "si su sitio no carga…".
  { re: /(?<!\bsi )\b(?:tu|su) (?:sitio|p[áa]gina|ficha)(?: web| de google)? no\b/i },
  { re: /\bsin (?:forma|manera) de\b/i },
];

// "We / I work with…" is a track record only when a kind of business follows
// within five words ("we work with independent fitness studios"), or "like
// you/yours". "We work with what you already use", "we work with small teams
// so nobody…" and "we work with the people on your team" are how we work, so
// "teams" and "people" are no business nouns here ("people we talk to" still is).
const BUSINESS_NOUNS_EN =
  "businesses|companies|studios|clinics|firms|practices|shops|stores|brands|owners|restaurants|gyms|hotels|agencies|manufacturers|distributors|retailers|schools|contractors|dealers";
const BUSINESS_NOUNS_ES =
  "negocios|empresas|estudios|cl[ií]nicas|despachos|consultorios|tiendas|comercios|marcas|due[ñn]os|restaurantes|gimnasios|hoteles|agencias|fabricantes|distribuidor(?:es|as)|minoristas|escuelas|contratistas|concesionarias|personas";
const UP_TO_4_WORDS = String.raw`(?:[\p{L}\p{N}'&.-]+\s+){0,4}?`;
const NOT_A_LETTER = String.raw`(?![\p{L}])`;
const WORK_WITH_EN = String.raw`\b(?:we|I)(?:'ve| have)? work(?:ed)? with (?!you\b|your\b)`;
const WORK_WITH_ES = String.raw`\b(?:trabajamos|trabajo|hemos trabajado|he trabajado) con (?!usted\b|ustedes\b|ti\b|tu\b|su\b)`;
// Who we "talk to": a claim of conversations we can't show ("most owners we talk to want AI").
const TALKED_TO_NOUNS = `${BUSINESS_NOUNS_EN}|people|teams|clients|administrators|managers`;
const LIKE_YOURS_ES = String.raw`como (?:t[uú]|usted(?:es)?|el tuyo|la tuya|el suyo|la suya|los suyos|las suyas)`;
// "For [up to four words] clinics / like yours", inside one sentence: no word
// here ends in a period, so "for you. Most businesses…" is two sentences.
const SAME_SENTENCE_UP_TO_4 = String.raw`(?:[\p{L}\p{N}'&-]+\s+){0,4}?`;
const FOR_BUSINESSES_EN = String.raw`for ${SAME_SENTENCE_UP_TO_4}(?:(?:${BUSINESS_NOUNS_EN})|like (?:you|yours))${NOT_A_LETTER}`;
const FOR_BUSINESSES_ES = String.raw`(?:para|con) ${SAME_SENTENCE_UP_TO_4}(?:(?:${BUSINESS_NOUNS_ES})|${LIKE_YOURS_ES})${NOT_A_LETTER}`;

const TRACK_RECORD_CLAIMS: readonly RegExp[] = [
  new RegExp(`${WORK_WITH_EN}${UP_TO_4_WORDS}(?:${BUSINESS_NOUNS_EN})${NOT_A_LETTER}`, "iu"),
  new RegExp(`${WORK_WITH_EN}${UP_TO_4_WORDS}like (?:you|yours)${NOT_A_LETTER}`, "iu"),
  new RegExp(String.raw`\bwe partner(?:ed)? with ${UP_TO_4_WORDS}(?:${BUSINESS_NOUNS_EN})${NOT_A_LETTER}`, "iu"),
  // "We help clinics like yours / like Boutique Sol".
  new RegExp(String.raw`\bwe help(?:ed)? ${UP_TO_4_WORDS}(?:${BUSINESS_NOUNS_EN}) like\b`, "iu"),
  // "We do this all the time for dentists like yours", "we do this kind of
  // work for dental clinics"; never "we do this for one business at a time"
  // or "we do that kind of work for you" (how we work, not who for).
  new RegExp(String.raw`\bwe do (?:this|that|it) (?:(?:kind|sort|type) of (?:work|thing)s? )?(?:all the time |often |a lot |regularly |every day )?${FOR_BUSINESSES_EN}`, "iu"),
  new RegExp(String.raw`\b(?:esto )?lo hacemos (?:(?:seguido|siempre|todo el tiempo|a menudo|mucho) )?${FOR_BUSINESSES_ES}`, "iu"),
  /\bwe(?:'ve| have) helped\b/i,
  /\bwe(?:'ve| have) built (?:this|that|these|it) for other\b/i,
  /\bour (?:clients|customers) (?:include|like)\b/i,
  new RegExp(String.raw`\b(?:${TALKED_TO_NOUNS}) (?:that |who )?(?:we|I)(?:'ve| have)? (?:talk(?:ed)?|speak|spoke(?:n)?|work(?:ed)?) (?:to|with)\b`, "iu"),
  new RegExp(String.raw`\bother ${UP_TO_4_WORDS}owners (?:tell|told) us\b`, "iu"),
  // "Examples from dental businesses we've built for".
  new RegExp(String.raw`\b(?:${TALKED_TO_NOUNS}) (?:that |who )?(?:we|I)(?:'ve| have)? built for\b`, "iu"),
  new RegExp(`${WORK_WITH_ES}${UP_TO_4_WORDS}(?:${BUSINESS_NOUNS_ES})${NOT_A_LETTER}`, "iu"),
  new RegExp(`${WORK_WITH_ES}${UP_TO_4_WORDS}${LIKE_YOURS_ES}${NOT_A_LETTER}`, "iu"),
  new RegExp(String.raw`\bayudamos a ${UP_TO_4_WORDS}(?:${BUSINESS_NOUNS_ES}) como${NOT_A_LETTER}`, "iu"),
  new RegExp(String.raw`\bcolaboramos con ${UP_TO_4_WORDS}(?:${BUSINESS_NOUNS_ES})${NOT_A_LETTER}`, "iu"),
  /\bcon (?:los|las) que (?:hablo|hablamos|trabajo|trabajamos)\b/i,
  /\bcon quienes (?:hablo|hablamos|trabajo|trabajamos)\b/i,
  /\bque hemos construido para\b/i,
  /\bhemos ayudado a\b/i,
  new RegExp(String.raw`\bhacemos (?:este|ese) (?:tipo de )?trabajo ${FOR_BUSINESSES_ES}`, "iu"),
  new RegExp(String.raw`\bhacemos esto ${FOR_BUSINESSES_ES}`, "iu"),
];

const GENERAL_OPENER = /^(?:when|whenever|if|cuando|si|en cuanto)(?![\p{L}])/iu;
const NAMES_THEM = /(?<![\p{L}])(?:you|your|tu|tus|su|sus|usted|ustedes)(?![\p{L}])/iu;

/**
 * The match sits in a clause that opens with "when / if / cuando / si…" and
 * names neither them nor their business, the match included: "When your
 * customers can't book online…" still says something about theirs.
 */
function inGeneralClause(text: string, at: number, matched: string, companyName?: string): boolean {
  const before = text.slice(0, at);
  const start = Math.max(...[".", "!", "?", ",", ";", ":", "\n", "¿", "¡"].map((c) => before.lastIndexOf(c))) + 1;
  const clause = `${before.slice(start).trim()} ${matched}`;
  if (!GENERAL_OPENER.test(clause) || NAMES_THEM.test(clause)) return false;
  return !(companyName && fold(clause).includes(fold(companyName)));
}

function matchesOf(text: string, rules: readonly ClaimRule[], companyName?: string): string[] {
  // Curly apostrophes ("didn’t", "We’ve") are the same word: the patterns know the straight one.
  const plain = text.replace(/[\u2018\u2019]/g, "'");
  return rules.flatMap(({ re, generalOk }) => {
    const all = new RegExp(re.source, re.flags.includes("g") ? re.flags : `${re.flags}g`);
    for (const m of plain.matchAll(all)) {
      if (generalOk && inGeneralClause(plain, m.index ?? 0, m[0], companyName)) continue;
      return [m[0].trim()];
    }
    return [];
  });
}

/**
 * Sentences that say what we did NOT see or what they lack. With the
 * company name, "Sonrisa Dental's customers can't book" counts as theirs too.
 */
export function findAbsenceClaims(text: string, companyName?: string | null): string[] {
  const name = companyName?.trim();
  const rules: ClaimRule[] = [...ABSENCE_CLAIMS];
  if (name) {
    rules.push({
      re: new RegExp(String.raw`(?<![\p{L}\p{N}])${escapeRegExp(name)}(?:'s)? (?:customers|clients|people|visitors) (?:can'?t|cannot) (?:book|buy|pay|order|reach)(?![\p{L}])`, "iu"),
      generalOk: true,
    });
  }
  return matchesOf(text, rules, name);
}

/** Sentences that claim we work, or have worked, with businesses like theirs, or quote who we talk to. */
export function findTrackRecordClaims(text: string): string[] {
  return matchesOf(text, TRACK_RECORD_CLAIMS.map((re) => ({ re })));
}
