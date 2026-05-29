"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { writeAuditLog } from "@/lib/audit/log";
import { requireUser } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import {
  scoreWithHeuristic,
  type RubricInputIcp,
  type RubricInputProspect,
  type RubricInputResearch,
  type RubricResult,
} from "./scoring/rubric";
import { scoreWithClaude } from "./scoring/claude-scorer";

const inputSchema = z.object({
  prospect_id: z.string().uuid(),
});

export type ScoreProspectResult =
  | {
      ok: true;
      composite_score: number;
      confidence: number;
      method: "heuristic" | "claude";
      breakdown: RubricResult["breakdown"];
      reasoning: string;
    }
  | { ok: false; error: string };

/**
 * Compute the ICP-rubric score for a prospect and persist it.
 *
 * Phase 1a: heuristic scorer (no LLM). Phase 2 adds a Claude call that
 * returns the same `RubricResult` shape, so this orchestrator only
 * needs a one-line swap. Until then we mark `method='heuristic'` and
 * `prompt_variant_id=null` so the UI can show "scored without Claude".
 *
 * Side effects:
 *   1. Insert a row into `scores` (immutable history)
 *   2. Mark prior active scores as superseded (so idx_scores_prospect_active
 *      always points at the latest)
 *   3. Update `prospects.match_score` + `research_quality_score`
 *      (used by /companies, /funnel, /today)
 */
export async function scoreProspect(
  prospectId: string,
): Promise<ScoreProspectResult> {
  const user = await requireUser();
  if (user.role === "viewer") return { ok: false, error: "Viewers cannot score." };

  const parsed = inputSchema.safeParse({ prospect_id: prospectId });
  if (!parsed.success) return { ok: false, error: "Invalid prospect id." };

  const supabase = await createClient();

  // Load prospect (with linked ICP rubric inputs).
  type ProspectRow = {
    id: string;
    industry: string | null;
    city: string | null;
    region: string | null;
    country_code: string | null;
    employee_size_estimate: number | null;
    red_flags: string[];
    icp_id: string | null;
    icps: {
      industry_tags: string[];
      geo_regions: string[];
      employee_size_min: number | null;
      employee_size_max: number | null;
      search_keywords: string[];
      excluded_keywords: string[];
    } | null;
  };
  const { data: prospect, error: prospectErr } = await supabase
    .from("prospects")
    .select(
      `
      id, industry, city, region, country_code, employee_size_estimate,
      red_flags, icp_id,
      icps(industry_tags, geo_regions, employee_size_min, employee_size_max,
           search_keywords, excluded_keywords)
    `,
    )
    .eq("id", parsed.data.prospect_id)
    .eq("tenant_id", user.tenantId)
    .maybeSingle<ProspectRow>();

  if (prospectErr) return { ok: false, error: `Lookup failed: ${prospectErr.message}` };
  if (!prospect) return { ok: false, error: "Prospect not found." };

  // Load research (optional — score works without it but won't be high).
  type ResearchRow = {
    what_they_do: string | null;
    tech_stack: string[];
    pain_points: unknown;
    evidence_urls: string[];
  };
  const { data: research, error: researchErr } = await supabase
    .from("prospect_research")
    .select("what_they_do, tech_stack, pain_points, evidence_urls")
    .eq("tenant_id", user.tenantId)
    .eq("prospect_id", parsed.data.prospect_id)
    .maybeSingle<ResearchRow>();

  if (researchErr) {
    if (
      researchErr.code !== "42P01" &&
      researchErr.code !== "PGRST205" &&
      !researchErr.message?.includes("schema cache")
    ) {
      return { ok: false, error: `Lookup failed: ${researchErr.message}` };
    }
    // Table missing — proceed with no research.
  }

  const rubricProspect: RubricInputProspect = {
    industry: prospect.industry,
    city: prospect.city,
    region: prospect.region,
    country_code: prospect.country_code,
    employee_size_estimate: prospect.employee_size_estimate,
    red_flags: prospect.red_flags ?? [],
  };
  const rubricResearch: RubricInputResearch = research
    ? {
        what_they_do: research.what_they_do,
        tech_stack: research.tech_stack ?? [],
        pain_points: normalizePainPoints(research.pain_points),
        evidence_urls: research.evidence_urls ?? [],
      }
    : null;
  const rubricIcp: RubricInputIcp = prospect.icps
    ? {
        industry_tags: prospect.icps.industry_tags ?? [],
        geo_regions: prospect.icps.geo_regions ?? [],
        employee_size_min: prospect.icps.employee_size_min,
        employee_size_max: prospect.icps.employee_size_max,
        search_keywords: prospect.icps.search_keywords ?? [],
        excluded_keywords: prospect.icps.excluded_keywords ?? [],
      }
    : null;

  // ── Scorer dispatch ──────────────────────────────────────────────────────
  // Use Claude when API key is present; fall back to heuristic otherwise.
  // scoreWithClaude already falls back internally on any API error.
  let result: RubricResult;
  let cost_usd = 0;
  let method: "heuristic" | "claude";

  if (process.env.ANTHROPIC_API_KEY) {
    const claudeResult = await scoreWithClaude(rubricProspect, rubricResearch, rubricIcp);
    result = claudeResult;
    cost_usd = claudeResult.cost_usd;
    method = claudeResult.model === "heuristic_fallback" ? "heuristic" : "claude";
  } else {
    result = scoreWithHeuristic(rubricProspect, rubricResearch, rubricIcp);
    method = "heuristic";
  }

  // Mark prior active scores as superseded so the partial index stays clean.
  const nowIso = new Date().toISOString();
  await supabase
    .from("scores")
    .update({ superseded_at: nowIso })
    .eq("tenant_id", user.tenantId)
    .eq("prospect_id", parsed.data.prospect_id)
    .is("superseded_at", null);

  // Insert new score. We don't have a prompt_variant_id yet (Phase 2 adds
  // that when Claude becomes the scorer).
  const { error: insertErr } = await supabase.from("scores").insert({
    tenant_id: user.tenantId,
    prospect_id: parsed.data.prospect_id,
    composite_score: result.composite_score,
    industry_fit_pts: result.breakdown.industry_fit_pts,
    size_fit_pts: result.breakdown.size_fit_pts,
    digital_maturity_pts: result.breakdown.digital_maturity_pts,
    pain_signal_pts: result.breakdown.pain_signal_pts,
    service_match_pts: result.breakdown.service_match_pts,
    contact_discoverability_pts: result.breakdown.contact_discoverability_pts,
    red_flag_penalty: result.breakdown.red_flag_penalty,
    confidence: result.confidence,
    reasoning: result.reasoning,
    cost_usd, // $0 for heuristic, actual spend for Claude calls
    generated_at: nowIso,
  });

  if (insertErr) return { ok: false, error: `Could not save score: ${insertErr.message}` };

  // Update prospect snapshot fields used by listing pages.
  const { error: updErr } = await supabase
    .from("prospects")
    .update({
      match_score: result.composite_score,
      research_quality_score: result.confidence,
      updated_at: nowIso,
    })
    .eq("id", parsed.data.prospect_id)
    .eq("tenant_id", user.tenantId);

  if (updErr) return { ok: false, error: `Score saved, but prospect update failed: ${updErr.message}` };

  await writeAuditLog({
    tenantId: user.tenantId,
    actorId: user.id,
    action: "prospect.scored",
    entityType: "prospect",
    entityId: parsed.data.prospect_id,
    metadata: {
      composite_score: result.composite_score,
      confidence: result.confidence,
      method,
      breakdown: result.breakdown,
    },
  });

  revalidatePath(`/companies/${parsed.data.prospect_id}`);
  revalidatePath("/companies");
  revalidatePath("/funnel");
  revalidatePath("/dashboard");

  return {
    ok: true,
    composite_score: result.composite_score,
    confidence: result.confidence,
    method,
    breakdown: result.breakdown,
    reasoning: result.reasoning,
  };
}

function normalizePainPoints(
  raw: unknown,
): RubricInputResearch extends infer T ? (T extends { pain_points: infer P } ? P : never) : never {
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((entry) => {
    if (!entry || typeof entry !== "object") return [];
    const e = entry as Record<string, unknown>;

    // ── Evidence-quote gate ───────────────────────────────────────────────
    // Pains without a real evidence quote from scraped content are filtered
    // before reaching the scoring rubric. This prevents Claude-inferred pains
    // (no grounding in what the site actually says) from inflating the score.
    //
    // A "real" quote must:
    //   1. Exist and be a non-empty string
    //   2. Be ≥20 characters (rules out single-word placeholder strings)
    //   3. Not be identical to the pain_label (the recycled-label anti-pattern:
    //      evidence_quote = "checkout abandonment" when label = "checkout abandonment")
    const quote = typeof e.evidence_quote === "string" ? e.evidence_quote.trim() : "";
    const label = typeof e.pain_label === "string" ? e.pain_label.trim() : "";
    if (quote.length < 20 || quote === label) return [];

    const out: Record<string, string> = {};
    if (typeof e.pain_id === "string") out.pain_id = e.pain_id;
    if (label) out.pain_label = label;
    out.evidence_quote = quote;
    if (typeof e.evidence_url === "string") out.evidence_url = e.evidence_url;
    return Object.keys(out).length > 0 ? [out] : [];
  });
}
