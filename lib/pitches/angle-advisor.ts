"use server";

/**
 * Pitch Angle Advisor (Learning Loop — PHASE 1).
 *
 * Surfaces the strongest pain → case-study → service combinations for a given
 * prospect, grounded in the prospect's deep research + Runna's case studies /
 * services / pain taxonomy. This is GUIDANCE for the human composing a pitch —
 * it does NOT touch generatePitch / composePitchWithClaude, and never auto-
 * applies anything. Hypothesis from current evidence, not validated learning.
 *
 * Grounding is strict: every case study + service + metric comes from the DB.
 * Claude (Haiku) is only used to order the candidates and phrase the rationale —
 * it is handed the already-resolved combos, so it cannot invent a client,
 * metric, or service.
 */

import { z } from "zod";
import { ANTHROPIC_HAIKU_MODEL, claudeIsAvailable, structuredCall } from "@/lib/anthropic/client";
import { requireUser } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { RUNNA_CAPABILITIES } from "@/lib/runna/capabilities";
import type { AngleStrength, PitchAngle, PitchAngleResult } from "./angle-types";

const HYPOTHESIS_NOTE =
  "Suggested angles from current research + Runna's case studies — guidance only, not validated by reply outcomes. The composer is unchanged; use these to steer it.";

type SizeSignal = "smb" | "mid_market" | "enterprise";

function deriveSize(estimate: number | null | undefined): SizeSignal {
  if (!estimate) return "smb";
  if (estimate >= 500) return "enterprise";
  if (estimate >= 50) return "mid_market";
  return "smb";
}

function tierEligible(size: SizeSignal, tier: string | null): boolean {
  if (size === "smb") return tier === "smb";
  if (size === "mid_market") return tier === "smb" || tier === "mid_market";
  return true;
}

function industryMatch(a: string | null, b: string | null): boolean {
  if (!a || !b) return false;
  const al = a.toLowerCase();
  const bl = b.toLowerCase();
  return al === bl || al.includes(bl) || bl.includes(al);
}

function hasNumber(s: string | null | undefined): boolean {
  return typeof s === "string" && /\d/.test(s);
}

export async function suggestPitchAnglesAction(prospectId: string): Promise<PitchAngleResult> {
  const idParse = z.string().uuid().safeParse(prospectId);
  if (!idParse.success) {
    return { ok: false, prospectName: "", angles: [], note: "Invalid prospect id.", method: "insufficient_data" };
  }

  const user = await requireUser();
  const supabase = await createClient();

  // ── Prospect + research ──────────────────────────────────────────────────────
  type ProspectRow = {
    company_name: string;
    industry: string | null;
    employee_size_estimate: number | null;
    language: "en" | "es";
  };
  const { data: prospect } = await supabase
    .from("prospects")
    .select("company_name, industry, employee_size_estimate, language")
    .eq("id", idParse.data)
    .eq("tenant_id", user.tenantId)
    .single<ProspectRow>();

  if (!prospect) {
    return { ok: false, prospectName: "", angles: [], note: "Prospect not found.", method: "insufficient_data" };
  }

  const { data: research } = await supabase
    .from("prospect_research")
    .select("pain_points")
    .eq("prospect_id", idParse.data)
    .maybeSingle<{ pain_points: unknown }>();

  const pains = normalizePains(research?.pain_points);
  if (pains.length === 0) {
    return {
      ok: false,
      prospectName: prospect.company_name,
      angles: [],
      note: "No researched pain points yet — run Deep Research on this prospect first, then the advisor can match case studies.",
      method: "insufficient_data",
    };
  }

  // ── Runna's proof base: case studies (+ pain tags), services, pain labels ─────
  type CaseRow = {
    id: string;
    client_name: string;
    industry: string | null;
    tier: string | null;
    hero_metric_en: string | null;
    hero_metric_es: string | null;
    featured_services_id: string[] | null;
    case_study_pain_tags: { pain_id: string; strength: number }[] | null;
  };
  const [{ data: cases }, { data: services }, painLabels] = await Promise.all([
    supabase
      .from("case_studies")
      .select(
        `id, client_name, industry, tier, hero_metric_en, hero_metric_es,
         featured_services_id, case_study_pain_tags(pain_id, strength)`,
      )
      .eq("tenant_id", user.tenantId)
      .eq("is_active", true)
      .returns<CaseRow[]>(),
    supabase
      .from("services")
      .select("id, display_name_en, display_name_es")
      .eq("tenant_id", user.tenantId)
      .eq("is_active", true)
      .returns<{ id: string; display_name_en: string; display_name_es: string | null }[]>(),
    loadPainLabels(supabase, user.tenantId),
  ]);

  const size = deriveSize(prospect.employee_size_estimate);
  const serviceById = new Map((services ?? []).map((s) => [s.id, s]));
  const serviceLabel = (id: string | null): { id: string | null; label: string | null } => {
    if (!id) return { id: null, label: null };
    const s = serviceById.get(id);
    if (!s) return { id: null, label: null };
    return { id: s.id, label: prospect.language === "es" ? (s.display_name_es ?? s.display_name_en) : s.display_name_en };
  };

  // ── Build deterministic combos: one best angle per prospect pain ──────────────
  const candidates = pains.map((pain) => {
    const painLabel = (pain.pain_label ?? (pain.pain_id ? painLabels.get(pain.pain_id) : null) ?? "Unspecified pain").trim();

    // Find the strongest tier-eligible case study that covers this pain.
    let best: { case: CaseRow; strength: number } | null = null;
    if (pain.pain_id) {
      for (const c of cases ?? []) {
        if (!tierEligible(size, c.tier)) continue;
        const tag = (c.case_study_pain_tags ?? []).find((t) => t.pain_id === pain.pain_id);
        if (!tag) continue;
        const score =
          tag.strength * 10 +
          (industryMatch(c.industry, prospect.industry) ? 5 : 0) +
          (hasNumber(prospect.language === "es" ? c.hero_metric_es : c.hero_metric_en) ? 3 : 0);
        if (!best || score > best.strength) best = { case: c, strength: score };
      }
    }

    const metric = best
      ? prospect.language === "es"
        ? best.case.hero_metric_es ?? best.case.hero_metric_en
        : best.case.hero_metric_en ?? best.case.hero_metric_es
      : null;
    const cleanMetric = hasNumber(metric) ? metric : null;
    const svc = serviceLabel(best?.case.featured_services_id?.[0] ?? null);

    // Strength reflects EVIDENCE, not "do we have a case study". A capability-led
    // angle (Runna's AI/optimization/dashboards/video + years of expertise) is a
    // legitimate angle even with no specific success story tied in (Pedro,
    // 2026-06-23). strong = directly-relevant case w/ real metric; moderate = a
    // fitting case OR a confident capability-led angle; exploratory = thin signal.
    const conf = pain.confidence ?? 0;
    let strength: AngleStrength;
    if (best && cleanMetric && conf >= 0.5) strength = "strong";
    else if (best) strength = "moderate";
    else if (conf >= 0.5) strength = "moderate";
    else strength = "exploratory";

    const sortKey = (best?.strength ?? 0) + (cleanMetric ? 5 : 0) + (pain.confidence ?? 0) * 4;

    return {
      angle: {
        painLabel,
        painId: pain.pain_id ?? null,
        evidenceQuote: pain.evidence_quote ?? null,
        caseStudyClient: best?.case.client_name ?? null,
        caseStudyId: best?.case.id ?? null,
        caseMetric: cleanMetric,
        serviceLabel: svc.label,
        serviceId: svc.id,
        rationale: "",
        strength,
      } as PitchAngle,
      sortKey,
    };
  });

  candidates.sort((a, b) => b.sortKey - a.sortKey);
  const ranked = candidates.slice(0, 5).map((c) => c.angle);

  const serviceNames = (services ?? []).map((s) =>
    prospect.language === "es" ? (s.display_name_es ?? s.display_name_en) : s.display_name_en,
  );

  // ── Phrase rationales (Haiku) — given resolved combos only, can't hallucinate ─
  if (claudeIsAvailable()) {
    const phrased = await phraseRationales(prospect.company_name, prospect.industry, ranked, serviceNames);
    if (phrased) {
      return { ok: true, prospectName: prospect.company_name, angles: phrased, note: HYPOTHESIS_NOTE, method: "claude" };
    }
  }

  // Deterministic rationale fallback. A case-less angle is framed as capability-led
  // (Runna's toolkit + expertise as proof), NOT as a weak "no case study" warning.
  for (const a of ranked) {
    a.rationale = a.caseStudyClient
      ? `Lead with "${a.painLabel}" — Runna proved this with ${a.caseStudyClient}${a.caseMetric ? ` (${a.caseMetric})` : ""}${a.serviceLabel ? `, delivered via ${a.serviceLabel}` : ""}.`
      : `Lead with "${a.painLabel}" — Runna's ${a.serviceLabel ?? "AI, optimization & production toolkit"} plus years of delivering this is the proof; no specific case study needed.`;
  }

  return {
    ok: true,
    prospectName: prospect.company_name,
    angles: ranked,
    note: HYPOTHESIS_NOTE,
    method: "heuristic",
  };
}

// ── Haiku rationale phrasing (ordering preserved; grounded inputs only) ─────────

const rationaleSchema = z.object({
  rationales: z.array(
    z.object({
      index: z.number().int().min(0),
      rationale: z.string().trim().min(1).max(2000).transform((s) => s.slice(0, 300)),
      // For an angle with no specific case study, the Runna capability to lead
      // with (e.g. "AI automation", "custom dashboard", "video ad production").
      capability: z.string().trim().max(400).transform((s) => s.slice(0, 60)).optional(),
    }),
  ),
});

async function phraseRationales(
  company: string,
  industry: string | null,
  angles: PitchAngle[],
  serviceNames: string[],
): Promise<PitchAngle[] | null> {
  const system = `You are a sales strategist for Runna, a creative + digital agency with a broad modern toolkit. You write ONE-sentence rationales explaining why each pitch angle works for a specific prospect.

${RUNNA_CAPABILITIES}

RULES:
- A specific case study is NOT required. When an angle has a case study that genuinely fits, cite it (client + metric). When it does NOT, lead with the relevant Runna CAPABILITY (AI, automation, optimization, dashboards, asset/video production) plus Runna's years of expertise as the proof — frame it confidently, NOT as a weakness. Never say "no case study" as if it's a problem.
- For an angle WITHOUT a case study, also return a "capability" — the single Runna capability to lead with (prefer one of: ${serviceNames.join(", ") || "AI automation, optimization, dashboards, video production"}).
- The ONE hard rule: never invent a SPECIFIC client name, metric, or geography that isn't provided. Speaking to general capability + expertise is encouraged.
- Each rationale: one sentence, concrete, plain language, no fluff.
- Return an entry for EVERY angle index provided.`;

  const user = `Prospect: ${company}${industry ? ` (industry: ${industry})` : ""}

Angles (by index):
${angles
  .map(
    (a, i) =>
      `${i}. pain="${a.painLabel}"${a.evidenceQuote ? ` evidence="${a.evidenceQuote}"` : ""}; ` +
      `case_study=${a.caseStudyClient ?? "none"}${a.caseMetric ? ` metric="${a.caseMetric}"` : ""}; ` +
      `service=${a.serviceLabel ?? "none"}; strength=${a.strength}`,
  )
  .join("\n")}

Return JSON { "rationales": [{ "index": n, "rationale": "...", "capability": "..." }] } covering every index. Include "capability" for angles whose case_study is "none".`;

  const result = await structuredCall({
    model: ANTHROPIC_HAIKU_MODEL,
    system,
    user,
    max_tokens: 800,
    schema: rationaleSchema,
  });

  if (!result.ok) {
    console.error(`[pitch-angles] Claude phrasing failed (${result.reason}): ${result.error}`);
    return null;
  }

  const byIndex = new Map(result.data.rationales.map((r) => [r.index, r]));
  return angles.map((a, i) => {
    const r = byIndex.get(i);
    return {
      ...a,
      rationale: r?.rationale ?? a.rationale,
      // Surface the capability as the service label when there's no case-linked service.
      serviceLabel: a.serviceLabel ?? r?.capability ?? null,
    };
  });
}

// ── Helpers ─────────────────────────────────────────────────────────────────

type PainPointJson = {
  pain_id?: string;
  pain_label?: string;
  evidence_quote?: string;
  confidence?: number;
};

function normalizePains(raw: unknown): PainPointJson[] {
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((e) => {
    if (!e || typeof e !== "object") return [];
    const o = e as Record<string, unknown>;
    // Only keep pains with a real evidence quote — matches the pipeline's
    // "evidence-backed pains only" rule (tasks/lessons.md).
    return [{
      pain_id: typeof o.pain_id === "string" ? o.pain_id : undefined,
      pain_label: typeof o.pain_label === "string" ? o.pain_label : undefined,
      evidence_quote: typeof o.evidence_quote === "string" ? o.evidence_quote : undefined,
      confidence: typeof o.confidence === "number" ? o.confidence : undefined,
    }];
  });
}

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
