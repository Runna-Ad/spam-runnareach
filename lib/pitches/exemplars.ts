/**
 * Exemplar memory: our own best past pitches, shown to the writer as a model
 * and to the critic as a bar.
 *
 * No vectors. A past pitch qualifies when it is a root pitch that was sent at
 * least ATTRIBUTION_WINDOW_DAYS ago (so its outcome is settled), was written in
 * the same language for the same industry, scored ≥ 0.5 on the shared outcome
 * scale (lib/learning/reward.ts: a reply, a free-check run, a booked meeting or
 * a deal), had no opt-out, did not bounce (a later booking does not mean anyone
 * read that email), did not fail the critic, did not go out under a gate override, and was not
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

import { ATTRIBUTION_WINDOW_DAYS, addressOutcome, scoreOutcome, type OutcomeEvent } from "../learning/reward.ts";
import { segmentOf, type Segment } from "../learning/segments.ts";
import { EN_WORDS } from "./wordlists/en.ts";
import { ES_WORDS } from "./wordlists/es.ts";
import { NAME_CAPITAL_ONLY, NAME_LIST, NAME_WEAK, NAME_WORDS } from "./wordlists/names.ts";
import { CAPITALIZED_WORDS, COMMON_NAMES, OWN_VOCABULARY } from "./wordlists/vocab.ts";

/** Recorded in the decision record when exemplars were shown. */
export const EXEMPLAR_PROMPT_VERSION = "exemplar-v3-2026-10-18";
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
    // A bounced email was never read, whatever the prospect did later: a
    // meeting booked another way scores 1 and would otherwise outweigh it.
    if (addressOutcome(c.events) === "bounced") continue;
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
// scrubbing, a fail-closed check (exemplarLeaks, below) looks for anything of
// the old company, contact or city with its OWN coarser matcher; toExemplar
// drops the whole exemplar if anything is left, whatever these rules missed.

/** Who the past email went to: everything that must not travel to the next one. */
export type ExemplarProspect = {
  company_name: string | null;
  domain: string | null;
  website_url?: string | null;
  recipient_name: string | null;
  recipient_email?: string | null;
  city?: string | null;
};

/** Letters NFD does not split: "Łukasz" ↔ "Lukasz", "Đorđe", "Søren". */
const STROKE_LETTERS: Record<string, string> = { ł: "l", Ł: "l", đ: "d", Đ: "d", ø: "o", Ø: "o" };

function fold(s: string): string {
  return s
    // NFKD, not NFD: full-width "Ｐａｔｅｌ" is "patel". Format characters go: "Pa\u200btel" is too.
    .replace(/\p{Cf}/gu, "")
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[łŁđĐøØ]/g, (c) => STROKE_LETTERS[c]!)
    .toLowerCase();
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

/** Any whole word that CONTAINS a folded piece: "the Wagners", "@wagnerlaw", "WagnerLawTO". */
function containingPattern(piece: string): RegExp {
  return new RegExp(`(?<![\\p{L}\\p{N}])[\\p{L}\\p{N}]*${piece}[\\p{L}\\p{N}]*(?![\\p{L}\\p{N}])`, "gu");
}

/** A word and its plural: "nguyen" matches "Nguyens", "smith" "Smiths". */
function pluralPattern(piece: string): RegExp {
  return new RegExp(`(?<![\\p{L}\\p{N}])${piece}(?:e?s)?(?![\\p{L}\\p{N}])`, "gu");
}

/** Letters as written, or with a dot after each: "cdmx" matches "CDMX", "C.D.M.X." and "c.d.m.x". */
function lettersPattern(letters: string): RegExp {
  return new RegExp(`(?<![\\p{L}\\p{N}])(?:${[...letters].join("\\.")}\\.?|${letters})(?![\\p{L}\\p{N}])`, "gu");
}

/**
 * The allow-list's word sets (the leak check's header says which applies where).
 * Loaded once. ALL_NAMES is the names net (./wordlists/names.ts plus our hand
 * list); the names that are also everyday words ("rosa", "price", "flores") are
 * allowed in lower case and, when common, at a sentence start; the rest
 * (NAME_ONLY: garcia, patel, gordon) nowhere. Our own vocabulary always passes.
 */
const lines = (s: string) => s.split("\n").filter(Boolean);
const EN = lines(EN_WORDS);
const ES = lines(ES_WORDS);
const FREQ_20K = new Set([...EN.slice(0, 20000), ...ES.slice(0, 20000)]);
const FREQ_50K = new Set([...EN, ...ES]);
/** The hand list: always a name, even when the dictionaries know the word. */
const NAMES = new Set(COMMON_NAMES);
const ALL_NAMES = new Set([...lines(NAME_LIST), ...COMMON_NAMES]);
const NAME_WORD_SET = new Set(lines(NAME_WORDS).filter((w) => !NAMES.has(w)));
/** Two-letter names ("du", "ng") pass in lower case: no identity there, and "du lado" is prose. */
const NAME_ONLY = new Set([...ALL_NAMES].filter((w) => w.length >= 3 && !NAME_WORD_SET.has(w)));
const OWN = [...OWN_VOCABULARY, ...CAPITALIZED_WORDS];
const without = (words: Iterable<string>, deny: ReadonlySet<string>) => [...words].filter((w) => !deny.has(w));
/**
 * Names that count capitalized mid-sentence: all but the word-like ones that are
 * weak names ("La", "More", "Re") or among the 300 most frequent words ("Will",
 * "Do"). "Grant", "Lee", "Graham", "Cruz" are names there.
 */
const TOP_300 = new Set([...EN.slice(0, 300), ...ES.slice(0, 300)]);
const CAPITAL_DENY = new Set([
  ...without(ALL_NAMES, new Set([...lines(NAME_WEAK), ...TOP_300].filter((w) => NAME_WORD_SET.has(w)))),
  ...lines(NAME_CAPITAL_ONLY),
]);
/** Capitalized mid-sentence, all capitals, and capitals in a subject or an address. */
const CAPITAL_WORDS = new Set([...without(FREQ_20K, CAPITAL_DENY), ...OWN]);
/** A capital opening a sentence: also the common names that are words ("Mark the date", "Rosa mexicano"). */
const OPENER_NAMES = new Set([...NAME_WORD_SET].filter((w) => FREQ_20K.has(w)));
const OPENER_WORDS = new Set([...CAPITAL_WORDS, ...OPENER_NAMES]);
const OPENER_DENY = new Set(without(ALL_NAMES, OPENER_NAMES));
/** Lower case in a subject or an address. */
const LOWER_STRICT_WORDS = new Set([...without(FREQ_20K, NAME_ONLY), ...OWN]);
/** Lower case anywhere else in a body. */
const KNOWN_WORDS = new Set([...without(FREQ_50K, NAME_ONLY), ...OWN]);
/** The 3,000 most frequent of each: words common enough to follow a name ("Dr. [name] told us"). */
const TOP_WORDS = new Set([...EN_WORDS.split("\n").slice(1, 3001), ...ES_WORDS.split("\n").slice(1, 3001)]);
/**
 * Endings and prefixes stripped to find a listed base form, up to two steps:
 * clinics → clinic, agendan → agendar, medibles → medir, quedándote → quedar,
 * inconsistente → consistente. Generous on purpose: a name that slips through
 * here is still caught by the field check above it.
 */
const ENDINGS: ReadonlyArray<readonly [string, readonly string[]]> = [
  ["s", [""]], ["es", [""]], ["ed", ["", "e"]], ["d", [""]], ["ing", ["", "e"]], ["ly", [""]], ["ies", ["y"]],
  ["ied", ["y"]], ["er", ["", "e"]], ["ers", ["", "e"]], ["mente", [""]], ["ciones", ["cion"]],
  ["a", ["o", "ar"]], ["as", ["os", "ar"]], ["e", ["ar", "er", "o"]], ["o", ["ar"]],
  ["an", ["ar", "er"]], ["en", ["er", "ir"]], ["amos", ["ar"]], ["emos", ["er"]], ["imos", ["ir"]],
  ["ando", ["ar"]], ["iendo", ["er", "ir"]], ["ado", ["ar"]], ["ada", ["ar"]], ["ados", ["ar"]], ["adas", ["ar"]],
  ["ido", ["er", "ir"]], ["ida", ["er", "ir"]], ["idos", ["er", "ir"]], ["idas", ["er", "ir"]],
  ["able", ["ar"]], ["ables", ["ar"]], ["ible", ["er", "ir"]], ["ibles", ["er", "ir"]],
  ["le", [""]], ["les", [""]], ["lo", [""]], ["la", [""]], ["los", [""]], ["las", [""]], ["nos", [""]], ["me", [""]],
  ["te", [""]], ["se", [""]],
  // Preterite, subjunctive and conditional: agendaron, resolviste, corresponda, armaríamos.
  ["aron", ["ar"]], ["ieron", ["er", "ir"]], ["aste", ["ar"]], ["iste", ["er", "ir"]], ["a", ["er", "ir"]],
  ["ariamos", ["ar"]], ["eriamos", ["er"]], ["iriamos", ["ir"]], ["aria", ["ar"]], ["arias", ["ar"]], ["arian", ["ar"]],
  ["eria", ["er"]], ["erian", ["er"]], ["iria", ["ir"]], ["irian", ["ir"]],
];
const PREFIXES = ["in", "im", "un", "re", "des", "dis", "pre"];

function bases(w: string): string[] {
  const out: string[] = [];
  for (const [end, adds] of ENDINGS) {
    if (w.endsWith(end) && w.length > end.length + 2) for (const a of adds) out.push(w.slice(0, -end.length) + a);
  }
  for (const pre of PREFIXES) if (w.startsWith(pre) && w.length > pre.length + 3) out.push(w.slice(pre.length));
  return out;
}

function inWords(words: ReadonlySet<string>, w: string, deny: ReadonlySet<string> = NAMES): boolean {
  if (w.length <= 1 || words.has(w) || HONORIFICS.has(w)) return true;
  if (deny.has(w)) return false;
  return bases(w).some((b) => words.has(b) || bases(b).some((c) => words.has(c)));
}
const isKnownWord = (w: string) => inWords(KNOWN_WORDS, w, NAME_ONLY);
/** The scrubber's "is this an ordinary word" (initials as a word, a name inside a handle): the 20k tier. */
const isCommonWord = (w: string) => inWords(LOWER_STRICT_WORDS, w, NAME_ONLY);

/** The blanks themselves: never matched, so a surname "Hunter" or a company word "url" cannot break them. */
const PLACEHOLDER_RE = /\[(?:name|company|site|city|n)\]|\{hunter_url\}/g;

/**
 * Which originals a match counts in: "any" case, "capital" (starts with a
 * capital: a given name that is also a word, "Will" goes, "will" stays),
 * "inline" (capital and not opening a sentence: a two-letter name like "To"
 * goes in "Thanks, To." but "To book" stays) or "upper" (all capitals: "TO"
 * for Toronto, never the word "to").
 */
type CaseRule = "any" | "capital" | "inline" | "upper";

function opensSentence(text: string, start: number): boolean {
  const before = text.slice(0, start).replace(/[ \t"“'‘(]+$/u, "");
  return before === "" || /[\n.!?¿¡]$/u.test(before);
}

/** Replace every match of a pattern run on the folded text, keeping the original elsewhere. */
function replaceMatches(text: string, re: RegExp, placeholder: string, rule: CaseRule = "any"): string {
  const { folded, map } = foldWithMap(text);
  const blanks = [...text.matchAll(PLACEHOLDER_RE)].map((m) => [m.index, m.index + m[0].length] as const);
  const spans: Array<[number, number]> = [];
  for (const m of folded.matchAll(re)) {
    const start = map[m.index]!;
    const end = map[m.index + m[0].length]!;
    if (blanks.some(([s, e]) => start < e && end > s)) continue;
    const capital = /^\p{Lu}/u.test(text.slice(start));
    if (rule === "capital" && !capital) continue;
    if (rule === "inline" && (!capital || opensSentence(text, start))) continue;
    if (rule === "upper" && /\p{Ll}/u.test(text.slice(start, end))) continue;
    spans.push([start, end]);
  }
  let out = text;
  for (const [s, e] of spans.reverse()) out = out.slice(0, s) + placeholder + out.slice(e);
  return out;
}

/** Replace every whole-word match of `phrase`, ignoring case (per `rule`) and accents. */
function replacePhrase(text: string, phrase: string, placeholder: string, rule: CaseRule = "any"): string {
  const re = phrasePattern(phrase);
  return re ? replaceMatches(text, re, placeholder, rule) : text;
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
  "una", "uno", "web", "app", "hub", "lab", "fix", "box", "inc", "ltd", "llc", "get", "fit", "now", "day", "way",
  "big", "red", "mas", "same",
]);

/** Name particles: never scrubbed or checked alone ("de" in "José Luis de la Peña"), unless one is the last name. */
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

/** How a name part made of these pieces is matched: two-letter common words never at a sentence start. */
function nameRule(ps: readonly string[]): CaseRule {
  const common = ps.filter((p) => COMMON_WORD_NAMES.has(p) || NAME_PARTICLES.has(p));
  if (common.length === 0) return "any";
  return common.every((p) => p.length <= 2) ? "inline" : "capital";
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
 * 3 for a domain label: "kpi"), not generic, not a particle.
 */
function distinctive(s: string | null | undefined, min = 4): string[] {
  if (!s) return [];
  return pieces(s).filter((p) => p.length >= min && !GENERIC_WORDS.has(p) && !NAME_PARTICLES.has(p) && !LEGAL_PIECES.has(p) && !/^\d+$/.test(p));
}

/** A company's own words as written, without the legal suffix or leading article. */
function companyCore(name: string): Array<{ raw: string; f: string }> {
  const ps = name.split(/[^\p{L}\p{N}]+/u).filter(Boolean).map((raw) => ({ raw, f: fold(raw) }));
  let end = ps.length;
  while (end > 1 && LEGAL_PIECES.has(ps[end - 1]!.f)) end--;
  let start = 0;
  while (start < end - 1 && ARTICLES.has(ps[start]!.f)) start++;
  return ps.slice(start, end);
}

/** Words that end a run of initials: "S.A. de C.V." is not "SADECV". */
const RUN_BREAKERS = new Set(["de", "del", "la", "las", "los", "el", "le", "les", "y", "e", "o", "u", "of", "and"]);

/**
 * Runs of one- and two-letter company pieces, joined: "KP Law" → "kp",
 * "A.B.C. Plumbing" → "abc", "J.D. Irving" → "jd". Matched in capitals only.
 */
function initialRuns(name: string | null | undefined): string[] {
  if (!name?.trim()) return [];
  const runs: string[] = [];
  let cur = "";
  for (const { f } of companyCore(name)) {
    if (f.length <= 2 && !RUN_BREAKERS.has(f) && /^\p{L}+$/u.test(f)) cur += f;
    else {
      if (cur.length >= 2) runs.push(cur);
      cur = "";
    }
  }
  if (cur.length >= 2) runs.push(cur);
  return runs;
}

/**
 * A company's words worth scrubbing alone: 4+ letters, or 3 letters written in
 * capitals ("BMO", "ABC"). An ordinary short word ("Get Fit Gym", "Same Day
 * Dental") is left to the full name, so prose like "most clinics get calls" survives.
 */
function companyWords(name: string | null | undefined): string[] {
  if (!name?.trim()) return [];
  return companyCore(name)
    .filter(({ raw, f }) => f.length >= 4 || (f.length === 3 && /^\p{Lu}+$/u.test(raw)))
    .map(({ f }) => f)
    .filter((f) => !GENERIC_WORDS.has(f) && !NAME_PARTICLES.has(f) && !LEGAL_PIECES.has(f) && !/^\d+$/.test(f));
}

/** A contact's name pieces of 2+ letters, particles aside: "Ng", "Wu", "Lee" are surnames, not noise. */
function namePieces(s: string | null | undefined): string[] {
  if (!s) return [];
  return pieces(s).filter((p) => p.length >= 2 && !NAME_PARTICLES.has(p) && !/^\d+$/.test(p));
}

/**
 * A city's short forms, nicknames and metro names. Each group is one city;
 * the prospect's city belongs to a group when any member appears inside it
 * ("Santiago de Querétaro" → QRO). "TO" counts only in capitals.
 */
const CITY_ALIAS_GROUPS: ReadonlyArray<readonly string[]> = [
  ["Ciudad de México", "Mexico City", "Cd. de México", "CDMX", "D.F.", "chilango", "chilangos", "chilanga", "chilangas",
    "defeño", "defeños", "capitalino", "capitalinos"],
  ["Guadalajara", "GDL", "Zapopan", "tapatío", "tapatíos", "tapatía", "tapatías"],
  ["Monterrey", "MTY", "San Pedro Garza García", "regiomontano", "regiomontanos", "regiomontana", "regiomontanas", "regio", "regios"],
  ["Querétaro", "QRO", "queretano", "queretanos", "queretana", "queretanas"],
  ["Toronto", "TO", "GTA", "YYZ", "North York", "Torontonian", "Torontonians"],
  ["Vancouver", "YVR", "Vancouverite", "Vancouverites"],
  ["Calgary", "YYC", "Calgarian", "Calgarians"],
  ["Edmonton", "YEG", "Edmontonian", "Edmontonians"],
  ["Ottawa", "YOW", "Ottawan", "Ottawans"],
  ["Montréal", "MTL", "YUL", "Montrealer", "Montrealers", "Montréalais", "Montréalaise"],
];
const UPPER_ONLY_ALIASES = new Set(["to"]);

/** Runs of single letters as one word: ["mexico", "d", "f"] → ["mexico", "df"] (a "México, D.F." city field). */
function collapseInitials(ps: readonly string[]): string[] {
  const out: string[] = [];
  let run = "";
  for (const p of ps) {
    if (p.length === 1) {
      run += p;
      continue;
    }
    if (run) out.push(run);
    run = "";
    out.push(p);
  }
  if (run) out.push(run);
  return out;
}

/** The scrubber's view of a city's group: members as folded keys ("D.F." → "df", "Cd. de México" → "cd de mexico"). */
function cityGroup(city: string | null | undefined): Array<{ key: string; rule: CaseRule }> {
  if (!city?.trim()) return [];
  const f = collapseInitials(pieces(city)).join(" ");
  const keyOf = (m: string) => (pieces(m).every((p) => p.length === 1) ? pieces(m).join("") : pieces(m).join(" "));
  const group = CITY_ALIAS_GROUPS.find((g) =>
    g.some((m) => !UPPER_ONLY_ALIASES.has(keyOf(m)) && new RegExp(`(?<![a-z0-9])${keyOf(m)}(?![a-z0-9])`).test(f)),
  );
  return (group ?? []).map((m) => ({ key: keyOf(m), rule: UPPER_ONLY_ALIASES.has(keyOf(m)) ? "upper" : "any" }));
}

/** Greeting words that open the first line: the addressee after them is the recipient. */
const GREETING_RE =
  /^(\s*(?:hi|hello|hey|dear|good\s+(?:morning|afternoon)|hola|buen[oa]s?\s+d[ií]as|buenas\s+tardes|buenas|estimad[oa]s?|querid[oa]s?)\s+)([^,!:;]{1,60}?)(\s*(?:[,!:;].*)?)$/iu;
const GENERIC_ADDRESSEE = /^(team|there|all|everyone|folks|equipo|todos|todas|a\s+todos|a\s+todas)$/iu;
/** Words that may stand next to a blank in a greeting or after an honorific without being a name. */
const FUNCTION_WORDS = new Set([
  "a", "an", "the", "and", "or", "but", "at", "in", "on", "of", "for", "to", "from", "with", "by", "about", "after",
  "before", "over", "into", "is", "are", "was", "were", "has", "have", "had", "will", "would", "can", "could", "may",
  "might", "should", "does", "did", "do", "who", "which", "that", "this", "these", "those", "it", "its", "as", "so",
  "too", "if", "then", "than", "when", "while", "also", "here", "there", "our", "your", "their", "his", "her", "we",
  "you", "they", "he", "she", "i", "me", "us", "team", "all", "everyone", "folks",
  "y", "o", "e", "u", "de", "del", "la", "el", "los", "las", "lo", "le", "les", "en", "con", "por", "para", "sobre",
  "desde", "hasta", "entre", "sin", "que", "quien", "se", "su", "sus", "al", "tras", "ya", "no", "es", "son", "fue",
  "equipo", "todos", "todas", "usted", "ustedes", "nos", "nuestro", "nuestra", "tambien", "aqui",
]);
const HONORIFICS = new Set([
  "dr", "dra", "drs", "lic", "licda", "lcda", "ing", "arq", "mtro", "mtra", "prof", "sr", "sra", "srta", "cp", "don",
  "dona", "mr", "mrs", "ms",
  // Plurals: "Drs. Patel and Wong", "Sres. Gómez".
  "dres", "dras", "sres", "sras", "srs", "lics", "ings", "arqs", "profs", "messrs", "mmes", "mme", "mlle",
]);
const NAME_LINK = "(?:de|del|la|las|los|van|von|der|da|di|du|dos|le|y)";
/**
 * An honorific and the capitalized name after it, with particles and initials:
 * "Dr. Patel", "Dr. J. Patel", "Sra. de la Peña", "Dra. María José Gómez Ruiz", "C.P. Ramírez".
 */
const HONORIFIC_RE = new RegExp(
  `(?<![\\p{L}])(Dr|Dra|Drs|Dres|Dras|Lic|Lics|Licda|Lcda|Ing|Ings|Arq|Arqs|Mtro|Mtra|Prof|Profs|Mr|Mrs|Ms|Mx|Messrs|Mmes?|Mlle|Sr|Sra|Srs|Sres|Sras|Srta|Don|Doña|C\\.\\s?P)(\\.?\\s+)` +
    `(?:(?:\\p{Lu}\\.?|${NAME_LINK})\\s+)*\\p{Lu}[\\p{L}’'-]*(?:\\s+(?:${NAME_LINK}\\s+)*\\p{Lu}[\\p{L}’'-]*){0,3}`,
  "gu",
);
/**
 * An honorific (dotted, or one of the unambiguous ones without a dot) and the
 * next word in ANY case, past particles and initials: "dr. patel", "dr patel",
 * "sra. de la peña", "dr. j patel", "lic. núñez" in a lower-case subject. A
 * blanked ordinary word ("dr. [name]" for "dr. visit") is the accepted cost.
 * The word stops before a possessive "'s".
 */
const LOWER_HONORIFIC_RE = new RegExp(
  `(?<![\\p{L}\\p{N}])((?:(?:dr|dra|drs|dres|dras|lic|lics|licda|lcda|ing|ings|arq|arqs|mtro|mtra|prof|profs|mr|mrs|ms|mx|messrs|mmes?|mlle|sr|sra|srs|sres|sras|srta|c\\.\\s?p)\\.[ \\t]*\\n?[ \\t]*` +
    `|(?:dr|dra|dres|lic|licda|lcda|arq|mtro|mtra|sra|sres|sras|srta)[ \\t]*\\n?[ \\t]+)+)` +
    `(?:(?:${NAME_LINK}|\\p{L}\\.?)[ \\t]+)*\\p{L}+(?:[’'-](?!s(?!\\p{L}))\\p{L}+)*`,
  "giu",
);

/**
 * Spelled-out numbers, EN and ES, 0–100 plus hundred/thousand/million and
 * dozen. Left out on purpose: "one", "uno", "un", "una" (pronoun and article)
 * and "once" (English "once"; Spanish 11 is rare in prose).
 */
const NUMBER_WORDS = [
  "zero", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten", "eleven", "twelve", "thirteen",
  "fourteen", "fifteen", "sixteen", "seventeen", "eighteen", "nineteen", "twenty", "thirty", "forty", "fifty", "sixty",
  "seventy", "eighty", "ninety", "hundred", "hundreds", "thousand", "thousands", "million", "millions", "dozen", "dozens",
  "cero", "dos", "tres", "cuatro", "cinco", "seis", "siete", "ocho", "nueve", "diez", "doce", "trece", "catorce",
  "quince", "dieciseis", "diecisiete", "dieciocho", "diecinueve", "veinte", "veintiuno", "veintiun", "veintidos",
  "veintitres", "veinticuatro", "veinticinco", "veintiseis", "veintisiete", "veintiocho", "veintinueve", "treinta",
  "cuarenta", "cincuenta", "sesenta", "setenta", "ochenta", "noventa", "cien", "ciento", "cientos", "mil", "millon",
  "millones", "docena", "docenas",
];
const NUMBER_WORDS_RE = new RegExp(`(?<![\\p{L}\\p{N}])(?:${NUMBER_WORDS.join("|")})(?![\\p{L}\\p{N}])`, "gu");

/** Inboxes that name a role, not a person: never read as a given name. */
const ROLE_LOCALS = new Set([
  "info", "informes", "informacion", "contact", "contacto", "contactanos", "hello", "hola", "hi", "admin", "office",
  "oficina", "sales", "ventas", "support", "soporte", "help", "ayuda", "booking", "bookings", "reservas",
  "reservaciones", "reception", "recepcion", "citas", "appointments", "team", "equipo", "mail", "correo", "general",
  "webmaster", "noreply", "marketing", "store", "tienda", "shop", "orders", "pedidos", "billing", "facturacion",
  "clinic", "clinica", "hotel", "restaurant", "restaurante", "direccion", "gerencia", "manager", "owner",
]);

/**
 * With no contact name, the writer greets from the e-mail address when it
 * reads as a given name (monica@ → "Hola Monica"): that name is a field too.
 * The scrubber's reading: the first segment of the local part, 3+ letters,
 * a known name and no role inbox.
 */
function emailGivenName(email: string | null | undefined): string | null {
  const seg = fold(email?.split("@")[0] ?? "").split(/[._+\-\d]+/)[0] ?? "";
  return /^\p{L}{3,}$/u.test(seg) && !ROLE_LOCALS.has(seg) && ALL_NAMES.has(seg) ? seg : null;
}

/**
 * Replace the past recipient's name, company, site and city, and every digit,
 * with [name], [company], [site], [city] and [n]. URLs and e-mail addresses go
 * too: a link on the 👉 line becomes {hunter_url} (the slot the writer fills),
 * any other one [site]. Text with none of these comes back unchanged. What this
 * misses, exemplarLeaks catches.
 */
export function scrubExemplar(text: string, prospect: ExemplarProspect): string {
  // Format characters (zero-width space, soft hyphen, bidi marks) first: "Pa\u200btel" is "Patel".
  let out = text.replace(/\p{Cf}/gu, "");
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

  // Company: the whole name, then the name without suffix, then its initials
  // ("KP", "A.B.C.") in capitals, then each distinctive word of it or of the
  // domain's label ("The team at Wagner", "waglaw", "kpi"); a 5+ letter word
  // takes the whole word it sits in ("the Wagners", "@wagnerlaw").
  if (prospect.company_name?.trim()) {
    for (const p of companyPhrases(prospect.company_name)) out = replacePhrase(out, p, "[company]");
  }
  // Initials that are no word ("kp", "rx") go in any case: a subject is lower case by house rule.
  for (const run of initialRuns(prospect.company_name)) {
    out = replaceMatches(out, lettersPattern(run), "[company]", isCommonWord(run) ? "upper" : "any");
  }
  const words = new Set([...companyWords(prospect.company_name), ...distinctive(host?.split(".")[0], 3)]);
  for (const w of words) {
    out = replaceMatches(out, w.length >= 5 ? containingPattern(w) : lettersPattern(w), "[company]");
  }

  // City: the name, its distinctive words, then every other name its group
  // goes by, with or without dots ("CDMX", "C.D.M.X.", "Qro", "T.O.").
  if (prospect.city?.trim()) {
    out = replacePhrase(out, prospect.city, "[city]");
    for (const w of distinctive(prospect.city)) out = replacePhrase(out, w, "[city]");
    for (const { key, rule } of cityGroup(prospect.city)) {
      out = key.includes(" ") ? replacePhrase(out, key, "[city]", rule) : replaceMatches(out, lettersPattern(key), "[city]", rule);
    }
  }

  // Contact: the full name, then each space-separated part ("Núñez-Ruiz",
  // "O’Brien"), then each piece of those. A particle or two-letter word as the
  // last name ("Minh Le", "Minh To") goes only where it cannot open a sentence.
  const fullName = prospect.recipient_name?.trim() || emailGivenName(prospect.recipient_email);
  if (fullName) {
    out = replacePhrase(out, fullName, "[name]", commonOnly(fullName) ? nameRule(pieces(fullName)) : "any");
    const chunks = fullName.split(/\s+/);
    chunks.forEach((chunk, i) => {
      const ps = pieces(chunk);
      if (ps.every((p) => NAME_PARTICLES.has(p))) {
        if (i === chunks.length - 1 && i > 0 && ps.join("").length >= 2) out = replacePhrase(out, chunk, "[name]", "inline");
        return;
      }
      out = replacePhrase(out, chunk, "[name]", nameRule(ps));
      // "O’Brien" is also "obrien" inside a handle ("@obrienlaw").
      const joined = ps.join("");
      if (ps.length > 1 && joined.length >= 5 && !isCommonWord(joined)) out = replaceMatches(out, containingPattern(joined), "[name]");
    });
    for (const p of namePieces(fullName)) {
      const rule = nameRule([p]);
      // "The Nguyens", "the Smiths"; a rare 5+ letter surname inside a handle ("@obrienlaw").
      if (rule === "any") out = replaceMatches(out, pluralPattern(p), "[name]");
      if (rule === "any" && p.length >= 5 && !isCommonWord(p)) out = replaceMatches(out, containingPattern(p), "[name]");
      out = replacePhrase(out, p, "[name]", rule);
    }
  }

  // Hashtags and handles hide a field inside a longer word: "#TorontoDental",
  // "#YYCbiz", "@nglaw". A tag that contains the city, one of its short forms
  // or a name piece of 2+ letters is blanked whole.
  const cityKeys = [...distinctive(prospect.city), ...cityGroup(prospect.city).filter((g) => g.rule === "any").map((g) => g.key.replace(/ /g, ""))]
    .filter((k) => k.length >= 3);
  const nameKeys = fullName ? namePieces(fullName).filter((p) => !COMMON_WORD_NAMES.has(p)) : [];
  out = out.replace(/(?<![\p{L}\p{N}])([#@])([\p{L}\p{N}_]+)/gu, (m, sigil: string, tag: string) => {
    const f = fold(tag);
    if (cityKeys.some((k) => f.includes(k))) return `${sigil}[city]`;
    if (nameKeys.some((k) => f.includes(k))) return `${sigil}[name]`;
    return m;
  });

  // Names the contact row did not know: after an honorific (capitalized, then
  // any case), and the greeting's addressee.
  out = out.replace(HONORIFIC_RE, (_m, title: string, sep: string) => `${title}${sep}[name]`);
  out = out.replace(LOWER_HONORIFIC_RE, (_m, titles: string) => `${titles}${/\s$/.test(titles) ? "" : " "}[name]`);
  const lead = out.match(/^\s*/)![0].length;
  const nl = out.indexOf("\n", lead);
  const first = nl === -1 ? out.slice(lead) : out.slice(lead, nl);
  const greeted = first.replace(GREETING_RE, (m, lead: string, who: string, rest: string) => {
    const w = who.trim();
    if (GENERIC_ADDRESSEE.test(w)) return m;
    // "Hola equipo de [company]" stays; "Hi [name] Patel" does not.
    const plain = (x: string) => fold(x).replace(/[^\p{L}]/gu, "");
    const ok = w.split(/\s+/).every((x) => /^\[\w+\]$/.test(x) || FUNCTION_WORDS.has(plain(x)) || HONORIFICS.has(plain(x)));
    if (w.includes("[") && ok) return m;
    return `${lead}[name]${rest}`;
  });
  out = out.slice(0, lead) + greeted + (nl === -1 ? "" : out.slice(nl));

  // "[name] [name]" (María José) and "[company]-[company]" (Smith-Jones) are one blank.
  out = out.replace(/\[(name|company|city|site)\](?:[ \t‐-]+\[\1\])+/g, "[$1]");

  // Every number, in digits or spelled out: a number from one email is never a fact about the next.
  out = out.replace(/\d+(?:[.,:/]\d+)*/g, "[n]");
  out = replaceMatches(out, NUMBER_WORDS_RE, "[n]");
  return out.replace(/\[n\](?:(?:[ \t-]+|[ \t]+(?:and|y)[ \t]+)\[n\])+/g, "[n]");
}

// ── The leak check ────────────────────────────────────────────────────────────
//
// A second, coarser matcher that shares NO matching code with the scrubber, so
// it can see what the scrubber's rules miss. Its own fold (NFKD + stroke
// letters), its own tokenizer (the dots inside initials removed, so "C.D.M.X."
// is the token "CDMX"), letters-only substrings for long company words, and
// span rules after honorifics and greetings. It shares only the word lists.
//
// The invariant a kept exemplar satisfies (allowListLeaks):
// I1 Tokens. Format characters (\p{Cf}: zero-width, soft hyphen, bidi marks)
//    are removed, the text is NFKD-folded, a letter + apostrophe + capital is
//    one word (O’Brien), and a token is a maximal run of letters (\p{L});
//    digits and punctuation separate tokens. A token with any letter outside
//    a-z after folding (金龍, Иванов, "Pаtel" with a Cyrillic а, Weiß) never
//    passes; neither does any letter drawn as a symbol (🅟, ⒫, regional
//    indicators) or a word split by a visible mark (Wil·son, Pa‧tel, Pa⠀tel).
// I2 Positions. A sentence opens at the start, after a newline, or after
//    . ! ? ¿ ¡ … that is not an abbreviation dot (one letter, a capitalized run
//    of up to 4 letters, an honorific: "J. Torres", "Nut. Cruz" are
//    mid-sentence). A colon never opens one ("Front desk: Grant").
// I3 Tiers, by position (sets below, names from ./wordlists/names.ts):
//    - capitalized mid-sentence, all capitals (2+ letters), any capital in the
//      subject or in an address chunk ("@", "#", "://", "www", a dot between
//      letters): the 20k lists minus every name (CAPITAL_DENY), plus our
//      vocabulary and CAPITALIZED_WORDS (months, countries, provinces);
//    - capitalized at a sentence start: that, plus the names that are common
//      words ("Mark the date", "Rosa mexicano");
//    - lower case in the subject or an address chunk: the 20k lists minus
//      NAME_ONLY (names that are no word: garcia, patel, gordon);
//    - lower case anywhere else: the 50k lists minus NAME_ONLY.
//    Residuals, accepted: a common-word name at a sentence start ("Grant
//    Hill runs the desk."), a name among the 300 most frequent words ("He",
//    "Lo", "Will") or a weak one (no given name, surname rank past 10,000:
//    "La", "Re") capitalized mid-sentence, a two-letter name in lower case.
// I4 The field checks and the honorific and greeting spans (exemplarLeaks)
//    run as well: they catch the current prospect's name, and with no contact
//    name the given name in the address (monica@), even when it is a word.

function leakFold(s: string): string {
  return s
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/ł/g, "l")
    .replace(/đ/g, "d")
    .replace(/ø/g, "o");
}

type LeakToken = { kind: "word" | "blank" | "stop"; raw: string; f: string; aposBefore: boolean; aposAfter: boolean };

function leakTokens(text: string): LeakToken[] {
  const dotless = text.replace(/(?<![\p{L}\p{N}])(\p{L})\.(?=\p{L}(?![\p{L}\p{N}]))/gu, "$1");
  const out: LeakToken[] = [];
  const re = /\[(?:name|company|site|city|n)\]|\{hunter_url\}|[\p{L}\p{N}]+|[\n.,;:!?¿¡()"“”\-–—]/gu;
  for (const m of dotless.matchAll(re)) {
    const raw = m[0];
    const kind = raw.startsWith("[") || raw.startsWith("{") ? "blank" : /^[\p{L}\p{N}]/u.test(raw) ? "word" : "stop";
    out.push({
      kind,
      raw,
      f: leakFold(raw),
      aposBefore: /['’]$/u.test(dotless.slice(0, m.index)),
      aposAfter: /^['’]/u.test(dotless.slice(m.index + raw.length)),
    });
  }
  return out;
}

type LeakRule = "any" | "capital" | "upper";

/** Raw parts of a field, folded: "A.B.C. Plumbing" → a, b, c, plumbing (as written and folded). */
function leakParts(s: string | null | undefined): Array<{ raw: string; f: string }> {
  return (s ?? "").split(/[^\p{L}\p{N}]+/u).filter(Boolean).map((raw) => ({ raw, f: leakFold(raw) }));
}

const leakGeneric = (f: string) =>
  GENERIC_WORDS.has(f) || NAME_PARTICLES.has(f) || LEGAL_PIECES.has(f) || ARTICLES.has(f) || /^\d+$/.test(f);

/**
 * Fail closed: what is still in the text of the old prospect. Anything here
 * means the scrubber missed, and the exemplar is dropped. Checked, with its
 * own matcher (see above):
 * - company: every distinctive word of 5+ letters as a SUBSTRING of each
 *   letters-only chunk ("the Wagners", "@wagnerlaw", "facebook.com/WagnerLawTO");
 *   4-letter words and 3-letter words written in capitals as words; runs of
 *   initials in capitals ("KP", "A.B.C.", "J.D."); a multi-word name as a phrase.
 *   The domain label's words likewise (3+ letters).
 * - city: distinctive words, the full name as a phrase, and every name of its
 *   alias group, found by any member inside the city field ("Santiago de
 *   Querétaro" → QRO), dotted or not ("Qro.", "T.O.", "C.D.M.X.").
 * - contact: every name piece of 2+ letters; the LAST piece always, in
 *   capitals only when it is a particle or a common word ("Minh Le").
 * - after any honorific, and after the first line's greeting: the name span
 *   must be blanks, particles, initials or function words.
 */
export function exemplarLeaks(rawText: string, prospect: ExemplarProspect, opts: { subject?: boolean } = {}): string[] {
  const text = rawText.replace(/\p{Cf}/gu, "");
  const toks = leakTokens(text);
  const seq = toks.filter((t) => t.kind !== "stop");
  const chunks = text
    .replace(PLACEHOLDER_RE, " ")
    .split(/\s+/)
    .map((c) => leakFold(c).replace(/[^\p{L}\p{N}]/gu, ""));
  const leaks = new Set<string>();

  const hasSeq = (fs: readonly string[], rule: LeakRule) =>
    seq.some((_, i) =>
      fs.every((f, k) => {
        const t = seq[i + k];
        if (!t || t.kind !== "word" || t.f !== f) return false;
        if (rule === "upper") return /\p{Lu}/u.test(t.raw) && !/\p{Ll}/u.test(t.raw);
        return rule === "capital" && k === 0 ? /^\p{Lu}/u.test(t.raw) : true;
      }),
    );
  const word = (f: string, rule: LeakRule = "any", label = f) => {
    if (hasSeq([f], rule)) leaks.add(label);
  };
  const phrase = (fs: readonly string[], rule: LeakRule = "any") => {
    if (fs.length > 0 && hasSeq(fs, rule)) leaks.add(rule === "upper" ? fs.join(" ").toUpperCase() : fs.join(" "));
  };
  const substring = (f: string) => {
    if (chunks.some((c) => c.includes(f))) leaks.add(f);
  };

  // Company.
  const parts = leakParts(prospect.company_name);
  let end = parts.length;
  while (end > 1 && LEGAL_PIECES.has(parts[end - 1]!.f)) end--;
  let start = 0;
  while (start < end - 1 && ARTICLES.has(parts[start]!.f)) start++;
  const core = parts.slice(start, end);
  let run = "";
  for (const { raw, f } of [...core, { raw: " ", f: " " }]) {
    if (f.length <= 2 && f !== " " && !RUN_BREAKERS.has(f) && /^\p{L}+$/u.test(f)) {
      run += f;
      continue;
    }
    if (run.length >= 2) word(run, FREQ_20K.has(run) && !NAMES.has(run) ? "upper" : "any");
    run = "";
    if (f === " " || leakGeneric(f)) continue;
    if (f.length >= 5) substring(f);
    else if (f.length === 4 || (f.length === 3 && /^\p{Lu}+$/u.test(raw))) word(f);
  }
  if (core.length >= 2) phrase(core.map((p) => p.f));
  const host = hostOf(prospect.domain, prospect.website_url);
  const label = leakParts(host?.split(".")[0]);
  for (const { f } of label) {
    if (leakGeneric(f)) continue;
    if (f.length >= 5) substring(f);
    else if (f.length >= 3) word(f);
  }
  const joinedLabel = label.map((p) => p.f).join("");
  if (label.length > 1 && joinedLabel.length >= 5) substring(joinedLabel);

  // City and its group.
  // Single letters run together, so a "México, D.F." field has the part "df".
  const cityParts = leakParts(prospect.city)
    .map((p) => p.f)
    .reduce<string[]>((acc, f, i, all) => {
      if (f.length === 1 && i > 0 && all[i - 1]!.length === 1) acc[acc.length - 1] += f;
      else acc.push(f);
      return acc;
    }, []);
  for (const f of cityParts) if (f.length >= 4 && !leakGeneric(f)) word(f);
  if (cityParts.length >= 2) phrase(cityParts);
  const memberParts = (m: string) => {
    const ps = leakParts(m).map((p) => p.f);
    return ps.every((p) => p.length === 1) ? [ps.join("")] : ps;
  };
  const inCity = (ms: string[]) => cityParts.some((_, i) => ms.every((m, k) => cityParts[i + k] === m));
  const group = CITY_ALIAS_GROUPS.find((g) =>
    g.some((m) => {
      const ms = memberParts(m);
      return !(ms.length === 1 && UPPER_ONLY_ALIASES.has(ms[0]!)) && inCity(ms);
    }),
  );
  for (const m of group ?? []) {
    const ms = memberParts(m);
    phrase(ms, ms.length === 1 && UPPER_ONLY_ALIASES.has(ms[0]!) ? "upper" : "any");
  }

  // Contact.
  // No contact name: the address's leading letters, when they are a name, are the name ("monica.r@" → monica).
  const local = /^[a-z]+/.exec(leakFold(prospect.recipient_email?.split("@")[0] ?? ""))?.[0] ?? "";
  const fromEmail = !prospect.recipient_name?.trim() && local.length >= 3 && !ROLE_LOCALS.has(local) && ALL_NAMES.has(local);
  const name = fromEmail ? [local] : leakParts(prospect.recipient_name).map((p) => p.f);
  name.forEach((f, i) => {
    if (f.length < 2 || /^\d+$/.test(f)) return;
    const last = i === name.length - 1;
    if (NAME_PARTICLES.has(f) && !last) return;
    const common = COMMON_WORD_NAMES.has(f) || NAME_PARTICLES.has(f);
    word(f, common ? "capital" : "any");
    // "The Nguyens", "the Smiths".
    if (!common) {
      word(`${f}s`, "any", f);
      word(`${f}es`, "any", f);
    }
  });

  // The name span after an honorific, and after the first line's greeting.
  const span = (from: number, lowerStyle: boolean, label: string) => {
    let seen = false;
    let count = 0;
    for (let j = from; j < toks.length && count < 4; j++) {
      const u = toks[j]!;
      if (u.kind === "stop") {
        const prev = toks[j - 1];
        // The dot of an honorific or an initial ("Dr. J. Patel") does not end the span,
        // nor does one line break ("Dr.\nPatel", "María\nGómez"); a blank line does.
        if (u.raw === "." && prev?.kind === "word" && (HONORIFICS.has(prev.f) || prev.f.length === 1)) continue;
        if (u.raw === "\n" && toks[j + 1]?.raw !== "\n" && prev?.raw !== "\n") continue;
        return;
      }
      if (u.kind === "blank") {
        seen = true;
        count++;
        continue;
      }
      if (u.aposBefore && u.f === "s") return; // "[name]'s"
      if (HONORIFICS.has(u.f)) continue;
      if (NAME_PARTICLES.has(u.f) || (u.f.length === 1 && /\p{L}/u.test(u.f))) {
        count++;
        continue;
      }
      // "Drs. [name] and Patel": a second name joined by "and" / "y" / "e".
      if (seen && (u.f === "and" || u.f === "y" || u.f === "e")) {
        seen = false;
        continue;
      }
      if (FUNCTION_WORDS.has(u.f)) return;
      // After the blank, a capitalized word is a name; so is any lower-case word
      // after a lower-case title, or one too rare to follow a name ("Dr. [name] patel").
      if (!seen || /^\p{Lu}/u.test(u.raw) || lowerStyle || !inWords(TOP_WORDS, u.f)) leaks.add(`${label} ${u.f}`);
      return;
    }
  };
  toks.forEach((t, i) => {
    if (t.kind !== "word" || !HONORIFICS.has(t.f) || t.aposAfter || t.aposBefore) return;
    if (i > 0 && toks[i - 1]!.kind === "word" && HONORIFICS.has(toks[i - 1]!.f)) return; // inside a chain
    span(i + 1, !/\p{Lu}/u.test(t.raw), t.f);
  });
  // Every line that opens with a greeting, not only the first: a body's "Hi Raj Patel,".
  const GREETINGS = [["good", "morning"], ["good", "afternoon"], ["good", "evening"], ["buenos", "dias"], ["buenas", "tardes"],
    ["buenas", "noches"], ["buen", "dia"], ["hi"], ["hello"], ["hey"], ["dear"], ["hola"], ["buenas"], ["estimado"],
    ["estimada"], ["estimados"], ["estimadas"], ["querido"], ["querida"]];
  toks.forEach((_, i) => {
    if (i > 0 && toks[i - 1]!.raw !== "\n") return;
    let lead = i;
    while (toks[lead]?.kind === "stop" && toks[lead]!.raw !== "\n") lead++;
    const greet = GREETINGS.find((g) => g.every((w, k) => toks[lead + k]?.kind === "word" && toks[lead + k]!.f === w));
    if (!greet) return;
    const next = toks[lead + greet.length];
    if (next?.kind === "word" && GENERIC_ADDRESSEE.test(next.f)) return;
    span(lead + greet.length, false, "greeting");
  });

  for (const w of allowListLeaks(text, opts.subject === true)) leaks.add(w);
  return [...leaks];
}

/** Where a blank stood: not a letter (it ends a token), and not a sentence end. */
const LEAK_BLANK = "\uE000";
/** What may stand between a sentence end and its first word: spaces, quotes, brackets, bullets, dashes, emoji. */
const OPENER_SKIP = /[^\S\n]|["“”'‘’«»([*•·\p{Pd}\p{So}\p{Sk}]/u;
/** Not ":": "Front desk: Grant" is mid-sentence. */
const SENTENCE_END = /[\n.!?¿¡…]/u;
/** A chunk that is a handle, hashtag, email, URL or domain: every token in it is strict. */
const ADDRESS_CHUNK = /[@#]|:\/\/|www|\p{L}\.\p{L}/iu;
/** Letters drawn as symbols, with no NFKD letter inside: 🅟🅐🅣, 🅿🅰🆃, regional indicators, ⒫⒜⒯ (NFKD "(p)(a)(t)"). */
const LETTER_SYMBOLS = /[\u2460-\u24ff\u{1f100}-\u{1f1ff}]/u;
/** Visible marks that split a word without looking like a break: "Wil·son", "Wiŀson", "Pa‧tel", "Pa᠆tel", "Pa⠀tel". */
const INWORD_SEPARATOR = /\p{L}[\u00b7\u0387\u2027\u1806\u2800\u2219\u22c5\u30fb\u318d]+\p{L}/u;

function leakOpensSentence(norm: string, at: number): boolean {
  let i = at;
  // By code point, so an emoji's two halves are skipped together.
  for (;;) {
    const prev = [...norm.slice(Math.max(0, i - 2), i)].pop();
    if (prev === undefined || !OPENER_SKIP.test(prev)) break;
    i -= prev.length;
  }
  if (i <= 0) return true;
  const end = norm[i - 1]!;
  if (!SENTENCE_END.test(end)) return false;
  if (end === ".") {
    // The dot of an initial or a short title ends nothing: "J. Torres", "C.D. Torres", "Nut. Cruz" are mid-sentence.
    const before = /(\p{L}+)$/u.exec(norm.slice(0, i - 1))?.[1] ?? "";
    if (before.length === 1 || (before.length <= 4 && /^\p{Lu}/u.test(before)) || HONORIFICS.has(leakFold(before))) return false;
  }
  return true;
}

/**
 * The allow-list (I1 to I3 above): every token must be a common EN or ES word,
 * our own vocabulary, or a blank, in the tier its place calls for. Whatever
 * else is left is a word of the old prospect's world the field checks did not
 * know to look for.
 */
function allowListLeaks(text: string, subject: boolean): string[] {
  const out: string[] = [];
  const symbol = LETTER_SYMBOLS.exec(text);
  if (symbol) out.push(symbol[0]);
  const norm = text
    .replace(/\p{Cf}/gu, "")
    .replace(PLACEHOLDER_RE, LEAK_BLANK)
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    // "O’Brien", "D'Angelo" are one word.
    .replace(/(?<!\p{L})([ODLMN])['’](?=\p{Lu})/gu, "$1");
  const split = INWORD_SEPARATOR.exec(norm);
  if (split) out.push(split[0]);
  for (const chunk of norm.matchAll(/\S+/gu)) {
    const address = ADDRESS_CHUNK.test(chunk[0]);
    for (const m of chunk[0].matchAll(/\p{L}+/gu)) {
      const raw = m[0];
      const f = leakFold(raw);
      if (!/^[a-z]+$/.test(f)) {
        out.push(f);
        continue;
      }
      const capital = /^\p{Lu}/u.test(raw);
      const caps = raw.length >= 2 && !/\p{Ll}/u.test(raw);
      let ok: boolean;
      if (capital && (caps || subject || address || !leakOpensSentence(norm, chunk.index + m.index))) ok = inWords(CAPITAL_WORDS, f, CAPITAL_DENY);
      else if (capital) ok = inWords(OPENER_WORDS, f, OPENER_DENY);
      else if (subject || address) ok = inWords(LOWER_STRICT_WORDS, f, NAME_ONLY);
      else ok = isKnownWord(f);
      if (!ok) out.push(f);
    }
  }
  return out;
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
  // Subject and body are checked apart: the body's first line is its own greeting line.
  if (exemplarLeaks(subject, pitch, { subject: true }).length > 0 || exemplarLeaks(body, pitch).length > 0) return null;
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
