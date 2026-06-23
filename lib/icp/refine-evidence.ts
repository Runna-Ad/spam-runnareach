import { createClient } from "@/lib/supabase/server";
import type { Counted, IcpEvidence } from "./refine-types";

/**
 * Evidence aggregation for the ICP Refinement Advisor (Learning Loop — PHASE 1).
 *
 * Pulls together everything we ALREADY know about the prospects assigned to a
 * given ICP — deep research (pains, tech stacks, what_they_do), scores (composite
 * + Claude reasoning) — and cross-references where Runna is strongest (case
 * studies + services + pain taxonomy). NO outcome/reply data is used; this is
 * hypothesis-generation material, not validated learning.
 *
 * Pure read-only aggregation. The advisor (suggest-action.ts) turns this into
 * SUGGESTED ICP field values for Pedro to review — nothing is auto-applied.
 *
 * Types live in refine-types.ts (client-safe — no server imports) so the ICP
 * drawer can render the evidence without bundle bleed.
 */

type PainPointJson = {
  pain_id?: string;
  pain_label?: string;
  evidence_quote?: string;
  confidence?: number;
};

const TOP_N = 8;

/**
 * Aggregate the evidence base for one ICP. Returns null-ish empty evidence
 * when the ICP has no assigned prospects yet (the advisor surfaces a
 * "not enough data" note in that case).
 */
export async function gatherIcpEvidence(
  tenantId: string,
  icpId: string,
): Promise<IcpEvidence> {
  const supabase = await createClient();

  // ── Prospects assigned to this ICP ──────────────────────────────────────────
  type ProspectRow = {
    id: string;
    industry: string | null;
    match_score: number | null;
    status: string;
  };
  const { data: prospects } = await supabase
    .from("prospects")
    .select("id, industry, match_score, status")
    .eq("tenant_id", tenantId)
    .eq("icp_id", icpId)
    .returns<ProspectRow[]>();

  const prospectRows = prospects ?? [];
  const prospectIds = prospectRows.map((p) => p.id);

  // Empty ICP — return a shell; advisor handles the "insufficient data" path.
  if (prospectIds.length === 0) {
    return {
      prospectCount: 0,
      researchedCount: 0,
      avgScore: null,
      topPains: [],
      topTech: [],
      industriesPresent: [],
      whatTheyDoSamples: [],
      scoreReasoningSamples: [],
      runnaStrength: await gatherRunnaStrength(supabase, tenantId),
    };
  }

  // ── Research + active scores for those prospects (chunked IN lists) ──────────
  type ResearchRow = {
    prospect_id: string;
    what_they_do: string | null;
    tech_stack: string[] | null;
    pain_points: unknown;
  };
  type ScoreRow = {
    prospect_id: string;
    composite_score: number;
    reasoning: string | null;
  };

  const [researchRows, scoreRows, painTax] = await Promise.all([
    chunkedIn<ResearchRow>(prospectIds, (ids) =>
      supabase
        .from("prospect_research")
        .select("prospect_id, what_they_do, tech_stack, pain_points")
        .in("prospect_id", ids)
        .returns<ResearchRow[]>(),
    ),
    chunkedIn<ScoreRow>(prospectIds, (ids) =>
      supabase
        .from("scores")
        .select("prospect_id, composite_score, reasoning")
        .in("prospect_id", ids)
        .is("superseded_at", null)
        .returns<ScoreRow[]>(),
    ),
    loadPainLabels(supabase, tenantId),
  ]);

  // ── Aggregate pains + tech + what_they_do ────────────────────────────────────
  const painCounts = new Map<string, Counted>();
  const techCounts = new Map<string, number>();
  const whatTheyDoByProspect = new Map<string, string>();
  let researchedCount = 0;

  for (const row of researchRows) {
    let hasSignal = false;
    const pains = normalizePains(row.pain_points);
    for (const p of pains) {
      const label = (p.pain_label ?? (p.pain_id ? painTax.get(p.pain_id) : null) ?? "")
        .trim();
      if (!label) continue;
      hasSignal = true;
      const key = label.toLowerCase();
      const prev = painCounts.get(key);
      if (prev) prev.count += 1;
      else painCounts.set(key, { name: label, count: 1, pain_id: p.pain_id ?? null });
    }
    for (const t of row.tech_stack ?? []) {
      const name = t.trim();
      if (!name) continue;
      hasSignal = true;
      techCounts.set(name.toLowerCase(), (techCounts.get(name.toLowerCase()) ?? 0) + 1);
    }
    if (row.what_they_do?.trim()) {
      whatTheyDoByProspect.set(row.prospect_id, row.what_they_do.trim());
      hasSignal = true;
    }
    if (hasSignal) researchedCount += 1;
  }

  // Tech needs original casing — keep first-seen.
  const techCasing = new Map<string, string>();
  for (const row of researchRows) {
    for (const t of row.tech_stack ?? []) {
      const k = t.trim().toLowerCase();
      if (k && !techCasing.has(k)) techCasing.set(k, t.trim());
    }
  }

  // ── Scores: average + reasoning from the strongest prospects ─────────────────
  const scoreByProspect = new Map<string, ScoreRow>();
  for (const s of scoreRows) {
    const prev = scoreByProspect.get(s.prospect_id);
    if (!prev || s.composite_score > prev.composite_score) scoreByProspect.set(s.prospect_id, s);
  }
  const scoreVals = [...scoreByProspect.values()].map((s) => s.composite_score);
  const avgScore =
    scoreVals.length > 0
      ? Math.round(scoreVals.reduce((a, b) => a + b, 0) / scoreVals.length)
      : null;

  // Rank prospects by score so samples come from the best-fit examples.
  const rankedProspectIds = [...prospectIds].sort(
    (a, b) => (scoreByProspect.get(b)?.composite_score ?? 0) - (scoreByProspect.get(a)?.composite_score ?? 0),
  );

  const whatTheyDoSamples: string[] = [];
  const scoreReasoningSamples: string[] = [];
  for (const pid of rankedProspectIds) {
    if (whatTheyDoSamples.length < 4) {
      const w = whatTheyDoByProspect.get(pid);
      if (w) whatTheyDoSamples.push(w.slice(0, 280));
    }
    if (scoreReasoningSamples.length < 4) {
      const r = scoreByProspect.get(pid)?.reasoning?.trim();
      if (r) scoreReasoningSamples.push(r.slice(0, 320));
    }
  }

  // ── Industries present among assigned prospects ──────────────────────────────
  const industryCounts = new Map<string, Counted>();
  for (const p of prospectRows) {
    const name = p.industry?.trim();
    if (!name) continue;
    const key = name.toLowerCase();
    const prev = industryCounts.get(key);
    if (prev) prev.count += 1;
    else industryCounts.set(key, { name, count: 1 });
  }

  return {
    prospectCount: prospectRows.length,
    researchedCount,
    avgScore,
    topPains: sortCounted([...painCounts.values()]).slice(0, TOP_N),
    topTech: sortCounted(
      [...techCounts.entries()].map(([k, count]) => ({ name: techCasing.get(k) ?? k, count })),
    ).slice(0, TOP_N),
    industriesPresent: sortCounted([...industryCounts.values()]).slice(0, TOP_N),
    whatTheyDoSamples,
    scoreReasoningSamples,
    runnaStrength: await gatherRunnaStrength(supabase, tenantId),
  };
}

// ── Runna strength (case studies + services) ───────────────────────────────────

async function gatherRunnaStrength(
  supabase: Awaited<ReturnType<typeof createClient>>,
  tenantId: string,
): Promise<IcpEvidence["runnaStrength"]> {
  type CaseRow = {
    industry: string | null;
    case_study_pain_tags: { pain_id: string; strength: number }[] | null;
  };
  const [{ data: cases }, { data: services }, painLabels] = await Promise.all([
    supabase
      .from("case_studies")
      .select("industry, case_study_pain_tags(pain_id, strength)")
      .eq("tenant_id", tenantId)
      .eq("is_active", true)
      .returns<CaseRow[]>(),
    supabase
      .from("services")
      .select("display_name_en")
      .eq("tenant_id", tenantId)
      .eq("is_active", true)
      .order("sort_order", { ascending: true })
      .returns<{ display_name_en: string }[]>(),
    loadPainLabels(supabase, tenantId),
  ]);

  const industries = new Set<string>();
  const painStrength = new Map<string, Counted>();
  for (const c of cases ?? []) {
    if (c.industry?.trim()) industries.add(c.industry.trim());
    for (const tag of c.case_study_pain_tags ?? []) {
      const label = painLabels.get(tag.pain_id);
      if (!label) continue;
      const key = tag.pain_id;
      const prev = painStrength.get(key);
      // "count" here doubles as cumulative strength so well-proven pains rank up.
      if (prev) prev.count += tag.strength;
      else painStrength.set(key, { name: label, count: tag.strength, pain_id: tag.pain_id });
    }
  }

  return {
    caseStudyIndustries: [...industries].sort((a, b) => a.localeCompare(b)),
    coveredPains: sortCounted([...painStrength.values()]).slice(0, TOP_N),
    services: (services ?? []).map((s) => s.display_name_en),
  };
}

// ── Helpers ─────────────────────────────────────────────────────────────────

async function loadPainLabels(
  supabase: Awaited<ReturnType<typeof createClient>>,
  tenantId: string,
): Promise<Map<string, string>> {
  const { data } = await supabase
    .from("pain_taxonomy")
    .select("id, display_name_en")
    .eq("tenant_id", tenantId)
    .returns<{ id: string; display_name_en: string }[]>();
  return new Map((data ?? []).map((p) => [p.id, p.display_name_en]));
}

function normalizePains(raw: unknown): PainPointJson[] {
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((e) => {
    if (!e || typeof e !== "object") return [];
    const o = e as Record<string, unknown>;
    return [{
      pain_id: typeof o.pain_id === "string" ? o.pain_id : undefined,
      pain_label: typeof o.pain_label === "string" ? o.pain_label : undefined,
      evidence_quote: typeof o.evidence_quote === "string" ? o.evidence_quote : undefined,
      confidence: typeof o.confidence === "number" ? o.confidence : undefined,
    }];
  });
}

function sortCounted(arr: Counted[]): Counted[] {
  return arr.sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
}

/**
 * Run a `.in()` query in chunks of 100 ids so a large prospect pool never
 * blows the PostgREST URL length limit. Flattens the results.
 */
async function chunkedIn<T>(
  ids: string[],
  run: (ids: string[]) => PromiseLike<{ data: T[] | null; error: unknown }>,
): Promise<T[]> {
  const out: T[] = [];
  for (let i = 0; i < ids.length; i += 100) {
    const { data } = await run(ids.slice(i, i + 100));
    if (data) out.push(...data);
  }
  return out;
}
