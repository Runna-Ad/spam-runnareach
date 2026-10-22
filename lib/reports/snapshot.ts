/**
 * Reads for the weekly report and the hourly health check. Plain SQL through
 * the service role, no AI. A failed query becomes null (the report prints
 * "n/a"), never an empty list that would read as 0. Test addresses are
 * filtered in weekly.ts, so every row here carries the address it went to.
 */

import "server-only";
import * as Sentry from "@sentry/nextjs";
import { INBOX_RESUMED_ACTION } from "@/lib/autopilot/inbox-resume";
import { getAccessToken } from "@/lib/gmail/client";
import { createServiceRoleClient } from "@/lib/supabase/service-role";
import type { ArmRow } from "@/lib/learning/report";
import { ATTRIBUTION_WINDOW_DAYS, OUTCOME_EVENT_TYPES, type OutcomeEvent } from "@/lib/learning/reward";
import {
  EXEMPLAR_CANDIDATE_COLUMNS,
  candidateFromRow,
  dncKeys,
  exemplarsEnabled,
  toDncEntries,
  type CandidateRow,
} from "@/lib/pitches/exemplar-queries";
import type { HealthProblem, HealthSnapshot } from "./health";
import type { ExemplarPool, WeeklyRaw } from "./weekly";

// Most of these tables (0040+) aren't in the generated types; queries go through any.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Db = any;
type Result = { data: unknown[] | null; error: { message: string } | null };

const DAY = 86_400_000;
const PAGE = 1000;
const MAX_PAGES = 20;
/** Code default of the AI cap (lib/anthropic/cost-tracking.ts DAILY_USD_CAP_DEFAULT). */
const DAILY_USD_CAP_DEFAULT = 6;
/** Values per .in() list: 100 uuids keep the request URL around 4 KB. */
const IN_CHUNK = 100;
/**
 * Every exemplar-pool read together (normally under 1s); past it the line reads n/a. Small
 * enough that token refresh + two notification sends still fit the route's 60s.
 */
const EXEMPLAR_POOL_BUDGET_MS = 8_000;

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

/** all() over each chunk of an .in() list, one chunk at a time. null on any error. */
async function allIn<T>(
  values: readonly string[],
  query: (chunk: string[], from: number, to: number) => PromiseLike<Result>,
  map: (row: Db) => T,
): Promise<T[] | null> {
  const out: T[] = [];
  for (let i = 0; i < values.length; i += IN_CHUNK) {
    const chunk = values.slice(i, i + IN_CHUNK);
    const rows = await all((a, b) => query(chunk, a, b), map);
    if (!rows) return null;
    out.push(...rows);
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

  const [sent, replies, opportunities, optOuts, bounces, discoveryJobs, researched, drafts, autoScheduled, state, breakerTrips, arms, insights, aiSpend, warmup, alerts, exemplarPool] =
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
          db.from("pitch_events").select("event_at, pitches:pitch_id(status, autopilot_reasons, prospect_contacts:contact_id(email))")
            .eq("tenant_id", tenantId).eq("event_type", "approved").eq("payload->>autopilot", "true")
            .gte("event_at", since14).order("event_at").range(a, b),
        (r) => {
          const p = one(r.pitches);
          // Reasons tell a person's veto from the autopilot's own pull-back (governor vetoedByPerson).
          const reasons = Array.isArray(p?.autopilot_reasons) ? (p.autopilot_reasons as string[]) : null;
          return { at: r.event_at as string, status: (p?.status as string | undefined) ?? "unknown", email: emailOf(p?.prospect_contacts), reasons };
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
          // review.attempt rows (lib/autopilot/learn.ts REVIEW_ATTEMPT_LEARNER) are the weekly
          // review's daily attempt markers, not insights: up to 7 a week would pad the count.
          db.from("learning_insights").select("created_at, kind, title")
            .eq("tenant_id", tenantId).neq("kind", "breaker").neq("learner", "review.attempt").gte("created_at", since7).order("created_at", { ascending: false }).range(a, b),
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
      // n/a by construction if anything in it throws, not only through all()'s own catch.
      exemplarPoolOf(db, tenantId, now).catch(() => null),
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
    exemplarsEnabled: exemplarsEnabled(),
    exemplarPool,
  };
}

/**
 * What the exemplar readiness count reads: every settled root send of the
 * tenant, with the columns fetchExemplars reads (rows passed through as it
 * gets them), their outcome events, and the do-not-contact entries for their
 * addresses and domains. Counting is pure (weekly.ts exemplarReadiness).
 */
async function exemplarPoolOf(db: Db, tenantId: string, now: Date): Promise<ExemplarPool | null> {
  const signal = AbortSignal.timeout(EXEMPLAR_POOL_BUDGET_MS);
  const settled = new Date(now.getTime() - ATTRIBUTION_WINDOW_DAYS * DAY).toISOString();
  const rows = await all(
    (a, b) =>
      db.from("pitches").select(EXEMPLAR_CANDIDATE_COLUMNS)
        .eq("tenant_id", tenantId).eq("status", "sent").is("parent_pitch_id", null).lte("sent_at", settled)
        .order("sent_at").order("id").range(a, b).abortSignal(signal),
    (r) => r as CandidateRow,
  );
  if (!rows) return null;
  // A suppressed prospect's pitch is never counted: its outcome and DNC entries are not needed.
  const live = rows.filter((r) => candidateFromRow(r) !== null);
  const events = await allIn(
    [...new Set(live.map((r) => r.id))],
    (ids, a, b) =>
      db.from("pitch_events").select("id, pitch_id, event_type, event_at, payload")
        .eq("tenant_id", tenantId).in("pitch_id", ids).in("event_type", OUTCOME_EVENT_TYPES)
        .order("id").range(a, b).abortSignal(signal),
    (r) => ({ pitchId: r.pitch_id as string, event: { type: r.event_type as string, at: r.event_at as string, payload: r.payload as OutcomeEvent["payload"] } }),
  );
  if (!events) return null;
  const { mailboxes, domains } = dncKeys(live.map((r) => r.prospect_contacts?.email ?? null));
  const [byEmail, byDomain] = await Promise.all([
    allIn(
      mailboxes,
      (xs, a, b) =>
        db.from("do_not_contact_list").select("id, email").eq("tenant_id", tenantId).in("email", xs).order("id").range(a, b).abortSignal(signal),
      (r) => ({ email: (r.email as string | null) ?? null }),
    ),
    allIn(
      domains,
      (xs, a, b) =>
        db.from("do_not_contact_list").select("id, domain").eq("tenant_id", tenantId).in("domain", xs).order("id").range(a, b).abortSignal(signal),
      (r) => ({ domain: (r.domain as string | null) ?? null }),
    ),
  ]);
  if (!byEmail || !byDomain) return null;
  const byPitch = new Map<string, OutcomeEvent[]>();
  for (const { pitchId, event } of events) byPitch.set(pitchId, [...(byPitch.get(pitchId) ?? []), event]);
  return { pitches: rows.map((r) => ({ ...r, events: byPitch.get(r.id) ?? [] })), dnc: toDncEntries(byEmail, byDomain) };
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
  const since48 = new Date(now.getTime() - 2 * DAY).toISOString();
  const [state, inboxRows, pending, sends] = await Promise.all([
    db.from("autonomy_state").select("enabled, stage, updated_at").eq("tenant_id", tenantId).maybeSingle(),
    db.from("sender_inboxes")
      .select("id, email, paused, paused_reason, daily_cap, gmail_refresh_token_encrypted")
      .eq("tenant_id", tenantId)
      .not("gmail_refresh_token_encrypted", "is", null),
    db.from("pitches")
      .select("id, status, scheduled_send_at, updated_at, sender_inbox_id, prospects:prospect_id(cooldown_until)")
      .eq("tenant_id", tenantId)
      .in("status", ["approved", "sending"])
      .limit(1000),
    db.from("pitches").select("sender_inbox_id, sent_at").eq("tenant_id", tenantId).gte("sent_at", since48).limit(1000),
  ]);
  // A failed read must not look healthy: surface it instead of returning empties.
  for (const [name, r] of [["autonomy_state", state], ["sender_inboxes", inboxRows], ["pitches", pending], ["recent sends", sends]] as const) {
    if (r.error) throw new Error(`${name} read failed: ${r.error.message}`);
  }

  // In parallel: each refresh can take up to 10s and app/** routes get 60s.
  type InboxRow = { id: string; email: string; paused: boolean; paused_reason: string | null; daily_cap: number | null; gmail_refresh_token_encrypted: string };
  const rows = (inboxRows.data ?? []) as InboxRow[];
  const [tokens, extra] = await Promise.all([
    Promise.all(rows.map((row) => getAccessToken(row.gmail_refresh_token_encrypted))),
    alarmReads(db, tenantId, now, rows.filter((r) => r.paused === true).map((r) => r.id)),
  ]);
  const inboxes: HealthSnapshot["inboxes"] = rows.map((row, i) => {
    const token = tokens[i] ?? { ok: false as const, error: "token refresh not run" };
    return {
      id: row.id,
      email: row.email,
      paused: row.paused === true,
      dailyCap: row.daily_cap ?? 0,
      tokenOk: token.ok,
      error: token.ok ? null : token.error,
      pausedReason: row.paused_reason ?? null,
      pausedSince: extra.pausedSince.get(row.id) ?? null,
    };
  });

  type PendingRow = { id: string; status: string; scheduled_send_at: string | null; updated_at: string | null; sender_inbox_id: string | null; prospects: unknown };
  const s = state.data as { enabled: boolean; stage: string; updated_at: string | null } | null;
  return {
    now: now.toISOString(),
    appUrl: appUrl(),
    autopilot: s ? { enabled: s.enabled, stage: s.stage, updatedAt: s.updated_at } : null,
    inboxes,
    pending: ((pending.data ?? []) as PendingRow[]).map((p) => ({
      id: p.id,
      status: p.status,
      scheduledSendAt: p.scheduled_send_at,
      updatedAt: p.updated_at,
      senderInboxId: p.sender_inbox_id,
      cooldownUntil: (one(p.prospects)?.cooldown_until as string | null | undefined) ?? null,
    })),
    recentSends: ((sends.data ?? []) as Array<{ sender_inbox_id: string | null; sent_at: string }>).map((r) => ({
      senderInboxId: r.sender_inbox_id,
      sentAt: r.sent_at,
    })),
    tickErrors: extra.tickErrors,
    learning: extra.learning,
    heartbeats: extra.heartbeats,
  };
}

/** audit_log action of the tick's error row (lib/autopilot/tick.ts; contract in tasks/briefs/health-alarms.md). */
export const TICK_ERRORS_ACTION = "autopilot.tick_errors";

/**
 * The reads behind inbox_paused, tick_errors, learning_stalled and job_silent.
 * Unlike the core reads above, a failure here makes only that input null (its
 * rule stays silent, and the failure is logged): a missing table or a bad read
 * must not take google_disconnected and emails_stuck down with it.
 */
async function alarmReads(
  db: Db,
  tenantId: string,
  now: Date,
  pausedIds: string[],
): Promise<{
  pausedSince: Map<string, string>;
  tickErrors: HealthSnapshot["tickErrors"];
  learning: HealthSnapshot["learning"];
  heartbeats: HealthSnapshot["heartbeats"];
}> {
  const iso = (days: number) => new Date(now.getTime() - days * DAY).toISOString();
  const [trips, resumes, ticks, due, arms, beats] = await Promise.all([
    pausedIds.length
      ? db.from("learning_insights").select("created_at, evidence").eq("tenant_id", tenantId)
          .eq("learner", "governor").eq("kind", "breaker").gte("created_at", iso(60)).order("created_at", { ascending: false }).limit(200)
      : { data: [], error: null },
    pausedIds.length
      ? db.from("audit_log").select("created_at, entity_id").eq("tenant_id", tenantId)
          .eq("action", INBOX_RESUMED_ACTION).in("entity_id", pausedIds).gte("created_at", iso(60))
      : { data: [], error: null },
    db.from("audit_log").select("created_at, metadata").eq("tenant_id", tenantId)
      .eq("action", TICK_ERRORS_ACTION).gte("created_at", iso(1)).order("created_at", { ascending: false }).limit(200),
    db.from("pitches").select("status, arms:decision->arms, prospect_contacts:contact_id(email)").eq("tenant_id", tenantId)
      .is("parent_pitch_id", null).gte("sent_at", iso(30)).lte("sent_at", iso(15)).limit(1000),
    db.from("learning_arms").select("trials, updated_at").eq("tenant_id", tenantId).like("learner", "writer.%"),
    db.from("cron_heartbeats").select("job, last_ok_at, last_error_at, last_error, created_at"),
  ]);
  const ok = (name: string, r: Result) => {
    if (r.error) console.warn(`[reports] health ${name} read failed:`, r.error.message);
    return !r.error;
  };

  const pausedSince = new Map<string, string>();
  if (ok("breaker trips", trips) && ok("resumes", resumes)) {
    const lastResume = new Map<string, string>();
    for (const r of (resumes.data ?? []) as Array<{ created_at: string; entity_id: string }>) {
      if ((lastResume.get(r.entity_id) ?? "") < r.created_at) lastResume.set(r.entity_id, r.created_at);
    }
    // Newest first: the first trip covering an inbox after its last resume.
    for (const t of (trips.data ?? []) as Array<{ created_at: string; evidence: { scope?: string; inboxId?: string } | null }>) {
      for (const id of pausedIds) {
        if (pausedSince.has(id) || t.created_at <= (lastResume.get(id) ?? "")) continue;
        if (t.evidence?.scope === "all" || t.evidence?.inboxId === id) pausedSince.set(id, t.created_at);
      }
    }
  }

  const tickErrors = ok("tick errors", ticks)
    ? ((ticks.data ?? []) as Array<{ created_at: string; metadata: { errors?: unknown } | null }>).map((r) => ({
        at: r.created_at,
        errors: Array.isArray(r.metadata?.errors) ? r.metadata.errors.filter((e): e is string => typeof e === "string") : [],
      }))
    : null;

  const learning =
    ok("due sends", due) && ok("writer arms", arms)
      ? {
          // The writer learner only counts first emails that recorded their arms (lib/autopilot/learn.ts).
          dueRootSends: ((due.data ?? []) as Array<{ status: string; arms: Record<string, unknown> | null; prospect_contacts: unknown }>)
            .filter((p) => p.arms && typeof p.arms === "object" && Object.keys(p.arms).some((k) => k.startsWith("writer.")))
            .map((p) => ({ email: emailOf(p.prospect_contacts), status: p.status })),
          writerArms: ((arms.data ?? []) as Array<{ trials: number | null; updated_at: string | null }>).map((r) => ({
            trials: r.trials ?? 0,
            updatedAt: r.updated_at,
          })),
        }
      : null;

  const heartbeats = ok("cron heartbeats", beats)
    ? ((beats.data ?? []) as Array<{ job: string; last_ok_at: string | null; last_error_at: string | null; last_error: string | null; created_at: string | null }>).map(
        (r) => ({ job: r.job, lastOkAt: r.last_ok_at, lastErrorAt: r.last_error_at, lastError: r.last_error, createdAt: r.created_at }),
      )
    : null;

  return { pausedSince, tickErrors, learning, heartbeats };
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
 * The dedupe row. A direct insert rather than writeAuditLog, which swallows
 * the error: a missing row means the next hourly run repeats the email, so a
 * failure goes to Sentry.
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
  if (error) {
    // Without the row the next hourly run emails the same problem again: say so loudly.
    console.error("[reports] health alert not recorded:", error.message);
    Sentry.captureMessage(`S.P.A.M. health alert dedupe row not recorded (${problem.kind}): ${error.message}`, { level: "error" });
  }
}
