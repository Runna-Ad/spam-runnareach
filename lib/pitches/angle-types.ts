/**
 * Client-safe types for the Pitch Angle Advisor (Learning Loop — PHASE 1).
 *
 * No server imports — safe to import from client components (prospect detail,
 * pitches page). See tasks/lessons.md on RSC bundle bleed.
 */

export type AngleStrength = "strong" | "moderate" | "exploratory";

export type PitchAngle = {
  /** The prospect pain this angle leads with. */
  painLabel: string;
  painId: string | null;
  /** Evidence quote from the prospect's research that grounds the pain (if any). */
  evidenceQuote: string | null;
  /** Runna case study that proves we can solve it (if a credible match exists). */
  caseStudyClient: string | null;
  caseStudyId: string | null;
  /** The case's headline metric (real number/%), if present. */
  caseMetric: string | null;
  /** The Runna service that delivers the fix. */
  serviceLabel: string | null;
  serviceId: string | null;
  /** One-line "why this angle" rationale, grounded in the data. */
  rationale: string;
  strength: AngleStrength;
};

export type PitchAngleResult = {
  ok: boolean;
  prospectName: string;
  angles: PitchAngle[];
  /** Disclaimer + any "not enough data" explanation. */
  note: string;
  method: "claude" | "heuristic" | "insufficient_data";
};
