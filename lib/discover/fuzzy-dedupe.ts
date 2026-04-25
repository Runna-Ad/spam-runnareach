/**
 * Fuzzy company dedupe.
 *
 * Two prospects are "the same company" if either:
 *   - Their normalized domains match exactly, OR
 *   - Their normalized names have a Jaccard similarity ≥ 0.85 over
 *     character-bigrams AND no domain conflict.
 *
 * The schema enforces `unique (tenant_id, domain)` so domain-level dedupe
 * happens at the DB layer. This module exists so the upload UI can preview
 * dedupe before insert and so name-only dedupe (no domain) is still possible.
 */

const SUFFIXES = [
  "inc",
  "incorporated",
  "llc",
  "ltd",
  "limited",
  "corp",
  "corporation",
  "co",
  "company",
  "gmbh",
  "ag",
  "sa",
  "srl",
  "bv",
  "plc",
  "the",
  "and",
  "&",
];

const COMMON_TLDS = new Set([
  "com",
  "ca",
  "co",
  "io",
  "net",
  "org",
  "biz",
  "us",
  "shop",
  "store",
  "agency",
]);

/**
 * Lowercases, strips punctuation, drops common corporate suffixes, collapses
 * whitespace. "Acme Corp." and "ACME, Inc." both normalize to "acme".
 */
export function normalizeCompanyName(raw: string): string {
  const stripped = raw
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "") // diacritics
    .replace(/[^a-z0-9\s&-]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  const tokens = stripped.split(" ").filter((t) => t.length > 0 && !SUFFIXES.includes(t));
  return tokens.join(" ");
}

/**
 * Lowercases, strips protocol + www + trailing slash + path/query.
 * "https://www.runna.agency/about?ref=foo" → "runna.agency".
 */
export function normalizeDomain(raw: string): string | null {
  const trimmed = raw.trim().toLowerCase();
  if (!trimmed) return null;
  let host = trimmed;
  try {
    const url = new URL(trimmed.startsWith("http") ? trimmed : `https://${trimmed}`);
    host = url.hostname;
  } catch {
    // fall through — treat input as a plain domain string
  }
  host = host.replace(/^www\./, "");
  if (!/^[a-z0-9.-]+\.[a-z]{2,}$/.test(host)) return null;
  return host;
}

/** Jaccard similarity of character-bigrams. Returns 0..1. */
export function nameSimilarity(a: string, b: string): number {
  const bigrams = (s: string): Set<string> => {
    if (s.length < 2) return new Set([s]);
    const out = new Set<string>();
    for (let i = 0; i < s.length - 1; i++) out.add(s.slice(i, i + 2));
    return out;
  };
  const A = bigrams(a);
  const B = bigrams(b);
  if (A.size === 0 || B.size === 0) return 0;
  let intersection = 0;
  for (const g of A) if (B.has(g)) intersection++;
  const union = A.size + B.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

export type DedupeKey = { name: string; domain: string | null };

/**
 * Returns the index of the first prior entry in `existing` that matches
 * `candidate`, or -1 if it's a new company.
 */
export function findDuplicate(candidate: DedupeKey, existing: DedupeKey[]): number {
  const cName = normalizeCompanyName(candidate.name);
  const cDomain = candidate.domain ? normalizeDomain(candidate.domain) : null;

  for (let i = 0; i < existing.length; i++) {
    const e = existing[i]!;
    const eDomain = e.domain ? normalizeDomain(e.domain) : null;
    if (cDomain && eDomain && cDomain === eDomain) return i;
    if (cDomain && eDomain && cDomain !== eDomain) continue; // domain conflict — different company
    if (nameSimilarity(cName, normalizeCompanyName(e.name)) >= 0.85) return i;
  }
  return -1;
}

// Suppress unused-export warning for COMMON_TLDS — kept exported for the
// industry-directory crawler in slice 1b.
export const _COMMON_TLDS = COMMON_TLDS;
