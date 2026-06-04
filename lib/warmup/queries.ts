// ─────────────────────────────────────────────────────────────────────────────
// lib/warmup/queries.ts
// Database helpers for warmup system tables.
//
// NOTE: warmup tables are not in the generated Supabase TypeScript types yet
// because the 0016_warmup_system.sql migration needs to be applied first.
// We cast `supabase as any` to bypass the type checker until types are
// regenerated post-migration. This is intentional and not a bug.
// ─────────────────────────────────────────────────────────────────────────────

import { createServiceRoleClient } from "@/lib/supabase/service-role";
import type {
  WarmupConfig,
  WarmupBuddy,
  WarmupTemplate,
  WarmupLogEntry,
  DomainHealth,
} from "./types";

// Shorthand — avoids repeating eslint-disable everywhere
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnySupabase = any;

// ── Config ─────────────────────────────────────────────────────────────────────

export async function getWarmupConfig(tenantId: string): Promise<WarmupConfig | null> {
  const supabase = createServiceRoleClient() as AnySupabase;
  const { data } = await supabase
    .from("warmup_config")
    .select("*")
    .eq("tenant_id", tenantId)
    .maybeSingle();
  return (data as WarmupConfig) ?? null;
}

export async function getAllActiveConfigs(): Promise<WarmupConfig[]> {
  const supabase = createServiceRoleClient() as AnySupabase;
  const { data } = await supabase
    .from("warmup_config")
    .select("*")
    .eq("status", "active");
  return (data as WarmupConfig[]) ?? [];
}

export async function updateWarmupConfigDay(
  configId: string,
  patch: Partial<
    Pick<
      WarmupConfig,
      | "current_day"
      | "daily_target"
      | "emails_sent_today"
      | "last_reset_date"
      | "last_buddy_index"
      | "status"
      | "pause_reason"
    >
  >,
): Promise<void> {
  const supabase = createServiceRoleClient() as AnySupabase;
  await supabase
    .from("warmup_config")
    .update({ ...patch, updated_at: new Date().toISOString() })
    .eq("id", configId);
}

/**
 * Atomically increments emails_sent_today using a SQL expression.
 * Avoids the read-modify-write race condition where a concurrent run
 * (e.g. manual "Run now" + cron duplicate) can overwrite a valid count with 0.
 */
export async function incrementEmailsSentToday(
  configId: string,
  count: number,
  lastBuddyIndex: number,
): Promise<void> {
  const supabase = createServiceRoleClient() as AnySupabase;
  // Use rpc to do an atomic increment — Supabase JS client doesn't support
  // .update({ col: sql`col + N` }) directly, so we use raw SQL via rpc.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  await (supabase as any).rpc("increment_warmup_sent_today", {
    p_config_id: configId,
    p_count: count,
    p_last_buddy_index: lastBuddyIndex,
  });
}

export async function resetDailyCount(configId: string): Promise<void> {
  const supabase = createServiceRoleClient() as AnySupabase;
  await supabase
    .from("warmup_config")
    .update({
      emails_sent_today: 0,
      last_reset_date: new Date().toISOString().split("T")[0],
      updated_at: new Date().toISOString(),
    })
    .eq("id", configId);
}

// ── Buddies ────────────────────────────────────────────────────────────────────

export async function getActiveBuddies(): Promise<WarmupBuddy[]> {
  const supabase = createServiceRoleClient() as AnySupabase;
  const { data } = await supabase
    .from("warmup_buddies")
    .select("*")
    .eq("is_active", true)
    .order("last_used_at", { ascending: true, nullsFirst: true });
  return (data as WarmupBuddy[]) ?? [];
}

export async function markBuddyUsed(buddyId: string): Promise<void> {
  const supabase = createServiceRoleClient() as AnySupabase;
  await supabase
    .from("warmup_buddies")
    .update({ last_used_at: new Date().toISOString() })
    .eq("id", buddyId);
}

// ── Templates ─────────────────────────────────────────────────────────────────

export async function getRandomTemplate(): Promise<WarmupTemplate | null> {
  const supabase = createServiceRoleClient() as AnySupabase;
  const { data } = await supabase
    .from("warmup_templates")
    .select("*")
    .eq("language", "en");

  if (!data || (data as WarmupTemplate[]).length === 0) return null;
  const templates = data as WarmupTemplate[];
  return templates[Math.floor(Math.random() * templates.length)] ?? null;
}

// ── Log ────────────────────────────────────────────────────────────────────────

export async function insertWarmupLog(
  entry: Omit<WarmupLogEntry, "id" | "created_at">,
): Promise<string | null> {
  const supabase = createServiceRoleClient() as AnySupabase;
  const { data } = await supabase
    .from("warmup_log")
    .insert(entry)
    .select("id")
    .maybeSingle();
  return (data as { id: string } | null)?.id ?? null;
}

export async function updateWarmupLog(
  logId: string,
  patch: Partial<Pick<WarmupLogEntry, "landed_in_inbox" | "reply_sent" | "message_id" | "thread_id">>,
): Promise<void> {
  const supabase = createServiceRoleClient() as AnySupabase;
  await supabase.from("warmup_log").update(patch).eq("id", logId);
}

export async function getRecentLog(tenantId: string, limit = 50): Promise<WarmupLogEntry[]> {
  const supabase = createServiceRoleClient() as AnySupabase;
  const { data } = await supabase
    .from("warmup_log")
    .select("*")
    .eq("tenant_id", tenantId)
    .order("created_at", { ascending: false })
    .limit(limit);
  return (data as WarmupLogEntry[]) ?? [];
}

export async function getRecentLogByConfig(
  configId: string,
  since: string,
): Promise<WarmupLogEntry[]> {
  const supabase = createServiceRoleClient() as AnySupabase;
  const { data } = await supabase
    .from("warmup_log")
    .select("*")
    .eq("config_id", configId)
    .gte("created_at", since);
  return (data as WarmupLogEntry[]) ?? [];
}

/** Returns log entries from yesterday (direction=sent) that haven't been inbox-checked yet. */
export async function getPendingInboxChecks(configId: string): Promise<WarmupLogEntry[]> {
  const supabase = createServiceRoleClient() as AnySupabase;
  const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  const { data } = await supabase
    .from("warmup_log")
    .select("*")
    .eq("config_id", configId)
    .eq("direction", "sent")
    .is("landed_in_inbox", null)
    .gte("created_at", yesterday)
    .not("message_id", "is", null);
  return (data as WarmupLogEntry[]) ?? [];
}

// ── Domain health ──────────────────────────────────────────────────────────────

export async function upsertDomainHealth(
  row: Omit<DomainHealth, "id" | "created_at">,
): Promise<void> {
  const supabase = createServiceRoleClient() as AnySupabase;
  await supabase
    .from("domain_health")
    .upsert(row, { onConflict: "tenant_id,domain,recorded_date" });
}

export async function getDomainHealthHistory(
  tenantId: string,
  domain: string,
  days = 14,
): Promise<DomainHealth[]> {
  const supabase = createServiceRoleClient() as AnySupabase;
  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000)
    .toISOString()
    .split("T")[0];
  const { data } = await supabase
    .from("domain_health")
    .select("*")
    .eq("tenant_id", tenantId)
    .eq("domain", domain)
    .gte("recorded_date", since)
    .order("recorded_date", { ascending: false });
  return (data as DomainHealth[]) ?? [];
}

export async function getLatestDomainHealth(
  tenantId: string,
  domain: string,
): Promise<DomainHealth | null> {
  const supabase = createServiceRoleClient() as AnySupabase;
  const { data } = await supabase
    .from("domain_health")
    .select("*")
    .eq("tenant_id", tenantId)
    .eq("domain", domain)
    .order("recorded_date", { ascending: false })
    .limit(1)
    .maybeSingle();
  return (data as DomainHealth) ?? null;
}
