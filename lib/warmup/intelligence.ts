// ─────────────────────────────────────────────────────────────────────────────
// lib/warmup/intelligence.ts
// Auto-adjustment logic: pause on spam spikes, rotate buddies, surface alerts.
// ─────────────────────────────────────────────────────────────────────────────

import type { WarmupConfig, WarmupLogEntry, DomainHealth } from "./types.ts";
import { resolveDailyTarget, resolvePhaseLabel } from "./types.ts";

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

// ── Inbox placement ────────────────────────────────────────────────────────────

/**
 * Whether a stored warmup message id is an RFC 5322 Message-ID (what a buddy's
 * IMAP search can find) rather than Gmail's internal hex id. Every send before
 * 2026-10-17 stored the internal id, so no placement check ever matched and
 * the spam-rate pause below never had data.
 */
export function isRfcMessageId(id: string | null | undefined): id is string {
  return typeof id === "string" && /^[^\s@<>]+@[^\s@<>]+$/.test(id);
}

/**
 * The placement to record from a buddy-side check. Found in the inbox (or a
 * category tab, or archived) = inbox. Found in spam = spam, even though the
 * check then rescues it to the inbox: the rescue is a warmup signal, the
 * placement is what the spam rate has to count.
 */
export function placementFromCheck(check: { foundInInbox: boolean; foundInSpam: boolean }): boolean | null {
  if (check.foundInInbox) return true;
  if (check.foundInSpam) return false;
  return null;
}

// ── Placement checks: time budget ─────────────────────────────────────────────

/**
 * Step 2 of the daily engine run starts no new check after this much of the
 * run has passed (the most it gets on a light day).
 */
export const PLACEMENT_CHECK_BUDGET_MS = 40_000;
/**
 * One check is cut off (connection closed, logout included) after this long.
 * Must stay above the IMAP connect + greeting timeouts: a close() during the
 * TLS handshake does not end a pending connect.
 */
export const PLACEMENT_CHECK_MAX_MS = 20_000;
/** What one warm-up send costs: 0-500ms jitter + send + Message-ID lookup + 3 writes. */
export const PER_SEND_RESERVE_MS = 1_500;
/** Even at the heaviest send day, checks may run this long (a re-warm needs data). */
export const PLACEMENT_CHECK_MIN_WINDOW_MS = 30_000;

/**
 * When step 2 must stop starting checks so the day's sends still fit before
 * the send deadline. All checks are over by stopAt + PLACEMENT_CHECK_MAX_MS.
 *   5 sends:  105 - 7.5 = 97.5s, capped at 40 + 20 → stop at 40s (checks over by 60s)
 *   40 sends: 105 - 60  = 45s                        → stop at 25s (over by 45s)
 *   50 sends: 105 - 75  = 30s = the 30s floor        → stop at 10s (over by 30s, 75s for 50 sends)
 */
export function placementCheckStopAt(tickStart: number, sendDeadline: number, remainingSends: number): number {
  const checksEnd = Math.max(
    tickStart + PLACEMENT_CHECK_MIN_WINDOW_MS,
    Math.min(
      tickStart + PLACEMENT_CHECK_BUDGET_MS + PLACEMENT_CHECK_MAX_MS,
      sendDeadline - Math.max(0, remainingSends) * PER_SEND_RESERVE_MS,
    ),
  );
  return checksEnd - PLACEMENT_CHECK_MAX_MS;
}

export type PlacementCheckDeps<B> = {
  buddies: B[];
  buddyId: (b: B) => string;
  now: () => number;
  /** The RFC Message-ID to search for, resolving a legacy Gmail id; null = can't. */
  resolveRfcId: (log: WarmupLogEntry) => Promise<string | null>;
  check: (buddy: B, rfcMessageId: string, timeoutMs: number) => Promise<{ foundInInbox: boolean; foundInSpam: boolean } | null>;
  record: (logId: string, landedInInbox: boolean) => Promise<void>;
};

export type PlacementCheckReport = {
  /** Rows given a placement (true or false). */
  checked: number;
  /** Checked but found in no folder, or the connection failed: still pending. */
  not_found: number;
  /** No buddy, inactive buddy or no searchable id: no check started. */
  skipped: number;
  /** Not reached because the budget ran out: tomorrow's run tries them first. */
  deferred: number;
};

/**
 * Check pending sends, oldest first (a row is retried before it leaves the 72h
 * window), until `stopAt`: no check starts after it, and each started check is
 * capped at PLACEMENT_CHECK_MAX_MS. A row that cannot be checked costs nothing.
 * Only a found placement is written; not found stays null.
 */
export async function runPlacementChecks<B>(
  pending: WarmupLogEntry[],
  stopAt: number,
  deps: PlacementCheckDeps<B>,
): Promise<PlacementCheckReport> {
  const report: PlacementCheckReport = { checked: 0, not_found: 0, skipped: 0, deferred: 0 };
  const rows = [...pending].sort((a, b) => a.created_at.localeCompare(b.created_at));

  const buddyFor = (log: WarmupLogEntry) =>
    log.message_id && log.buddy_id ? deps.buddies.find((b) => deps.buddyId(b) === log.buddy_id) : undefined;

  for (const [i, log] of rows.entries()) {
    const buddy = buddyFor(log);
    if (!buddy) {
      report.skipped++;
      continue;
    }
    if (deps.now() >= stopAt) {
      const rest = rows.slice(i);
      report.deferred = rest.filter((r) => buddyFor(r)).length;
      report.skipped += rest.length - report.deferred;
      break;
    }

    const rfcMessageId = await deps.resolveRfcId(log);
    if (!rfcMessageId) {
      report.skipped++;
      continue;
    }

    const check = await deps.check(buddy, rfcMessageId, PLACEMENT_CHECK_MAX_MS);
    const landed = check ? placementFromCheck(check) : null;
    if (landed === null) {
      report.not_found++;
      continue;
    }
    await deps.record(log.id, landed);
    report.checked++;
  }

  return report;
}

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
