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

import Anthropic from "@anthropic-ai/sdk";
import { ANTHROPIC_HAIKU_MODEL } from "@/lib/anthropic/client";
import {
  scoreWithHeuristic,
  type RubricInputIcp,
  type RubricInputProspect,
  type RubricInputResearch,
  type RubricResult,
} from "./rubric";

const MODEL = ANTHROPIC_HAIKU_MODEL; // claude-haiku-4-5

// Anthropic pricing for claude-haiku-4-5
const INPUT_PRICE_PER_TOKEN = 0.000001;  // $1.00 / 1M
const OUTPUT_PRICE_PER_TOKEN = 0.000005; // $5.00 / 1M

export type ClaudeScorerResult = RubricResult & {
  cost_usd: number;
  model: string;
};

// ── Entry point ───────────────────────────────────────────────────────────────

export async function scoreWithClaude(
  prospect: RubricInputProspect,
  research: RubricInputResearch,
  icp: RubricInputIcp,
): Promise<ClaudeScorerResult> {
  const client = new Anthropic();

  try {
    const response = await client.messages.create({
      model: MODEL,
      max_tokens: 800,
      messages: [{ role: "user", content: buildPrompt(prospect, research, icp) }],
    });

    const raw = response.content
      .filter((b) => b.type === "text")
      .map((b) => (b as { type: "text"; text: string }).text)
      .join("");

    const parsed = parseResponse(raw);
    const cost_usd =
      response.usage.input_tokens * INPUT_PRICE_PER_TOKEN +
      response.usage.output_tokens * OUTPUT_PRICE_PER_TOKEN;

    return { ...parsed, cost_usd, model: MODEL };
  } catch (err) {
    const errMsg = err instanceof Error ? err.message.slice(0, 120) : String(err);
    console.error("[claude-scorer] Claude call failed — falling back to heuristic:", errMsg);
    const fallback = scoreWithHeuristic(prospect, research, icp);
    return {
      ...fallback,
      cost_usd: 0,
      model: "heuristic_fallback",
      // Surface why Claude wasn't used so the UI "heuristic" label is debuggable
      reasoning: `[Heuristic — Claude error: ${errMsg}] ${fallback.reasoning}`,
    };
  }
}

// ── Prompt builder ────────────────────────────────────────────────────────────

function buildPrompt(
  prospect: RubricInputProspect,
  research: RubricInputResearch,
  icp: RubricInputIcp,
): string {
  const icpBlock = icp
    ? `Industry tags: ${icp.industry_tags.join(", ") || "any"}
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

  return `You are scoring a B2B sales prospect for Runna, a digital marketing agency specializing in email marketing, paid media, and growth for ecommerce/DTC brands in Canada and Mexico.

CRITICAL RULE — COMPETITOR / SERVICE PROVIDER DETECTION:
If the prospect is a web development agency, digital marketing agency, SEO firm, design studio, software consultancy, or any other B2B service provider (i.e. they sell services TO businesses rather than selling products TO consumers), they are a COMPETITOR or at minimum a zero-fit prospect. In that case:
- Set industry_fit_pts = 0, service_match_pts = 0
- Set composite_score ≤ 10 regardless of other signals
- Note this explicitly in reasoning

PROSPECT TYPES THAT SCORE WELL: DTC product brands, online retailers, consumer goods companies, subscription box services, physical stores with ecommerce, food/beverage brands, apparel brands, beauty/cosmetics, home goods, pet products, sporting goods, etc.

Score the prospect against the ICP using this rubric. Return ONLY valid JSON — no markdown, no explanation outside the JSON.

RUBRIC DIMENSIONS (max points):
- industry_fit_pts (max 20): ICP industry match — 0 if they're a service provider/agency
- size_fit_pts (max 15): Employee count within ICP band
- digital_maturity_pts (max 15): Sophistication of their marketing tech stack
- pain_signal_pts (max 15): Documented pain points with evidence
- service_match_pts (max 10): Fit with email / paid media / growth services — 0 if they sell services not products
- contact_discoverability_pts (max 10): Ease of finding decision-maker contact
- geo_fit_pts (max 15): Prospect in ICP's target geography
- red_flag_penalty: −10 per red flag, max −30 total

ICP:
${icpBlock}

PROSPECT:
${prospectBlock}

RESEARCH:
${researchBlock}

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

// ── Response parser ───────────────────────────────────────────────────────────

function parseResponse(raw: string): RubricResult {
  // Strip markdown code fences if present
  const cleaned = raw
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```\s*$/, "")
    .trim();

  let obj: unknown;
  try {
    obj = JSON.parse(cleaned);
  } catch {
    // Try extracting JSON from a longer response
    const match = cleaned.match(/\{[\s\S]+\}/);
    if (!match) throw new Error("No JSON found in Claude response");
    obj = JSON.parse(match[0]);
  }

  if (!obj || typeof obj !== "object") throw new Error("Response is not an object");
  const r = obj as Record<string, unknown>;

  const bd = r.breakdown as Record<string, unknown> | undefined;
  if (!bd || typeof bd !== "object") throw new Error("Missing breakdown in response");

  const clamp = (n: unknown, min: number, max: number): number =>
    Math.min(Math.max(Math.round(Number(n) || 0), min), max);

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

  const composite_score = clamp(r.composite_score, 0, 100);
  const confidence = Math.min(Math.max(Number(r.confidence) || 0.5, 0.1), 0.95);
  const reasoning = typeof r.reasoning === "string" ? r.reasoning : "Scored by Claude.";

  return { composite_score, breakdown, confidence, reasoning };
}
