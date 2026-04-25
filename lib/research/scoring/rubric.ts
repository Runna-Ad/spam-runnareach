/**
 * Heuristic ICP-rubric scorer for a prospect. Pure function — no I/O.
 *
 * This is the *stub* scorer for Phase 1a. Once Anthropic credits land
 * (Phase 2), `scoreProspect` will swap this for a Claude call that
 * reads the same inputs and returns the same `RubricResult` shape, so
 * downstream code (the scores table writer, the UI badge, the funnel
 * filter) doesn't change.
 *
 * Composite score is 0–100, made of weighted bucket points minus a
 * red-flag penalty. Breakdown is preserved so the UI can explain
 * "why 72?".
 */

export type RubricInputProspect = {
  industry: string | null;
  city: string | null;
  region: string | null;
  country_code: string | null;
  employee_size_estimate: number | null;
  red_flags: string[];
};

export type RubricInputResearch = {
  what_they_do: string | null;
  tech_stack: string[];
  pain_points: { pain_id?: string; pain_label?: string; evidence_quote?: string; evidence_url?: string }[];
  evidence_urls: string[];
} | null;

export type RubricInputIcp = {
  industry_tags: string[];
  geo_regions: string[];
  employee_size_min: number | null;
  employee_size_max: number | null;
  search_keywords: string[];
  excluded_keywords: string[];
} | null;

export type RubricBreakdown = {
  industry_fit_pts: number;       // /20
  size_fit_pts: number;           // /15
  digital_maturity_pts: number;   // /15
  pain_signal_pts: number;        // /15
  service_match_pts: number;      // /10 — placeholder until best_service inference lands
  contact_discoverability_pts: number; // /10
  geo_fit_pts: number;            // /15
  red_flag_penalty: number;       // negative
};

export type RubricResult = {
  composite_score: number;        // 0–100, clamped
  breakdown: RubricBreakdown;
  confidence: number;             // 0..1 — heuristic confidence
  reasoning: string;
};

const MAX_PTS = {
  industry_fit_pts: 20,
  size_fit_pts: 15,
  digital_maturity_pts: 15,
  pain_signal_pts: 15,
  service_match_pts: 10,
  contact_discoverability_pts: 10,
  geo_fit_pts: 15,
} as const;

/**
 * Score a prospect against an ICP using observable signals from the
 * scraper + research editor. No LLM. Determinism makes this easy to
 * test and gives the UI something to show while we wait on credits.
 */
export function scoreWithHeuristic(
  prospect: RubricInputProspect,
  research: RubricInputResearch,
  icp: RubricInputIcp,
): RubricResult {
  const reasoningParts: string[] = [];

  // ---- Industry fit (/20) -------------------------------------------------
  let industry_fit_pts = 0;
  if (prospect.industry && icp?.industry_tags?.length) {
    const lower = prospect.industry.toLowerCase();
    const hit = icp.industry_tags.find((t) => lower.includes(t.toLowerCase()));
    if (hit) {
      industry_fit_pts = MAX_PTS.industry_fit_pts;
      reasoningParts.push(`Industry "${prospect.industry}" matches ICP tag "${hit}".`);
    } else {
      industry_fit_pts = 5;
      reasoningParts.push(`Industry "${prospect.industry}" doesn't match any ICP tag.`);
    }
  } else if (icp?.industry_tags?.length) {
    reasoningParts.push("No industry on prospect — penalized.");
  } else {
    industry_fit_pts = 10; // unknown ICP — neutral
  }

  // ---- Size fit (/15) -----------------------------------------------------
  let size_fit_pts = 0;
  if (prospect.employee_size_estimate !== null && icp) {
    const min = icp.employee_size_min ?? 0;
    const max = icp.employee_size_max ?? Number.POSITIVE_INFINITY;
    const n = prospect.employee_size_estimate;
    if (n >= min && n <= max) {
      size_fit_pts = MAX_PTS.size_fit_pts;
      reasoningParts.push(`Size ${n} fits ICP band [${min}, ${max === Infinity ? "∞" : max}].`);
    } else {
      // Partial credit if within 50% of the band edges
      const slack = 0.5;
      const minSlack = min * (1 - slack);
      const maxSlack = max === Infinity ? Infinity : max * (1 + slack);
      if (n >= minSlack && n <= maxSlack) {
        size_fit_pts = 6;
        reasoningParts.push(`Size ${n} near ICP band — partial credit.`);
      } else {
        reasoningParts.push(`Size ${n} far from ICP band [${min}, ${max === Infinity ? "∞" : max}].`);
      }
    }
  } else {
    size_fit_pts = 5;
    reasoningParts.push("Employee size unknown — neutral credit.");
  }

  // ---- Geo fit (/15) ------------------------------------------------------
  let geo_fit_pts = 0;
  if (icp?.geo_regions?.length) {
    const candidates = [prospect.region, prospect.city, prospect.country_code]
      .filter(Boolean)
      .map((s) => (s as string).toLowerCase());
    const hit = icp.geo_regions.find((r) =>
      candidates.some((c) => c.includes(r.toLowerCase())),
    );
    if (hit) {
      geo_fit_pts = MAX_PTS.geo_fit_pts;
      reasoningParts.push(`Located in ICP region "${hit}".`);
    } else {
      reasoningParts.push("Outside ICP geo regions.");
    }
  } else {
    geo_fit_pts = 8;
  }

  // ---- Digital maturity (/15) --------------------------------------------
  let digital_maturity_pts = 0;
  const tech = research?.tech_stack ?? [];
  if (tech.length === 0) {
    reasoningParts.push("No tech stack detected — likely brochure site or insufficient research.");
  } else {
    // Cap at 3 tools = 9 pts, then bonuses for marketing maturity tools.
    digital_maturity_pts = Math.min(tech.length, 3) * 3;
    const marketingTools = ["Klaviyo", "Mailchimp", "HubSpot", "Recharge", "Gorgias"];
    const hasMarketing = tech.some((t) => marketingTools.includes(t));
    const hasAnalytics = tech.some((t) =>
      ["Google Analytics", "Meta Pixel", "Google Tag Manager"].includes(t),
    );
    if (hasMarketing) digital_maturity_pts += 4;
    if (hasAnalytics) digital_maturity_pts += 2;
    digital_maturity_pts = Math.min(digital_maturity_pts, MAX_PTS.digital_maturity_pts);
    reasoningParts.push(`${tech.length} tech tool(s) detected${hasMarketing ? ", incl. marketing automation" : ""}.`);
  }

  // ---- Pain signal (/15) --------------------------------------------------
  let pain_signal_pts = 0;
  const pains = research?.pain_points ?? [];
  const painsWithEvidence = pains.filter((p) => p.evidence_quote || p.evidence_url);
  if (pains.length === 0) {
    reasoningParts.push("No pain points captured.");
  } else {
    pain_signal_pts = Math.min(pains.length * 4, MAX_PTS.pain_signal_pts);
    if (painsWithEvidence.length > 0) {
      reasoningParts.push(
        `${pains.length} pain point(s) captured, ${painsWithEvidence.length} with evidence.`,
      );
    } else {
      pain_signal_pts = Math.max(pain_signal_pts - 4, 0);
      reasoningParts.push(`${pains.length} pain point(s) captured but no evidence cited — penalized.`);
    }
  }

  // ---- Service match (/10) — placeholder ---------------------------------
  // Stub: any pain with a canonical pain_id implies SOME service should match.
  // Phase 2 replaces this with case_study_pains lookup + best_service inference.
  const service_match_pts = pains.some((p) => p.pain_id)
    ? MAX_PTS.service_match_pts
    : Math.min(pains.length, 1) * 4;

  // ---- Contact discoverability (/10) -------------------------------------
  // Stub: scraper writes contact emails into research.notes (next slice
  // will move to a dedicated `prospect_contacts` table). For now, evidence
  // URL count is a weak proxy.
  let contact_discoverability_pts = 0;
  const evidenceCount = research?.evidence_urls?.length ?? 0;
  if (evidenceCount >= 3) contact_discoverability_pts = MAX_PTS.contact_discoverability_pts;
  else if (evidenceCount >= 1) contact_discoverability_pts = 5;

  // ---- Red flag penalty (capped at -30) ----------------------------------
  const red_flag_penalty = Math.min(prospect.red_flags.length * 10, 30);
  if (red_flag_penalty > 0) {
    reasoningParts.push(`Red flag(s): ${prospect.red_flags.join(", ")} → -${red_flag_penalty}.`);
  }

  // ---- Excluded-keyword instant disqualifier ------------------------------
  // ICPs can list keywords that should suppress a prospect. If any appear in
  // industry / what_they_do, we slash the score in half (don't zero — the
  // user can override). Phase 2 turns this into status='suppressed'.
  let exclusionFactor = 1;
  if (icp?.excluded_keywords?.length) {
    const haystack = [prospect.industry, research?.what_they_do]
      .filter(Boolean)
      .join(" ")
      .toLowerCase();
    const banned = icp.excluded_keywords.find((k) => haystack.includes(k.toLowerCase()));
    if (banned) {
      exclusionFactor = 0.5;
      reasoningParts.push(`Excluded keyword "${banned}" detected — score halved.`);
    }
  }

  const breakdown: RubricBreakdown = {
    industry_fit_pts,
    size_fit_pts,
    digital_maturity_pts,
    pain_signal_pts,
    service_match_pts,
    contact_discoverability_pts,
    geo_fit_pts,
    red_flag_penalty,
  };

  const subtotal =
    industry_fit_pts +
    size_fit_pts +
    digital_maturity_pts +
    pain_signal_pts +
    service_match_pts +
    contact_discoverability_pts +
    geo_fit_pts -
    red_flag_penalty;

  const composite_score = clamp(Math.round(subtotal * exclusionFactor), 0, 100);

  // Confidence is a coarse signal of how much input we had.
  const inputs =
    Number(Boolean(prospect.industry)) +
    Number(prospect.employee_size_estimate !== null) +
    Number(tech.length > 0) +
    Number(pains.length > 0) +
    Number(research?.what_they_do !== null && research?.what_they_do !== "");
  const confidence = clamp(inputs / 5, 0.2, 0.95);

  return {
    composite_score,
    breakdown,
    confidence,
    reasoning:
      reasoningParts.join(" ") ||
      "Insufficient signal — heuristic scorer used. Phase 2 will rescore with Claude.",
  };
}

function clamp(n: number, min: number, max: number): number {
  return Math.min(Math.max(n, min), max);
}
