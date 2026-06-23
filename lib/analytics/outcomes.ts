import { createClient } from "@/lib/supabase/server";

/**
 * Outcome learning — PHASE 2a (observation only).
 *
 * Aggregates real pipeline OUTCOMES by dimension (ICP, industry, discovery
 * source, city, pain, case study) so Pedro can SEE what's converting as data
 * accumulates. This is the honest first half of the statistical learning loop:
 * it surfaces counts + rates with explicit SAMPLE-SIZE CONFIDENCE, and
 * deliberately suggests nothing and changes nothing.
 *
 * GUARDRAIL (learning-loop-spec Phase 2): "capturing data ≠ learning". We just
 * shipped the reply funnel, so outcome volume is ~0. Reweighting targeting or
 * scoring on this now would be fitting noise. Phase 2b (suggested reweights,
 * human-approved) waits until a dimension clears a real volume threshold —
 * which is exactly what the confidence labels here make visible.
 *
 * Outcome signal:
 *   - sent     = the prospect has at least one pitch with status 'sent'.
 *   - replied  = prospect.status in {replied, booked, won}.
 *   - booked   = prospect.status in {booked, won}.
 * Rates are denominated on SENT (a reply rate is meaningless before send).
 */

export type OutcomeConfidence = "actionable" | "emerging" | "insufficient";

/** A dimension has enough SENT volume to read its rates at these thresholds. */
const ACTIONABLE_MIN_SENT = 20;
const EMERGING_MIN_SENT = 5;

function confidenceFor(sent: number): OutcomeConfidence {
  if (sent >= ACTIONABLE_MIN_SENT) return "actionable";
  if (sent >= EMERGING_MIN_SENT) return "emerging";
  return "insufficient";
}

export type OutcomeRow = {
  key: string;
  label: string;
  prospects: number;
  sent: number;
  replied: number;
  booked: number;
  /** replied/sent — null when sent === 0 (a rate would be a divide-by-zero lie). */
  replyRate: number | null;
  bookRate: number | null;
  confidence: OutcomeConfidence;
};

export type OutcomeDimensionKey =
  | "icp"
  | "industry"
  | "source"
  | "city"
  | "pain"
  | "case_study";

export type OutcomeDimension = {
  key: OutcomeDimensionKey;
  label: string;
  /** Sorted: most sent first; rows with no sends drop to the bottom. */
  rows: OutcomeRow[];
};

export type OutcomeInsights = {
  totalProspects: number;
  totalSent: number;
  totalReplied: number;
  totalBooked: number;
  dimensions: OutcomeDimension[];
  /** True once ANY dimension row clears the emerging threshold — i.e. there's
   *  something worth reading. Drives the "not enough data yet" banner. */
  hasReadableData: boolean;
};

const REPLIED_STATUSES = new Set(["replied", "booked", "won"]);
const BOOKED_STATUSES = new Set(["booked", "won"]);

type ProspectRow = {
  id: string;
  icp_id: string | null;
  industry: string | null;
  discovery_source: string | null;
  city: string | null;
  status: string;
};

export async function getOutcomeInsights(tenantId: string): Promise<OutcomeInsights> {
  const supabase = await createClient();

  const [prospectsRes, pitchesRes, scoresRes, icpsRes, painsRes, casesRes] =
    await Promise.all([
      supabase
        .from("prospects")
        .select("id, icp_id, industry, discovery_source, city, status")
        .eq("tenant_id", tenantId)
        .returns<ProspectRow[]>(),
      supabase
        .from("pitches")
        .select("prospect_id, status")
        .eq("tenant_id", tenantId)
        .returns<{ prospect_id: string; status: string }[]>(),
      supabase
        .from("scores")
        .select("prospect_id, best_pain_id, best_case_study_id")
        .eq("tenant_id", tenantId)
        .is("superseded_at", null)
        .returns<{ prospect_id: string; best_pain_id: string | null; best_case_study_id: string | null }[]>(),
      supabase
        .from("icps")
        .select("id, name")
        .eq("tenant_id", tenantId)
        .returns<{ id: string; name: string }[]>(),
      supabase
        .from("pain_taxonomy")
        .select("id, display_name_en")
        .eq("tenant_id", tenantId)
        .returns<{ id: string; display_name_en: string }[]>(),
      supabase
        .from("case_studies")
        .select("id, client_name")
        .eq("tenant_id", tenantId)
        .returns<{ id: string; client_name: string }[]>(),
    ]);

  const prospects = prospectsRes.data ?? [];

  // Prospects with a genuinely SENT pitch.
  const sentProspectIds = new Set<string>();
  for (const p of pitchesRes.data ?? []) {
    if (p.status === "sent") sentProspectIds.add(p.prospect_id);
  }

  // Latest-active score per prospect → pain / case-study dimension keys.
  const painByProspect = new Map<string, string | null>();
  const caseByProspect = new Map<string, string | null>();
  for (const s of scoresRes.data ?? []) {
    if (!painByProspect.has(s.prospect_id)) painByProspect.set(s.prospect_id, s.best_pain_id);
    if (!caseByProspect.has(s.prospect_id)) caseByProspect.set(s.prospect_id, s.best_case_study_id);
  }

  const icpName = new Map((icpsRes.data ?? []).map((i) => [i.id, i.name]));
  const painName = new Map((painsRes.data ?? []).map((p) => [p.id, p.display_name_en]));
  const caseName = new Map((casesRes.data ?? []).map((c) => [c.id, c.client_name]));

  // Accumulator: dimension → key → tallies (+ label).
  type Tally = { label: string; prospects: number; sent: number; replied: number; booked: number };
  const acc: Record<OutcomeDimensionKey, Map<string, Tally>> = {
    icp: new Map(),
    industry: new Map(),
    source: new Map(),
    city: new Map(),
    pain: new Map(),
    case_study: new Map(),
  };

  const bump = (dim: OutcomeDimensionKey, key: string | null, label: string, isSent: boolean, isReplied: boolean, isBooked: boolean) => {
    if (!key) return; // skip rows with no value for this dimension
    const map = acc[dim];
    const t = map.get(key) ?? { label, prospects: 0, sent: 0, replied: 0, booked: 0 };
    t.prospects += 1;
    if (isSent) t.sent += 1;
    if (isReplied) t.replied += 1;
    if (isBooked) t.booked += 1;
    map.set(key, t);
  };

  let totalSent = 0;
  let totalReplied = 0;
  let totalBooked = 0;

  for (const p of prospects) {
    const isSent = sentProspectIds.has(p.id);
    const isReplied = REPLIED_STATUSES.has(p.status);
    const isBooked = BOOKED_STATUSES.has(p.status);
    if (isSent) totalSent += 1;
    if (isReplied) totalReplied += 1;
    if (isBooked) totalBooked += 1;

    bump("icp", p.icp_id ?? "__none__", p.icp_id ? (icpName.get(p.icp_id) ?? "Unknown ICP") : "No ICP assigned", isSent, isReplied, isBooked);
    bump("industry", p.industry?.trim().toLowerCase() || null, p.industry?.trim() ?? "", isSent, isReplied, isBooked);
    bump("source", p.discovery_source ?? null, p.discovery_source ?? "", isSent, isReplied, isBooked);
    bump("city", p.city?.trim().toLowerCase() || null, p.city?.trim() ?? "", isSent, isReplied, isBooked);

    const painId = painByProspect.get(p.id) ?? null;
    bump("pain", painId, painId ? (painName.get(painId) ?? "Unknown pain") : "", isSent, isReplied, isBooked);
    const caseId = caseByProspect.get(p.id) ?? null;
    bump("case_study", caseId, caseId ? (caseName.get(caseId) ?? "Unknown case") : "", isSent, isReplied, isBooked);
  }

  const DIM_LABELS: Record<OutcomeDimensionKey, string> = {
    icp: "By ICP",
    industry: "By industry",
    source: "By discovery source",
    city: "By city",
    pain: "By pain (matched)",
    case_study: "By case study (matched)",
  };

  const dimensions: OutcomeDimension[] = (Object.keys(acc) as OutcomeDimensionKey[]).map((dim) => {
    const rows: OutcomeRow[] = [...acc[dim].entries()].map(([key, t]) => ({
      key,
      label: t.label,
      prospects: t.prospects,
      sent: t.sent,
      replied: t.replied,
      booked: t.booked,
      replyRate: t.sent > 0 ? t.replied / t.sent : null,
      bookRate: t.sent > 0 ? t.booked / t.sent : null,
      confidence: confidenceFor(t.sent),
    }));
    // Most-sent first, then most-prospects — surfaces the segments worth reading.
    rows.sort((a, b) => b.sent - a.sent || b.prospects - a.prospects);
    return { key: dim, label: DIM_LABELS[dim], rows };
  });

  const hasReadableData = dimensions.some((d) =>
    d.rows.some((r) => r.confidence !== "insufficient"),
  );

  return {
    totalProspects: prospects.length,
    totalSent,
    totalReplied,
    totalBooked,
    dimensions,
    hasReadableData,
  };
}
