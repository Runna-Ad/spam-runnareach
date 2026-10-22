/**
 * The pre-send guardrail for AI-written guidance (Pedro, 2026-10-22, decision 12).
 *
 * Guidance arms (`writer.guidance`) go live as challengers with no person in
 * the loop. Outcomes (replies, scans) take two weeks and arrive rarely, so a
 * bad instruction would run for months before the reward bandit noticed. Its
 * drafts tell much sooner: a draft the autopilot throws away for its WRITING
 * (the AI reviewer or a writing gate code held it, then held it again after one
 * rewrite) is a cost the instruction caused.
 *
 *   heldForWriting   was this auto_rejected reason caused by the writing only?
 *   presendStats     per guidance arm: Claude drafts and writing-held drafts.
 *   probabilityWorse P(challenger's held rate > champion's), exact for
 *                    Beta(1 + held, 1 + kept) posteriors.
 *   presendGuardrail which challengers to retire: ≥ 12 drafts each side and
 *                    P(worse) ≥ 0.9. The champion is never retired here.
 *
 * Only reasons the writer caused count. A reason about the address (verifier,
 * source), the company or domain, a template, a probation segment, a person's
 * hold, a failed rewrite or anything this file does not recognise makes the
 * draft not count at all: the guardrail must never punish an instruction for
 * a cause it did not choose.
 *
 * Pure — tested in tests/presend-learning.test.ts.
 */

/** Drafts created in this many days are counted. */
export const PRESEND_WINDOW_DAYS = 14;
/** Each side needs this many drafts before any decision. */
export const PRESEND_MIN_DRAFTS = 12;
/** Retire when the challenger is at least this likely to be held more often. */
export const PRESEND_RETIRE_AT = 0.9;
/** The insight / action reason, shared with the evidence the learner logs. */
export const PRESEND_REASON = "presend_held_rate";

// Prefixes heldAction (lib/autopilot/governor.ts) puts in front of the reasons it joins with "; ".
const AFTER_REWRITE = "still held after one rewrite: ";
const CANT_FIX = "a rewrite can't fix: ";

// The governor's laneFor reasons that are about the writing (exact shapes).
const WRITER_REASON = /^(AI review flagged issues|AI review score \d+(\.\d+)? < \d+(\.\d+)?)$/;
const GATE_REASON = /^gate: (\S+)$/;

/**
 * True only when every reason that closed the draft is about the writing: the
 * AI reviewer, or a gate code in `writerFixable` (lib/pitches/review.ts
 * WRITER_FIXABLE, passed in so this file stays pure). "A rewrite can't fix"
 * lists only reasons a rewrite cannot change, so it never counts.
 */
export function heldForWriting(reason: string | null | undefined, writerFixable: ReadonlySet<string>): boolean {
  if (!reason) return false;
  const text = reason.trim();
  if (text.startsWith(CANT_FIX)) return false;
  const parts = (text.startsWith(AFTER_REWRITE) ? text.slice(AFTER_REWRITE.length) : text)
    .split("; ")
    .map((p) => p.trim())
    .filter(Boolean);
  if (parts.length === 0) return false;
  return parts.every((p) => {
    if (WRITER_REASON.test(p)) return true;
    const code = p.match(GATE_REASON)?.[1];
    return code !== undefined && writerFixable.has(code);
  });
}

export type PresendDraft = {
  /** decision.arms: present only on Claude-path drafts. */
  arms: Record<string, string> | null | undefined;
  status: string;
  auto_rejected_reason: string | null;
};

export type HeldCount = { drafts: number; held: number };

/**
 * Per `writer.guidance` arm: every Claude draft that recorded the arm, and
 * those the autopilot closed for their writing. Templates record no arms and
 * are not counted; the evidence arm a draft drew does not matter (a
 * no_benchmark draft followed its guidance arm like any other).
 */
export function presendStats(drafts: readonly PresendDraft[], writerFixable: ReadonlySet<string>): Map<string, HeldCount> {
  const out = new Map<string, HeldCount>();
  for (const d of drafts) {
    const key = d.arms?.["writer.guidance"];
    if (typeof key !== "string" || !key) continue;
    const c = out.get(key) ?? { drafts: 0, held: 0 };
    c.drafts += 1;
    if (d.status === "auto_rejected" && heldForWriting(d.auto_rejected_reason, writerFixable)) c.held += 1;
    out.set(key, c);
  }
  return out;
}

/** ln Γ(x) for x > 0 (Lanczos, g = 7). */
function lnGamma(x: number): number {
  const c = [
    0.99999999999980993, 676.5203681218851, -1259.1392167224028, 771.32342877765313, -176.61502916214059,
    12.507343278686905, -0.13857109526572012, 9.9843695780195716e-6, 1.5056327351493116e-7,
  ];
  if (x < 0.5) return Math.log(Math.PI / Math.sin(Math.PI * x)) - lnGamma(1 - x);
  const z = x - 1;
  let a = c[0]!;
  const t = z + 7.5;
  for (let i = 1; i < 9; i++) a += c[i]! / (z + i);
  return 0.5 * Math.log(2 * Math.PI) + (z + 0.5) * Math.log(t) - t + Math.log(a);
}

const lnBeta = (a: number, b: number) => lnGamma(a) + lnGamma(b) - lnGamma(a + b);

/**
 * P(X > Y) for X ~ Beta(1 + a.held, 1 + a.drafts - a.held) and Y the same for
 * `b`: how likely `a`'s true held rate is above `b`'s. Exact for the integer
 * parameters a count gives (the sum over Y's first shape parameter), so the
 * same counts always give the same decision.
 */
export function probabilityWorse(a: HeldCount, b: HeldCount): number {
  const aA = 1 + a.held;
  const bA = 1 + (a.drafts - a.held);
  const aB = 1 + b.held;
  const bB = 1 + (b.drafts - b.held);
  // P(Y > X) = Σ_{i=0}^{aB-1} B(aA+i, bA+bB) / ((bB+i) B(1+i, bB) B(aA, bA))
  let pYAbove = 0;
  for (let i = 0; i < aB; i++) {
    pYAbove += Math.exp(lnBeta(aA + i, bA + bB) - Math.log(bB + i) - lnBeta(1 + i, bB) - lnBeta(aA, bA));
  }
  return Math.min(1, Math.max(0, 1 - pYAbove));
}

export type PresendRetire = {
  kind: "retire";
  key: string;
  reason: typeof PRESEND_REASON;
  pWorse: number;
  challenger: HeldCount & { rate: number };
  champion: HeldCount & { key: string; rate: number };
};

export type PresendOptions = { minDrafts?: number; retireAt?: number };

/**
 * Challengers of `writer.guidance` to retire for a higher held rate than the
 * champion. Never the champion, never a retired arm, nothing without a
 * champion that has enough drafts of its own to compare against.
 */
export function presendGuardrail(
  arms: ReadonlyArray<{ key: string; status: string }>,
  stats: ReadonlyMap<string, HeldCount>,
  opts: PresendOptions = {},
): PresendRetire[] {
  const minDrafts = opts.minDrafts ?? PRESEND_MIN_DRAFTS;
  const retireAt = opts.retireAt ?? PRESEND_RETIRE_AT;
  const champion = arms.find((a) => a.status === "champion");
  if (!champion) return [];
  const base = stats.get(champion.key);
  if (!base || base.drafts < minDrafts) return [];
  const rate = (c: HeldCount) => c.held / c.drafts;
  const out: PresendRetire[] = [];
  for (const arm of arms) {
    if (arm.status !== "challenger") continue;
    const mine = stats.get(arm.key);
    if (!mine || mine.drafts < minDrafts) continue;
    const pWorse = probabilityWorse(mine, base);
    if (pWorse < retireAt) continue;
    out.push({
      kind: "retire",
      key: arm.key,
      reason: PRESEND_REASON,
      pWorse,
      challenger: { ...mine, rate: rate(mine) },
      champion: { key: champion.key, ...base, rate: rate(base) },
    });
  }
  return out;
}
