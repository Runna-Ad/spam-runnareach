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
