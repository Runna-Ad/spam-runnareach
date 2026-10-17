// ─────────────────────────────────────────────────────────────────────────────
// app/api/public/hunter-signals/route.ts
// What the Inefficiency Hunter (runna-hunter, a separate app) should learn from
// S.P.A.M. and from itself: a weight per Hunter industry × finding id
// (lib/learning/hunter-weights.ts). The Hunter fetches it once per visit and
// uses it to order findings; with no evidence it returns nothing and the Hunter
// behaves as before.
//
// Public on purpose: aggregate weights only, no prospect, pitch or scan data.
// Cached at the edge for an hour.
// ─────────────────────────────────────────────────────────────────────────────

import { NextResponse } from "next/server";
import { findingWeights, type PitchEvidence, type ScanEvidence } from "@/lib/learning/hunter-weights";
import { scoreOutcome, type OutcomeEvent } from "@/lib/learning/reward";
import { mapToHunterIndustry, painToLeadKey } from "@/lib/pitches/hunter-mapping";
import { createServiceRoleClient } from "@/lib/supabase/service-role";

// Computed per request; the CDN caches it for an hour (Cache-Control below).
export const dynamic = "force-dynamic";

const HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Cache-Control": "public, s-maxage=3600, stale-while-revalidate=86400",
};

export async function GET() {
  // hunter_scans belongs to runna-hunter and isn't in the generated types.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const db = createServiceRoleClient() as any;
  const since = new Date(Date.now() - 180 * 86_400_000).toISOString();

  try {
    const [{ data: scans }, { data: pitches }] = await Promise.all([
      db.from("hunter_scans").select("industry, results, contacted").gte("created_at", since).limit(5000),
      db.from("pitches").select("id, decision").is("parent_pitch_id", null).not("sent_at", "is", null).gte("created_at", since).limit(5000),
    ]);

    const scanEvidence: ScanEvidence[] = ((scans ?? []) as Array<{ industry: string | null; results: { findings?: Array<{ id?: string }> } | null; contacted: boolean | null }>)
      .map((s) => ({
        industry: s.industry,
        findingIds: (s.results?.findings ?? []).map((f) => f.id).filter((id): id is string => Boolean(id)),
        contacted: Boolean(s.contacted),
      }))
      .filter((s) => s.findingIds.length > 0);

    const pitchRows = ((pitches ?? []) as Array<{ id: string; decision: { segment?: { industry?: string | null }; pain?: { label?: string | null } } | null }>)
      .filter((p) => p.decision);
    const events = new Map<string, OutcomeEvent[]>();
    for (let i = 0; i < pitchRows.length; i += 200) {
      const { data } = await db
        .from("pitch_events")
        .select("pitch_id, event_type, event_at, payload")
        .in("pitch_id", pitchRows.slice(i, i + 200).map((p) => p.id));
      for (const e of (data ?? []) as Array<{ pitch_id: string; event_type: string; event_at: string; payload: OutcomeEvent["payload"] }>) {
        const list = events.get(e.pitch_id) ?? [];
        list.push({ type: e.event_type, at: e.event_at, payload: e.payload });
        events.set(e.pitch_id, list);
      }
    }
    const pitchEvidence: PitchEvidence[] = pitchRows.map((p) => {
      const industry = mapToHunterIndustry(p.decision?.segment?.industry ?? null);
      const o = scoreOutcome(events.get(p.id) ?? []);
      return {
        industry,
        lead: painToLeadKey(p.decision?.pain?.label ?? null, industry),
        value: o.status === "settled" ? o.value : null,
      };
    });

    return NextResponse.json(
      { v: 1, generated_at: new Date().toISOString(), weights: findingWeights(scanEvidence, pitchEvidence) },
      { headers: HEADERS },
    );
  } catch {
    return NextResponse.json({ v: 1, generated_at: new Date().toISOString(), weights: {} }, { headers: HEADERS });
  }
}
