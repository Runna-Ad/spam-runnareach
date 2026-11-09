/**
 * web_research (0055) reads and writes. The readers (webFactsFor for the email
 * writers, webLookState for the tick) never throw. The route's writes are
 * service role only: claim_web_research inserts the 'pending' row (that is the
 * claim), save turns it into the outcome while it is still pending, release
 * deletes a claim the run could not afford to dive.
 */

// Type-only imports from dive.ts and keep.ts: the readers load no Claude client.
import type { DiveOutcome, DiveProspect } from "./dive.ts";
import { WEB_FACTS_MAX_AGE_DAYS, webFactsFromJson, type WebFact } from "./facts.ts";
import type { DroppedCandidate } from "./keep.ts";

const DAY_MS = 86_400_000;
/** A pending row older than this was killed at maxDuration (the claim sweeps it to 'abandoned'). */
export const PENDING_ABANDON_MS = 10 * 60_000;
export const WEB_RESEARCH_READ_TIMEOUT_MS = 5_000;

type DbError = { message: string } | null;
export type DbResult = { data: unknown; error: DbError; count?: number | null };

/** The slice of a Supabase query builder used here (web_research isn't in the generated types). */
export interface WebResearchQuery extends PromiseLike<DbResult> {
  select(cols: string, opts?: { count?: "exact"; head?: boolean }): WebResearchQuery;
  eq(col: string, v: string): WebResearchQuery;
  neq(col: string, v: string): WebResearchQuery;
  in(col: string, v: readonly string[]): WebResearchQuery;
  gt(col: string, v: string): WebResearchQuery;
  gte(col: string, v: string): WebResearchQuery;
  order(col: string, o: { ascending: boolean }): WebResearchQuery;
  limit(n: number): WebResearchQuery;
  range(from: number, to: number): WebResearchQuery;
  abortSignal(s: AbortSignal): WebResearchQuery;
}

/** What the readers need: pass the Supabase client as `supabase as unknown as WebResearchDb`. */
export type WebResearchDb = {
  from(table: string): { select(cols: string, opts?: { count?: "exact"; head?: boolean }): WebResearchQuery };
};

/** What the route needs on top (service role). */
export type WebDiveDb = {
  from(table: string): {
    select(cols: string, opts?: { count?: "exact"; head?: boolean }): WebResearchQuery;
    update(values: Record<string, unknown>): WebResearchQuery;
    delete(): WebResearchQuery;
  };
  rpc(fn: string, args: Record<string, unknown>): WebResearchQuery;
};

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const errText = (e: DbError): string => (e ? e.message || "empty error" : "");
const cutoff = (now: Date, days: number) => new Date(now.getTime() - days * DAY_MS).toISOString();

// ── Readers ──────────────────────────────────────────────────────────────────

/**
 * The web facts for the email writers: the newest FINISHED dive (ok or empty)
 * younger than 60 days. ok → its facts re-validated to the WebFact shape (bad
 * entries dropped); empty, failed or nothing → []. Never throws: an error
 * returns [] (the email then makes no web claim at all).
 */
export async function webFactsFor(db: WebResearchDb, tenantId: string, prospectId: string, now: Date = new Date()): Promise<WebFact[]> {
  try {
    const { data, error } = await db
      .from("web_research")
      .select("status, facts, started_at")
      .eq("tenant_id", tenantId)
      .eq("prospect_id", prospectId)
      .in("status", ["ok", "empty"])
      .gt("started_at", cutoff(now, WEB_FACTS_MAX_AGE_DAYS))
      .order("started_at", { ascending: false })
      .limit(1)
      .abortSignal(AbortSignal.timeout(WEB_RESEARCH_READ_TIMEOUT_MS));
    // Presence, not truthiness: an empty-body 5xx comes back as { message: "" }.
    if (error) {
      console.warn("[web-dive] facts read failed:", errText(error));
      return [];
    }
    const row = Array.isArray(data) ? data[0] : null;
    if (!isObj(row) || row.status !== "ok") return [];
    return webFactsFromJson(row.facts);
  } catch (e) {
    console.warn("[web-dive] facts read failed:", e instanceof Error ? e.message : String(e));
    return [];
  }
}

export type LookState = "done" | "waiting" | "gave_up";
export type LookRow = { status: string; started_at: string };

/**
 * done     an ok or empty dive in the last 60 days
 * gave_up  2+ failed or abandoned dives in 60 days and no ok/empty (a pending
 *          row older than 10 minutes counts as abandoned: the next claim sweeps it so)
 * waiting  anything else (never dived, one failure, a dive running)
 */
export function lookStateFrom(rows: readonly LookRow[], now: Date): LookState {
  const since = now.getTime() - WEB_FACTS_MAX_AGE_DAYS * DAY_MS;
  let failures = 0;
  for (const r of rows) {
    const at = Date.parse(r.started_at);
    if (!Number.isFinite(at) || at <= since) continue;
    if (r.status === "ok" || r.status === "empty") return "done";
    if (r.status === "failed" || r.status === "abandoned") failures++;
    else if (r.status === "pending" && at < now.getTime() - PENDING_ABANDON_MS) failures++;
  }
  return failures >= 2 ? "gave_up" : "waiting";
}

const LOOK_COLUMNS = "prospect_id, status, started_at";

/** One prospect's web look. Never throws: a read error is "waiting" (a look we could not read is not done). */
export async function webLookState(db: WebResearchDb, tenantId: string, prospectId: string, now: Date = new Date()): Promise<LookState> {
  const r = await webLookStates(db, tenantId, [prospectId], now);
  if (r.error !== null) {
    console.warn("[web-dive] look read failed:", r.error);
    return "waiting";
  }
  return r.states.get(prospectId) ?? "waiting";
}

/** Many prospects at once (the tick). Never throws: on an error every state is "waiting" and the error says why. */
export async function webLookStates(
  db: WebResearchDb,
  tenantId: string,
  prospectIds: readonly string[],
  now: Date = new Date(),
): Promise<{ states: Map<string, LookState>; error: string | null }> {
  const states = new Map<string, LookState>(prospectIds.map((id) => [id, "waiting"]));
  if (prospectIds.length === 0) return { states, error: null };
  try {
    const { data, error } = await db
      .from("web_research")
      .select(LOOK_COLUMNS)
      .eq("tenant_id", tenantId)
      .in("prospect_id", prospectIds)
      .gt("started_at", cutoff(now, WEB_FACTS_MAX_AGE_DAYS))
      .order("started_at", { ascending: false })
      .limit(Math.max(50, prospectIds.length * 10))
      .abortSignal(AbortSignal.timeout(WEB_RESEARCH_READ_TIMEOUT_MS));
    if (error) return { states, error: `web_research read failed: ${errText(error)}` };
    const byProspect = new Map<string, LookRow[]>();
    for (const row of Array.isArray(data) ? data : []) {
      if (!isObj(row) || typeof row.prospect_id !== "string") continue;
      const list = byProspect.get(row.prospect_id) ?? [];
      list.push({ status: String(row.status), started_at: String(row.started_at) });
      byProspect.set(row.prospect_id, list);
    }
    for (const id of prospectIds) states.set(id, lookStateFrom(byProspect.get(id) ?? [], now));
    return { states, error: null };
  } catch (e) {
    return { states, error: `web_research read failed: ${e instanceof Error ? e.message : String(e)}` };
  }
}

// ── The route's writes (service role) ────────────────────────────────────────

/** A claimed row plus the prospect fields the prompt and the keep-check need. */
export type DueDive = DiveProspect & { research_id: string };

const optStr = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v : null);

/** Sweeps stale claims, then claims up to `limit` due prospects (claim_web_research, 0055). Throws on an error. */
export async function claimWebResearch(db: WebDiveDb, limit: number, timeoutMs: number): Promise<DueDive[]> {
  const { data, error } = await db.rpc("claim_web_research", { p_limit: limit }).abortSignal(AbortSignal.timeout(timeoutMs));
  if (error) throw new Error(`claim_web_research: ${errText(error)}`);
  const out: DueDive[] = [];
  for (const r of Array.isArray(data) ? data : []) {
    if (!isObj(r) || typeof r.id !== "string" || typeof r.tenant_id !== "string" || typeof r.prospect_id !== "string") continue;
    if (typeof r.company_name !== "string" || !r.company_name.trim()) continue;
    out.push({
      research_id: r.id,
      id: r.prospect_id,
      tenant_id: r.tenant_id,
      company_name: r.company_name,
      city: optStr(r.city),
      region: optStr(r.region),
      country_code: optStr(r.country_code),
      domain: optStr(r.domain),
      website_url: optStr(r.website_url),
      industry: optStr(r.industry),
    });
  }
  return out;
}

/** Stored drops are for debugging: bounded so a runaway answer can't bloat the row. */
const DROPPED_MAX = 20;

/** The drops as stored: strings clipped, at most DROPPED_MAX. */
export function droppedForRow(dropped: readonly DroppedCandidate[]): DroppedCandidate[] {
  return dropped.slice(0, DROPPED_MAX).map((d) => ({
    candidate: {
      fact: d.candidate.fact.slice(0, 400),
      quote: d.candidate.quote.slice(0, 600),
      url: d.candidate.url.slice(0, 500),
      kind: d.candidate.kind.slice(0, 40),
    },
    reason: d.reason,
  }));
}

/** The row's columns for one finished dive. */
export function webResearchRow(o: DiveOutcome, finishedAt: Date): Record<string, unknown> {
  return {
    status: o.status,
    facts: o.status === "ok" ? o.facts : [],
    searches: o.searches,
    cost_usd: o.costUsd,
    model: o.model,
    error: o.error,
    dropped: droppedForRow(o.dropped),
    finished_at: finishedAt.toISOString(),
  };
}

/** Writes the outcome, only while the row is still pending (a row the next claim swept stays abandoned). */
export async function saveWebResearch(
  db: WebDiveDb,
  researchId: string,
  outcome: DiveOutcome,
  finishedAt: Date,
  timeoutMs: number,
): Promise<{ ok: boolean; error?: string }> {
  try {
    const { data, error } = await db
      .from("web_research")
      .update(webResearchRow(outcome, finishedAt))
      .eq("id", researchId)
      .eq("status", "pending")
      .select("id")
      .abortSignal(AbortSignal.timeout(timeoutMs));
    if (error) return { ok: false, error: errText(error) };
    if (!Array.isArray(data) || data.length === 0) return { ok: false, error: "row no longer pending (swept as abandoned)" };
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

/** Gives a claim back unused (the budget stopped the run): only while it is still our pending row. */
export async function releaseWebResearch(db: WebDiveDb, researchId: string, timeoutMs: number): Promise<{ ok: boolean; error?: string }> {
  try {
    const { error } = await db
      .from("web_research")
      .delete()
      .eq("id", researchId)
      .eq("status", "pending")
      .abortSignal(AbortSignal.timeout(timeoutMs));
    return error ? { ok: false, error: errText(error) } : { ok: true };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

/** Dives the tenant started in the last 24h, any status, the given claim excluded. */
export async function divesStartedSince(
  db: WebDiveDb,
  tenantId: string,
  since: Date,
  excludeId: string,
  timeoutMs: number,
): Promise<{ count: number } | { error: string }> {
  try {
    const { count, error } = await db
      .from("web_research")
      .select("id", { count: "exact", head: true })
      .eq("tenant_id", tenantId)
      .gt("started_at", since.toISOString())
      .neq("id", excludeId)
      .abortSignal(AbortSignal.timeout(timeoutMs));
    if (error) return { error: `web_research count failed: ${errText(error)}` };
    if (typeof count !== "number") return { error: "web_research count missing" };
    return { count };
  } catch (e) {
    return { error: `web_research count failed: ${e instanceof Error ? e.message : String(e)}` };
  }
}

/**
 * Claude spend in the rolling 24h, failing CLOSED. isUnderDailyCap
 * (lib/anthropic/cost-tracking.ts) reads the same rows (tenant, category
 * anthropic, incurred_at in 24h, paged) but answers "under" on a read error;
 * a dive costs ~$0.21, so here an error means "do not dive".
 */
export async function spentLast24h(db: WebDiveDb, tenantId: string, now: Date, timeoutMs: number): Promise<{ usd: number } | { error: string }> {
  const PAGE = 1000;
  const since = new Date(now.getTime() - DAY_MS).toISOString();
  // One deadline for every page: the whole read is bounded by timeoutMs.
  const signal = AbortSignal.timeout(timeoutMs);
  let usd = 0;
  try {
    for (let from = 0; from < 20 * PAGE; from += PAGE) {
      const { data, error } = await db
        .from("cost_tracking")
        .select("cost_usd")
        .eq("tenant_id", tenantId)
        .eq("category", "anthropic")
        .gte("incurred_at", since)
        .order("incurred_at", { ascending: true })
        .range(from, from + PAGE - 1)
        .abortSignal(signal);
      if (error) return { error: `cost read failed: ${errText(error)}` };
      const rows = Array.isArray(data) ? data : [];
      for (const r of rows) {
        const n = isObj(r) ? Number(r.cost_usd) : Number.NaN;
        if (!Number.isFinite(n)) return { error: "cost read returned a non-number" };
        usd += n;
      }
      if (rows.length < PAGE) return { usd };
    }
    return { error: "cost read: more than 20,000 rows in 24h" };
  } catch (e) {
    return { error: `cost read failed: ${e instanceof Error ? e.message : String(e)}` };
  }
}
