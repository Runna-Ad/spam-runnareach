// Pitch status rules shared by every writer that moves a pitch, and the one
// "may this prospect be emailed right now" check every send path asks.
//
// Pure apart from the injected client: relative imports only, so the node test
// runner can load it (tests/pitch-status-transitions.test.ts,
// tests/send-path-safety.test.ts).

import { DO_NOT_SEND_STATUSES } from "../prospects/status.ts";
import { isEmailOnDncList, type DncClient } from "../discover/dnc-check.ts";

/** The prod `pitch_status` enum. */
export const PITCH_STATUSES = [
  "draft", "queued_for_approval", "approved", "auto_rejected", "reviewer_rejected",
  "sending", "sent", "bounced", "failed",
] as const;

export type PitchStatusValue = (typeof PITCH_STATUSES)[number];

/** The statuses a person (or the autopilot) may move a pitch to, and from where. */
const ALLOWED_FROM: Readonly<Record<string, readonly PitchStatusValue[]>> = {
  queued_for_approval: ["draft"],
  approved: ["draft", "queued_for_approval"],
  reviewer_rejected: ["draft", "queued_for_approval", "approved", "auto_rejected"],
  draft: ["queued_for_approval", "approved", "reviewer_rejected", "auto_rejected"],
};

/**
 * For the UPDATE's WHERE: `.in("status", allowedFrom(next))`. Nothing moves a
 * pitch out of sending/sent/bounced/failed; an unknown target allows nothing.
 */
export function allowedFrom(next: string): PitchStatusValue[] {
  return [...(ALLOWED_FROM[next] ?? [])];
}

export type TransitionVerdict = "noop" | "allowed" | "refused";

/** Same status → noop (idempotent: a double-click or the autopilot re-approving). */
export function transitionVerdict(current: string, next: string): TransitionVerdict {
  if (current === next) return "noop";
  return allowedFrom(next).includes(current as PitchStatusValue) ? "allowed" : "refused";
}

/** One sentence, shown as-is on /pitches and stored in autopilot_reasons. */
export function transitionRefusedMessage(observed: string): string {
  return `This pitch is now ${observed}; nothing was changed.`;
}

// ── May this prospect be emailed ────────────────────────────────────────────

export type SendBlock = {
  /** do_not_send / dnc: can never send. cooldown: later. unreadable: unknown, retry. */
  kind: "do_not_send" | "dnc" | "cooldown" | "unreadable";
  reason: string;
};

type ProspectStatusRow = { status: string | null; cooldown_until: string | null };

/**
 * Fails closed: a read error or a missing row is "unreadable", never "send".
 * null = the prospect may be emailed.
 */
export function prospectSendBlock(
  row: ProspectStatusRow | null | undefined,
  error: { message?: string } | null | undefined,
  nowIso: string,
): SendBlock | null {
  if (error) {
    return { kind: "unreadable", reason: `Couldn't read the prospect: ${error.message ?? "unknown error"}` };
  }
  if (!row) return { kind: "unreadable", reason: "Prospect not found" };
  if (!row.status) return { kind: "unreadable", reason: "Prospect has no status" };
  if (DO_NOT_SEND_STATUSES.has(row.status)) return { kind: "do_not_send", reason: `Prospect is ${row.status}` };
  if (row.cooldown_until && row.cooldown_until > nowIso) return { kind: "cooldown", reason: "Prospect in cooldown" };
  return null;
}

/** Narrow client shape for the prospect read (callers cast, as with DncClient). */
export type ProspectReadClient = {
  from: (table: string) => {
    select: (cols: string) => {
      eq: (col: string, val: string) => {
        eq: (col: string, val: string) => {
          maybeSingle: () => PromiseLike<{ data: unknown; error: { message?: string } | null }>;
        };
      };
    };
  };
};

export type SendCheckClient = ProspectReadClient & DncClient;

/**
 * The last question before the Gmail call, asked AFTER the claim: re-read the
 * prospect's status + cooldown and re-run the do-not-contact list for the
 * recipient. An opt-out the reply poll recorded since the first read is seen.
 */
export async function recheckBeforeSend(
  db: SendCheckClient,
  args: { tenantId: string; prospectId: string; email: string; nowIso?: string },
): Promise<SendBlock | null> {
  const nowIso = args.nowIso ?? new Date().toISOString();
  const { data, error } = await db
    .from("prospects")
    .select("status, cooldown_until")
    .eq("id", args.prospectId)
    .eq("tenant_id", args.tenantId)
    .maybeSingle();
  const block = prospectSendBlock(data as ProspectStatusRow | null, error, nowIso);
  if (block) return block;
  const dnc = await isEmailOnDncList(db, args.tenantId, args.email);
  if (dnc.blocked) return { kind: "dnc", reason: dnc.reason };
  return null;
}

// ── Releasing a claim ───────────────────────────────────────────────────────

/** Narrow update shape for {@link releaseClaim}. */
export type ReleaseClient = {
  from: (table: string) => {
    update: (payload: Record<string, unknown>) => {
      eq: (col: string, val: string) => {
        eq: (col: string, val: string) => PromiseLike<{ error: unknown }> & {
          eq: (col: string, val: string) => PromiseLike<{ error: unknown }>;
        };
      };
    };
  };
};

export type ReleaseTo = { to: "approved" } | { to: "auto_rejected"; reason: string };

/**
 * Move a claimed pitch out of 'sending' without sending it. Guarded on
 * status = 'sending': a pitch a person rejected (or a run recovered) meanwhile
 * is left alone, never re-approved.
 */
export async function releaseClaim(
  db: ReleaseClient,
  args: { pitchId: string; tenantId?: string } & ReleaseTo,
): Promise<void> {
  const payload =
    args.to === "auto_rejected"
      ? { status: "auto_rejected", auto_rejected: true, auto_rejected_reason: args.reason }
      : { status: "approved" };
  const q = db.from("pitches").update(payload).eq("id", args.pitchId).eq("status", "sending");
  if (args.tenantId) await q.eq("tenant_id", args.tenantId);
  else await q;
}

/** Where the send-queue releases a claim it may not send: can never send → out of the queue. */
export function queueReleaseFor(block: SendBlock): ReleaseTo {
  return block.kind === "do_not_send" || block.kind === "dnc"
    ? { to: "auto_rejected", reason: block.reason }
    : { to: "approved" };
}
