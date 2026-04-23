import type { CaseStudyWithRelations } from "./queries";

export type Completeness = {
  enComplete: boolean;
  esStatus: "missing" | "partial" | "complete";
  hasTestimonial: boolean;
};

/**
 * Derive bilingual completeness for a case study.
 *
 * EN complete = hero_metric_en + result_description_en both filled
 *   (testimonial is optional — only ~3 of 20 carry a real client testimonial)
 *
 * ES status compares the three translation-pair fields (hero, result, testimonial)
 *   missing  — EN has content, ES has none
 *   partial  — ES has some but not matching EN coverage
 *   complete — ES fields match EN coverage exactly (including nothing-in-both for a field)
 */
export function deriveCompleteness(
  cs: Pick<
    CaseStudyWithRelations,
    | "hero_metric_en"
    | "hero_metric_es"
    | "result_description_en"
    | "result_description_es"
    | "testimonial_quote_en"
    | "testimonial_quote_es"
  >,
): Completeness {
  const enComplete = hasValue(cs.hero_metric_en) && hasValue(cs.result_description_en);
  const hasTestimonial = hasValue(cs.testimonial_quote_en);

  const pairs: Array<[string | null, string | null]> = [
    [cs.hero_metric_en, cs.hero_metric_es],
    [cs.result_description_en, cs.result_description_es],
    [cs.testimonial_quote_en, cs.testimonial_quote_es],
  ];

  const pairsWithEn = pairs.filter(([en]) => hasValue(en));
  const matchedPairs = pairsWithEn.filter(([, es]) => hasValue(es));

  let esStatus: Completeness["esStatus"];
  if (pairsWithEn.length === 0) {
    esStatus = "missing";
  } else if (matchedPairs.length === 0) {
    esStatus = "missing";
  } else if (matchedPairs.length === pairsWithEn.length) {
    esStatus = "complete";
  } else {
    esStatus = "partial";
  }

  return { enComplete, esStatus, hasTestimonial };
}

function hasValue(v: string | null | undefined): boolean {
  return typeof v === "string" && v.trim().length > 0;
}
