/**
 * Claude-powered ICP scorer — Phase 2 replacement for scoreWithHeuristic.
 *
 * Uses claude-3-5-haiku for cost efficiency (~$0.001-$0.002 per score call).
 * Returns the same RubricResult shape so score-action.ts needs no structural
 * changes — only the swap point changes.
 *
 * Falls back silently to the heuristic scorer on any Claude error so callers
 * are never blocked by API issues.
 */

import { z } from "zod";
import {
  ANTHROPIC_HAIKU_MODEL,
  structuredCall,
  type ClaudeUsage,
} from "@/lib/anthropic/client";
import {
  scoreWithHeuristic,
  type RubricInputIcp,
  type RubricInputProspect,
  type RubricInputResearch,
  type RubricResult,
} from "./rubric";

const MODEL = ANTHROPIC_HAIKU_MODEL; // claude-haiku-4-5

const ZERO_USAGE: ClaudeUsage = {
  input_tokens: 0,
  output_tokens: 0,
  cache_read_input_tokens: 0,
  cache_creation_input_tokens: 0,
  cost_usd: 0,
};

// Loose schema — the API returns numbers; we clamp to rubric ranges afterwards
// (clampToRubric) so a slightly out-of-range value is corrected, not rejected.
const scorerSchema = z.object({
  composite_score: z.number(),
  breakdown: z.object({
    industry_fit_pts: z.number(),
    size_fit_pts: z.number(),
    digital_maturity_pts: z.number(),
    pain_signal_pts: z.number(),
    service_match_pts: z.number(),
    contact_discoverability_pts: z.number(),
    geo_fit_pts: z.number(),
    red_flag_penalty: z.number(),
  }),
  confidence: z.number(),
  reasoning: z.string().optional(),
});

export type ClaudeScorerResult = RubricResult & {
  cost_usd: number;
  model: string;
  /** Token usage for cost_tracking. Zero on the heuristic fallback. */
  usage: ClaudeUsage;
};

// ── Entry point ───────────────────────────────────────────────────────────────

export async function scoreWithClaude(
  prospect: RubricInputProspect,
  research: RubricInputResearch,
  icp: RubricInputIcp,
): Promise<ClaudeScorerResult> {
  // Routed through the shared structuredCall so it inherits the no-keepalive
  // client, JSON+Zod parsing, and returned token usage for cost tracking.
  const call = await structuredCall({
    model: MODEL,
    system: buildSystemPrompt(),
    user: buildUserPrompt(prospect, research, icp),
    max_tokens: 800,
    schema: scorerSchema,
  });

  if (!call.ok) {
    const errMsg = call.error.slice(0, 120);
    console.error("[claude-scorer] Claude call failed — falling back to heuristic:", errMsg);
    const fallback = scoreWithHeuristic(prospect, research, icp);
    return {
      ...fallback,
      cost_usd: 0,
      model: "heuristic_fallback",
      usage: ZERO_USAGE,
      // Surface why Claude wasn't used so the UI "heuristic" label is debuggable
      reasoning: `[Heuristic — Claude error: ${errMsg}] ${fallback.reasoning}`,
    };
  }

  const parsed = clampToRubric(call.data);
  return { ...parsed, cost_usd: call.usage.cost_usd, model: MODEL, usage: call.usage };
}

// ── Prompt builders ───────────────────────────────────────────────────────────
// Split into a static system prompt (rules + rubric + JSON shape — identical
// every call) and a per-prospect user prompt (ICP + prospect + research data).

function buildUserPrompt(
  prospect: RubricInputProspect,
  research: RubricInputResearch,
  icp: RubricInputIcp,
): string {
  const icpBlock = icp
    ? `Industry tags: ${icp.industry_tags.join(", ") || "any"}
Business types (the kinds of business this ICP targets — a prospect matching one of these is a FIT, even if it sells services): ${icp.business_types.join(", ") || "any"}
Geo regions: ${icp.geo_regions.join(", ") || "any"}
Employee size: ${icp.employee_size_min ?? 0}–${icp.employee_size_max ?? "∞"}
Search keywords: ${icp.search_keywords.join(", ") || "none"}
Excluded keywords (match whole words only, not substrings — "agency" in "no visible agency relationships" is NOT a match): ${icp.excluded_keywords.join(", ") || "none"}`
    : "No ICP defined — score neutrally.";

  const prospectBlock = `Industry: ${prospect.industry ?? "unknown"}
City: ${prospect.city ?? "unknown"}, Region: ${prospect.region ?? "unknown"}, Country: ${prospect.country_code ?? "unknown"}
Employee estimate: ${prospect.employee_size_estimate ?? "unknown"}
Red flags: ${prospect.red_flags.length > 0 ? prospect.red_flags.join(", ") : "none"}`;

  const researchBlock = research
    ? `What they do: ${research.what_they_do ?? "not scraped"}
Tech stack: ${research.tech_stack.length > 0 ? research.tech_stack.join(", ") : "none detected"}
Pain points documented: ${research.pain_points.length}
Evidence URLs: ${research.evidence_urls.length}`
    : "No research data yet.";

  return `ICP:
${icpBlock}

PROSPECT:
${prospectBlock}

RESEARCH:
${researchBlock}`;
}

function buildSystemPrompt(): string {
  return `You are scoring a B2B sales prospect for Runna, a digital marketing agency. Runna sells marketing services to SMBs: websites, booking apps, social media management, video/ad creative, email marketing, paid media, and marketing automation. Runna's customers are businesses that NEED those services — both product brands (DTC/ecommerce) AND service businesses (fitness studios, gyms, clinics, salons, restaurants, hospitality, local services). Operating market: Canada and Mexico.

CRITICAL RULE — EXCLUDE ONLY COMPETITORS AND ALREADY-SERVED BUSINESSES:
Hard-reject (set industry_fit_pts = 0, service_match_pts = 0, composite_score ≤ 10, and say so in reasoning) ONLY when the prospect is one of:
  (a) A Runna COMPETITOR — a marketing/digital/creative/branding/advertising agency, SEO firm, web-development shop, or growth/marketing consultancy (i.e. they SELL marketing/creative/dev services to other businesses).
  (b) ALREADY SERVED — clear evidence they already have a dedicated marketing/creative agency handling their marketing.
Do NOT hard-reject a business merely because it "sells services." A fitness studio, clinic, restaurant, or salon sells services to consumers but is a PERFECT Runna customer — it needs websites, booking, social, ads, and email. Score these normally on fit + pain.

PROSPECT TYPES THAT SCORE WELL: DTC/product brands AND consumer-facing service businesses — fitness studios, gyms, yoga/pilates, clinics, dental/med-spa, salons, restaurants, cafes, hospitality, local services, etc. Anything with a real marketing surface and a decision-maker to reach.

Score the prospect against the ICP (provided in the user message) using this rubric. Return ONLY valid JSON — no markdown, no explanation outside the JSON.

RUBRIC DIMENSIONS (max points):
- industry_fit_pts (max 20): Match to the ICP's industry_tags AND business_types. A consumer-facing service business that matches the ICP's targeted types is a fit — do NOT zero it for being a service business. 0 only for competitors/agencies (see CRITICAL RULE) or a genuinely off-ICP industry.
- size_fit_pts (max 15): Employee count within ICP band
- digital_maturity_pts (max 15): Sophistication of their marketing tech stack
- pain_signal_pts (max 15): Documented pain points with evidence
- service_match_pts (max 10): How well Runna's services (websites, booking apps, social, video/ad creative, email, paid media, automation) fit this prospect's marketing needs. Most SMBs with any marketing surface score moderate-to-high here. 0 ONLY for competitors or a business with no marketing surface at all — NOT for "sells services instead of products".
- contact_discoverability_pts (max 10): Ease of finding decision-maker contact
- geo_fit_pts (max 15): Prospect in ICP's target geography
- red_flag_penalty: −10 per red flag, max −30 total

Return exactly this JSON shape:
{
  "composite_score": <integer 0–100, sum of pts minus penalty, clamped>,
  "breakdown": {
    "industry_fit_pts": <0–20>,
    "size_fit_pts": <0–15>,
    "digital_maturity_pts": <0–15>,
    "pain_signal_pts": <0–15>,
    "service_match_pts": <0–10>,
    "contact_discoverability_pts": <0–10>,
    "geo_fit_pts": <0–15>,
    "red_flag_penalty": <0 or negative integer>
  },
  "confidence": <0.1–0.95 based on data completeness>,
  "reasoning": "<2–4 sentence plain-English explanation of the score>"
}`;
}

// ── Response clamp ─────────────────────────────────────────────────────────────
// structuredCall already JSON-parsed + Zod-validated the shape; here we only
// clamp each field into its rubric range (same behaviour as the old parser).

function clampToRubric(data: z.infer<typeof scorerSchema>): RubricResult {
  const clamp = (n: number, min: number, max: number): number =>
    Math.min(Math.max(Math.round(Number(n) || 0), min), max);

  const bd = data.breakdown;
  const breakdown = {
    industry_fit_pts: clamp(bd.industry_fit_pts, 0, 20),
    size_fit_pts: clamp(bd.size_fit_pts, 0, 15),
    digital_maturity_pts: clamp(bd.digital_maturity_pts, 0, 15),
    pain_signal_pts: clamp(bd.pain_signal_pts, 0, 15),
    service_match_pts: clamp(bd.service_match_pts, 0, 10),
    contact_discoverability_pts: clamp(bd.contact_discoverability_pts, 0, 10),
    geo_fit_pts: clamp(bd.geo_fit_pts, 0, 15),
    red_flag_penalty: clamp(bd.red_flag_penalty, -30, 0),
  };

  const composite_score = clamp(data.composite_score, 0, 100);
  const confidence = Math.min(Math.max(Number(data.confidence) || 0.5, 0.1), 0.95);
  const reasoning = typeof data.reasoning === "string" ? data.reasoning : "Scored by Claude.";

  return { composite_score, breakdown, confidence, reasoning };
}
