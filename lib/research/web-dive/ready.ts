/**
 * The tick's "draft ready prospects" step (lib/autopilot/tick.ts, step
 * first-draft). A prospect in `match` with no pitch row gets its first email
 * once both looks are finished (looks.ts firstDraftDecision), or after the
 * timeout with the audit reason "looks timed out". Mirrors the re-draft step:
 * at most FIRST_DRAFTS_PER_TICK a tick, only with 60 s of tick time and the
 * rewrite minimum of AI budget left, an audit row on every failure (a
 * prospect gets FIRST_DRAFT_MAX_TRIES tries).
 *
 * Also: a `match` prospect that already has a pitch row (a person pressed
 * "Generate pitch", or our status write failed after the draft) is moved to
 * `pitched` with the same guarded write, so nothing stays in `match` with a
 * draft.
 *
 * With the web dive switched off (flag.ts, the default), the web look counts
 * as done ("off"): a prospect is drafted once its site look is finished.
 */

import { protectedStatusFilter } from "../../prospects/status.ts";
import { webDiveEnabled } from "./flag.ts";
import { firstDraftDecision, siteLookState, WAITING_FOR_LOOKS, SITE_LOOK_DAYS, type FirstDraftReason, type SiteLook, type SiteRow, type WebLook } from "./looks.ts";
import { webLookStates, type WebResearchDb } from "./store.ts";

export const FIRST_DRAFTS_PER_TICK = 2;
export const FIRST_DRAFT_MAX_TRIES = 2;
/** audit_log action of each first draft the tick wrote (entity: the prospect). */
export const FIRST_DRAFT_ACTION = "autopilot.first_draft";
/** audit_log action of a first draft that could not be generated (entity: the prospect). */
export const FIRST_DRAFT_FAILED_ACTION = "autopilot.first_draft_failed";
/**
 * audit_log action written ONCE, with the last failed try: the tick stops trying
 * and the prospect stays in `match` ("Waiting for checks" on /companies and the
 * funnel) for a person to press Generate pitch.
 */
export const FIRST_DRAFT_GAVE_UP_ACTION = "autopilot.first_draft_gave_up";
/**
 * `match` prospects read per tick, NEWEST-updated first: one whose first draft
 * failed twice stays in `match` (a person can still press Generate pitch) and
 * nothing updates it again, so it sinks to the end instead of filling the scan.
 * The designed load keeps far fewer waiting (10-24 a day, a day at most each).
 */
export const FIRST_DRAFT_SCAN = 200;
/** A draft is a full write + review (up to ~60 s): don't start one with less tick time left. */
export const FIRST_DRAFT_MIN_TIME_MS = 60_000;
const HORIZON_DAYS = 60;
const DAY_MS = 86_400_000;

export type FirstDraftReport = {
  drafted: number;
  failed: number;
  /** Of drafted + failed: started because the looks timed out. */
  timedOut: number;
  /** `match` prospects that already had a pitch, moved to `pitched`. */
  advanced: number;
  waiting: string | null;
};

type GenerateResult = { ok: true; pitch_id: string } | { ok: false; error: string };

export type FirstDraftDeps = {
  // A narrow structural view of the service-role client (tick.ts passes its Db).
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  db: any;
  tenantId: string;
  now: Date;
  /** Epoch ms: the tick's time budget. */
  deadline: number;
  minBudgetUsd: number;
  underCap: (tenantId: string) => Promise<{ under: boolean; spent_today_usd: number; cap_usd: number }>;
  generate: (prospectId: string) => Promise<GenerateResult>;
  clock?: () => number;
  /** Is the web dive on? Default: WEB_DIVE_ENABLED (flag.ts). Off, the web look counts as done. */
  webDive?: boolean;
};

type Candidate = { id: string; domain: string | null; website_url: string | null; updated_at: string };

const errMsg = (e: { message?: string } | null | undefined) => (e ? e.message || "no detail" : "");

/** The pipeline's status write (pipeline-stage.ts writeStatus): guarded by the status rule, and only from `match`. */
async function writePitched(db: FirstDraftDeps["db"], tenantId: string, prospectId: string, now: Date): Promise<{ moved: boolean; error?: string }> {
  let q = db
    .from("prospects")
    .update({ status: "pitched", pitch_gate_passed: true, updated_at: now.toISOString() })
    .eq("id", prospectId)
    .eq("tenant_id", tenantId)
    .eq("status", "match");
  const guard = protectedStatusFilter("pitched", "automation");
  if (guard) q = q.not("status", "in", guard);
  const { data, error } = await q.select("id");
  if (error) return { moved: false, error: `status write (pitched) failed: ${errMsg(error)}` };
  return { moved: Array.isArray(data) && data.length > 0 };
}

export async function draftReadyProspects(deps: FirstDraftDeps): Promise<FirstDraftReport> {
  const { db, tenantId, now } = deps;
  const clock = deps.clock ?? Date.now;
  const out: FirstDraftReport = { drafted: 0, failed: 0, timedOut: 0, advanced: 0, waiting: null };
  const horizon = new Date(now.getTime() - HORIZON_DAYS * DAY_MS).toISOString();

  const { data: rows, error: rowsErr } = await db
    .from("prospects")
    .select("id, domain, website_url, updated_at")
    .eq("tenant_id", tenantId)
    .eq("status", "match")
    .order("updated_at", { ascending: false })
    .limit(FIRST_DRAFT_SCAN);
  if (rowsErr) throw new Error(`match prospects not read: ${errMsg(rowsErr)}`);
  const all = (Array.isArray(rows) ? rows : []) as Candidate[];
  if (all.length === 0) return out;
  const ids = all.map((p) => p.id);

  // Any pitch row, follow-ups and auto_rejected included: that prospect was drafted.
  const { data: pitchRows, error: pitchErr } = await db.from("pitches").select("prospect_id").eq("tenant_id", tenantId).in("prospect_id", ids);
  if (pitchErr) throw new Error(`pitches not read: ${errMsg(pitchErr)}`);
  const drafted = new Set(((pitchRows ?? []) as Array<{ prospect_id: string }>).map((r) => r.prospect_id));
  for (const p of all.filter((x) => drafted.has(x.id))) {
    const w = await writePitched(db, tenantId, p.id, now);
    if (w.error) throw new Error(w.error);
    if (w.moved) out.advanced++;
  }
  const waiting = all.filter((p) => !drafted.has(p.id));
  if (waiting.length === 0) return out;
  const wids = waiting.map((p) => p.id);

  const [{ data: auditRows, error: auditErr }, { data: failRows, error: failErr }] = await Promise.all([
    db
      .from("audit_log")
      .select("entity_id, created_at")
      .eq("tenant_id", tenantId)
      .eq("action", "prospect.scored")
      .eq("metadata->>kind", WAITING_FOR_LOOKS)
      .in("entity_id", wids)
      .gte("created_at", horizon)
      .order("created_at", { ascending: false })
      .limit(wids.length * 5),
    db
      .from("audit_log")
      .select("entity_id")
      .eq("tenant_id", tenantId)
      .eq("action", FIRST_DRAFT_FAILED_ACTION)
      .in("entity_id", wids)
      .gte("created_at", horizon)
      .limit(wids.length * FIRST_DRAFT_MAX_TRIES + 10),
  ]);
  if (auditErr) throw new Error(`waiting_for_looks rows not read: ${errMsg(auditErr)}`);
  if (failErr) throw new Error(`failed first drafts not read: ${errMsg(failErr)}`);
  // Newest entry into `match` per prospect. Without one (its audit write is best-effort),
  // the row's updated_at: any later write only moves that later, so the wait only grows.
  const entered = new Map<string, number>();
  for (const r of (auditRows ?? []) as Array<{ entity_id: string; created_at: string }>) {
    if (!entered.has(r.entity_id)) entered.set(r.entity_id, Date.parse(r.created_at));
  }
  const tries = new Map<string, number>();
  for (const r of (failRows ?? []) as Array<{ entity_id: string }>) tries.set(r.entity_id, (tries.get(r.entity_id) ?? 0) + 1);

  // The two looks. A look we could not read is not done (only the timeout drafts then).
  const notes: string[] = [];
  const site = new Map<string, SiteLook>(wids.map((id) => [id, "waiting"]));
  const { data: obsRows, error: obsErr } = await db
    .from("site_observations")
    .select("prospect_id, status, crawled_at")
    .eq("tenant_id", tenantId)
    .in("prospect_id", wids)
    .gt("crawled_at", new Date(now.getTime() - SITE_LOOK_DAYS * DAY_MS).toISOString())
    .limit(wids.length * 10);
  const obsBy = new Map<string, SiteRow[]>();
  if (obsErr) notes.push(`site looks not read: ${errMsg(obsErr)}`);
  else for (const r of (obsRows ?? []) as Array<SiteRow & { prospect_id: string }>) obsBy.set(r.prospect_id, [...(obsBy.get(r.prospect_id) ?? []), r]);
  for (const p of waiting) {
    const noSite = !p.domain?.trim() && !p.website_url?.trim();
    if (!obsErr || noSite) site.set(p.id, siteLookState(p, obsBy.get(p.id) ?? [], now));
  }
  // The web dive switched off: no web look to wait for, and nothing to read.
  const webOn = deps.webDive ?? webDiveEnabled();
  const web = webOn ? await webLookStates(db as WebResearchDb, tenantId, wids, now) : null;
  if (web?.error) notes.push(web.error);

  const queue = waiting
    .filter((p) => (tries.get(p.id) ?? 0) < FIRST_DRAFT_MAX_TRIES)
    .map((p) => ({ p, enteredAt: entered.get(p.id) ?? Date.parse(p.updated_at), tries: tries.get(p.id) ?? 0 }))
    .sort((a, b) => a.enteredAt - b.enteredAt);

  for (const { p, enteredAt, tries: triedBefore } of queue) {
    const webState: WebLook = web ? (web.states.get(p.id) ?? "waiting") : "off";
    const siteState = site.get(p.id) ?? "waiting";
    const decision = firstDraftDecision({ site: siteState, web: webState, enteredAtMs: enteredAt, nowMs: now.getTime() });
    if (!decision.draft) continue;
    if (out.drafted + out.failed >= FIRST_DRAFTS_PER_TICK) break;
    if (deps.deadline - clock() < FIRST_DRAFT_MIN_TIME_MS) {
      notes.push("tick time budget");
      break;
    }
    const cap = await deps.underCap(tenantId);
    if (!cap.under || cap.cap_usd - cap.spent_today_usd < deps.minBudgetUsd) {
      notes.push(`AI budget: $${cap.spent_today_usd.toFixed(2)} of $${cap.cap_usd.toFixed(2)} used in 24h`);
      break;
    }
    await draftOne(deps, p.id, decision.reason, { site: siteState, web: webState, waitedHours: Math.round((now.getTime() - enteredAt) / 360_000) / 10 }, triedBefore, out);
  }
  out.waiting = notes.length ? notes.join("; ").slice(0, 300) : null;
  return out;
}

async function draftOne(
  deps: FirstDraftDeps,
  prospectId: string,
  reason: FirstDraftReason,
  looks: { site: SiteLook; web: WebLook; waitedHours: number },
  triedBefore: number,
  out: FirstDraftReport,
): Promise<void> {
  const { db, tenantId, now } = deps;
  if (reason === "looks timed out") out.timedOut++;
  let result: GenerateResult;
  try {
    result = await deps.generate(prospectId);
  } catch (err) {
    result = { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
  const metadata = { reason, site_look: looks.site, web_look: looks.web, waited_hours: looks.waitedHours };
  if (!result.ok) {
    out.failed++;
    const { error } = await db.from("audit_log").insert({
      tenant_id: tenantId,
      actor_id: null,
      action: FIRST_DRAFT_FAILED_ACTION,
      entity_type: "prospect",
      entity_id: prospectId,
      metadata: { ...metadata, error: result.error.slice(0, 300) },
    });
    // Not recorded = it would be tried again every tick: stop and leave a tick error.
    if (error) throw new Error(`failed first draft not recorded: ${errMsg(error)}`);
    if (triedBefore + 1 >= FIRST_DRAFT_MAX_TRIES) {
      // The last try: one row says the tick gave up. The prospect stays in `match`, visible.
      const { error: gaveUpErr } = await db.from("audit_log").insert({
        tenant_id: tenantId,
        actor_id: null,
        action: FIRST_DRAFT_GAVE_UP_ACTION,
        entity_type: "prospect",
        entity_id: prospectId,
        metadata: { ...metadata, tries: triedBefore + 1, error: result.error.slice(0, 300) },
      });
      if (gaveUpErr) console.warn("[first-draft] gave-up row not recorded:", errMsg(gaveUpErr));
    }
    return;
  }
  out.drafted++;
  const w = await writePitched(db, tenantId, prospectId, now);
  const { error } = await db.from("audit_log").insert({
    tenant_id: tenantId,
    actor_id: null,
    action: FIRST_DRAFT_ACTION,
    entity_type: "prospect",
    entity_id: prospectId,
    metadata: { ...metadata, pitch_id: result.pitch_id, status_moved: w.moved },
  });
  if (error) console.warn("[first-draft] audit row not recorded:", errMsg(error));
  // The draft exists; the next tick moves the prospect to pitched (it has a pitch row now).
  if (w.error) throw new Error(w.error);
}
