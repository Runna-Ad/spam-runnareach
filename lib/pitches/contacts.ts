// Resolve the contact a pitch should actually use. A pitch stores contact_id at
// generation time, but that FK goes stale — the prospect may gain a usable
// contact afterward (re-enrich, masking fix), or the frozen one may have been a
// name-only/placeholder row. So display + send should resolve the prospect's
// CURRENT top usable contact, not trust the frozen FK.
//
// Plain module (not "use server") — a normal server-side helper.

import type { createClient } from "@/lib/supabase/server";
import { hasUsableEmail } from "@/lib/research/email-utils";
import { storedVerdictUsable } from "@/lib/research/verify-recipient";

export type MiniContact = {
  id?: string;
  email: string | null;
  full_name: string | null;
  priority_rank?: number | null;
  /** How the address was obtained — 'scraper', 'anymail', 'hunter', 'manual'… */
  selected_by?: string | null;
};

/**
 * True when the address was never verified — a firstname@domain GUESS kept only
 * because the domain is catch-all (so it can't hard-bounce). It may still go
 * nowhere. Surfaced in the UI so a human never approves a guess believing it's
 * a confirmed contact.
 */
export function isGuessedContact(selectedBy: string | null | undefined): boolean {
  return selectedBy === "snapverify_catchall_guess";
}

/** Pick the highest-priority contact that has a usable email, from an in-memory list. */
export function pickTopUsableContact<T extends MiniContact>(
  contacts: T[] | null | undefined,
): T | null {
  if (!contacts || contacts.length === 0) return null;
  const sorted = [...contacts].sort(
    (a, b) => (a.priority_rank ?? 99) - (b.priority_rank ?? 99),
  );
  return sorted.find((c) => hasUsableEmail(c.email)) ?? null;
}

/** A contact with the verifier's stored verdict (prospect_contacts.verify_*). */
export type VerdictContact = MiniContact & {
  verify_verdict?: "send" | "review" | "drop" | null;
  verify_checked_at?: string | null;
};

/**
 * The verifier's stored verdict on this contact when it still counts (within
 * VERDICT_TTL_MS, lib/research/verify-recipient.ts storedVerdictUsable), and
 * it is a bad one: "drop" (will not deliver) or "review" (unsure). A stale or
 * missing verdict is no verdict.
 */
export function badStoredVerdict(c: VerdictContact, now: Date): "drop" | "review" | null {
  const v = c.verify_verdict ?? null;
  if (v !== "drop" && v !== "review") return null;
  return storedVerdictUsable({ verdict: v, checkedAt: c.verify_checked_at ?? null, selectedBy: c.selected_by ?? null }, now) ? v : null;
}

/**
 * The ONE rule for "which contact does a new pitch go to" once verdicts are
 * known. In priority order, the first usable contact the verifier has not
 * flagged; failing that, the first usable one it is only unsure about
 * ("review": a person can still decide in the review lane); failing that,
 * the same contact as pickTopUsableContact (no alternative, nothing changes).
 */
export function chooseRecipient<T extends VerdictContact>(contacts: T[] | null | undefined, now: Date): T | null {
  if (!contacts || contacts.length === 0) return null;
  const usable = [...contacts]
    .sort((a, b) => (a.priority_rank ?? 99) - (b.priority_rank ?? 99))
    .filter((c) => hasUsableEmail(c.email));
  return (
    usable.find((c) => badStoredVerdict(c, now) === null) ??
    usable.find((c) => badStoredVerdict(c, now) === "review") ??
    usable[0] ??
    null
  );
}

/**
 * Would a new draft go to someone other than `currentContactId`, someone the
 * verifier has not flagged? Asks chooseRecipient, the same rule the next
 * draft's recipient comes from, so a "yes" here is the contact it will pick.
 */
export function hasAlternativeRecipient(
  contacts: Array<VerdictContact & { id: string }> | null | undefined,
  currentContactId: string | null,
  now: Date,
): boolean {
  const next = chooseRecipient(contacts, now);
  if (!next || next.id === currentContactId || badStoredVerdict(next, now) !== null) return false;
  const current = (contacts ?? []).find((c) => c.id === currentContactId);
  // A duplicate row for the same address is not another person.
  return !current?.email || current.email.trim().toLowerCase() !== (next.email ?? "").trim().toLowerCase();
}

/**
 * Who an existing pitch goes to, for display: its own contact (contact_id)
 * when that address is usable, else the prospect's pick (chooseRecipient), the
 * same resolution as the manual send (send-action.ts) and the address the
 * send-queue uses.
 */
export function pitchRecipient<T extends VerdictContact & { id?: string }>(
  contacts: T[] | null | undefined,
  contactId: string | null | undefined,
  now: Date,
): T | null {
  const own = contactId ? (contacts ?? []).find((c) => c.id === contactId) : undefined;
  return own && hasUsableEmail(own.email) ? own : chooseRecipient(contacts, now);
}

/** The columns chooseRecipient reads, for every query that feeds it. */
export const RECIPIENT_COLUMNS = "id, email, full_name, priority_rank, selected_by, verify_verdict, verify_checked_at";

/**
 * Fetch the contact a pitch for this prospect goes to (chooseRecipient), for
 * the single-pitch send/generate paths: the autopilot, the manual "Generate
 * pitch" button and the manual send's fallback when the pitch's own contact
 * has no usable address.
 */
export async function fetchTopUsableContact(
  supabase: Awaited<ReturnType<typeof createClient>>,
  tenantId: string,
  prospectId: string,
  now: Date = new Date(),
): Promise<{ id: string; email: string; full_name: string | null; selected_by: string | null } | null> {
  const { data } = await supabase
    .from("prospect_contacts")
    .select(RECIPIENT_COLUMNS)
    .eq("tenant_id", tenantId)
    .eq("prospect_id", prospectId)
    .order("priority_rank", { ascending: true })
    .limit(12)
    .returns<(VerdictContact & { id: string })[]>();
  const top = chooseRecipient(data, now);
  return top?.email
    ? { id: top.id, email: top.email, full_name: top.full_name, selected_by: top.selected_by ?? null }
    : null;
}
