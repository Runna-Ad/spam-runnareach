// ─────────────────────────────────────────────────────────────────────────────
// lib/warmup/intelligence.ts
// Auto-adjustment logic: pause on spam spikes, rotate buddies, surface alerts.
// ─────────────────────────────────────────────────────────────────────────────

import type { WarmupConfig, WarmupLogEntry, DomainHealth } from "./types";
import { resolveDailyTarget, resolvePhaseLabel } from "./types";

// ── Thresholds ─────────────────────────────────────────────────────────────────

/** If ≥ this % of recent sends landed in spam → pause warmup */
export const SPAM_PAUSE_THRESHOLD = 0.20; // 20%

/** If domain spam_rate from Postmaster exceeds this → pause */
export const POSTMASTER_SPAM_RATE_THRESHOLD = 0.08; // 8%

/** Minimum inbox-checked samples before acting on spam rate */
export const MIN_SAMPLE_FOR_DECISION = 5;

// ── Spam rate analysis ─────────────────────────────────────────────────────────

export type SpamAnalysis = {
  total: number;
  inInbox: number;
  inSpam: number;
  unchecked: number;
  inboxRate: number | null;
  spamRate: number | null;
  shouldPause: boolean;
  reason: string | null;
};

export function analyzeSpamRate(recentLogs: WarmupLogEntry[]): SpamAnalysis {
  const sent = recentLogs.filter((l) => l.direction === "sent");
  const checked = sent.filter((l) => l.landed_in_inbox !== null);
  const inInbox = checked.filter((l) => l.landed_in_inbox === true).length;
  const inSpam = checked.filter((l) => l.landed_in_inbox === false).length;
  const unchecked = sent.length - checked.length;

  if (checked.length < MIN_SAMPLE_FOR_DECISION) {
    return {
      total: sent.length,
      inInbox,
      inSpam,
      unchecked,
      inboxRate: null,
      spamRate: null,
      shouldPause: false,
      reason: null,
    };
  }

  const spamRate = inSpam / checked.length;
  const inboxRate = inInbox / checked.length;

  const shouldPause = spamRate >= SPAM_PAUSE_THRESHOLD;
  const reason = shouldPause
    ? `Spam rate ${(spamRate * 100).toFixed(0)}% exceeds threshold (${(SPAM_PAUSE_THRESHOLD * 100).toFixed(0)}%). Warmup paused.`
    : null;

  return { total: sent.length, inInbox, inSpam, unchecked, inboxRate, spamRate, shouldPause, reason };
}

// ── Postmaster-based pause ─────────────────────────────────────────────────────

export function shouldPauseFromPostmaster(health: DomainHealth | null): {
  pause: boolean;
  reason: string | null;
} {
  if (!health) return { pause: false, reason: null };

  if (
    health.spam_rate !== null &&
    health.spam_rate >= POSTMASTER_SPAM_RATE_THRESHOLD
  ) {
    return {
      pause: true,
      reason: `Postmaster spam rate ${(health.spam_rate * 100).toFixed(2)}% exceeds ${(POSTMASTER_SPAM_RATE_THRESHOLD * 100).toFixed(0)}% threshold.`,
    };
  }

  if (health.domain_reputation === "BAD") {
    return {
      pause: true,
      reason: "Postmaster domain reputation is BAD. Pausing warmup until reputation recovers.",
    };
  }

  return { pause: false, reason: null };
}

// ── Daily target computation ───────────────────────────────────────────────────

export type DayPlan = {
  targetForToday: number;
  remainingToday: number;
  shouldSend: boolean;
  phase: string;
};

export function computeDayPlan(config: WarmupConfig): DayPlan {
  // Check if we need to reset the daily count (new calendar day)
  const today = new Date().toISOString().split("T")[0];
  const isNewDay = config.last_reset_date !== today;

  const emailsSentToday = isNewDay ? 0 : config.emails_sent_today;
  // Re-warm-aware: while re-warming this returns the re-warm curve target, not
  // the day-79 maintenance floor.
  const targetForToday = resolveDailyTarget(config);
  const remainingToday = Math.max(0, targetForToday - emailsSentToday);

  return {
    targetForToday,
    remainingToday,
    shouldSend: remainingToday > 0,
    phase: resolvePhaseLabel(config),
  };
}

// ── Day advancement ────────────────────────────────────────────────────────────

/**
 * Given the config, determine if current_day should increment.
 * Increments once per calendar day regardless of send count.
 */
export function shouldIncrementDay(config: WarmupConfig): boolean {
  const today = new Date().toISOString().split("T")[0];
  return config.last_reset_date !== today;
}

// ── Buddy rotation ────────────────────────────────────────────────────────────

/**
 * Round-robin buddy selection — advances the index each call.
 * Returns the index into the buddies array to use next.
 */
export function pickNextBuddyIndex(
  currentIndex: number,
  buddyCount: number,
): number {
  if (buddyCount === 0) return 0;
  return (currentIndex + 1) % buddyCount;
}

// ── Alert formatting ──────────────────────────────────────────────────────────

export type WarmupAlert = {
  level: "info" | "warning" | "critical";
  message: string;
  timestamp: string;
};

export function buildAlerts(
  config: WarmupConfig,
  spamAnalysis: SpamAnalysis,
  health: DomainHealth | null,
): WarmupAlert[] {
  const alerts: WarmupAlert[] = [];
  const now = new Date().toISOString();

  if (config.status === "paused") {
    alerts.push({
      level: "critical",
      message: `Warmup paused: ${config.pause_reason ?? "manual pause"}`,
      timestamp: now,
    });
  }

  if (spamAnalysis.shouldPause) {
    alerts.push({
      level: "critical",
      message: spamAnalysis.reason ?? "High spam rate detected",
      timestamp: now,
    });
  }

  if (
    spamAnalysis.spamRate !== null &&
    spamAnalysis.spamRate >= SPAM_PAUSE_THRESHOLD * 0.7 &&
    !spamAnalysis.shouldPause
  ) {
    alerts.push({
      level: "warning",
      message: `Spam rate ${((spamAnalysis.spamRate ?? 0) * 100).toFixed(0)}% approaching threshold — monitor closely.`,
      timestamp: now,
    });
  }

  if (health?.domain_reputation === "LOW") {
    alerts.push({
      level: "warning",
      message: "Postmaster domain reputation is LOW. Check authentication records.",
      timestamp: now,
    });
  }

  if (health?.domain_reputation === "BAD") {
    alerts.push({
      level: "critical",
      message: "Postmaster domain reputation is BAD. Warmup should be paused immediately.",
      timestamp: now,
    });
  }

  if (
    health?.spf_success_ratio !== null &&
    (health?.spf_success_ratio ?? 1) < 0.95
  ) {
    alerts.push({
      level: "warning",
      message: `SPF success rate is low (${(((health?.spf_success_ratio ?? 0)) * 100).toFixed(0)}%). Check SPF record.`,
      timestamp: now,
    });
  }

  return alerts;
}
