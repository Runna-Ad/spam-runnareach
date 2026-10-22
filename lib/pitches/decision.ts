/**
 * The decision record: what was decided when a pitch was written, kept so an
 * outcome (reply, scan, opt-out) can be traced back to the choices behind it.
 *
 * Written once, at generation, into pitches.decision (a trigger refuses later
 * changes). Send-time facts — the recipient actually used, the verifier's
 * verdict, how much a person edited — go to pitch_events instead, because a
 * pitch can be edited and re-sent long after it was written.
 *
 * Pure — tested in tests/decision.test.ts.
 */

import { fold, normalizeNumbers } from "./content-rules.ts";

export const DECISION_VERSION = 1;

export type CriticVerdict = {
  model: string;
  pass: boolean;
  score: number;
  /** Concrete fix instructions from the final review (empty when it passed). */
  issues: string[];
  /** How many times the writer was sent back to revise (0–2). */
  revisions: number;
  /** One entry per review, oldest first: shows whether revising helped. */
  history: Array<{ pass: boolean; score: number; issues: string[] }>;
};

export type DecisionRecord = {
  v: number;
  created_at: string;
  /** Which writer produced the text. */
  path: "claude" | "template" | "website_claude" | "website_template";
  prompt_version: string;
  model: string | null;
  fallback_reason: string | null;
  lang: "en" | "es";
  register: "tu" | "usted" | null;
  segment: {
    industry: string | null;
    market: string | null;
    size_band: SizeBand;
  };
  pain: { id: string | null; label: string | null };
  /**
   * pain_codes: the prospect pains the row was offered for (its for_pains).
   * Optional: decisions written before pitch-v3.1 have none.
   */
  benchmarks_offered: Array<{ id: string; figure: string; pain_codes?: string[] }>;
  /** The offered benchmark the email actually quoted, if any (stat vs no-stat). */
  benchmark_cited: { id: string; figure: string } | null;
  attribution_code: string | null;
  recipient: {
    email_domain: string | null;
    selected_by: string | null;
    role_based: boolean;
    named: boolean;
  };
  critic: CriticVerdict | null;
  gate: { version: number; pass: boolean; codes: string[] } | null;
  /**
   * The learning arms this pitch was written under, learner → arm key
   * ({"writer.evidence": "benchmark", "writer.guidance": "g-…"}). Each arm's
   * reward is this pitch's outcome (lib/autopilot/learn.ts). Absent before
   * the learners existed.
   */
  arms?: Record<string, string>;
  /**
   * Our own past pitches shown to the writer and critic as exemplars
   * (lib/pitches/exemplars.ts), with the outcome score that qualified each.
   * Empty when none were shown; absent before exemplar memory existed.
   */
  exemplars_used?: Array<{ pitch_id: string; score: number }>;
  /** EXEMPLAR_PROMPT_VERSION when exemplars were shown, else null. */
  exemplar_prompt_version?: string | null;
  /**
   * Set when the autopilot rewrote a draft it had held for review: the held
   * draft's id. A rewrite gets no second one (lib/autopilot/governor.ts).
   */
  retry_of?: string;
  /**
   * With retry_of: "revised" when the writer revised the held draft against
   * its notes, "fresh" when it wrote from scratch (template held draft, no
   * notes, person-edited, unreadable, or the rewrite fell back to a template).
   */
  retry_mode?: "revised" | "fresh";
  /**
   * Set when the autopilot wrote a fresh draft for a prospect whose only draft
   * was thrown away for its writing (lib/autopilot/tick.ts redraftPool): that
   * auto_rejected pitch's id. Carried onto the re-draft's own rewrite, so a
   * prospect is re-drafted once (governor.redraftOf).
   */
  redraft_of?: string;
  /**
   * The statistic the writer wished it had (its wanted_fact, as written, before
   * the recording's discard checks). Claude path only; absent before
   * pitch-v3.2 and on a template. RAW model output: it may carry a guessed
   * number or the company's name, so never hand it to a model, an exemplar or a
   * report without lib/benchmarks/wanted-facts.ts cleanWantedFact.
   */
  wanted_fact?: string | null;
};

export type SizeBand = "smb" | "mid_market" | "enterprise" | "unknown";

/** Same thresholds as the composer's register choice (claude-composer deriveSize). */
export function sizeBand(employeeEstimate: number | null | undefined): SizeBand {
  if (!employeeEstimate) return "unknown";
  if (employeeEstimate >= 500) return "enterprise";
  if (employeeEstimate >= 50) return "mid_market";
  return "smb";
}

/** The Spanish register the composer used: tú for small businesses, usted above. */
export function registerFor(lang: "en" | "es", band: SizeBand): "tu" | "usted" | null {
  if (lang !== "es") return null;
  return band === "mid_market" || band === "enterprise" ? "usted" : "tu";
}

const CODE_ALPHABET = "abcdefghjkmnpqrstuvwxyz23456789"; // no 0/o/1/l/i

/**
 * Short, URL-safe code for the audit-tool link (&r=). 8 characters from a
 * 31-letter alphabet is ~8.5e11 combinations: unguessable enough for an
 * attribution tag, short enough not to look like tracking.
 */
export function newAttributionCode(random: () => number = Math.random): string {
  let out = "";
  const bytes = new Uint8Array(8);
  if (random === Math.random && typeof globalThis.crypto?.getRandomValues === "function") {
    globalThis.crypto.getRandomValues(bytes);
    for (const b of bytes) out += CODE_ALPHABET[b % CODE_ALPHABET.length];
    return out;
  }
  for (let i = 0; i < 8; i++) out += CODE_ALPHABET[Math.floor(random() * CODE_ALPHABET.length)];
  return out;
}

/**
 * Which offered benchmark did the email quote? A benchmark counts as cited
 * when every number in its figure appears standalone in the body ("7 times" →
 * a standalone 7), or, for a figure with no digits ("twice"), when the word
 * itself does. First match wins; null when none was used.
 */
export function detectCitedBenchmark(
  body: string,
  benchmarks: ReadonlyArray<{ id: string; figure: string }>,
): { id: string; figure: string } | null {
  const text = fold(normalizeNumbers(body));
  for (const b of benchmarks) {
    const nums = fold(normalizeNumbers(b.figure)).match(/\d+(?:[.,]\d+)?/g);
    if (nums && nums.length > 0) {
      const all = nums.every((n) =>
        new RegExp(`(^|[^\\d.,])${n.replace(/[.,]/g, "\\$&")}(?![\\d]|[.,]\\d)`).test(text),
      );
      if (all) return { id: b.id, figure: b.figure };
    } else {
      const word = fold(b.figure).trim();
      if (word && new RegExp(`(^|[^a-z])${word}([^a-z]|$)`).test(text)) return { id: b.id, figure: b.figure };
    }
  }
  return null;
}

/**
 * How much of the text a person changed before it went out, 0 (untouched) to
 * 1 (rewritten): word-level edit distance over the longer text. Word-level is
 * plenty for "did they rewrite it" and stays cheap on a 150-word email.
 */
export function editRatio(original: string, sent: string): number {
  const a = original.trim().split(/\s+/).filter(Boolean);
  const b = sent.trim().split(/\s+/).filter(Boolean);
  if (a.length === 0 && b.length === 0) return 0;
  const prev = new Array<number>(b.length + 1);
  const cur = new Array<number>(b.length + 1);
  for (let j = 0; j <= b.length; j++) prev[j] = j;
  for (let i = 1; i <= a.length; i++) {
    cur[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      cur[j] = Math.min(prev[j]! + 1, cur[j - 1]! + 1, prev[j - 1]! + cost);
    }
    for (let j = 0; j <= b.length; j++) prev[j] = cur[j]!;
  }
  return Math.round((prev[b.length]! / Math.max(a.length, b.length)) * 1000) / 1000;
}

/** Recipient summary for the record: never the full address, only its shape. */
export function recipientSummary(contact: {
  email: string | null;
  full_name: string | null;
  selected_by?: string | null;
  email_is_role_based?: boolean;
} | null): DecisionRecord["recipient"] {
  const email = contact?.email ?? null;
  return {
    email_domain: email && email.includes("@") ? email.split("@")[1]!.toLowerCase() : null,
    selected_by: contact?.selected_by ?? null,
    role_based: Boolean(contact?.email_is_role_based),
    named: Boolean(contact?.full_name?.trim()),
  };
}
