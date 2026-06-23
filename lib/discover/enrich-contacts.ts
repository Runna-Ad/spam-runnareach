// Contact enrichment waterfall — shared by the pipeline (pipeline-action.ts)
// and bulk re-score (bulk-actions.ts). Plain module (NOT "use server") so it can
// be imported as a normal server-side helper without becoming a public action.

import type { createClient } from "@/lib/supabase/server";
import { anymailFindDecisionMaker } from "@/lib/research/anymail-finder";
import { hunterDomainSearch } from "@/lib/research/hunter";
import { snapVerifyEnrich } from "@/lib/research/snap-contact";
import { isRoleBasedEmail } from "@/lib/research/email-utils";

/**
 * Contact enrichment for a single prospect (call only for score ≥ 70):
 *
 *   When skipSnapVerify=false (e.g. re-enrich / bulk re-score):
 *     Tier 1 — SnapVerify (free) → Tier 2 — Anymail → Tier 3 — Hunter
 *
 *   When skipSnapVerify=true (pipeline path — SnapVerify already ran in Pass 1):
 *     Tier 2 — Anymail → Tier 3 — Hunter
 *
 * Short-circuits on first success — each tier preserves the next tier's credits.
 * Duplicate inserts (23505) are silently ignored.
 */
export async function enrichContactsForProspect(
  tenantId: string,
  prospectId: string,
  domain: string,
  companyName: string,
  supabase: Awaited<ReturnType<typeof createClient>>,
  skipSnapVerify = false,
): Promise<void> {
  // A catch-all-domain best-guess (firstname@domain). Captured from SnapVerify
  // but only used as the LAST resort, after the verified finders fail.
  let catchAllGuess: { email: string; full_name: string | null; role_title: string | null } | null = null;

  if (!skipSnapVerify) {
    // ── Tier 1: SnapVerify (SMTP-verified only — 3 passes) ───────────────────
    type ResearchRow = { notes: string | null; what_they_do: string | null };
    const { data: research } = await supabase
      .from("prospect_research")
      .select("notes, what_they_do")
      .eq("prospect_id", prospectId)
      .eq("tenant_id", tenantId)
      .maybeSingle<ResearchRow>();

    const snapResult = await snapVerifyEnrich(
      prospectId,
      domain,
      research?.notes ?? null,
      research?.what_they_do ?? null,
      companyName,
    );

    if (snapResult.found) {
      // SMTP-verified, real personal email — best possible, short-circuit.
      await supabase.from("prospect_contacts").insert({
        tenant_id: tenantId,
        prospect_id: prospectId,
        email: snapResult.email,
        full_name: snapResult.full_name ?? null,
        role_title: snapResult.role_title ?? null,
        email_is_role_based: isRoleBasedEmail(snapResult.email),
        priority_rank: isRoleBasedEmail(snapResult.email) ? 5 : 1,
        selected_by: "snapverify_smtp",
        selected_at: new Date().toISOString(),
      });
      return;
    }
    // Not verified — remember the catch-all guess (if any) for the last resort.
    catchAllGuess = snapResult.catchAllGuess ?? null;
  }

  // ── Tier 2: Anymail Finder (verified) ─────────────────────────────────────
  const anymailResult = await anymailFindDecisionMaker(domain);
  if (anymailResult.ok) {
    const c = anymailResult.contact;
    const roleBased = isRoleBasedEmail(c.email);
    await supabase.from("prospect_contacts").insert({
      tenant_id: tenantId,
      prospect_id: prospectId,
      email: c.email,
      full_name: c.full_name ?? null,
      role_title: c.job_title ?? null,
      linkedin_url: c.linkedin_url ?? null,
      email_is_role_based: roleBased,
      // A role inbox (info@, sales@) ranks below any personal address.
      priority_rank: roleBased ? 5 : 1,
      selected_by: "anymail",
      selected_at: new Date().toISOString(),
    });
    return; // short-circuit — Anymail found someone, skip Hunter
  }

  // ── Tier 3: Hunter.io (verified) ──────────────────────────────────────────
  const hunterResult = await hunterDomainSearch(domain);
  if (hunterResult.ok && hunterResult.contacts.length > 0) {
    for (const contact of hunterResult.contacts) {
      const roleBased = isRoleBasedEmail(contact.email);
      // Hunter's domain sweep often returns info@/contact@ — rank those below
      // any personal hit so a real decision-maker is preferred when present.
      const rank = roleBased ? 5 : contact.confidence >= 70 ? 2 : 3;
      await supabase.from("prospect_contacts").insert({
        tenant_id: tenantId,
        prospect_id: prospectId,
        email: contact.email,
        full_name:
          contact.first_name || contact.last_name
            ? [contact.first_name, contact.last_name].filter(Boolean).join(" ")
            : null,
        role_title: contact.position ?? null,
        email_is_role_based: roleBased,
        priority_rank: rank,
        selected_by: "hunter",
        selected_at: new Date().toISOString(),
      });
    }
    return; // Hunter found at least one — done.
  }

  // ── Last resort: catch-all best guess ─────────────────────────────────────
  // Every verified path failed. On a CATCH-ALL domain the server accepts all
  // mail, so this firstname@domain guess can't hard-bounce — keep it, clearly
  // flagged (selected_by='snapverify_catchall_guess') and low priority, so the
  // UI can mark it "guess". On a non-catch-all domain we keep nothing (a wrong
  // address there would bounce) → the prospect stays "no contact".
  if (catchAllGuess) {
    await supabase.from("prospect_contacts").insert({
      tenant_id: tenantId,
      prospect_id: prospectId,
      email: catchAllGuess.email,
      full_name: catchAllGuess.full_name,
      role_title: catchAllGuess.role_title,
      email_is_role_based: isRoleBasedEmail(catchAllGuess.email),
      priority_rank: 4,
      selected_by: "snapverify_catchall_guess",
      selected_at: new Date().toISOString(),
    });
  }
}
