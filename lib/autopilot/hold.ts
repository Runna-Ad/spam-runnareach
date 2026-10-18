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
 */

import { HELD_BY_PERSON } from "./governor.ts";
import { holdExpiry, signHoldToken, type HoldPayload } from "./hold-token.ts";

// Untyped like tick.ts: the autopilot columns aren't in every generated type.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Db = any;

/** Starts with HELD_BY_PERSON so §4 resolveHeld (heldAction) leaves the draft alone. */
export const HOLD_REASON = `${HELD_BY_PERSON} from the digest link`;

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
    .update({
      status: "draft",
      scheduled_send_at: null,
      queued_at: null,
      sender_inbox_id: null,
      autopilot_lane: "review",
      autopilot_reasons: [HOLD_REASON],
    })
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
      `Sending runs every 10 minutes 15:00–23:00 UTC on weekdays and once around 15:00 UTC on weekends; anything scheduled outside those hours goes out the next time sending runs.\n\n` +
      lines.join("\n") +
      `\n\n${how} Holding one counts as a veto; few vetoes over two weeks lets the autopilot send without the wait.\n\n${appUrl}/pitches`,
  };
}
