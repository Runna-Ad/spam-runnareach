// ONE lookup for "the conversation's root pitch".
//
// Follow-ups are child rows (parent_pitch_id set) and are also status = 'sent' with a
// later sent_at, so "latest sent pitch" picks the wrong row for any prospect who got a
// follow-up. Every timeline event (opt-out, meeting booked, won, lost) is recorded
// against the ROOT pitch, which is the only row the learners read. Opt-out, opportunity
// outcomes and the calendar sync all call this; do not write a second version.

import type { SupabaseClient } from "@supabase/supabase-js";

export async function latestRootSentPitchId(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  supabase: SupabaseClient<any>,
  args: { tenantId: string; prospectId: string },
): Promise<string | null> {
  const { data } = await supabase
    .from("pitches")
    .select("id")
    .eq("prospect_id", args.prospectId)
    .eq("tenant_id", args.tenantId)
    .is("parent_pitch_id", null)
    .eq("status", "sent")
    .order("sent_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  return (data as { id: string } | null)?.id ?? null;
}
