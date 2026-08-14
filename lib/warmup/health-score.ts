// ─────────────────────────────────────────────────────────────────────────────
// lib/warmup/health-score.ts
// Derived domain-health grade — the SINGLE source of truth for "how healthy is
// this sending domain right now", from signals available at ANY volume (unlike
// Google Postmaster, which needs high volume). Used by BOTH the warmup dashboard
// (to show the grade) and the auto-reactivation loop (to decide when to re-warm).
//
// Keeping this in one pure module means the number the human sees and the number
// the automation acts on can never drift apart.
// ─────────────────────────────────────────────────────────────────────────────

import type { DeliverabilityHealth } from "./deliverability.ts";
import type { DmarcSummary } from "./dmarc-summary.ts";

export type HealthGrade = "STRONG" | "GOOD" | "FAIR" | "AT RISK";

export type DerivedHealth = {
  grade: HealthGrade;
  score: number; // 0..1
  color: string;
  basis: string;
};

const STATUS_WEIGHT: Record<string, number> = { pass: 1, warn: 0.5, fail: 0, unknown: 0.5 };

/**
 * Raw 0..1 health score, or null when we have no basis to judge (no DNS + no
 * DMARC data). Pure. The blocklist term is pass/fail/unknown: a REAL listing
 * scores 0 (tanks the domain); an inconclusive "unknown" check does NOT penalize
 * (scores as not-listed) — a DNS provider refusing the query is not evidence of
 * a listing, and must never be treated as one.
 */
export function scoreDomainHealth(
  dmarc: DmarcSummary | null,
  deliverability: DeliverabilityHealth | null,
): number | null {
  const parts: number[] = [];

  if (deliverability) {
    parts.push(STATUS_WEIGHT[deliverability.spf.status] ?? 0.5);
    parts.push(STATUS_WEIGHT[deliverability.dkim.status] ?? 0.5);
    parts.push(STATUS_WEIGHT[deliverability.dmarc.status] ?? 0.5);
    // Only a genuine listing (status "fail") scores 0. "unknown" (query refused)
    // is treated as not-listed → 1.
    parts.push(deliverability.blocklist.status === "fail" ? 0 : 1);
  }
  if (dmarc && dmarc.total_messages > 0 && dmarc.pass_rate !== null) {
    // DMARC alignment pass rate, double-weighted (strongest real signal).
    parts.push(dmarc.pass_rate, dmarc.pass_rate);
    // Any unauthorized source is a hard penalty.
    if (dmarc.failed_alignment.length > 0) parts.push(0);
  }

  if (parts.length === 0) return null;
  return parts.reduce((a, b) => a + b, 0) / parts.length;
}

export function gradeFromScore(score: number): HealthGrade {
  return score >= 0.9 ? "STRONG" : score >= 0.75 ? "GOOD" : score >= 0.55 ? "FAIR" : "AT RISK";
}

function colorFor(grade: HealthGrade): string {
  return grade === "STRONG"
    ? "#22c55e"
    : grade === "GOOD"
      ? "#84cc16"
      : grade === "FAIR"
        ? "#eab308"
        : "#ef4444";
}

/** Full graded health for display. Returns null when there's no basis. */
export function deriveDomainHealth(
  dmarc: DmarcSummary | null,
  deliverability: DeliverabilityHealth | null,
): DerivedHealth | null {
  const score = scoreDomainHealth(dmarc, deliverability);
  if (score === null) return null;
  const grade = gradeFromScore(score);

  const basisBits: string[] = [];
  if (dmarc && dmarc.total_messages > 0) basisBits.push("DMARC");
  if (deliverability) basisBits.push("DNS auth");
  const basis = basisBits.length > 0 ? `from ${basisBits.join(" + ")}` : "";

  return { grade, score, color: colorFor(grade), basis };
}
