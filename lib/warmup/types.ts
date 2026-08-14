// ─────────────────────────────────────────────────────────────────────────────
// lib/warmup/types.ts
// Shared types for the email warmup system.
// ─────────────────────────────────────────────────────────────────────────────

export type WarmupStatus = "active" | "paused" | "maintenance" | "completed";

export type WarmupConfig = {
  id: string;
  tenant_id: string;
  sending_email: string;
  status: WarmupStatus;
  start_date: string;
  current_day: number;
  daily_target: number;
  emails_sent_today: number;
  last_reset_date: string;
  last_buddy_index: number;
  pause_reason: string | null;
  created_at: string;
  updated_at: string;

  // ── Re-warm overlay (migration 0032) ────────────────────────────────────────
  // When deliverability dips (or Pedro clicks "Re-warm now"), the domain leaves
  // the day-79 maintenance floor and climbs a short, gentle ramp again. These
  // fields drive that; all null/0 when NOT re-warming (normal schedule applies).
  /** ISO timestamp the current re-warm started; null = not re-warming. */
  rewarm_started_at: string | null;
  /** 1-indexed day within the current re-warm; 0 when idle. */
  rewarm_day: number;
  /** Human-readable reason the re-warm was triggered (dip signal or "manual"). */
  rewarm_reason: string | null;
  /** Consecutive daily health evaluations that came back healthy (recovery counter). */
  healthy_streak: number;
  /** YYYY-MM-DD of the last reactivation evaluation — guards one eval per day. */
  last_health_eval_date: string | null;
};

export type WarmupBuddy = {
  id: string;
  email: string;
  display_name: string;
  /** Vercel env var NAME that holds the app password — not the password itself */
  app_password_secret: string;
  /** Vercel env var NAME that holds the email address */
  email_env_var: string;
  imap_host: string;
  imap_port: number;
  is_active: boolean;
  last_used_at: string | null;
};

export type WarmupLogEntry = {
  id: string;
  tenant_id: string;
  config_id: string;
  buddy_id: string | null;
  direction: "sent" | "received";
  subject: string;
  message_id: string | null;
  thread_id: string | null;
  landed_in_inbox: boolean | null;
  reply_sent: boolean;
  day_number: number;
  created_at: string;
};

export type WarmupTemplate = {
  id: string;
  category: "general" | "b2b" | "question" | "update" | "casual" | "followup";
  subject: string;
  body_text: string;
  reply_text: string;
  language: string;
};

export type DomainHealth = {
  id: string;
  tenant_id: string;
  domain: string;
  recorded_date: string;
  domain_reputation: "HIGH" | "MEDIUM" | "LOW" | "BAD" | "REPUTATION_CATEGORY_UNSPECIFIED" | null;
  ip_reputation: "HIGH" | "MEDIUM" | "LOW" | "BAD" | "REPUTATION_CATEGORY_UNSPECIFIED" | null;
  spam_rate: number | null;
  spf_success_ratio: number | null;
  dkim_success_ratio: number | null;
  dmarc_success_ratio: number | null;
  inbound_encryption_ratio: number | null;
  raw_response?: Record<string, unknown> | null;
  created_at: string;
};

// ── Engine result types ────────────────────────────────────────────────────────

export type EngineTickResult = {
  config_id: string;
  sending_email: string;
  day: number;
  sent: number;
  checked: number;
  inbox_rate: number | null;
  skipped_reason?: string;
};

export type IMAPCheckResult = {
  message_id: string;
  thread_id: string;
  found_in_inbox: boolean;
  replied: boolean;
};

// ── Ramp schedule ──────────────────────────────────────────────────────────────

export type RampWeek = {
  weekStart: number; // day start (inclusive)
  weekEnd: number;   // day end (inclusive)
  dailyTarget: number;
};

// Ramp updated for 5 buddy accounts (~10 sends/buddy/day = 50/day safe cap)
export const RAMP_SCHEDULE: readonly RampWeek[] = [
  { weekStart: 1,  weekEnd: 7,  dailyTarget: 10 },  // Week 1 — 2/buddy/day with 5 buddies
  { weekStart: 8,  weekEnd: 14, dailyTarget: 20 },  // Week 2 — ~4/buddy/day
  { weekStart: 15, weekEnd: 21, dailyTarget: 30 },  // Week 3 — ~6/buddy/day
  { weekStart: 22, weekEnd: 28, dailyTarget: 50 },  // Week 4 — ~10/buddy/day (cap)
  // Day 29+ → maintenance
] as const;

export const MAINTENANCE_DAILY_TARGET = 5;

export function getDailyTarget(currentDay: number): number {
  for (const week of RAMP_SCHEDULE) {
    if (currentDay >= week.weekStart && currentDay <= week.weekEnd) {
      return week.dailyTarget;
    }
  }
  return MAINTENANCE_DAILY_TARGET;
}

export function getRampPhase(currentDay: number): string {
  if (currentDay <= 7)  return "Week 1 — Warming (10/day)";
  if (currentDay <= 14) return "Week 2 — Building (20/day)";
  if (currentDay <= 21) return "Week 3 — Ramping (30/day)";
  if (currentDay <= 28) return "Week 4 — Full Ramp (50/day)";
  return "Maintenance (5/day)";
}

// ── Re-warm ramp ─────────────────────────────────────────────────────────────
// A gentle re-ramp back up from the maintenance floor after a deliverability
// dip. Deliberately NOT a jump straight to 50 — a 5→50 spike is itself a
// spam-pattern tell. Climb over ~2 weeks, then hold at the cap until health
// recovers (the auto-reactivation loop exits back to maintenance on recovery).

export type RewarmStep = { dayStart: number; dayEnd: number; dailyTarget: number };

export const REWARM_SCHEDULE: readonly RewarmStep[] = [
  { dayStart: 1,  dayEnd: 3,  dailyTarget: 20 }, // ease back on with a moderate volume
  { dayStart: 4,  dayEnd: 7,  dailyTarget: 30 },
  { dayStart: 8,  dayEnd: 14, dailyTarget: 40 },
  // Day 15+ → hold at the 50/day cap until recovery.
] as const;

export const REWARM_CAP_TARGET = 50;

/** Daily target for a given re-warm day (1-indexed). Plateaus at the cap. */
export function rewarmTargetForDay(rewarmDay: number): number {
  for (const step of REWARM_SCHEDULE) {
    if (rewarmDay >= step.dayStart && rewarmDay <= step.dayEnd) return step.dailyTarget;
  }
  return REWARM_CAP_TARGET;
}

/** True when the config is in an active re-warm. */
export function isRewarming(config: Pick<WarmupConfig, "rewarm_started_at">): boolean {
  return config.rewarm_started_at != null;
}

/**
 * The authoritative daily send target. While re-warming, the re-warm curve
 * OVERRIDES the day-based schedule (which at day 29+ would otherwise force the
 * maintenance floor of 5/day). This is the single function the engine and the
 * day-plan must both use so a day-rollover can't clobber the re-warm target.
 */
export function resolveDailyTarget(
  config: Pick<WarmupConfig, "current_day" | "rewarm_started_at" | "rewarm_day">,
): number {
  if (config.rewarm_started_at != null) {
    return rewarmTargetForDay(Math.max(1, config.rewarm_day));
  }
  return getDailyTarget(config.current_day);
}

/** Phase label for display — re-warm-aware. */
export function resolvePhaseLabel(
  config: Pick<WarmupConfig, "current_day" | "rewarm_started_at" | "rewarm_day">,
): string {
  if (config.rewarm_started_at != null) {
    const day = Math.max(1, config.rewarm_day);
    return `Re-warming · day ${day} (${rewarmTargetForDay(day)}/day)`;
  }
  return getRampPhase(config.current_day);
}
