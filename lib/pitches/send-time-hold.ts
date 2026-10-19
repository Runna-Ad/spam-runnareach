/**
 * A doubtful address after an automatic approval (send-queue, send time).
 *
 * SPAM Verify runs again right before a send. A "review" verdict on a pitch a
 * person approved is that person's call and still sends. On a pitch the
 * autopilot approved, the address became doubtful after approval, so the pitch
 * goes back to draft in the review lane for a person, with a reason that starts
 * with HELD_BY_AUTOPILOT (heldAction leaves it alone).
 *
 * Who approved is read from the latest `approved` pitch event. recordPitchEvent
 * is best-effort, so a pitch with no approval event is treated like an
 * automatic one (back to a person), and an unreadable event log means not
 * sent this run.
 *
 * The db is injected so this is tested with fakes (tests/send-path-hardening.test.ts).
 * Its own copy of "was the latest approval the autopilot's" for now:
 * lib/autopilot/hold.ts has another; the conductor unifies them later.
 */

import { HELD_BY_AUTOPILOT } from "../autopilot/governor.ts";

// Untyped like lib/autopilot/hold.ts: pitch_events and the autopilot columns aren't in every generated type.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Db = any;

/** Start of the hold reason; begins with HELD_BY_AUTOPILOT so heldAction leaves the draft alone. */
export const DOUBTFUL_ADDRESS_HOLD = `${HELD_BY_AUTOPILOT}: address doubtful at send time`;

/** The pitch_events columns latestApproval reads (checked against migration 0001 by a test). */
export const APPROVAL_EVENT_COLUMNS = ["tenant_id", "pitch_id", "event_type", "event_at", "payload"] as const;

/** Who gave the pitch's latest approval. "none" = no approval event; "unreadable" = the read failed. */
export type ApprovalSource = "autopilot" | "person" | "none" | "unreadable";

function isAutopilotApproval(payload: unknown): boolean {
  const v = (payload as { autopilot?: unknown } | null)?.autopilot;
  return v === true || v === "true";
}

export async function latestApproval(db: Db, tenantId: string, pitchId: string): Promise<ApprovalSource> {
  const { data, error } = await db
    .from("pitch_events")
    .select("payload, event_at")
    .eq("tenant_id", tenantId)
    .eq("pitch_id", pitchId)
    .eq("event_type", "approved")
    .order("event_at", { ascending: false })
    .limit(1);
  if (error) return "unreadable";
  const row = ((data ?? []) as Array<{ payload: unknown }>)[0];
  if (!row) return "none";
  return isAutopilotApproval(row.payload) ? "autopilot" : "person";
}

/**
 * Send-time SPAM Verify verdict → what the send-queue does. "drop" never
 * sends; "review" sends only when a person approved it, goes back to a person
 * when the autopilot did or nobody is on record, and waits when unreadable.
 */
export function sendTimeVerdictAction(
  verdict: "send" | "review" | "drop",
  approval: ApprovalSource | null,
): "send" | "drop" | "hold" | "skip" {
  if (verdict === "drop") return "drop";
  if (verdict === "send") return "send";
  if (approval === "person") return "send";
  if (approval === "autopilot" || approval === "none") return "hold";
  return "skip";
}

/**
 * Back to draft in the review lane, schedule cleared, guarded on 'approved'
 * (the same fields as lib/autopilot/hold.ts), plus one audit_log `pitch.held`
 * row when it moved. Returns whether the row moved.
 */
export async function holdDoubtfulAutoApproval(
  db: Db,
  args: { tenantId: string; pitchId: string; why: string },
): Promise<boolean> {
  const { data, error } = await db
    .from("pitches")
    .update({
      status: "draft",
      scheduled_send_at: null,
      queued_at: null,
      approved_at: null,
      sender_inbox_id: null,
      autopilot_lane: "review",
      autopilot_reasons: [`${DOUBTFUL_ADDRESS_HOLD} (${args.why})`.slice(0, 300)],
    })
    .eq("id", args.pitchId)
    .eq("tenant_id", args.tenantId)
    .eq("status", "approved")
    .select("id");
  if (error || !Array.isArray(data) || data.length === 0) return false;

  const { error: auditError } = await db.from("audit_log").insert({
    tenant_id: args.tenantId,
    actor_id: null,
    action: "pitch.held",
    entity_type: "pitch",
    entity_id: args.pitchId,
    metadata: { source: "send_time_review", why: args.why.slice(0, 300) },
  });
  if (auditError) console.warn("[send-time-hold] audit not recorded:", auditError.message || "no detail");
  return true;
}
