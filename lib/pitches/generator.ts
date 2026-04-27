/**
 * Pure heuristic pitch composer. Phase-2 swap point: replace the body
 * of `composePitchHeuristic` with a Claude call that returns the same
 * `ComposedPitch` shape and the rest of the pipeline doesn't change.
 *
 * Strategy:
 *   1. Pick the best pain — first one from research.pain_points that
 *      has both pain_id AND evidence_quote (we need both for the email
 *      to feel personalized). Fallback: first pain with a label.
 *   2. Pick the best case study — case_study_pain_tags filter for that
 *      pain_id, then prefer (a) industry match with prospect, (b)
 *      highest strength score. Fallback: any case study tagged for the
 *      pain. Last fallback: highest-strength case study for any pain.
 *   3. Pick the decision-maker — first prospect_contacts row, prefer
 *      non-role-based. Fallback: from_email if a research email is
 *      present in notes. Last fallback: "there" (no name).
 *   4. Slot into the localized template (en/es per prospect.language).
 *   5. Compute quality_self_score from input completeness — proxy for
 *      whether the pitch will read well or look generic.
 *
 * Returns null if there's no case study at all (hard requirement —
 * pitches.case_study_id is NOT NULL).
 */

import { getTemplate, type TemplateVars } from "./templates.ts";

export type GeneratorInputProspect = {
  id: string;
  company_name: string;
  industry: string | null;
  language: "en" | "es";
};

export type GeneratorInputResearchPain = {
  pain_id: string | null;
  pain_label: string | null;
  evidence_quote: string | null;
};

export type GeneratorInputContact = {
  full_name: string | null;
  email: string | null;
  email_is_role_based: boolean;
};

export type GeneratorInputCaseStudy = {
  id: string;
  client_name: string;
  industry: string | null;
  hero_metric_en: string | null;
  hero_metric_es: string | null;
  /** Full result paragraph — gives Claude context to judge fit beyond client_name. */
  result_description_en: string | null;
  result_description_es: string | null;
  /** Optional testimonial — adds voice + credibility signal. */
  testimonial_quote_en: string | null;
  testimonial_quote_es: string | null;
  /** Array of measurable_results [{ metric, label }] — surfaces numbers to cite. */
  measurable_results: { metric?: string; label?: string }[];
  /** strength from case_study_pain_tags for the chosen pain (0..1), or null. */
  pain_strength: number | null;
};

export type GeneratorInputSender = {
  full_name: string | null;
  tenant_display_name: string;
};

export type ComposedPitch = {
  subject: string;
  body: string;
  pain_id: string | null;
  /**
   * Null when no case study clearly addressed the prospect's pain.
   * Body must NOT reference any client name in that case — the
   * pitch leans on a generic capability claim instead of a fake
   * "we helped X" bridge.
   */
  case_study_id: string | null;
  contact_used: string | null;
  measurable_result_included: boolean;
  quality_self_score: number; // 0..1
  reasoning: string;
};

export type GeneratorInputs = {
  prospect: GeneratorInputProspect;
  pains: GeneratorInputResearchPain[];
  contacts: GeneratorInputContact[];
  case_studies: GeneratorInputCaseStudy[];
  sender: GeneratorInputSender;
  /** Optional URL pattern for deep-link to runna-website pitch. Empty = no link. */
  deep_pitch_url?: string | null;
};

export function composePitchHeuristic(input: GeneratorInputs): ComposedPitch | null {
  const reasoning: string[] = [];

  // 1) Pain selection
  const evidencedPain =
    input.pains.find((p) => p.pain_id && p.evidence_quote) ?? null;
  const labelOnlyPain =
    !evidencedPain ? input.pains.find((p) => p.pain_label) ?? null : null;
  const chosenPain = evidencedPain ?? labelOnlyPain;

  if (chosenPain?.evidence_quote) {
    reasoning.push(`Pain: "${chosenPain.pain_label}" (with evidence).`);
  } else if (chosenPain) {
    reasoning.push(`Pain: "${chosenPain.pain_label}" (label-only — no evidence).`);
  } else {
    reasoning.push("No pain captured — pitch will be generic.");
  }

  // 2) Case study selection
  // Only consider case studies that have a non-null pain_strength for the
  // chosen pain. If pain_strength is null, the case wasn't tagged for this
  // pain — including it produces the "Pet's Club for a checkout pain" bug
  // we caught on 2026-04-27.
  const tagged = chosenPain?.pain_id
    ? input.case_studies.filter((cs) => cs.pain_strength !== null && cs.pain_strength > 0)
    : [];
  const sorted = [...tagged].sort((a, b) => {
    const aIndustryMatch = industryMatch(a.industry, input.prospect.industry) ? 1 : 0;
    const bIndustryMatch = industryMatch(b.industry, input.prospect.industry) ? 1 : 0;
    if (aIndustryMatch !== bIndustryMatch) return bIndustryMatch - aIndustryMatch;
    return (b.pain_strength ?? 0) - (a.pain_strength ?? 0);
  });
  // Hard floor: only pick a case if its pain_strength is at least 0.4
  // (loosely — needs to be actually relevant). Below that, prefer null +
  // a no-case body over a forced-fit bridge.
  const chosenCase = sorted[0] && (sorted[0].pain_strength ?? 0) >= 0.4 ? sorted[0] : null;
  if (chosenCase) {
    reasoning.push(
      `Case: ${chosenCase.client_name} (${
        industryMatch(chosenCase.industry, input.prospect.industry)
          ? "industry match"
          : "no industry match"
      }, strength=${chosenCase.pain_strength ?? "n/a"}).`,
    );
  } else if (input.case_studies.length === 0) {
    reasoning.push("No case studies available.");
  } else {
    reasoning.push(
      `No case study clearly addresses the chosen pain (best strength=${
        sorted[0]?.pain_strength ?? "n/a"
      }) — pitch will skip the case bridge.`,
    );
  }

  // 3) Contact selection
  const realContact =
    input.contacts.find((c) => !c.email_is_role_based && c.full_name) ??
    input.contacts.find((c) => !c.email_is_role_based) ??
    input.contacts[0] ??
    null;
  const firstName = extractFirstName(realContact?.full_name) ?? "there";
  if (realContact && firstName !== "there") {
    reasoning.push(`Contact: ${realContact.full_name} (${realContact.email ?? "no email"}).`);
  } else {
    reasoning.push("Contact: generic salutation — no decision-maker named.");
  }

  // 4) Template variables
  const heroMetric = chosenCase
    ? input.prospect.language === "es"
      ? chosenCase.hero_metric_es ?? chosenCase.hero_metric_en ?? "(metric pending)"
      : chosenCase.hero_metric_en ?? chosenCase.hero_metric_es ?? "(metric pending)"
    : "(no case)";

  const evidenceQuote = trimQuote(chosenPain?.evidence_quote ?? null);
  const senderFirst = extractFirstName(input.sender.full_name) ?? "Pedro";
  const senderSignature = buildSignature(input.sender);

  const tpl = getTemplate(input.prospect.language);
  const vars: TemplateVars = {
    first_name: firstName,
    company_name: input.prospect.company_name,
    industry: input.prospect.industry ?? (input.prospect.language === "es" ? "DTC" : "DTC"),
    evidence_quote: evidenceQuote,
    pain_label: chosenPain?.pain_label ?? (input.prospect.language === "es" ? "esto" : "this"),
    case_client: chosenCase?.client_name ?? "",
    case_metric: heroMetric,
    sender_first_name: senderFirst,
    sender_signature: senderSignature,
    deep_pitch_link_block: input.deep_pitch_url
      ? `\n\nMore context if useful: ${input.deep_pitch_url}`
      : "",
  };

  const subject = tpl.subject(vars);
  // When there's no case, render the no-case template variant which
  // skips the "We helped X" bridge and uses an agency-level claim.
  const body = chosenCase ? tpl.body(vars) : tpl.bodyNoCase(vars);

  // 5) Quality self-score
  const score = computeSelfScore({
    hasEvidence: Boolean(evidenceQuote),
    hasNamedContact: firstName !== "there",
    hasIndustryMatch: chosenCase
      ? industryMatch(chosenCase.industry, input.prospect.industry)
      : false,
    hasMetric: heroMetric !== "(metric pending)" && heroMetric !== "(no case)",
  });

  return {
    subject,
    body,
    pain_id: chosenPain?.pain_id ?? null,
    case_study_id: chosenCase?.id ?? null,
    contact_used: realContact?.email ?? null,
    measurable_result_included:
      heroMetric !== "(metric pending)" && heroMetric !== "(no case)",
    quality_self_score: score,
    reasoning: reasoning.join(" "),
  };
}

function industryMatch(a: string | null, b: string | null): boolean {
  if (!a || !b) return false;
  const al = a.toLowerCase();
  const bl = b.toLowerCase();
  if (al === bl) return true;
  // Substring either way (handles "DTC coffee" vs "coffee" vs "DTC apparel" vs "DTC").
  return al.includes(bl) || bl.includes(al);
}

function extractFirstName(fullName: string | null | undefined): string | null {
  if (!fullName) return null;
  const trimmed = fullName.trim();
  if (!trimmed) return null;
  return trimmed.split(/\s+/)[0] ?? null;
}

function trimQuote(quote: string | null): string {
  if (!quote) return "";
  const cleaned = quote.replace(/\s+/g, " ").trim();
  if (cleaned.length <= 120) return cleaned;
  return cleaned.slice(0, 117).trim() + "...";
}

function buildSignature(sender: GeneratorInputSender): string {
  const name = sender.full_name?.trim() || "Pedro De Velasco";
  return `${name}\n${sender.tenant_display_name}`;
}

function computeSelfScore(flags: {
  hasEvidence: boolean;
  hasNamedContact: boolean;
  hasIndustryMatch: boolean;
  hasMetric: boolean;
}): number {
  // Each flag worth 0.25 — combined = 0..1. Maps directly to the schema's
  // quality_self_score (numeric(3,2)).
  let s = 0;
  if (flags.hasEvidence) s += 0.35; // most important
  if (flags.hasMetric) s += 0.25;
  if (flags.hasNamedContact) s += 0.2;
  if (flags.hasIndustryMatch) s += 0.2;
  // Round to 2 decimals (matches DB precision).
  return Math.round(s * 100) / 100;
}
