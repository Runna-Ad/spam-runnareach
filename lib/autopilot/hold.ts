/**
 * Holding an autopilot-scheduled pitch from the veto digest's "Hold" link.
 *
 * A hold is exactly a person's veto: the pitch goes back to draft with its
 * schedule cleared, and the tick (§5 scheduleAuto) sees "autopilot approved,
 * back in draft" and never re-queues it. It is ONE conditional update guarded
 * on status = 'approved', so it can't flip a row the send-queue has already
 * claimed ('sending') or sent back to draft. (transitionPitchStatusWith is not
 * used: its update has no current-status guard.)
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

export type DigestItem = { pitchId: string; company: string; subject: string };

/**
 * Body of the veto digest. Each line gets its own hold link when a secret is
 * available; without one (no TOKEN_ENCRYPTION_KEY) the lines carry no link and
 * the /pitches route still works.
 */
export function buildVetoDigest(opts: {
  items: DigestItem[];
  tenantId: string;
  sendAt: string;
  windowHours: number;
  appUrl: string;
  secret: string | null;
}): { subject: string; body: string } {
  const { items, tenantId, sendAt, windowHours, secret } = opts;
  const appUrl = opts.appUrl.replace(/\/+$/, "");
  const exp = holdExpiry(sendAt);
  const lines = items.map((s) => {
    const line = `• ${s.company}: "${s.subject}"`;
    if (!secret) return line;
    const token = signHoldToken({ pitchId: s.pitchId, tenantId, exp }, secret);
    return `${line}\n  Hold: ${appUrl}/api/autopilot/hold?t=${encodeURIComponent(token)}`;
  });
  const how = secret
    ? "To hold one, tap its Hold link (or move it back to draft on /pitches) before then."
    : "To hold one, move it back to draft on /pitches before then.";
  return {
    subject: `Autopilot scheduled ${items.length} email${items.length === 1 ? "" : "s"} (sends in ${windowHours}h unless held)`,
    body:
      `These passed every check and will send in about ${windowHours} hours:\n\n` +
      lines.join("\n") +
      `\n\n${how} Holding one counts as a veto; few vetoes over two weeks lets the autopilot send without the wait.\n\n${appUrl}/pitches`,
  };
}
