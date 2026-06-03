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
