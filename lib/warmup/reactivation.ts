// ─────────────────────────────────────────────────────────────────────────────
// lib/warmup/reactivation.ts
// Auto-reactivation ("re-warm") decision logic — PURE, unit-tested.
//
// The warmup engine ramps a domain up over 4 weeks then holds it at a 5/day
// maintenance floor forever. But deliverability decays: inbox placement slips,
// DMARC alignment drops, a domain gets graded AT RISK. This module decides, once
// per day, whether to pull the domain OFF the maintenance floor and back into a
// gentle re-warm ramp — and, once health has recovered and held, to settle it
// back to maintenance.
//
// Design guardrails (learned the hard way on this project — see the watchdog
// lesson in tasks/lessons.md):
//   • Exactly ONE evaluation per calendar day (idempotent for manual re-runs /
//     double cron fires) — guarded by last_health_eval_date.
//   • Hysteresis: the dip thresholds sit BELOW the recovery thresholds, so a
//     domain hovering at the boundary doesn't flap in and out of re-warm.
//   • A hard MAX duration bounds the auto-loop — an automatic recovery that can
//     re-arm itself forever is an infinite-cost loop by construction.
//   • Defers entirely to a spam auto-pause: never ramp volume UP into a domain
//     that's actively landing in spam.
// ─────────────────────────────────────────────────────────────────────────────

import type { WarmupConfig, DomainHealth } from "./types.ts";
import { rewarmTargetForDay } from "./types.ts";

// ── Thresholds ─────────────────────────────────────────────────────────────────

// Inbox placement is the PRIMARY trigger — it's the real-time truth about where
// mail is landing. With active inbox-rescue buddies a healthy warmup sits near
// 95-100%; a sag to the 80s is a genuine reputation problem.
/** Inbox-placement rate below which we consider the domain dipping. */
export const DIP_INBOX_RATE = 0.9;
/** Inbox rate the domain must clear to count a day as "healthy" (> dip → hysteresis). */
export const RECOVER_INBOX_RATE = 0.95;

// The derived health score is a SECONDARY guard for genuinely broken auth
// (missing SPF/DKIM, a real blocklisting, a DMARC pass-rate collapse). Its floor
// is structurally ~0.74 whenever DMARC is p=none and any forwarding exists, so
// the dip line sits well below that (near the AT-RISK grade of 0.55) and the
// recovery line at/below the structural floor so recovery stays reachable.
/** Derived domain-health score below which we consider the domain dipping. */
export const DIP_HEALTH_SCORE = 0.6;
/** Health score the domain must clear to count a day as "healthy" (> dip → hysteresis). */
export const RECOVER_HEALTH_SCORE = 0.72;

/** Consecutive healthy days required to exit re-warm back to maintenance. */
export const HEALTHY_STREAK_TO_EXIT = 3;
/** Don't exit re-warm before this many days, even on an early healthy streak. */
export const REWARM_MIN_DAYS = 7;
/** Hard cap — after this many days without sustained recovery, drop to maintenance for manual review. */
export const REWARM_MAX_DAYS = 30;

// ── Signals → verdict ──────────────────────────────────────────────────────────

export type HealthSignals = {
  /** Derived 0..1 domain-health score (lib/warmup/health-score). null = no basis. */
  healthScore: number | null;
  /** 0..1 inbox-placement rate from IMAP checks. null = insufficient sample. */
  inboxRate: number | null;
  /** A REAL DNSBL listing (blocklist status "fail"), NOT an inconclusive check. */
  blocklistListed: boolean;
  /** Google Postmaster domain reputation, when available. */
  postmasterRep: DomainHealth["domain_reputation"] | null;
};

export type HealthVerdict = {
  dip: boolean;
  healthy: boolean;
  reasons: string[];
};

const pct = (v: number) => `${Math.round(v * 100)}%`;

/**
 * Turn raw signals into a dip / healthy verdict. `dip` and `healthy` are mutually
 * exclusive by construction (dip thresholds < recovery thresholds); the gap
 * between them is a "hold" dead-band that prevents flapping.
 */
export function evaluateHealth(s: HealthSignals): HealthVerdict {
  const reasons: string[] = [];
  let dip = false;

  if (s.blocklistListed) {
    dip = true;
    reasons.push("domain listed on a DNS blocklist");
  }
  if (s.postmasterRep === "BAD" || s.postmasterRep === "LOW") {
    dip = true;
    reasons.push(`Postmaster domain reputation ${s.postmasterRep}`);
  }
  if (s.healthScore !== null && s.healthScore < DIP_HEALTH_SCORE) {
    dip = true;
    reasons.push(`domain health ${pct(s.healthScore)} (below ${pct(DIP_HEALTH_SCORE)})`);
  }
  if (s.inboxRate !== null && s.inboxRate < DIP_INBOX_RATE) {
    dip = true;
    reasons.push(`inbox placement ${pct(s.inboxRate)} (below ${pct(DIP_INBOX_RATE)})`);
  }

  // Healthy = clears the recovery bar on every signal we have, with no red flag,
  // and we actually have at least one signal to judge on (a blind domain is not
  // "healthy", it's unknown).
  const scoreOk = s.healthScore === null || s.healthScore >= RECOVER_HEALTH_SCORE;
  const inboxOk = s.inboxRate === null || s.inboxRate >= RECOVER_INBOX_RATE;
  const noRedFlags = !s.blocklistListed && s.postmasterRep !== "BAD" && s.postmasterRep !== "LOW";
  const haveSignal = s.healthScore !== null || s.inboxRate !== null || s.postmasterRep != null;
  const healthy = scoreOk && inboxOk && noRedFlags && haveSignal;

  return { dip, healthy, reasons };
}

// ── Plan ────────────────────────────────────────────────────────────────────────

export type ReactivationPlan =
  | { kind: "skip"; reason: string }
  | { kind: "hold"; reason: string }
  | { kind: "none"; reason: string }
  | { kind: "enter"; reason: string; rewarmDay: number; target: number }
  | { kind: "advance"; reason: string; rewarmDay: number; healthyStreak: number; target: number }
  | { kind: "recover"; reason: string }
  | { kind: "abort"; reason: string };

export type PlanInput = {
  status: WarmupConfig["status"];
  rewarmStartedAt: string | null;
  rewarmDay: number;
  healthyStreak: number;
  lastHealthEvalDate: string | null;
  today: string; // YYYY-MM-DD
  verdict: HealthVerdict;
};

/**
 * Decide the day's transition. The caller applies the returned plan to the DB.
 * States that write nothing: "skip" (paused), "hold" (already ran today).
 */
export function planReactivation(inp: PlanInput): ReactivationPlan {
  // A spam auto-pause (or a manual pause) wins — don't ramp volume up into a
  // domain that's actively being spam-foldered. Reactivation resumes once the
  // pause is lifted.
  if (inp.status === "paused") {
    return { kind: "skip", reason: "warmup paused — reactivation defers to the pause" };
  }

  // Exactly one evaluation per calendar day.
  if (inp.lastHealthEvalDate === inp.today) {
    return { kind: "hold", reason: "already evaluated today" };
  }

  const inRewarm = inp.rewarmStartedAt != null;

  if (!inRewarm) {
    if (inp.verdict.dip) {
      return {
        kind: "enter",
        reason: inp.verdict.reasons.join("; ") || "deliverability dip",
        rewarmDay: 1,
        target: rewarmTargetForDay(1),
      };
    }
    return { kind: "none", reason: "healthy — holding at maintenance" };
  }

  // Already re-warming: advance one calendar day.
  const rewarmDay = inp.rewarmDay + 1;
  const healthyStreak = inp.verdict.healthy ? inp.healthyStreak + 1 : 0;

  if (healthyStreak >= HEALTHY_STREAK_TO_EXIT && rewarmDay >= REWARM_MIN_DAYS) {
    return {
      kind: "recover",
      reason: `healthy ${healthyStreak} days running — returning to maintenance`,
    };
  }
  if (rewarmDay >= REWARM_MAX_DAYS) {
    return {
      kind: "abort",
      reason: `re-warm ran ${REWARM_MAX_DAYS} days without sustained recovery — dropping to maintenance for manual review`,
    };
  }
  return {
    kind: "advance",
    reason: inp.verdict.dip
      ? `still dipping (${inp.verdict.reasons.join("; ")})`
      : "holding re-warm, awaiting sustained recovery",
    rewarmDay,
    healthyStreak,
    target: rewarmTargetForDay(rewarmDay),
  };
}
