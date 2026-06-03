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

// ── Province / state abbreviation expansion ───────────────────────────────────
// Google Places and YP both return two-letter codes (e.g. "AB"), but ICPs
// store full province names (e.g. "Alberta"). Without this map, geo matching
// fails for every Canadian prospect.
const CANADIAN_PROVINCE_ABBREV: Record<string, string> = {
  "ab": "Alberta",
  "bc": "British Columbia",
  "mb": "Manitoba",
  "nb": "New Brunswick",
  "nl": "Newfoundland and Labrador",
  "nt": "Northwest Territories",
  "ns": "Nova Scotia",
  "nu": "Nunavut",
  "on": "Ontario",
  "pe": "Prince Edward Island",
  "qc": "Quebec",
  "sk": "Saskatchewan",
  "yt": "Yukon",
};

export type RubricInputProspect = {
  industry: string | null;
  city: string | null;
  region: string | null;
  country_code: string | null;
  employee_size_estimate: number | null;
  red_flags: string[];
  has_verified_contact?: boolean; // true if prospect_contacts has a real email
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
  // Token-based matching so "direct to consumer" matches "consumer goods",
  // "furniture store" matches "furniture", etc. Pure substring matching fails
  // when the ICP tag is an abbreviation ("dtc") or the prospect industry is
  // a multi-word phrase ("direct to consumer").
  let industry_fit_pts = 0;
  if (prospect.industry && icp?.industry_tags?.length) {
    const lower = prospect.industry.toLowerCase();
    const tokens = lower.split(/[\s\-/,]+/).filter((t) => t.length > 2);
    const hit = icp.industry_tags.find((t) => {
      const tLower = t.toLowerCase();
      // Direct substring match (handles "consumer goods" ⊂ "consumer goods")
      if (lower.includes(tLower)) return true;
      // Token match: any individual word in the industry string matches the tag
      // e.g. "furniture store" has token "furniture" which matches tag "furniture"
      if (tokens.some((tok) => tLower.includes(tok) || tok.includes(tLower))) return true;
      return false;
    });
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
  // Province abbreviations (AB, BC, ON…) are expanded to full names before
  // matching so "AB" correctly matches ICP geo_region "Alberta".
  let geo_fit_pts = 0;
  if (icp?.geo_regions?.length) {
    const rawCandidates = [prospect.region, prospect.city, prospect.country_code]
      .filter(Boolean)
      .map((s) => (s as string).toLowerCase());

    // Expand two-letter abbreviations to full province names
    const expandedCandidates = rawCandidates.flatMap((c) => {
      const full = CANADIAN_PROVINCE_ABBREV[c];
      return full ? [c, full.toLowerCase()] : [c];
    });

    const hit = icp.geo_regions.find((r) => {
      const rLower = r.toLowerCase();
      return expandedCandidates.some(
        (c) => c.includes(rLower) || rLower.includes(c),
      );
    });

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

  // ---- Service match (/10) — graduated scoring ───────────────────────────
  // Canonical pain_id = full 10 pts (maps to a Runna service definitively).
  // Labelled pain + evidence = 6 pts (clear signal, just not yet taxonomised).
  // Bare label only = 4 pts (weak signal — pain named but no proof).
  const service_match_pts = pains.some((p) => p.pain_id)
    ? MAX_PTS.service_match_pts
    : pains.some((p) => p.pain_label && p.evidence_quote)
      ? Math.round(MAX_PTS.service_match_pts * 0.6) // 6 pts
      : Math.min(pains.length, 1) * 4;              // 4 pts

  // ---- Contact discoverability (/10) -------------------------------------
  // Primary signal: whether SnapVerify/Anymail/Hunter found a real email.
  // Secondary signal: evidence URL count as a weak proxy when no contact yet.
  let contact_discoverability_pts = 0;
  if (prospect.has_verified_contact) {
    contact_discoverability_pts = MAX_PTS.contact_discoverability_pts; // 10 pts — email confirmed
    reasoningParts.push("Verified contact email found → +10.");
  } else {
    const evidenceCount = research?.evidence_urls?.length ?? 0;
    if (evidenceCount >= 3) contact_discoverability_pts = 6;
    else if (evidenceCount >= 1) contact_discoverability_pts = 3;
  }

  // ---- Red flag penalty (capped at -30) ----------------------------------
  const red_flag_penalty = Math.min(prospect.red_flags.length * 10, 30);
  if (red_flag_penalty > 0) {
    reasoningParts.push(`Red flag(s): ${prospect.red_flags.join(", ")} → -${red_flag_penalty}.`);
  }

  // ---- Excluded-keyword instant disqualifier ------------------------------
  // Uses word-boundary regex (\b) so excluded keyword "agency" does NOT match
  // "No visible agency relationships" (a non-agency company), but DOES match
  // "We are a web agency" (an actual agency). Multi-word phrases like
  // "web agency" are also supported.
  let exclusionFactor = 1;
  if (icp?.excluded_keywords?.length) {
    const haystack = [prospect.industry, research?.what_they_do]
      .filter(Boolean)
      .join(" ")
      .toLowerCase();
    const banned = icp.excluded_keywords.find((k) => {
      const escaped = k.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      return new RegExp(`\\b${escaped}\\b`, "i").test(haystack);
    });
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
