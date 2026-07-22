/**
 * Verified benchmark lookup for the pitch composer.
 *
 * Only rows a human approved (verified_at set, is_active true) are ever
 * returned — the table's own CHECK constraint enforces that pairing, this is
 * the second half of it. Every row carries a citation, because an uncited
 * benchmark is a fabricated one wearing a database for a costume.
 *
 * Matching is on pain AND industry, deliberately. A DTC cart-abandonment figure
 * quoted at a construction firm is the same non-sequitur the composer already
 * bans for case studies ("⛔ NEVER bridge a case about a DIFFERENT service"), and
 * it would be more damaging here because a statistic reads as researched.
 *
 * Returning nothing is the expected, safe outcome. The composer writes the pitch
 * without a number, exactly as it does today.
 */

import type { createClient } from "@/lib/supabase/server";
import type { GeneratorInputBenchmark } from "@/lib/pitches/generator";

type Client = Awaited<ReturnType<typeof createClient>>;

type BenchmarkRow = {
  id: string;
  statistic: string;
  figure: string;
  publisher: string;
  source_url: string;
  pain_codes: string[];
  industry_scope: string[];
  market: string | null;
};

/** Loose industry comparison — mirrors generator.ts's industryMatch. */
function industryOverlaps(scope: string[], industry: string | null): boolean {
  // An empty scope means "universal". Rare and deliberate; most rows are scoped.
  if (scope.length === 0) return true;
  if (!industry) return false;
  const target = industry.toLowerCase();
  return scope.some((s) => {
    const sl = s.toLowerCase();
    return sl === target || sl.includes(target) || target.includes(sl);
  });
}

/**
 * Resolve the pain identifiers the pipeline carries into taxonomy CODES.
 *
 * pain_id is genuinely polymorphic here: the composer's own schema notes it
 * "can be a text slug like 'abandoned_cart_loss' or a UUID — accept both", and
 * stored pitches hold UUIDs. Benchmarks are tagged by code so seed rows stay
 * readable and survive a taxonomy re-key, so UUIDs get translated first.
 */
async function resolvePainCodes(
  supabase: Client,
  tenantId: string,
  painIds: string[],
): Promise<string[]> {
  const ids = painIds.filter(Boolean);
  if (ids.length === 0) return [];

  const isUuid = (s: string) =>
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s);
  const codes = ids.filter((i) => !isUuid(i));
  const uuids = ids.filter(isUuid);
  if (uuids.length === 0) return codes;

  type TaxRow = { id: string; code: string };
  const { data } = await supabase
    .from("pain_taxonomy")
    .select("id, code")
    .eq("tenant_id", tenantId)
    .in("id", uuids)
    .returns<TaxRow[]>();

  return [...codes, ...(data ?? []).map((r) => r.code)];
}

/**
 * Benchmarks citable for this prospect, best-effort.
 *
 * Never throws: a benchmark is an enhancement, and a lookup failure must not
 * cost a pitch. On any error the caller gets an empty list and writes the
 * number-free pitch.
 */
export async function fetchBenchmarksForPitch(
  supabase: Client,
  tenantId: string,
  opts: { painIds: string[]; industry: string | null; market: string | null },
): Promise<GeneratorInputBenchmark[]> {
  try {
    const codes = await resolvePainCodes(supabase, tenantId, opts.painIds);
    if (codes.length === 0) return [];

    const { data, error } = await supabase
      .from("benchmarks")
      .select("id, statistic, figure, publisher, source_url, pain_codes, industry_scope, market")
      .eq("tenant_id", tenantId)
      .eq("is_active", true)
      .not("verified_at", "is", null)
      .overlaps("pain_codes", codes)
      .returns<BenchmarkRow[]>();

    if (error || !data) return [];

    return data
      .filter((r) => industryOverlaps(r.industry_scope, opts.industry))
      // A geography-scoped row only applies in that market; unscoped applies anywhere.
      .filter((r) => !r.market || r.market === "GLOBAL" || r.market === opts.market)
      .map((r) => ({
        id: r.id,
        statistic: r.statistic,
        figure: r.figure,
        publisher: r.publisher,
        source_url: r.source_url,
      }));
  } catch {
    return [];
  }
}

/**
 * Every active benchmark figure for this tenant, for the send gate.
 *
 * Rule 5 holds a pitch whose number appears in no stored evidence. Until now
 * that could only ever say "no", because nothing was a legitimate source for a
 * figure. This is the allowlist that makes it enforceable rather than absolute.
 */
export async function fetchActiveBenchmarkFigures(
  supabase: Client,
  tenantId: string,
): Promise<string[]> {
  try {
    const { data } = await supabase
      .from("benchmarks")
      .select("figure")
      .eq("tenant_id", tenantId)
      .eq("is_active", true)
      .not("verified_at", "is", null)
      .returns<{ figure: string }[]>();
    return (data ?? []).map((r) => r.figure);
  } catch {
    return [];
  }
}
