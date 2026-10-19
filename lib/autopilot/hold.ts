/**
 * Holding an autopilot-scheduled pitch from the veto digest's "Hold" link.
 *
 * A hold is exactly a person's veto: the pitch goes back to draft with its
 * schedule cleared, and the tick (§5 scheduleAuto) sees "autopilot approved,
 * back in draft" and never re-queues it. It is ONE conditional update guarded
 * on status = 'approved', so it can't flip a row the send-queue has already
 * claimed ('sending') or sent back to draft. (It stays separate from
 * transitionPitchStatusWith, which is guarded too since batch 3, because a hold
 * also clears the schedule and writes the hold reason in the same update.)
 *
 * The db is injected so the logic is tested with a fake (tests/autopilot-hold.test.ts).
 * The route (app/api/autopilot/hold) passes the service-role client, behind a
 * verified token.
 *
 * holdAutoApprovals is the autopilot's own version, run by the tick's stage
 * step when the stage drops to shadow or off: the same fields, the same guard,
 * its own reason (HELD_BY_AUTOPILOT). Tested in tests/bounce-incident.test.ts.
 *
 * Two more db steps of the tick live here so they run against the test fake
 * (tick.ts itself can't be imported by the node test runner):
 * stageQualityTrips, the stage step's breaker count (only QUALITY trips,
 * governor BREAKER_KIND, count against the stage), and relabelFinderDrafts,
 * §5's guard against approving on a pre-2026-10-19 AUTO label. Tested in
 * tests/bounce-incident.test.ts.
 */

import { isFinderSource } from "../research/verify-recipient.ts";
import { HELD_BY_AUTOPILOT, HELD_BY_PERSON, isQualityBreaker, type Stage } from "./governor.ts";
import { holdExpiry, signHoldToken, type HoldPayload } from "./hold-token.ts";

// Untyped like tick.ts: the autopilot columns aren't in every generated type.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Db = any;

/** Starts with HELD_BY_PERSON so §4 resolveHeld (heldAction) leaves the draft alone. */
export const HOLD_REASON = `${HELD_BY_PERSON} from the digest link`;

/** What every hold writes: back to draft, schedule cleared, review lane for good. */
function heldFields(reason: string) {
  return {
    status: "draft",
    scheduled_send_at: null,
    queued_at: null,
    sender_inbox_id: null,
    autopilot_lane: "review",
    autopilot_reasons: [reason],
  };
}

export type HoldState = "holdable" | "already_sent" | "sending" | "already_held" | "not_scheduled" | "not_found";

export type HoldTarget = {
  state: HoldState;
  company: string;
  subject: string;
  scheduledSendAt: string | null;
};

/** "try_again": the row read 'approved' after our guarded update matched nothing (a race with the send-queue). */
export type HoldResult = { state: "held" | "try_again" | Exclude<HoldState, "holdable">; target: HoldTarget | null };

/** What a hold would do to a pitch in this status. */
export function holdStateFor(status: string | null | undefined): HoldState {
  switch (status) {
    case "approved":
      return "holdable";
    case "sending":
      return "sending";
    case "sent":
    case "bounced":
      return "already_sent";
    case "draft":
      return "already_held";
    case undefined:
    case null:
      return "not_found";
    default:
      return "not_scheduled";
  }
}

/** Read-only: the pitch the token names, and whether a hold would apply. Never writes. */
export async function loadHoldTarget(db: Db, payload: HoldPayload): Promise<HoldTarget> {
  const { data } = await db
    .from("pitches")
    .select("id, status, subject, scheduled_send_at, prospects:prospect_id(company_name)")
    .eq("id", payload.pitchId)
    .eq("tenant_id", payload.tenantId)
    .maybeSingle();
  const row = data as {
    status: string;
    subject: string | null;
    scheduled_send_at: string | null;
    prospects: { company_name: string | null } | null;
  } | null;
  if (!row) return { state: "not_found", company: "", subject: "", scheduledSendAt: null };
  return {
    state: holdStateFor(row.status),
    company: row.prospects?.company_name ?? "",
    subject: row.subject ?? "",
    scheduledSendAt: row.scheduled_send_at,
  };
}

/**
 * Hold the pitch: approved → draft, schedule cleared, review lane for good.
 * Only an 'approved' row changes; anything else is reported, never touched.
 */
export async function holdPitch(db: Db, payload: HoldPayload): Promise<HoldResult> {
  const { data, error } = await db
    .from("pitches")
    .update(heldFields(HOLD_REASON))
    .eq("id", payload.pitchId)
    .eq("tenant_id", payload.tenantId)
    .eq("status", "approved")
    .select("id");
  if (error) throw new Error(`hold failed: ${error.message}`);

  if (Array.isArray(data) && data.length > 0) {
    const { error: auditError } = await db.from("audit_log").insert({
      tenant_id: payload.tenantId,
      actor_id: null,
      action: "pitch.held",
      entity_type: "pitch",
      entity_id: payload.pitchId,
      metadata: { source: "digest_link" },
    });
    if (auditError) console.warn("[autopilot-hold] audit not recorded:", auditError.message);
    return { state: "held", target: null };
  }

  // Nothing changed: say why. A row that reads 'approved' here was claimed by
  // the send-queue during our update and put back (approved → sending →
  // approved); it isn't held, so say so and ask for another try.
  const target = await loadHoldTarget(db, payload);
  return { state: target.state === "holdable" ? "try_again" : target.state, target };
}

// ── Demotion: pull back automatic approvals ──────────────────────────────────

/**
 * Stages that never send automatically. The send-queue sends every approved
 * pitch whatever the stage, so dropping to one of these must also pull back
 * the automatic approvals still waiting (2026-10-19: 9 stayed scheduled after
 * veto → shadow and had to be held by hand).
 */
export function pullsBackApprovals(stage: Stage): boolean {
  return stage === "shadow" || stage === "off";
}

/** The reason a pulled-back pitch carries. Starts with HELD_BY_AUTOPILOT, never HELD_BY_PERSON. */
export function demotionHoldReason(stage: Stage): string {
  return `${HELD_BY_AUTOPILOT}: stage dropped to ${stage}`;
}

/** The reason a pitch pulled back by the kill switch carries (same prefix: a person's call next). */
export const KILL_SWITCH_HOLD_REASON = `${HELD_BY_AUTOPILOT}: autopilot switched off`;

export type PullbackResult = { held: number; error: string | null };

const PULLBACK_CHUNK = 100;
const detail = (e: { message?: string } | null | undefined) => e?.message || "no detail";
const chunks = <T,>(xs: T[], n: number): T[][] => Array.from({ length: Math.ceil(xs.length / n) }, (_, i) => xs.slice(i * n, i * n + n));

/** The approval event's payload says the autopilot made it (pitch-stage records `autopilot: actor.system`). */
function isAutopilotApproval(payload: unknown): boolean {
  const v = (payload as { autopilot?: unknown } | null)?.autopilot;
  return v === true || v === "true";
}

/**
 * Hold every automatic approval still waiting to send: status 'approved', lane
 * 'auto', not sent, and the pitch's LATEST approval was the autopilot's. A pitch
 * a person approved by hand is never touched. Same guarded update as holdPitch
 * (only rows still 'approved', so never one the send-queue has claimed), one
 * pitch.held audit row per pitch (source 'demotion'). Idempotent: a second run
 * finds nothing to hold.
 */
export async function holdAutoApprovals(
  db: Db,
  tenantId: string,
  stage: Stage,
  reason: string = demotionHoldReason(stage),
): Promise<PullbackResult> {
  const { data: rows, error } = await db
    .from("pitches")
    .select("id")
    .eq("tenant_id", tenantId)
    .eq("status", "approved")
    .eq("autopilot_lane", "auto")
    .is("sent_at", null)
    .limit(1000);
  if (error) return { held: 0, error: `approved pitches: ${detail(error)}` };
  const ids = ((rows ?? []) as Array<{ id: string }>).map((r) => r.id);

  let held = 0;
  for (const part of chunks(ids, PULLBACK_CHUNK)) {
    const { data: events, error: eventsError } = await db
      .from("pitch_events")
      .select("pitch_id, payload, event_at")
      .eq("tenant_id", tenantId)
      .eq("event_type", "approved")
      .in("pitch_id", part)
      .order("event_at", { ascending: true });
    if (eventsError) return { held, error: `approval events: ${detail(eventsError)}` };
    // Oldest first, so the last write per pitch is its latest approval.
    const latestIsAutopilot = new Map<string, boolean>();
    for (const e of (events ?? []) as Array<{ pitch_id: string; payload: unknown }>) {
      latestIsAutopilot.set(e.pitch_id, isAutopilotApproval(e.payload));
    }
    const automatic = part.filter((id) => latestIsAutopilot.get(id) === true);
    if (automatic.length === 0) continue;

    const { data: updated, error: updateError } = await db
      .from("pitches")
      .update(heldFields(reason))
      .eq("tenant_id", tenantId)
      .in("id", automatic)
      .eq("status", "approved")
      .eq("autopilot_lane", "auto")
      .is("sent_at", null)
      .select("id");
    if (updateError) return { held, error: `hold: ${detail(updateError)}` };
    const heldIds = ((updated ?? []) as Array<{ id: string }>).map((r) => r.id);
    held += heldIds.length;
    if (heldIds.length === 0) continue;

    const { error: auditError } = await db.from("audit_log").insert(
      heldIds.map((id) => ({
        tenant_id: tenantId,
        actor_id: null,
        action: "pitch.held",
        entity_type: "pitch",
        entity_id: id,
        metadata: { source: "demotion", stage },
      })),
    );
    if (auditError) console.warn("[autopilot-hold] demotion audit not recorded:", detail(auditError));
  }
  return { held, error: null };
}

/**
 * QUALITY breaker trips recorded since `sinceIso` (the stage's start): the
 * codes of the breaker insights (kind 'breaker', evidence = the BreakerTrip)
 * that governor.isQualityBreaker counts, oldest first ("unknown" for evidence
 * without a code). Delivery trips (bounces, Gmail, DNS, placement) pause
 * sending but never count here. Throws when the insights can't be read, so the
 * stage step skips the tick instead of reading 0.
 */
export async function stageQualityTrips(db: Db, tenantId: string, sinceIso: string): Promise<string[]> {
  const { data, error } = await db
    .from("learning_insights")
    .select("evidence, created_at")
    .eq("tenant_id", tenantId)
    .eq("kind", "breaker")
    .gte("created_at", sinceIso)
    .order("created_at", { ascending: true })
    .limit(1000);
  if (error) throw new Error(`breaker insights: ${detail(error)}`);
  return ((data ?? []) as Array<{ evidence: { code?: unknown } | null }>)
    .filter((r) => isQualityBreaker(r.evidence?.code))
    .map((r) => (typeof r.evidence?.code === "string" ? r.evidence.code : "unknown"));
}

/**
 * §5 scheduleAuto, before approving: a draft labelled AUTO before finder
 * addresses needed a person (2026-10-19) still carries that label, so never
 * approve on it. Its label is cleared (draft rows only) so §4 labels it again
 * on today's rules, which re-verify (verify-recipient.ts). Returns the ids the
 * caller must not approve this tick; throws when the recipient sources can't
 * be read (approve nothing).
 */
export async function relabelFinderDrafts(
  db: Db,
  tenantId: string,
  candidates: ReadonlyArray<{ id: string; contact_id: string | null }>,
): Promise<Set<string>> {
  const relabel = new Set<string>();
  const contactIds = [...new Set(candidates.map((c) => c.contact_id).filter((id): id is string => !!id))];
  if (contactIds.length === 0) return relabel;
  const { data: contacts, error } = await db
    .from("prospect_contacts")
    .select("id, selected_by")
    .eq("tenant_id", tenantId)
    .in("id", contactIds);
  if (error) throw new Error(`recipient sources: ${detail(error)}`);
  const finder = new Set(
    ((contacts ?? []) as Array<{ id: string; selected_by: string | null }>).filter((c) => isFinderSource(c.selected_by)).map((c) => c.id),
  );
  for (const c of candidates) if (c.contact_id && finder.has(c.contact_id)) relabel.add(c.id);
  if (relabel.size) {
    await db
      .from("pitches")
      .update({ autopilot_lane: null, autopilot_reasons: null })
      .in("id", [...relabel])
      .eq("tenant_id", tenantId)
      .eq("status", "draft");
  }
  return relabel;
}

/** The line the stage-change email carries about the pull-back. */
export function pullbackSentence(r: PullbackResult): string {
  const n = r.held;
  const pulled =
    n === 0
      ? "No automatic emails were waiting to send."
      : `Pulled back ${n} automatic email${n === 1 ? "" : "s"} that ${n === 1 ? "was" : "were"} approved and waiting to send: ` +
        `${n === 1 ? "it is" : "they are"} back in drafts (review lane) for a person to approve or drop.`;
  if (!r.error) return pulled;
  const failed = `(${r.error}): any still approved will send. Check /pitches now.`;
  return n === 0
    ? `Could not pull back the automatic emails waiting to send ${failed}`
    : `${pulled} Could not pull back the rest ${failed}`;
}

// ── The veto digest ──────────────────────────────────────────────────────────

export type DigestItem = { pitchId: string; company: string; subject: string; sendAt: string };

/**
 * The veto digest goes out twice a day, not once per scheduling tick (Pedro,
 * 2026-10-18: 18 digests in one day was too many). Slots are 01:00 and 13:00 UTC
 * = 19:00 and 07:00 Mexico City (no DST). Twelve hours apart is below the 18h veto
 * window, so every scheduled email is listed in at least one digest before it can
 * send; a missed slot is caught up by the next tick.
 */
export const DIGEST_SLOTS_UTC: readonly number[] = [1, 13];
/** Veto stage: how long a person has to hold an AUTO pitch before it sends. Must stay above the 12h slot gap. */
export const VETO_WINDOW_HOURS = 18;
/** A digest lists every approved email scheduled within this many hours, overdue ones included. */
export const DIGEST_HORIZON_HOURS = 24;

/** The most recent digest slot at or before `now`. */
export function lastDigestSlot(now: Date): Date {
  const day = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  for (let d = 0; d <= 1; d++) {
    for (const h of [...DIGEST_SLOTS_UTC].sort((a, b) => b - a)) {
      const t = day - d * 86_400_000 + h * 3_600_000;
      if (t <= now.getTime()) return new Date(t);
    }
  }
  return new Date(day - 86_400_000);
}

/** Due when no digest was recorded at or after the most recent slot. */
export function digestDue(now: Date, lastDigestAt: string | null): boolean {
  if (!lastDigestAt) return true;
  return new Date(lastDigestAt).getTime() < lastDigestSlot(now).getTime();
}

const when = (iso: string) => `${new Date(iso).toISOString().slice(0, 16).replace("T", " ")} UTC`;

/**
 * Body of the veto digest. Each line gets its own hold link when a secret is
 * available; without one (no TOKEN_ENCRYPTION_KEY) the lines carry no link and
 * the /pitches route still works.
 */
export function buildVetoDigest(opts: {
  items: DigestItem[];
  tenantId: string;
  appUrl: string;
  secret: string | null;
  now?: Date;
}): { subject: string; body: string } {
  const { items, tenantId, secret } = opts;
  const nowMs = (opts.now ?? new Date()).getTime();
  const appUrl = opts.appUrl.replace(/\/+$/, "");
  const lines = items.map((s) => {
    const line = `• ${s.company}: "${s.subject}" (scheduled ${when(s.sendAt)})`;
    if (!secret) return line;
    // An overdue email (waiting for sending hours) keeps a live link: expiry counts from now.
    const exp = holdExpiry(new Date(Math.max(Date.parse(s.sendAt), nowMs)));
    const token = signHoldToken({ pitchId: s.pitchId, tenantId, exp }, secret);
    return `${line}\n  Hold: ${appUrl}/api/autopilot/hold?t=${encodeURIComponent(token)}`;
  });
  const how = secret
    ? "To hold one, tap its Hold link (or move it back to draft on /pitches) before it sends."
    : "To hold one, move it back to draft on /pitches before it sends.";
  return {
    subject: `Autopilot: ${items.length} email${items.length === 1 ? "" : "s"} will send in the next ${DIGEST_HORIZON_HOURS}h unless held`,
    body:
      `These passed every check and are scheduled to send in the next ${DIGEST_HORIZON_HOURS} hours. ` +
      `Sending runs every 10 minutes 15:00–23:00 UTC, Monday to Friday only; anything scheduled outside those hours goes out the next time sending runs.\n\n` +
      lines.join("\n") +
      `\n\n${how} Holding one counts as a veto; few vetoes over two weeks lets the autopilot send without the wait.\n\n${appUrl}/pitches`,
  };
}
