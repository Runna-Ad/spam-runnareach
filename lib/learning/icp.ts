/**
 * Smarter ICPs: grow the scout's search space toward what converts.
 *
 * Two signals rank industries:
 *   - outcomes: the scout reward of prospects in that industry (what research,
 *     pitching and replies taught us), with a Beta prior so a single lucky
 *     reply doesn't dominate;
 *   - the Inefficiency Hunter: industries whose owners run the free check on
 *     their own (organic scans, no attribution code) are telling us they feel
 *     the problem, a demand signal no outbound list has.
 *
 * `proposeCells` turns the top industries into new search cells for each
 * active ICP (its market's language, its regions), skipping what the ICP
 * already searches. They enter the scout as fresh challengers, so they earn
 * traffic only if they pay off.
 *
 * Pure — tested in tests/icp-learner.test.ts.
 */

import type { HunterIndustryKey, SegmentIndustry } from "./segments.ts";
import { cellKey, type SearchCell } from "./scout.ts";

/** Search phrases a directory understands, per industry and language. */
export const SEARCH_TERMS: Record<SegmentIndustry, { en: string[]; es: string[] }> = {
  manufacturing: { en: ["manufacturer", "metal fabrication"], es: ["fábrica", "manufactura"] },
  distribution: { en: ["wholesale distributor"], es: ["distribuidora"] },
  logistics: { en: ["trucking company", "freight company"], es: ["transporte de carga"] },
  construction: { en: ["general contractor", "home builder"], es: ["constructora"] },
  trades: { en: ["plumber", "electrician", "hvac contractor"], es: ["plomero", "electricista"] },
  legal: { en: ["law firm"], es: ["despacho de abogados"] },
  accounting: { en: ["accounting firm"], es: ["despacho contable"] },
  consulting: { en: ["business consultant"], es: ["consultoría empresarial"] },
  healthcare: { en: ["medical clinic", "physiotherapy clinic"], es: ["clínica médica"] },
  dental: { en: ["dental clinic"], es: ["clínica dental"] },
  fitness: { en: ["gym", "fitness studio"], es: ["gimnasio"] },
  beauty: { en: ["beauty salon", "day spa"], es: ["salón de belleza"] },
  restaurant: { en: ["restaurant"], es: ["restaurante"] },
  hospitality: { en: ["boutique hotel"], es: ["hotel boutique"] },
  realestate: { en: ["real estate agency"], es: ["inmobiliaria"] },
  retail: { en: ["retail store"], es: ["tienda"] },
  ecommerce: { en: ["online store"], es: ["tienda en línea"] },
  automotive: { en: ["auto repair shop", "car dealership"], es: ["taller mecánico", "agencia de autos"] },
  education: { en: ["private school", "tutoring centre"], es: ["escuela privada"] },
  other: { en: [], es: [] },
};

/** The Hunter's buckets → the S.P.A.M. industries inside each. */
export const FROM_HUNTER: Record<HunterIndustryKey, SegmentIndustry[]> = {
  proservices: ["legal", "accounting", "consulting"],
  trades: ["trades", "construction"],
  fitness: ["fitness", "beauty"],
  restaurant: ["restaurant"],
  hospitality: ["hospitality"],
  realestate: ["realestate"],
  retail: ["retail"],
  ecommerce: ["ecommerce"],
  automotive: ["automotive"],
  other: [],
};

export type IndustryEvidence = {
  /** Scout reward (0..1 per prospect) summed, and settled prospects. */
  reward: number;
  trials: number;
  /** Organic Hunter scans attributed to this industry (fractional when a bucket spans several). */
  hunterScans: number;
};

/** Posterior mean with a weak prior around the typical yield, plus a demand bonus. */
export function industryScore(e: IndustryEvidence, prior = { mean: 0.15, weight: 10 }): number {
  const mean = (e.reward + prior.mean * prior.weight) / (e.trials + prior.weight);
  return mean + 0.02 * Math.log1p(e.hunterScans);
}

/** Organic Hunter scans by Hunter bucket → evidence per S.P.A.M. industry. */
export function hunterDemand(scans: ReadonlyArray<{ industry: string | null }>): Map<SegmentIndustry, number> {
  const out = new Map<SegmentIndustry, number>();
  for (const s of scans) {
    const inside = FROM_HUNTER[(s.industry ?? "other") as HunterIndustryKey] ?? [];
    for (const ind of inside) out.set(ind, (out.get(ind) ?? 0) + 1 / inside.length);
  }
  return out;
}

export type IcpForCells = {
  id: string;
  market: string | null;
  search_keywords: string[] | null;
  geo_regions: string[] | null;
};

/**
 * New cells for the best industries the ICPs don't search yet. At most
 * `topIndustries` industries, `regionsPerIcp` regions each, `maxNew` cells.
 */
export function proposeCells(i: {
  icps: readonly IcpForCells[];
  evidence: ReadonlyMap<SegmentIndustry, IndustryEvidence>;
  existingKeys: ReadonlySet<string>;
  topIndustries?: number;
  regionsPerIcp?: number;
  maxNew?: number;
}): Array<{ cell: SearchCell; industry: SegmentIndustry; score: number }> {
  const top = i.topIndustries ?? 2;
  const perIcp = i.regionsPerIcp ?? 2;
  const maxNew = i.maxNew ?? 6;
  const ranked = [...i.evidence.entries()]
    .filter(([ind]) => ind !== "other")
    .map(([ind, e]) => ({ industry: ind, score: industryScore(e), e }))
    .filter((r) => r.e.trials > 0 || r.e.hunterScans > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, top);

  const out: Array<{ cell: SearchCell; industry: SegmentIndustry; score: number }> = [];
  for (const icp of i.icps) {
    const lang = (icp.market ?? "").toUpperCase() === "MX" ? "es" : "en";
    const searched = new Set((icp.search_keywords ?? []).map((k) => k.trim().toLowerCase()));
    const regions = (icp.geo_regions ?? []).filter(Boolean).slice(0, perIcp);
    for (const r of ranked) {
      const term = SEARCH_TERMS[r.industry][lang].find((t) => !searched.has(t.toLowerCase()));
      if (!term) continue;
      for (const region of regions.length ? regions : [null]) {
        const cell: SearchCell = { icpId: icp.id, keyword: term, region };
        const key = cellKey(cell);
        if (i.existingKeys.has(key) || out.some((o) => cellKey(o.cell) === key)) continue;
        out.push({ cell, industry: r.industry, score: r.score });
        if (out.length >= maxNew) return out;
      }
    }
  }
  return out;
}
