/**
 * Reads for the weekly report and the hourly health check. Plain SQL through
 * the service role, no AI. A failed query becomes null (the report prints
 * "n/a"), never an empty list that would read as 0. Test addresses are
 * filtered in weekly.ts, so every row here carries the address it went to.
 */

import "server-only";
import { getAccessToken } from "@/lib/gmail/client";
import { createServiceRoleClient } from "@/lib/supabase/service-role";
import type { ArmRow } from "@/lib/learning/report";
import type { HealthProblem, HealthSnapshot } from "./health";
import type { WeeklyRaw } from "./weekly";

// Most of these tables (0040+) aren't in the generated types; queries go through any.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Db = any;
type Result = { data: unknown[] | null; error: { message: string } | null };

const DAY = 86_400_000;
const PAGE = 1000;
const MAX_PAGES = 20;
/** Code default of the AI cap (lib/anthropic/cost-tracking.ts DAILY_USD_CAP_DEFAULT). */
const DAILY_USD_CAP_DEFAULT = 6;

export const HEALTH_ALERT_ACTION = "health.alert";

export const appUrl = () => process.env.NEXT_PUBLIC_APP_URL || "https://spam-runnareach.vercel.app";

export function dailyCapUsd(): number {
  const v = Number.parseFloat(process.env.ANTHROPIC_DAILY_USD_CAP ?? "");
  return Number.isFinite(v) && v > 0 ? v : DAILY_USD_CAP_DEFAULT;
}

/** Every row of a query, paged past PostgREST's 1000-row cap. null on any error. */
async function all<T>(query: (from: number, to: number) => PromiseLike<Result>, map: (row: Db) => T): Promise<T[] | null> {
  const out: T[] = [];
  for (let page = 0; page < MAX_PAGES; page++) {
    try {
      const { data, error } = await query(page * PAGE, page * PAGE + PAGE - 1);
      if (error) {
        console.warn("[reports] query failed:", error.message);
        return null;
      }
      const rows = data ?? [];
      out.push(...rows.map(map));
      if (rows.length < PAGE) return out;
    } catch (err) {
      console.warn("[reports] query threw:", (err as Error).message);
      return null;
    }
  }
  return out;
}

/** A to-one embed comes back as an object, but be safe with arrays. */
function one(v: unknown): Db {
  return Array.isArray(v) ? v[0] ?? null : v ?? null;
}
const emailOf = (contact: unknown): string | null => (one(contact)?.email as string | undefined) ?? null;

export async function reportTenantIds(): Promise<string[]> {
  const { data, error } = await (createServiceRoleClient() as Db).from("autonomy_state").select("tenant_id");
  if (error) throw new Error(`tenant lookup failed: ${error.message}`);
  return ((data ?? []) as Array<{ tenant_id: string }>).map((r) => r.tenant_id);
}

export async function gatherWeeklyRaw(tenantId: string, now: Date): Promise<WeeklyRaw> {
  const db = createServiceRoleClient() as Db;
  const since14 = new Date(now.getTime() - 14 * DAY).toISOString();
  const since7 = new Date(now.getTime() - 7 * DAY).toISOString();
  const nowIso = now.toISOString();

  const [sent, replies, opportunities, optOuts, bounces, discoveryJobs, researched, drafts, autoScheduled, state, breakerTrips, arms, insights, aiSpend, warmup, alerts] =
    await Promise.all([
      all(
        (a, b) =>
          db.from("pitches").select("sent_at, parent_pitch_id, prospect_contacts:contact_id(email)")
            .eq("tenant_id", tenantId).gte("sent_at", since14).lte("sent_at", nowIso).order("sent_at").range(a, b),
        (r) => ({ at: r.sent_at as string, followUp: r.parent_pitch_id !== null, email: emailOf(r.prospect_contacts) }),
      ),
      all(
        (a, b) =>
          db.from("replies").select("received_at, intent, from_email")
            .eq("tenant_id", tenantId).gte("received_at", since14).lte("received_at", nowIso).order("received_at").range(a, b),
        (r) => ({ at: r.received_at as string, intent: r.intent as string, email: r.from_email as string | null }),
      ),
      all(
        (a, b) =>
          db.from("opportunities").select("created_at, updated_at, actual_close_date, stage, deal_value_cad, prospect_contacts:contact_id(email)")
            .eq("tenant_id", tenantId).or(`created_at.gte.${since14},updated_at.gte.${since14}`).order("created_at").range(a, b),
        (r) => ({
          createdAt: r.created_at as string,
          stage: r.stage as string,
          // actual_close_date is a date; without one, the last update is when it closed.
          closedAt: r.stage === "won" || r.stage === "lost" ? ((r.actual_close_date as string | null) ?? (r.updated_at as string)) : null,
          valueCad: r.deal_value_cad === null || r.deal_value_cad === undefined ? null : Number(r.deal_value_cad),
          email: emailOf(r.prospect_contacts),
        }),
      ),
      all(
        (a, b) =>
          db.from("audit_log").select("created_at, metadata")
            .eq("tenant_id", tenantId).eq("action", "prospect.opted_out").gte("created_at", since14).order("created_at").range(a, b),
        (r) => ({ at: r.created_at as string, email: (r.metadata?.email as string | undefined) ?? null }),
      ),
      all(
        (a, b) =>
          db.from("pitch_events").select("event_at, payload, pitches:pitch_id(prospect_contacts:contact_id(email))")
            .eq("tenant_id", tenantId).eq("event_type", "bounce").gte("event_at", since14).order("event_at").range(a, b),
        (r) => ({ at: r.event_at as string, test: r.payload?.test === true, email: emailOf(one(r.pitches)?.prospect_contacts) }),
      ),
      all(
        (a, b) => db.from("discovery_jobs").select("created_at").eq("tenant_id", tenantId).gte("created_at", since14).order("created_at").range(a, b),
        (r) => ({ at: r.created_at as string }),
      ),
      all(
        (a, b) => db.from("prospect_research").select("created_at").eq("tenant_id", tenantId).gte("created_at", since14).order("created_at").range(a, b),
        (r) => ({ at: r.created_at as string }),
      ),
      all(
        (a, b) =>
          db.from("pitches").select("created_at, auto_rejected, auto_rejected_reason, prospect_contacts:contact_id(email)")
            .eq("tenant_id", tenantId).is("parent_pitch_id", null).gte("created_at", since14).order("created_at").range(a, b),
        (r) => ({
          at: r.created_at as string,
          autoRejected: r.auto_rejected === true,
          reason: (r.auto_rejected_reason as string | null) ?? null,
          email: emailOf(r.prospect_contacts),
        }),
      ),
      all(
        (a, b) =>
          db.from("pitch_events").select("event_at, pitches:pitch_id(status, prospect_contacts:contact_id(email))")
            .eq("tenant_id", tenantId).eq("event_type", "approved").eq("payload->>autopilot", "true")
            .gte("event_at", since14).order("event_at").range(a, b),
        (r) => {
          const p = one(r.pitches);
          return { at: r.event_at as string, status: (p?.status as string | undefined) ?? "unknown", email: emailOf(p?.prospect_contacts) };
        },
      ),
      db.from("autonomy_state").select("enabled, stage, reason").eq("tenant_id", tenantId).maybeSingle() as Promise<{ data: Db; error: unknown }>,
      all(
        (a, b) =>
          db.from("learning_insights").select("created_at, title")
            .eq("tenant_id", tenantId).eq("kind", "breaker").gte("created_at", since7).order("created_at").range(a, b),
        (r) => ({ at: r.created_at as string, title: r.title as string }),
      ),
      all(
        (a, b) =>
          db.from("learning_arms").select("learner, key, status, origin, reward, trials, negatives, updated_at")
            .eq("tenant_id", tenantId).neq("status", "retired").order("trials", { ascending: false }).range(a, b),
        (r) => r as ArmRow,
      ),
      all(
        (a, b) =>
          db.from("learning_insights").select("created_at, kind, title")
            .eq("tenant_id", tenantId).neq("kind", "breaker").gte("created_at", since7).order("created_at", { ascending: false }).range(a, b),
        (r) => ({ at: r.created_at as string, kind: r.kind as string, title: r.title as string }),
      ),
      all(
        (a, b) =>
          db.from("cost_tracking").select("incurred_at, cost_usd")
            .eq("tenant_id", tenantId).eq("category", "anthropic").gte("incurred_at", since7).order("incurred_at").range(a, b),
        (r) => ({ at: r.incurred_at as string, usd: Number(r.cost_usd) || 0 }),
      ),
      warmupChecks(db, tenantId, since7),
      all(
        (a, b) =>
          db.from("audit_log").select("created_at, metadata")
            .eq("tenant_id", tenantId).eq("action", HEALTH_ALERT_ACTION).gte("created_at", since7).order("created_at").range(a, b),
        (r) => ({ at: r.created_at as string, kind: (r.metadata?.kind as string | undefined) ?? "unknown" }),
      ),
    ]);

  const s = state.error ? null : (state.data as { enabled: boolean; stage: string; reason: string | null } | null);
  return {
    now: nowIso,
    appUrl: appUrl(),
    sent,
    replies,
    opportunities,
    optOuts,
    bounces,
    discoveryJobs,
    researched,
    drafts,
    autoScheduled,
    autopilot: s ? { enabled: s.enabled, stage: s.stage, reason: s.reason } : null,
    breakerTrips,
    arms,
    insights,
    aiSpend,
    dailyCapUsd: dailyCapUsd(),
    warmup,
    alerts,
  };
}

/**
 * warmup_config.tenant_id is an auth user id (0016), not the tenant, so the
 * warmup identities are found by the tenant's sending addresses instead.
 */
async function warmupChecks(db: Db, tenantId: string, since: string): Promise<WeeklyRaw["warmup"]> {
  const { data: inboxes, error } = await db.from("sender_inboxes").select("email").eq("tenant_id", tenantId);
  if (error) return null;
  const emails = ((inboxes ?? []) as Array<{ email: string }>).map((i) => i.email);
  if (emails.length === 0) return [];
  const { data: configs, error: cErr } = await db.from("warmup_config").select("id").in("sending_email", emails);
  if (cErr) return null;
  const ids = ((configs ?? []) as Array<{ id: string }>).map((c) => c.id);
  if (ids.length === 0) return [];
  return all(
    (a, b) =>
      db.from("warmup_log").select("created_at, landed_in_inbox")
        .in("config_id", ids).eq("direction", "sent").gte("created_at", since).order("created_at").range(a, b),
    (r) => ({ at: r.created_at as string, landed: (r.landed_in_inbox as boolean | null) ?? null }),
  );
}

// ── Health ────────────────────────────────────────────────────────────────────

export async function gatherHealthSnapshot(tenantId: string, now: Date): Promise<HealthSnapshot> {
  const db = createServiceRoleClient() as Db;
  const [state, inboxRows, pending] = await Promise.all([
    db.from("autonomy_state").select("enabled, stage, updated_at").eq("tenant_id", tenantId).maybeSingle(),
    db.from("sender_inboxes").select("email, gmail_refresh_token_encrypted").eq("tenant_id", tenantId).not("gmail_refresh_token_encrypted", "is", null),
    db.from("pitches").select("id, status, scheduled_send_at, updated_at").eq("tenant_id", tenantId).in("status", ["approved", "sending"]).limit(1000),
  ]);
  // A failed read must not look healthy: surface it instead of returning empties.
  for (const [name, r] of [["autonomy_state", state], ["sender_inboxes", inboxRows], ["pitches", pending]] as const) {
    if (r.error) throw new Error(`${name} read failed: ${r.error.message}`);
  }

  const inboxes: HealthSnapshot["inboxes"] = [];
  for (const row of (inboxRows.data ?? []) as Array<{ email: string; gmail_refresh_token_encrypted: string }>) {
    const token = await getAccessToken(row.gmail_refresh_token_encrypted);
    inboxes.push({ email: row.email, tokenOk: token.ok, error: token.ok ? null : token.error });
  }

  const s = state.data as { enabled: boolean; stage: string; updated_at: string | null } | null;
  return {
    now: now.toISOString(),
    appUrl: appUrl(),
    autopilot: s ? { enabled: s.enabled, stage: s.stage, updatedAt: s.updated_at } : null,
    inboxes,
    pending: ((pending.data ?? []) as Array<{ id: string; status: string; scheduled_send_at: string | null; updated_at: string | null }>).map((p) => ({
      id: p.id,
      status: p.status,
      scheduledSendAt: p.scheduled_send_at,
      updatedAt: p.updated_at,
    })),
  };
}

export async function recentHealthAlerts(tenantId: string, since: Date): Promise<Array<{ kind: string; at: string }>> {
  const { data, error } = await (createServiceRoleClient() as Db)
    .from("audit_log")
    .select("created_at, metadata")
    .eq("tenant_id", tenantId)
    .eq("action", HEALTH_ALERT_ACTION)
    .gte("created_at", since.toISOString());
  // Can't tell what was already sent: fail toward one extra email, not silence.
  if (error) {
    console.warn("[reports] alert dedupe read failed:", error.message);
    return [];
  }
  return ((data ?? []) as Array<{ created_at: string; metadata: { kind?: string } | null }>).map((r) => ({
    kind: r.metadata?.kind ?? "unknown",
    at: r.created_at,
  }));
}

/**
 * The dedupe row. Written here rather than through writeAuditLog because
 * "health.alert" is not in its AuditAction union (lib/audit is conductor-only).
 */
export async function recordHealthAlert(tenantId: string, problem: HealthProblem): Promise<void> {
  const { error } = await (createServiceRoleClient() as Db).from("audit_log").insert({
    tenant_id: tenantId,
    actor_id: null,
    action: HEALTH_ALERT_ACTION,
    entity_type: "tenant",
    entity_id: tenantId,
    metadata: { kind: problem.kind, title: problem.title, detail: problem.detail },
  });
  if (error) console.warn("[reports] health alert not recorded:", error.message);
}
