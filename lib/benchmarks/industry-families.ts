/**
 * Industry families for benchmark matching. Pure, no imports.
 *
 * A benchmark scoped to ["online store", "retail"] is just as true of a
 * boutique, but whole-word matching (`industryOverlaps`) cannot see that:
 * "boutique" contains neither word. Families close that gap by an explicit,
 * reviewed list instead of fuzzier matching.
 *
 * The lookup is on the WHOLE industry string (trimmed, lower-cased, accents
 * kept as stored), never on words inside it. Word containment is exactly the
 * mistake this avoids: "boutique hotel" contains "boutique" and is a hotel,
 * not a store, so it must never be offered a cart-abandonment figure.
 */

const FAMILIES: Record<string, readonly string[]> = {
  retail: ["online store", "retail", "boutique", "direct to consumer", "tienda", "ecommerce", "e-commerce"],
  b2b_industrial: [
    "manufacturer",
    "manufacturing",
    "industrial supplier",
    "distribution",
    "distributor",
    "wholesale",
    "wholesale distributor",
    "supply chain",
    "logistics",
  ],
  professional: [
    "accounting firm",
    "chartered accountant",
    "despacho contable",
    "asesoría fiscal",
    "law firm",
    "despacho de abogados",
    "consultoría",
    "consulting firm",
    "agencia de seguros",
  ],
  clinic: ["hospital", "clínica", "consultorio dental", "fisioterapia"],
  wellness: ["spa", "salón de belleza", "estética", "fitness studio", "gimnasio"],
  food: ["restaurant", "restaurante", "restaurant group", "bar", "panadería"],
  lodging: ["hotel", "hotel chain", "boutique hotel"],
  // "outdoor" would go here once Pedro decides which family it belongs to
  // (open question 2026-10-21); until then it matches only directly.
};

const BY_INDUSTRY: ReadonlyMap<string, string> = new Map(
  Object.entries(FAMILIES).flatMap(([family, members]) => members.map((m) => [m, family] as const)),
);

/** The family of an industry string, or null when it is in none. */
export function industryFamily(industry: string | null): string | null {
  if (!industry) return null;
  return BY_INDUSTRY.get(industry.trim().toLowerCase()) ?? null;
}

/** True when some scope term is in the same (non-null) family as `industry`. */
export function sameIndustryFamily(scope: readonly string[], industry: string | null): boolean {
  const family = industryFamily(industry);
  if (!family) return false;
  return scope.some((s) => industryFamily(s) === family);
}
