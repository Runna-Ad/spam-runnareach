/**
 * Exemplar memory: our own best past pitches, shown to the writer as a model
 * and to the critic as a bar.
 *
 * No vectors. A past pitch qualifies when it is a root pitch that was sent at
 * least ATTRIBUTION_WINDOW_DAYS ago (so its outcome is settled), was written in
 * the same language for the same industry, scored ≥ 0.5 on the shared outcome
 * scale (lib/learning/reward.ts: a reply or a free-check run), had no opt-out,
 * did not fail the critic, did not go out under a gate override, and was not
 * sent to a test address. Same industry and market first, then same industry
 * in any market, then none; at most two.
 *
 * What the writer sees is the subject and body only, scrubbed: the old
 * recipient's name, company, site and city, and every digit, become [name],
 * [company], [site], [city] and [n]. That is what keeps one prospect's details, a
 * client name or a number out of another prospect's email.
 *
 * Pure — tested in tests/pitch-exemplars.test.ts.
 */

import { ATTRIBUTION_WINDOW_DAYS, scoreOutcome, type OutcomeEvent } from "../learning/reward.ts";
import { segmentOf, type Segment } from "../learning/segments.ts";

/** Recorded in the decision record when exemplars were shown. */
export const EXEMPLAR_PROMPT_VERSION = "exemplar-v2-2026-10-18";
export const MAX_EXEMPLARS = 2;
export const MIN_EXEMPLAR_SCORE = 0.5;
/**
 * How many eligible candidates get their events read and scored. Large enough
 * that the few with a reply or a scan are never crowded out by newer silent
 * sends (most sends are silent, and silence scores 0).
 */
export const EXEMPLAR_SHORTLIST = 100;

/** One past pitch, before its outcome is read. */
export type ExemplarCandidate = {
  pitch_id: string;
  prospect_id: string;
  parent_pitch_id: string | null;
  status: string;
  sent_at: string | null;
  /** The prospect's language: an exemplar never crosses languages. */
  lang: string;
  /** Raw prospect.industry / prospect.market; normalized here with segmentOf. */
  industry: string | null;
  market: string | null;
  recipient_email: string | null;
  /** decision.critic.pass; null when the pitch was never reviewed. */
  critic_pass: boolean | null;
  /** Sent under a gate override: a person accepted a rule break. */
  gate_overridden: boolean;
};

export type ExemplarTarget = {
  segment: Segment;
  lang: "en" | "es";
  /** The prospect being pitched now; its own past pitches are not exemplars. */
  prospect_id?: string | null;
};

export type ExemplarOpts = {
  now?: Date;
  max?: number;
  minScore?: number;
  /** Test addresses (lib/compliance/test-addresses.ts), injected to stay pure. */
  isTestAddress?: (email: string | null) => boolean;
};

/** What the writer and critic are given, already scrubbed. */
export type Exemplar = { pitch_id: string; score: number; subject: string; body: string };

/** 1 = same industry and market, 2 = same industry any market, null = no match. */
export function exemplarTier(c: Pick<ExemplarCandidate, "industry" | "market" | "lang">, target: Segment): 1 | 2 | null {
  // "other" is everything we could not classify: a match there says nothing.
  if (target.industry === "other") return null;
  const seg = segmentOf({ industry: c.industry, market: c.market, language: c.lang });
  if (seg.industry !== target.industry) return null;
  return seg.market === target.market && target.market !== "unknown" ? 1 : 2;
}

/**
 * Everything that can be decided without the outcome: root, sent, settled by
 * time, same language, a segment match, not a test, not failed by the critic.
 */
export function isEligibleCandidate(c: ExemplarCandidate, target: ExemplarTarget, opts: ExemplarOpts = {}): boolean {
  const now = opts.now ?? new Date();
  if (c.parent_pitch_id !== null) return false;
  if (c.status !== "sent" || !c.sent_at) return false;
  const sentMs = new Date(c.sent_at).getTime();
  if (!Number.isFinite(sentMs) || now.getTime() - sentMs < ATTRIBUTION_WINDOW_DAYS * 86_400_000) return false;
  if (c.lang !== target.lang) return false;
  if (target.prospect_id && c.prospect_id === target.prospect_id) return false;
  if (c.critic_pass === false || c.gate_overridden) return false;
  if (opts.isTestAddress?.(c.recipient_email)) return false;
  return exemplarTier(c, target.segment) !== null;
}

function byTierThenNewest(target: Segment) {
  return (a: ExemplarCandidate, b: ExemplarCandidate) =>
    (exemplarTier(a, target) ?? 9) - (exemplarTier(b, target) ?? 9) || (b.sent_at ?? "").localeCompare(a.sent_at ?? "");
}

/** The candidates worth reading events for: eligible, best tier first, newest first. */
export function shortlistCandidates(
  candidates: readonly ExemplarCandidate[],
  target: ExemplarTarget,
  opts: ExemplarOpts & { limit?: number } = {},
): ExemplarCandidate[] {
  return candidates
    .filter((c) => isEligibleCandidate(c, target, opts))
    .sort(byTierThenNewest(target.segment))
    .slice(0, opts.limit ?? EXEMPLAR_SHORTLIST);
}

/**
 * Pick at most two exemplars. Segment match beats score (every tier-1 pitch
 * ranks above every tier-2 one), then the higher outcome, then the newer send.
 */
export function selectExemplars(
  candidates: ReadonlyArray<ExemplarCandidate & { events: readonly OutcomeEvent[] }>,
  target: ExemplarTarget,
  opts: ExemplarOpts = {},
): Array<{ pitch_id: string; score: number; tier: 1 | 2 }> {
  const now = opts.now ?? new Date();
  const minScore = opts.minScore ?? MIN_EXEMPLAR_SCORE;
  const scored: Array<{ c: ExemplarCandidate; score: number; tier: 1 | 2 }> = [];
  for (const c of candidates) {
    if (!isEligibleCandidate(c, target, { ...opts, now })) continue;
    // A test send anywhere on the timeline: not outreach, not an exemplar.
    if (c.events.some((e) => e.payload?.test)) continue;
    // Pitches sent before pitch_events existed have no "sent" row; the pitch's
    // own sent_at is the same fact.
    const events = c.events.some((e) => e.type === "sent")
      ? c.events
      : [{ type: "sent", at: c.sent_at!, payload: null }, ...c.events];
    const outcome = scoreOutcome(events, now);
    if (outcome.value === null || outcome.negative || outcome.value < minScore) continue;
    const tier = exemplarTier(c, target.segment);
    if (tier === null) continue;
    scored.push({ c, score: outcome.value, tier });
  }
  scored.sort(
    (a, b) =>
      a.tier - b.tier ||
      b.score - a.score ||
      (b.c.sent_at ?? "").localeCompare(a.c.sent_at ?? "") ||
      a.c.pitch_id.localeCompare(b.c.pitch_id),
  );
  const out: Array<{ pitch_id: string; score: number; tier: 1 | 2 }> = [];
  const prospects = new Set<string>();
  for (const s of scored) {
    if (out.length >= (opts.max ?? MAX_EXEMPLARS)) break;
    // Two emails to the same business are one example, not two.
    if (prospects.has(s.c.prospect_id)) continue;
    prospects.add(s.c.prospect_id);
    out.push({ pitch_id: s.c.pitch_id, score: s.score, tier: s.tier });
  }
  return out;
}

// ── The scrubber ──────────────────────────────────────────────────────────────
//
// All matching runs on an accent-folded, lower-cased shadow of the text with an
// index map back to the original, so "Wagner", "wagner", "WAGNER" and "Wágner"
// are one word, and the original's accents survive everywhere else. After
// scrubbing, a fail-closed check (exemplarLeaks) looks for any distinctive
// token of the old company, contact or city; toExemplar drops the whole
// exemplar if one is left, whatever the replacement rules missed.

/** Who the past email went to: everything that must not travel to the next one. */
export type ExemplarProspect = {
  company_name: string | null;
  domain: string | null;
  website_url?: string | null;
  recipient_name: string | null;
  recipient_email?: string | null;
  city?: string | null;
};

function fold(s: string): string {
  return s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
}

/** Folded text plus, for each folded code unit, the index of the original char it came from. */
function foldWithMap(text: string): { folded: string; map: number[] } {
  let folded = "";
  const map: number[] = [];
  for (let i = 0; i < text.length; ) {
    const ch = String.fromCodePoint(text.codePointAt(i)!);
    const f = fold(ch);
    folded += f;
    for (let k = 0; k < f.length; k++) map.push(i);
    i += ch.length;
  }
  map.push(text.length);
  return { folded, map };
}

/** Word pieces of a phrase, folded: "Núñez-Ruiz" → ["nunez", "ruiz"], "O’Brien" → ["o", "brien"]. */
function pieces(s: string): string[] {
  return fold(s).split(/[^\p{L}\p{N}]+/u).filter(Boolean);
}

/** A folded phrase as a whole-word pattern; any short run of separators (" ", "-", "’", ". ", " & ") between pieces. */
function phrasePattern(phrase: string): RegExp | null {
  const ps = pieces(phrase);
  if (ps.length === 0) return null;
  return new RegExp(`(?<![\\p{L}\\p{N}])${ps.join("[^\\p{L}\\p{N}\\n]{0,3}")}(?![\\p{L}\\p{N}])`, "gu");
}

/** The blanks themselves: never matched, so a surname "Hunter" or a company word "url" cannot break them. */
const PLACEHOLDER_RE = /\[(?:name|company|site|city|n)\]|\{hunter_url\}/g;

/**
 * Which originals a match counts in: "any" case, "capital" (starts with a
 * capital: a given name that is also a word, "Will" goes, "will" stays) or
 * "upper" (all capitals: "TO" for Toronto, never the word "to").
 */
type CaseRule = "any" | "capital" | "upper";

/** Replace every whole-word match of `phrase`, ignoring case (per `rule`) and accents. */
function replacePhrase(text: string, phrase: string, placeholder: string, rule: CaseRule = "any"): string {
  const re = phrasePattern(phrase);
  if (!re) return text;
  const { folded, map } = foldWithMap(text);
  const blanks = [...text.matchAll(PLACEHOLDER_RE)].map((m) => [m.index, m.index + m[0].length] as const);
  const spans: Array<[number, number]> = [];
  for (const m of folded.matchAll(re)) {
    const start = map[m.index]!;
    const end = map[m.index + m[0].length]!;
    if (blanks.some(([s, e]) => start < e && end > s)) continue;
    if (rule === "capital" && !/^\p{Lu}/u.test(text.slice(start))) continue;
    if (rule === "upper" && /\p{Ll}/u.test(text.slice(start, end))) continue;
    spans.push([start, end]);
  }
  let out = text;
  for (const [s, e] of spans.reverse()) out = out.slice(0, s) + placeholder + out.slice(e);
  return out;
}

function hostOf(domain: string | null, websiteUrl: string | null | undefined): string | null {
  const raw = (domain ?? "").trim() || (websiteUrl ?? "").trim();
  if (!raw) return null;
  const host = raw
    .replace(/^[a-z]+:\/\//i, "")
    .split(/[/?#:]/)[0]!
    .replace(/^www\./i, "")
    .toLowerCase();
  return host.includes(".") ? host : null;
}

/** Legal suffixes and articles: dropped from a company's ends to find the name as written in prose. */
const LEGAL_PIECES = new Set([
  "inc", "incorporated", "ltd", "limited", "llc", "llp", "lp", "corp", "corporation", "co", "company", "ltee", "plc",
  "sa", "s", "a", "de", "c", "v", "cv", "rl", "r", "l", "sc", "sapi", "sab", "srl",
]);
const ARTICLES = new Set(["the", "el", "la", "los", "las", "le", "les"]);

/**
 * Words that name a kind of business or place, not this one: never scrubbed on
 * their own and never counted as a leak ("legal", "dental", "north").
 */
const GENERIC_WORDS = new Set([
  "legal", "law", "laws", "lawyers", "firm", "group", "dental", "dentistry", "clinic", "clinica", "medical", "medica",
  "health", "salud", "home", "homes", "care", "plumbing", "heating", "cooling", "electric", "electrical", "services",
  "service", "servicios", "solutions", "soluciones", "company", "compania", "consulting", "consultores", "partners",
  "associates", "asociados", "restaurant", "restaurante", "cafe", "studio", "center", "centre", "centro", "salon",
  "shop", "store", "tienda", "auto", "autos", "motors", "construction", "constructora", "contracting", "contractors",
  "realty", "properties", "inmobiliaria", "fitness", "accounting", "contadores", "despacho", "abogados", "bufete",
  "distribution", "distribuidora", "manufacturing", "industrial", "industries", "logistics", "transport", "supply",
  "supplies", "global", "international", "canada", "canadian", "mexico", "mexicana", "mexicano", "office", "team",
  "north", "south", "east", "west", "city", "ciudad", "lake", "port", "mount", "saint", "sainte", "santa", "santo",
  "nuevo", "nueva", "villa", "valle", "puerto", "beach", "falls", "river", "hills", "park", "heights", "bay",
  "name", "site", "with", "from", "your", "that", "this", "para", "with", "and", "y",
  // Short business words and articles: a three-letter company or domain piece
  // is checked unless it is one of these ("The Art Spa", "kpi-law").
  "spa", "art", "bar", "inn", "pub", "gym", "car", "pet", "tax", "kid", "dog", "cat", "bio", "eco", "pro", "med",
  "vet", "dds", "cpa", "llp", "plc", "sas", "cv", "sa", "de", "rl", "the", "los", "las", "les", "del", "dos", "van",
  "von", "der", "den", "mac", "san", "for", "our", "you", "new", "one", "two", "top", "all", "con", "por", "sin",
  "una", "uno", "web", "app", "hub", "lab", "fix", "box", "inc", "ltd", "llc",
]);

/** Name particles: never scrubbed or checked alone ("de" in "José Luis de la Peña"). */
const NAME_PARTICLES = new Set([
  "de", "del", "la", "las", "los", "el", "y", "e", "al", "da", "di", "do", "dos", "du", "le", "van", "von", "der", "den",
  "st", "san", "mc", "mac", "jr", "sr", "ii", "iii", "o", "d",
]);

/**
 * GIVEN names that are also common words: in a contact's name they are
 * scrubbed and leak-checked only when capitalized ("Will" goes, "will" stays).
 * Never applied to company or city words: subjects are lower case by house
 * rule, so "who books summit at night" and "clinics in victoria" must go.
 */
const COMMON_WORD_NAMES = new Set([
  "will", "mark", "may", "june", "april", "rose", "grace", "hope", "faith", "joy", "bill", "art", "pat", "sun", "sol",
  "luz", "paz", "rey", "dolores", "amparo", "consuelo", "angel", "angeles", "rocio", "pilar", "mercedes", "guadalupe",
  "victoria", "rich", "frank", "earnest", "ernest", "dean", "chase", "page", "sky", "summer", "winter", "rob", "sue",
  // Two-letter name pieces that are also everyday words ("To", "Do", "An").
  "to", "do", "so", "an", "in", "on", "at", "no", "go", "me", "my", "we", "he", "be", "by", "or", "us", "as", "is",
  "it", "if", "of", "up", "mi", "tu", "su", "se", "lo", "ya", "yo", "en", "es", "un",
]);

/** A contact name made only of common-word given names ("Will", "April May") is matched only when capitalized. */
function commonOnly(phrase: string): boolean {
  const ps = pieces(phrase);
  return ps.length > 0 && ps.every((p) => COMMON_WORD_NAMES.has(p));
}

/** The company as it may appear in prose: full, then without the legal suffix and leading article. */
function companyPhrases(name: string): string[] {
  const ps = pieces(name);
  let end = ps.length;
  while (end > 1 && LEGAL_PIECES.has(ps[end - 1]!)) end--;
  let start = 0;
  while (start < end - 1 && ARTICLES.has(ps[start]!)) start++;
  const core = ps.slice(start, end).join(" ");
  return [...new Set([name, core])].filter((p) => pieces(p).length > 0);
}

/**
 * Pieces worth scrubbing alone and checking for: `min`+ letters (4 for a city,
 * 3 for a company or domain: "BMO", "kpi"), not generic, not a particle.
 */
function distinctive(s: string | null | undefined, min = 4): string[] {
  if (!s) return [];
  return pieces(s).filter((p) => p.length >= min && !GENERIC_WORDS.has(p) && !NAME_PARTICLES.has(p) && !LEGAL_PIECES.has(p) && !/^\d+$/.test(p));
}

/** A contact's name pieces of 2+ letters, particles aside: "Ng", "Wu", "Lee" are surnames, not noise. */
function namePieces(s: string | null | undefined): string[] {
  if (!s) return [];
  return pieces(s).filter((p) => p.length >= 2 && !NAME_PARTICLES.has(p) && !/^\d+$/.test(p));
}

/**
 * A city's short forms and nicknames. Each group is one city; whichever member
 * the prospect row carries, the others are its aliases. "TO" counts only in
 * capitals (the word "to" is everywhere).
 */
const CITY_ALIAS_GROUPS: ReadonlyArray<readonly string[]> = [
  ["Ciudad de México", "Mexico City", "CDMX", "D.F."],
  ["Guadalajara", "GDL"],
  ["Monterrey", "MTY"],
  ["Querétaro", "QRO"],
  ["Toronto", "TO", "GTA", "YYZ"],
  ["Vancouver", "YVR"],
  ["Calgary", "YYC"],
  ["Edmonton", "YEG"],
  ["Ottawa", "YOW"],
  ["Montréal", "MTL", "YUL"],
];
const UPPER_ONLY_ALIASES = new Set(["to"]);
const cityKey = (s: string) => pieces(s.split(",")[0]!).join(" ");
/** Folded city name → every other name the same city goes by. */
const CITY_ALIASES = new Map<string, string[]>(
  CITY_ALIAS_GROUPS.flatMap((g) => g.map((name) => [cityKey(name), g.filter((o) => cityKey(o) !== cityKey(name))] as const)),
);

function cityAliases(city: string | null | undefined): Array<{ alias: string; rule: CaseRule }> {
  if (!city?.trim()) return [];
  return (CITY_ALIASES.get(cityKey(city)) ?? []).map((alias) => ({
    alias,
    rule: UPPER_ONLY_ALIASES.has(cityKey(alias)) ? "upper" : "any",
  }));
}

/** A multi-word field as one phrase ("north bay", "ciudad de mexico"): checked even when every word is generic. */
function multiWord(phrase: string | null | undefined): string[] {
  const ps = pieces(phrase ?? "");
  return ps.length >= 2 ? [ps.join(" ")] : [];
}

/** Greeting words that open the first line: the addressee after them is the recipient. */
const GREETING_RE =
  /^(\s*(?:hi|hello|hey|dear|good\s+(?:morning|afternoon)|hola|buen[oa]s?\s+d[ií]as|buenas\s+tardes|buenas|estimad[oa]s?|querid[oa]s?)\s+)([^,!:;]{1,60}?)(\s*(?:[,!:;].*)?)$/iu;
const GENERIC_ADDRESSEE = /^(team|there|all|everyone|folks|equipo|todos|todas|a\s+todos|a\s+todas)$/iu;
/** An honorific and the capitalized name after it: "Dr. Patel", "Lic. Núñez", "Sra. Gómez Ruiz". */
const HONORIFIC_RE =
  /(?<![\p{L}])(Dr|Dra|Drs|Lic|Licda|Ing|Arq|Mtro|Mtra|Prof|Mr|Mrs|Ms|Mx|Sr|Sra|Srta|Don|Doña)(\.?\s+)\p{Lu}[\p{L}’'-]*(?:\s+\p{Lu}[\p{L}’'-]*){0,2}/gu;
/**
 * A dotted honorific (or a run of them: "Prof. Dr.") and the next word in ANY
 * case: "dr. patel", "lic. núñez" in a lower-case subject. A blanked ordinary
 * word ("dr. [name]" for "dr. visit") is the accepted cost; a leaked name is not.
 * The word stops before a possessive "'s".
 */
const DOTTED_HONORIFIC_RE =
  /(?<![\p{L}\p{N}])((?:(?:dr|dra|drs|lic|licda|ing|arq|mtro|mtra|prof|mr|mrs|ms|mx|sr|sra|srta)\.[ \t]*)+)(\p{L}+(?:[’'-](?!s(?!\p{L}))\p{L}+)*)/giu;

/**
 * Replace the past recipient's name, company, site and city, and every digit,
 * with [name], [company], [site], [city] and [n]. URLs and e-mail addresses go
 * too: a link on the 👉 line becomes {hunter_url} (the slot the writer fills),
 * any other one [site]. Text with none of these comes back unchanged. What this
 * misses, exemplarLeaks catches.
 */
export function scrubExemplar(text: string, prospect: ExemplarProspect): string {
  let out = text;
  const host = hostOf(prospect.domain, prospect.website_url);

  // Addresses and links first: they carry the domain, the name and digits.
  out = out.replace(/[\p{L}\p{N}._%+-]+@[\p{L}\p{N}.-]+\.[a-z]{2,}/giu, "[site]");
  out = out
    .split("\n")
    .map((line) =>
      line.replace(/\b(?:https?:\/\/|www\.)[^\s<>()]+/gi, (url) => {
        const trail = url.match(/[.,;:!?)\]]+$/)?.[0] ?? "";
        return (line.trim().startsWith("👉") ? "{hunter_url}" : "[site]") + trail;
      }),
    )
    .join("\n");
  if (host) out = replacePhrase(out, host, "[site]");

  // Company: the whole name, then the name without suffix, then each distinctive
  // word of it or of the domain's label ("The team at Wagner", "waglaw").
  if (prospect.company_name?.trim()) {
    for (const p of companyPhrases(prospect.company_name)) out = replacePhrase(out, p, "[company]");
  }
  const words = new Set([...distinctive(prospect.company_name, 3), ...distinctive(host?.split(".")[0], 3)]);
  for (const w of words) out = replacePhrase(out, w, "[company]");

  // City: the name, its distinctive words, then its short forms ("CDMX", "YYZ").
  if (prospect.city?.trim()) {
    out = replacePhrase(out, prospect.city, "[city]");
    for (const w of distinctive(prospect.city)) out = replacePhrase(out, w, "[city]");
    for (const { alias, rule } of cityAliases(prospect.city)) out = replacePhrase(out, alias, "[city]", rule);
  }

  // Contact: the full name, then each space-separated part ("Núñez-Ruiz",
  // "O’Brien"), then each piece of those.
  const fullName = prospect.recipient_name?.trim();
  if (fullName) {
    const capital = (common: boolean): CaseRule => (common ? "capital" : "any");
    out = replacePhrase(out, fullName, "[name]", capital(commonOnly(fullName)));
    for (const chunk of fullName.split(/\s+/)) {
      if (pieces(chunk).every((p) => NAME_PARTICLES.has(p))) continue;
      out = replacePhrase(out, chunk, "[name]", capital(pieces(chunk).some((p) => COMMON_WORD_NAMES.has(p))));
    }
    for (const p of namePieces(fullName)) out = replacePhrase(out, p, "[name]", capital(COMMON_WORD_NAMES.has(p)));
  }

  // Names the contact row did not know: after an honorific (capitalized, then
  // any case after a dotted one), and the greeting's addressee.
  out = out.replace(HONORIFIC_RE, (_m, title: string, sep: string) => `${title}${sep}[name]`);
  out = out.replace(DOTTED_HONORIFIC_RE, (_m, titles: string) => `${titles}${/\s$/.test(titles) ? "" : " "}[name]`);
  const nl = out.indexOf("\n");
  const first = nl === -1 ? out : out.slice(0, nl);
  const greeted = first.replace(GREETING_RE, (m, lead: string, who: string, rest: string) => {
    const w = who.trim();
    if (w.includes("[") || GENERIC_ADDRESSEE.test(w)) return m;
    return `${lead}[name]${rest}`;
  });
  out = greeted + (nl === -1 ? "" : out.slice(nl));

  // "[name] [name]" (María José) and "[company]-[company]" (Smith-Jones) are one blank.
  out = out.replace(/\[(name|company|city|site)\](?:[ \t\u2010-]+\[\1\])+/g, "[$1]");

  // Every digit: a number from one email is never a fact about the next.
  return out.replace(/\d+(?:[.,:/]\d+)*/g, "[n]");
}

/**
 * Fail closed: what is still in the text of the old prospect (case- and
 * accent-insensitive, whole words). Anything here means the scrubber missed,
 * and the exemplar is dropped. Checked: the distinctive words of the company
 * and domain (3+ letters) and city (4+), a multi-word company or city as a
 * phrase, the city's short forms, every name piece of 2+ letters, and any word
 * still standing after a dotted honorific. A contact's common-word name piece
 * ("Will", "To") and the alias "TO" count only capitalized / in capitals.
 */
export function exemplarLeaks(text: string, prospect: ExemplarProspect): string[] {
  const host = hostOf(prospect.domain, prospect.website_url);
  const company = prospect.company_name?.trim() ? companyPhrases(prospect.company_name) : [];
  const anyCase = new Set([
    ...distinctive(prospect.company_name, 3),
    ...distinctive(host?.split(".")[0], 3),
    ...distinctive(prospect.city),
    ...company.flatMap(multiWord),
    ...multiWord(prospect.city),
  ]);
  const tokens = new Map<string, CaseRule>();
  for (const t of namePieces(prospect.recipient_name)) tokens.set(t, COMMON_WORD_NAMES.has(t) ? "capital" : "any");
  for (const { alias, rule } of cityAliases(prospect.city)) tokens.set(rule === "upper" ? alias : cityKey(alias), rule);
  for (const t of anyCase) tokens.set(t, "any");
  const leaks: string[] = [];
  for (const [t, rule] of tokens) {
    if (replacePhrase(text, t, "\u0000", rule) !== text) leaks.push(t);
  }
  for (const m of text.matchAll(DOTTED_HONORIFIC_RE)) leaks.push(m[0].trim());
  return leaks;
}

/**
 * A selected past pitch → what the writer and critic may see, or null when the
 * scrubbed text still carries a distinctive word of the old prospect.
 */
export function toExemplar(
  picked: { pitch_id: string; score: number },
  pitch: { subject: string; body: string } & ExemplarProspect,
): Exemplar | null {
  const subject = scrubExemplar(pitch.subject, pitch);
  const body = scrubExemplar(pitch.body, pitch);
  if (exemplarLeaks(`${subject}\n${body}`, pitch).length > 0) return null;
  return { pitch_id: picked.pitch_id, score: picked.score, subject, body };
}

/**
 * The decision record's exemplar fields. Only an AI-written pitch was shown
 * exemplars; a template (or a failed AI path) records none.
 */
export function decisionExemplarFields(
  path: "claude" | "template" | "website_claude" | "website_template",
  exemplars: readonly Pick<Exemplar, "pitch_id" | "score">[],
): { exemplars_used: Array<{ pitch_id: string; score: number }>; exemplar_prompt_version: string | null } {
  const used = path === "claude" ? exemplars.map((e) => ({ pitch_id: e.pitch_id, score: e.score })) : [];
  return { exemplars_used: used, exemplar_prompt_version: used.length > 0 ? EXEMPLAR_PROMPT_VERSION : null };
}

// ── Prompt text ───────────────────────────────────────────────────────────────

function exemplarBlock(exemplars: readonly Pick<Exemplar, "subject" | "body">[]): string {
  return exemplars
    // No numbering: the section carries no digit of any kind.
    .map((e) => `--- Past email ---\nSubject: ${e.subject}\n\n${e.body.trim()}`)
    .join("\n\n");
}

/**
 * For the writer's USER message (never the cached system prompt). Empty when
 * there are none, so a pitch without exemplars gets today's exact prompt.
 */
export function writerExemplarSection(exemplars: readonly Pick<Exemplar, "subject" | "body">[] | null | undefined): string {
  if (!exemplars || exemplars.length === 0) return "";
  return `

Below are our own past emails that businesses like this one replied to or acted on. Match their shape and restraint, never their facts: nothing in them is true of this prospect. Bracketed words ([name], [company], [site], [city], [n]) are blanks, never text to copy, and the rules in the system prompt still win.

${exemplarBlock(exemplars)}`;
}

/** For the critic's user message: the bar, not a source of facts. */
export function criticExemplarSection(exemplars: readonly Pick<Exemplar, "subject" | "body">[] | null | undefined): string {
  if (!exemplars || exemplars.length === 0) return "";
  return `

Judge against this bar: our own past emails that businesses like this one replied to or acted on. They are not part of the payload and prove nothing about this prospect. Bracketed words are blanks. A draft clearly weaker than these in relevance or plainness deserves the issue that says why.

${exemplarBlock(exemplars)}`;
}
