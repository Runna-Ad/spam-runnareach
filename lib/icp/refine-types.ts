/**
 * Client-safe types for the ICP Refinement Advisor (Learning Loop — PHASE 1).
 *
 * Lives in its own file with ZERO server imports so client components (the ICP
 * edit drawer) can import these types without dragging `next/headers` /
 * createClient into the browser bundle. See tasks/lessons.md
 * "Splitting server-only queries from client-safe constants poisons the client bundle".
 */

export type Counted = { name: string; count: number; pain_id?: string | null };

export type IcpEvidence = {
  prospectCount: number;
  researchedCount: number;
  avgScore: number | null;
  topPains: Counted[];
  topTech: Counted[];
  industriesPresent: Counted[];
  whatTheyDoSamples: string[];
  scoreReasoningSamples: string[];
  runnaStrength: {
    caseStudyIndustries: string[];
    coveredPains: Counted[];
    services: string[];
  };
};

/** Proposed field values — additive suggestions merged into the form on apply. */
export type IcpProposed = {
  industry_tags: string[];
  business_types: string[];
  search_keywords: string[];
  excluded_keywords: string[];
  employee_size_min: string | null;
  employee_size_max: string | null;
};

export type IcpRefinement = {
  ok: boolean;
  evidence: IcpEvidence;
  proposed: IcpProposed;
  /** Per-field one-line justification, keyed by field name. */
  fieldRationales: Partial<Record<keyof IcpProposed, string>>;
  /** Overall "what the evidence shows" paragraph. */
  summary: string;
  method: "claude" | "heuristic" | "insufficient_data";
  /** Always-on disclaimer: hypothesis, not validated learning. */
  note: string;
};
