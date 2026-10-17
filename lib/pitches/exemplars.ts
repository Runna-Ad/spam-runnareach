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
export const EXEMPLAR_PROMPT_VERSION = "exemplar-v1-2026-10-17";
export const MAX_EXEMPLARS = 2;
export const MIN_EXEMPLAR_SCORE = 0.5;
/** How many segment-matching candidates get their events read and scored. */
export const EXEMPLAR_SHORTLIST = 20;

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

/** Who the past email went to: everything that must not travel to the next one. */
export type ExemplarProspect = {
  company_name: string | null;
  domain: string | null;
  website_url?: string | null;
  recipient_name: string | null;
  recipient_email?: string | null;
  city?: string | null;
};

const ACCENTS: Record<string, string> = {
  a: "aáàâäã",
  e: "eéèêë",
  i: "iíìîï",
  o: "oóòôöõ",
  u: "uúùûü",
  n: "nñ",
  c: "cç",
};

function fold(s: string): string {
  return s.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "");
}

/** A literal as a regex source where each letter also matches its accented forms. */
function accentInsensitive(literal: string): string {
  let out = "";
  for (const ch of literal) {
    const base = fold(ch);
    const set = ACCENTS[base];
    if (set) {
      out += `[${set}${set.toUpperCase()}]`;
    } else if (/[a-z]/i.test(ch)) {
      out += ch;
    } else if (/\s/.test(ch)) {
      out += "\\s+";
    } else {
      out += ch.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");
    }
  }
  return out;
}

/** Whole-word replace, accent- and (optionally) case-insensitive. */
function replaceWord(text: string, literal: string, placeholder: string, caseInsensitive: boolean): string {
  const lit = literal.trim();
  if (!lit) return text;
  const re = new RegExp(`(?<![\\p{L}\\p{N}])${accentInsensitive(lit)}(?![\\p{L}\\p{N}])`, caseInsensitive ? "giu" : "gu");
  return text.replace(re, placeholder);
}

const LEGAL_SUFFIX =
  /[\s,]+(inc\.?|incorporated|ltd\.?|limited|llc|llp|corp\.?|corporation|co\.?|company|ltée|ltee|s\.?\s?a\.?(\s+de\s+c\.?\s?v\.?)?|s\.?\s?de\s+r\.?\s?l\.?(\s+de\s+c\.?\s?v\.?)?|s\.?\s?c\.?)$/i;

/** The company as it may appear in prose: full, without "The", without the legal suffix. */
function companyVariants(name: string, domain: string | null): string[] {
  const out = new Set<string>();
  const full = name.trim();
  if (full.length >= 2) out.add(full);
  let core = full;
  for (let i = 0; i < 3; i++) core = core.replace(LEGAL_SUFFIX, "").trim();
  core = core.replace(/^(the|el|la|los|las)\s+/i, "").trim();
  if (core.length >= 3) out.add(core);
  // The domain's label ("waglaw" for waglaw.net) is often the brand as written.
  const label = domain?.split(".")[0];
  if (label && label.length >= 4) out.add(label);
  // Longest first, so "Acme Dental Inc." is replaced before "Acme Dental".
  return [...out].sort((a, b) => b.length - a.length);
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

/** Name particles and short words that are also ordinary prose: never scrubbed alone. */
const NAME_PARTICLES = new Set([
  "de", "del", "la", "las", "los", "el", "y", "e", "al", "da", "di", "do", "dos", "du", "le", "van", "von", "der", "den",
  "st", "san", "mc", "jr", "sr", "ii", "iii",
]);
/** Given names that are also common words: scrubbed only when capitalized. */
const COMMON_WORD_NAMES = new Set([
  "will", "mark", "may", "june", "april", "rose", "grace", "hope", "faith", "joy", "bill", "art", "pat", "sun", "sol",
  "luz", "paz", "rey", "dolores", "amparo", "consuelo", "angel", "angeles", "rocio", "pilar", "mercedes", "guadalupe",
  "victoria", "rich", "frank", "earnest", "ernest", "dean", "chase", "page", "sky", "summer", "winter", "rob", "sue",
]);

/** Greeting words that open the first line: the addressee after them is the recipient. */
const GREETING_RE =
  /^(\s*(?:hi|hello|hey|dear|good\s+(?:morning|afternoon)|hola|buen[oa]s?\s+d[ií]as|buenas\s+tardes|buenas|estimad[oa]s?|querid[oa]s?)\s+)([^,\n!:;]{1,60})([,!:;])/iu;
const GENERIC_ADDRESSEE = /^(team|there|all|everyone|folks|equipo|todos|todas|a\s+todos|a\s+todas)$/iu;

/**
 * Replace the past recipient's name, company, site and city, and every digit,
 * with [name], [company], [site], [city] and [n]. URLs and e-mail addresses go too: a link
 * on the 👉 line becomes {hunter_url} (the slot the writer fills), any other
 * one [site]. Text with none of these comes back unchanged.
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
  if (host) {
    out = replaceWord(out, `www.${host}`, "[site]", true);
    out = replaceWord(out, host, "[site]", true);
  }

  if (prospect.company_name?.trim()) {
    for (const v of companyVariants(prospect.company_name, host)) out = replaceWord(out, v, "[company]", true);
  }

  // A city is a proper noun; matching it case-sensitively spares "mission" for Mission, BC.
  if (prospect.city?.trim()) out = replaceWord(out, prospect.city, "[city]", false);

  const fullName = prospect.recipient_name?.trim();
  if (fullName) {
    out = replaceWord(out, fullName, "[name]", true);
    for (const token of fullName.split(/\s+/)) {
      const t = token.replace(/^[^\p{L}]+|[^\p{L}]+$/gu, "");
      const f = fold(t);
      if (t.length < 2 || NAME_PARTICLES.has(f)) continue;
      out = replaceWord(out, t, "[name]", !COMMON_WORD_NAMES.has(f));
    }
  }

  // The greeting names the recipient even when the contact row had no name
  // ("Hi Miguel," from miguel@…): the first line's addressee goes.
  out = out.replace(GREETING_RE, (m, lead: string, who: string, punct: string) => {
    const w = who.trim();
    if (w.includes("[") || GENERIC_ADDRESSEE.test(w)) return m;
    return `${lead}[name]${punct}`;
  });

  // Every digit: a number from one email is never a fact about the next.
  return out.replace(/\d+(?:[.,:/]\d+)*/g, "[n]");
}

/** A selected past pitch → what the writer and critic may see. */
export function toExemplar(
  picked: { pitch_id: string; score: number },
  pitch: { subject: string; body: string } & ExemplarProspect,
): Exemplar {
  return {
    pitch_id: picked.pitch_id,
    score: picked.score,
    subject: scrubExemplar(pitch.subject, pitch),
    body: scrubExemplar(pitch.body, pitch),
  };
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
