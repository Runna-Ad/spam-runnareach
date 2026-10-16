/**
 * Checks every send path runs immediately before emailing a prospect.
 *
 * The crons run hours apart (reply poll 13:xx, follow-ups 16:xx, nudges 17:xx),
 * so "has this person written back?" must be asked of Gmail right before the
 * send, not of whatever the last poll imported. And a prospect gets ONE first
 * email: regenerated drafts and duplicate prospect rows must not produce a second.
 */

import { fetchThreadReplies } from "../gmail/read.ts";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnySupabase = any;

/** Intents that mean a person engaged — never follow up over these. */
const ENGAGED_INTENTS = new Set(["wants_meeting", "wants_info", "not_now", "wrong_person", "unclassified", "hard_no"]);

/**
 * Reason not to send into this thread, or null when it's safe. Fails closed:
 * if Gmail can't be read we don't know, so we don't send.
 *
 * mode "followup": any inbound the poll hasn't processed, or any imported reply
 *   from a person, blocks (a follow-up assumes silence).
 * mode "unseen_only": only messages the poll hasn't processed block — a nudge
 *   always follows a known reply, so that reply can't be the reason to stop.
 */
export async function threadBlocksSend(
  supabase: AnySupabase,
  accessToken: string,
  args: {
    tenantId: string;
    threadId: string;
    ourEmail: string;
    sinceIso: string | null;
    mode?: "followup" | "unseen_only";
  },
): Promise<string | null> {
  const fetched = await fetchThreadReplies(accessToken, args.threadId, [args.ourEmail]);
  if (!fetched.ok) return `Couldn't read the Gmail thread before sending (${fetched.error})`;

  const sinceMs = args.sinceIso ? Date.parse(args.sinceIso) - 60_000 : 0;
  const inbound = fetched.replies.filter((r) => r.internalDate >= sinceMs);
  if (inbound.length === 0) return null;

  const { data, error } = await supabase
    .from("replies")
    .select("gmail_message_id, intent")
    .eq("tenant_id", args.tenantId)
    .in("gmail_message_id", inbound.map((r) => r.gmailMessageId));
  if (error) return `Couldn't check imported replies (${error.message})`;

  const known = new Map<string, string | null>(
    (data ?? []).map((r: { gmail_message_id: string; intent: string | null }) => [r.gmail_message_id, r.intent]),
  );
  if (inbound.some((r) => !known.has(r.gmailMessageId))) {
    return "New message in the thread the reply poll hasn't processed yet";
  }
  if (args.mode !== "unseen_only" && [...known.values()].some((intent) => intent && ENGAGED_INTENTS.has(intent))) {
    return "The prospect already replied in this thread";
  }
  return null;
}

/** Escape LIKE wildcards so "john_doe@x.com" can't match "johnXdoe@x.com". */
function likeLiteral(value: string): string {
  return value.replace(/[\\%_]/g, (c) => `\\${c}`);
}

/**
 * Reason this first email would be a duplicate, or null. Checks the prospect
 * (any other first email already sent) and the address (sent to on any
 * prospect row — duplicates of the same company exist).
 */
export async function firstTouchConflict(
  supabase: AnySupabase,
  args: { tenantId: string; prospectId: string; pitchId: string; email: string },
): Promise<string | null> {
  const { data: sameProspect } = await supabase
    .from("pitches")
    .select("id")
    .eq("tenant_id", args.tenantId)
    .eq("prospect_id", args.prospectId)
    .is("parent_pitch_id", null)
    .not("sent_at", "is", null)
    .neq("id", args.pitchId)
    .limit(1);
  if (sameProspect && sameProspect.length > 0) {
    return `This prospect already got a first email (pitch ${sameProspect[0].id})`;
  }

  const { data: contacts } = await supabase
    .from("prospect_contacts")
    .select("id")
    .eq("tenant_id", args.tenantId)
    .ilike("email", likeLiteral(args.email.trim()));
  const contactIds = (contacts ?? []).map((c: { id: string }) => c.id);
  if (contactIds.length === 0) return null;

  const { data: sameAddress } = await supabase
    .from("pitches")
    .select("id")
    .eq("tenant_id", args.tenantId)
    .in("contact_id", contactIds)
    .not("sent_at", "is", null)
    .neq("id", args.pitchId)
    .limit(1);
  if (sameAddress && sameAddress.length > 0) {
    return `${args.email} was already emailed (pitch ${sameAddress[0].id})`;
  }
  return null;
}
