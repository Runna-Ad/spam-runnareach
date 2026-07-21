// Resolve the contact a pitch should actually use. A pitch stores contact_id at
// generation time, but that FK goes stale — the prospect may gain a usable
// contact afterward (re-enrich, masking fix), or the frozen one may have been a
// name-only/placeholder row. So display + send should resolve the prospect's
// CURRENT top usable contact, not trust the frozen FK.
//
// Plain module (not "use server") — a normal server-side helper.

import type { createClient } from "@/lib/supabase/server";
import { hasUsableEmail } from "@/lib/research/email-utils";

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

/** Fetch the prospect's current top usable contact (for single-pitch send/generate paths). */
export async function fetchTopUsableContact(
  supabase: Awaited<ReturnType<typeof createClient>>,
  tenantId: string,
  prospectId: string,
): Promise<{ id: string; email: string; full_name: string | null } | null> {
  const { data } = await supabase
    .from("prospect_contacts")
    .select("id, email, full_name, priority_rank")
    .eq("tenant_id", tenantId)
    .eq("prospect_id", prospectId)
    .order("priority_rank", { ascending: true })
    .limit(12)
    .returns<(MiniContact & { id: string })[]>();
  const top = pickTopUsableContact(data);
  return top?.email ? { id: top.id, email: top.email, full_name: top.full_name } : null;
}
