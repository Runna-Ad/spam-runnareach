/**
 * Record that someone asked us to stop emailing them.
 *
 * One routine for every opt-out source (the unsubscribe link, one-click
 * List-Unsubscribe, an "unsubscribe"/"no me interesa" reply) so they all do the
 * same four things:
 *   1. the ADDRESS goes on do_not_contact_list — the permanent block every send
 *      path checks, which also covers duplicate prospect rows;
 *   2. the prospect is suppressed (won/booked/lost keep their outcome status —
 *      the DNC entry already stops the email);
 *   3. every follow-up sequence for the prospect stops;
 *   4. an audit row records when and how.
 *
 * CASL requires opt-outs to take effect within 10 business days; this makes it
 * immediate. Called with a service-role client (the link has no login).
 */

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnySupabase = any;

import { recordPitchEvent } from "../pitches/events.ts";
import { latestRootSentPitchId } from "../pitches/root-pitch.ts";

export type OptOutSource = "unsubscribe_link" | "one_click" | "reply";

export async function recordOptOut(
  supabase: AnySupabase,
  args: { tenantId: string; prospectId: string | null; email: string; source: OptOutSource; note?: string },
): Promise<{ ok: true } | { ok: false; error: string }> {
  const email = args.email.trim().toLowerCase();
  const now = new Date();

  // 1. Address-level block. This is the part that must not fail silently.
  const { data: existing, error: lookupErr } = await supabase
    .from("do_not_contact_list")
    .select("id")
    .eq("tenant_id", args.tenantId)
    .eq("email", email)
    .limit(1);
  if (lookupErr) return { ok: false, error: `DNC lookup failed: ${lookupErr.message}` };
  if (!existing || existing.length === 0) {
    const { error: insertErr } = await supabase.from("do_not_contact_list").insert({
      tenant_id: args.tenantId,
      entry_type: "unsubscribed",
      email,
      notes: `Opted out via ${args.source} on ${now.toISOString().slice(0, 10)}.${args.note ? ` ${args.note}` : ""}`,
    });
    if (insertErr) return { ok: false, error: `DNC insert failed: ${insertErr.message}` };
  }

  if (args.prospectId) {
    // 2. Suppress — but keep a real outcome (won/booked/lost) visible.
    await supabase
      .from("prospects")
      .update({
        status: "suppressed",
        suppressed_at: now.toISOString(),
        suppressed_reason: `Opted out (${args.source})`,
        cooldown_until: new Date(now.getTime() + 10 * 365 * 24 * 60 * 60 * 1000).toISOString(),
      })
      .eq("id", args.prospectId)
      .eq("tenant_id", args.tenantId)
      .not("status", "in", "(won,booked,lost)");

    // 3. Stop every sequence for this prospect.
    await supabase
      .from("pitches")
      .update({ sequence_paused_at: now.toISOString(), next_followup_at: null })
      .eq("prospect_id", args.prospectId)
      .eq("tenant_id", args.tenantId)
      .is("sequence_paused_at", null);
  }

  // 4. The pitch timeline: which email this opt-out answered (the latest sent
  // first-touch to this prospect). Best effort, like the audit row.
  if (args.prospectId) {
    try {
      const rootId = await latestRootSentPitchId(supabase, { tenantId: args.tenantId, prospectId: args.prospectId });
      if (rootId) {
        await recordPitchEvent(supabase, {
          tenantId: args.tenantId,
          pitchId: rootId,
          type: "unsubscribe",
          payload: { source: args.source },
        });
      }
    } catch {
      /* evidence, not a dependency */
    }
  }

  // 5. Audit (best effort).
  await supabase.from("audit_log").insert({
    tenant_id: args.tenantId,
    actor_id: null,
    action: "prospect.opted_out",
    entity_type: "prospect",
    entity_id: args.prospectId ?? args.tenantId,
    metadata: { email, source: args.source, note: args.note ?? null },
  });

  return { ok: true };
}
