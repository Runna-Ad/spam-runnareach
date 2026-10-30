/**
 * Turning raw outcomes into what each learner reads.
 *
 *   armStats            per arm of one learner: summed reward, settled trials,
 *                       negatives, from pitches that recorded the arm in their
 *                       decision record (decision.arms[learner]).
 *   funnelForProspect   what one discovered prospect became, for the scout.
 *   sanitizeGuidance    whether an AI-proposed writing instruction may enter
 *                       live testing at all.
 *
 * Pure — tested in tests/outcomes.test.ts.
 */

import { findBannedTerms } from "../pitches/content-rules.ts";
import { scoreOutcome, type OutcomeEvent, type ScoreOptions } from "./reward.ts";
import type { ProspectFunnel } from "./scout.ts";

export type PitchOutcomeInput = {
  arms: Record<string, string> | null | undefined;
  events: readonly OutcomeEvent[];
};

export type ArmTotals = { reward: number; trials: number; negatives: number };

/**
 * The showcase test (writer.showcase) compares where the builds go. A thread
 * whose follow-up #1 was meant to be the showcase or the pain note but went out
 * as the plain template tested neither, so writer.showcase leaves it out.
 */
export function showcaseFollowupFellBack(events: readonly OutcomeEvent[]): boolean {
  return events.some(
    (e) =>
      e.type === "sent" &&
      e.payload?.step === 2 &&
      (e.payload.followup_mode === "showcase" || e.payload.followup_mode === "pain") &&
      e.payload.composed_by === "template",
  );
}

/**
 * Settled outcomes only; a pitch that must not teach the writer (bounce, never
 * sent) is skipped. `score` goes to scoreOutcome: the writer learners pass
 * `{ clicks: true }` (lib/autopilot/learn.ts), nothing else does.
 */
export function armStats(
  pitches: readonly PitchOutcomeInput[],
  learner: string,
  now: Date = new Date(),
  score: ScoreOptions = {},
): Map<string, ArmTotals> {
  const out = new Map<string, ArmTotals>();
  for (const p of pitches) {
    const key = p.arms?.[learner];
    if (!key) continue;
    const o = scoreOutcome(p.events, now, score);
    if (o.status !== "settled" || o.value === null) continue;
    const t = out.get(key) ?? { reward: 0, trials: 0, negatives: 0 };
    t.reward += o.value;
    t.trials += 1;
    if (o.negative) t.negatives += 1;
    out.set(key, t);
  }
  return out;
}

const DISQUALIFIED = new Set(["suppressed", "no_match", "disqualified"]);

/**
 * One discovered prospect's funnel. `status` is prospects.status; `pitches`
 * are its first emails (not follow-ups) with their events.
 */
export function funnelForProspect(
  status: string,
  pitches: ReadonlyArray<{ gatePass: boolean; sent: boolean; events: readonly OutcomeEvent[] }>,
  now: Date = new Date(),
): ProspectFunnel {
  if (status === "raw") return { qualified: null, pitchReady: false, outcomeValue: null };
  if (DISQUALIFIED.has(status)) return { qualified: false, pitchReady: false, outcomeValue: null };
  const pitchReady = pitches.some((p) => p.gatePass);
  let outcomeValue: number | null = null;
  let negative = false;
  for (const p of pitches) {
    if (!p.sent) continue;
    const o = scoreOutcome(p.events, now);
    if (o.status === "settled" && o.value !== null) {
      outcomeValue = Math.max(outcomeValue ?? 0, o.value);
      negative = negative || o.negative;
    }
  }
  return { qualified: true, pitchReady, outcomeValue, negative };
}

export const GUIDANCE_MAX_CHARS = 280;

/**
 * May this AI-proposed instruction be tested on live emails? It must be one
 * short, plain instruction that cannot smuggle in what the rules forbid:
 * no digits (numbers come only from verified benchmarks), no jargon from the
 * banned lists, nothing that reads like a rule override.
 * Returns the cleaned text, or null with the reason.
 */
export function sanitizeGuidance(text: string): { ok: true; text: string } | { ok: false; reason: string } {
  const t = text.replace(/\s+/g, " ").trim().replace(/^[-•*]\s*/, "");
  if (t.length < 12) return { ok: false, reason: "too short to be an instruction" };
  if (t.length > GUIDANCE_MAX_CHARS) return { ok: false, reason: `longer than ${GUIDANCE_MAX_CHARS} characters` };
  if (/\d/.test(t)) return { ok: false, reason: "contains a number (numbers come only from verified benchmarks)" };
  if (/ignore|override|disregard|instead of the rules|system prompt|previous instructions/i.test(t)) {
    return { ok: false, reason: "reads like a rule override" };
  }
  const banned = [...findBannedTerms(t, "en"), ...findBannedTerms(t, "es")];
  if (banned.length) return { ok: false, reason: `uses banned wording: ${banned.join(", ")}` };
  return { ok: true, text: t };
}
