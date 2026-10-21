/**
 * Verified benchmark lookup for the pitch composer.
 *
 * Only rows a human approved (verified_at set, is_active true) are ever
 * returned — the table's own CHECK constraint enforces that pairing, this is
 * the second half of it. Every row carries a citation, because an uncited
 * benchmark is a fabricated one wearing a database for a costume.
 *
 * Matching is on pain AND industry (or industry family), deliberately. A DTC cart-abandonment figure
 * quoted at a construction firm is the same non-sequitur the composer already
 * bans for case studies ("⛔ NEVER bridge a case about a DIFFERENT service"), and
 * it would be more damaging here because a statistic reads as researched.
 *
 * Returning nothing is the expected, safe outcome. The composer writes the pitch
 * without a number, exactly as it does today.
 */

import type { createClient } from "@/lib/supabase/server";
import type { GeneratorInputBenchmark } from "@/lib/pitches/generator";
import { sameIndustryFamily } from "./industry-families.ts";

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
  caveat: string | null;
  is_vendor_sourced: boolean;
};

/**
 * The part of a caveat the composer should read: what the figure measures and
 * how to say it. Provenance notes ("Source-checked by…", "Activated…") are for
 * the human reviewing /benchmarks, not the model.
 */
export function caveatForPrompt(caveat: string | null): string | null {
  if (!caveat) return null;
  const cut = caveat.split(/\s(?:Source-checked by|Activated 2026|Read first-hand)/)[0]?.trim() ?? "";
  return cut ? cut.slice(0, 280) : null;
}

/** True when `phrase` occurs in `text` as whole words ("hotel" in "hotel chain"). */
function containsWords(text: string, phrase: string): boolean {
  const esc = phrase.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(^|[^\\p{L}\\p{N}])${esc}(?![\\p{L}\\p{N}])`, "u").test(text);
}

/**
 * Industry comparison on whole words. "hotel" matches "hotel chain" and
 * "restaurant" matches "restaurant group", but "spa" no longer matches
 * "despacho de abogados": with plain substrings every spa prospect was being
 * offered law-firm statistics.
 */
export function industryOverlaps(scope: string[], industry: string | null): boolean {
  // An empty scope means "universal". Rare and deliberate; most rows are scoped.
  if (scope.length === 0) return true;
  if (!industry) return false;
  const target = industry.trim().toLowerCase();
  return scope.some((s) => {
    const sl = s.trim().toLowerCase();
    return sl === target || containsWords(sl, target) || containsWords(target, sl);
  });
}

/**
 * Resolve the pain identifiers the pipeline carries into taxonomy CODES, as
 * (input id, code) pairs in input order, so a caller can map the writer's
 * chosen `pain_id` back to its code.
 *
 * pain_id is genuinely polymorphic here: the composer's own schema notes it
 * "can be a text slug like 'abandoned_cart_loss' or a UUID — accept both", and
 * stored pitches hold UUIDs. Benchmarks are tagged by code so seed rows stay
 * readable and survive a taxonomy re-key, so UUIDs get translated first. A
 * slug is its own code. Unknown UUIDs are dropped. Never throws.
 */
export async function resolvePainCodes(
  supabase: Client,
  tenantId: string,
  painIds: string[],
): Promise<Array<{ id: string; code: string }>> {
  return (await resolvePains(supabase, tenantId, painIds)).map(({ id, code }) => ({ id, code }));
}

type ResolvedPain = { id: string; code: string; label: string | null };

async function resolvePains(supabase: Client, tenantId: string, painIds: string[]): Promise<ResolvedPain[]> {
  try {
    const ids = painIds.filter(Boolean);
    if (ids.length === 0) return [];

    const isUuid = (s: string) =>
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s);
    const uuids = ids.filter(isUuid);

    const byId = new Map<string, { code: string; label: string | null }>();
    if (uuids.length > 0) {
      type TaxRow = { id: string; code: string; display_name_en: string | null };
      const { data } = await supabase
        .from("pain_taxonomy")
        .select("id, code, display_name_en")
        .eq("tenant_id", tenantId)
        .in("id", uuids)
        .returns<TaxRow[]>();
      for (const r of data ?? []) byId.set(r.id.toLowerCase(), { code: r.code, label: r.display_name_en ?? null });
    }

    return ids.flatMap((id) => {
      if (!isUuid(id)) return [{ id, code: id, label: null }];
      const hit = byId.get(id.toLowerCase());
      return hit ? [{ id, ...hit }] : [];
    });
  } catch {
    return [];
  }
}

/** The fields the matcher reads. A DB row, or a fixture row in tests. */
export type BenchmarkCandidate = {
  id: string;
  pain_codes: string[];
  industry_scope: string[];
  market: string | null;
  is_vendor_sourced: boolean;
};

/** At most this many rows for one pain, and in total. */
export const MAX_BENCHMARKS_PER_PAIN = 3;
export const MAX_BENCHMARKS_TOTAL = 8;

/**
 * Which rows this prospect is offered, and for which of its pains. Pure.
 *
 * Pain first: a row is considered only for the pains it is tagged with, and it
 * is tagged (`for_pains`) with every one of the prospect's pains it is about,
 * so the writer and critic can refuse a figure about a different problem.
 * Then per pain: direct industry match (`industryOverlaps`, unchanged) before
 * a same-family match (`industry-families.ts`) before a universal row (empty
 * scope); within a tier, non-vendor before vendor; then input order (the query
 * orders by created_at, id). Top 3 per pain; pains take turns, first evidenced
 * pain first, until 8 rows. Output is grouped by pain in that same order.
 *
 * `pains` is in the prospect's evidence order; duplicate codes count once.
 */
export function matchBenchmarks<R extends BenchmarkCandidate>(
  rows: readonly R[],
  pains: ReadonlyArray<{ code: string; label: string | null; id?: string }>,
  prospect: { industry: string | null; market: string | null },
): Array<{ row: R; for_pains: GeneratorInputBenchmark["for_pains"] }> {
  const seen = new Set<string>();
  const order = pains.filter((p) => (seen.has(p.code) ? false : (seen.add(p.code), true)));

  const eligible = rows.filter(
    // A geography-scoped row only applies in that market; unscoped applies anywhere.
    (r) => !r.market || r.market === "GLOBAL" || r.market === prospect.market,
  );

  const tier = (r: R): number | null => {
    if (r.industry_scope.length === 0) return 2;
    if (industryOverlaps(r.industry_scope, prospect.industry)) return 0;
    if (sameIndustryFamily(r.industry_scope, prospect.industry)) return 1;
    return null;
  };

  const ranked = order.map((p) =>
    eligible
      .map((r, i) => ({ r, i, t: tier(r) }))
      .filter((x): x is { r: R; i: number; t: number } => x.t !== null && x.r.pain_codes.includes(p.code))
      .sort((a, b) => a.t - b.t || Number(a.r.is_vendor_sourced) - Number(b.r.is_vendor_sourced) || a.i - b.i)
      .slice(0, MAX_BENCHMARKS_PER_PAIN)
      .map((x) => x.r),
  );

  const picked = new Set<string>();
  for (let rank = 0; rank < MAX_BENCHMARKS_PER_PAIN && picked.size < MAX_BENCHMARKS_TOTAL; rank++) {
    for (const list of ranked) {
      const r = list[rank];
      if (r && !picked.has(r.id)) picked.add(r.id);
      if (picked.size >= MAX_BENCHMARKS_TOTAL) break;
    }
  }

  const out: Array<{ row: R; for_pains: GeneratorInputBenchmark["for_pains"] }> = [];
  const emitted = new Set<string>();
  for (const list of ranked) {
    for (const r of list) {
      if (!picked.has(r.id) || emitted.has(r.id)) continue;
      emitted.add(r.id);
      out.push({
        row: r,
        for_pains: order
          .filter((p) => r.pain_codes.includes(p.code))
          .map((p) => ({ code: p.code, label: p.label, ...(p.id ? { pain_id: p.id } : {}) })),
      });
    }
  }
  return out;
}

/**
 * Benchmarks citable for this prospect, best-effort, each tagged with the
 * prospect pains it is about (`matchBenchmarks`).
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
    const pains = await resolvePains(supabase, tenantId, opts.painIds);
    if (pains.length === 0) return [];

    const { data, error } = await supabase
      .from("benchmarks")
      .select(
        "id, statistic, figure, publisher, source_url, pain_codes, industry_scope, market, caveat, is_vendor_sourced",
      )
      .eq("tenant_id", tenantId)
      .eq("is_active", true)
      .not("verified_at", "is", null)
      // 0050's CHECK already keeps a rejected row inactive; this says it twice.
      .is("rejected_at", null)
      .overlaps("pain_codes", [...new Set(pains.map((p) => p.code))])
      .order("created_at", { ascending: true })
      .order("id", { ascending: true })
      .returns<BenchmarkRow[]>();

    if (error || !data) return [];

    return matchBenchmarks(data, pains, opts).map(({ row: r, for_pains }) => ({
      id: r.id,
      statistic: r.statistic,
      figure: r.figure,
      publisher: r.publisher,
      source_url: r.source_url,
      caveat: caveatForPrompt(r.caveat),
      for_pains,
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

// ── Admin listing ────────────────────────────────────────────────────────────

export type BenchmarkAdminRow = {
  id: string;
  statistic: string;
  figure: string;
  pain_codes: string[];
  industry_scope: string[];
  market: string | null;
  source_url: string;
  publisher: string;
  published_date: string | null;
  is_vendor_sourced: boolean;
  caveat: string | null;
  verified_at: string | null;
  is_active: boolean;
};

/**
 * Every benchmark for the admin page — active and inactive alike.
 *
 * Deliberately NOT filtered: the whole point of the page is reviewing rows that
 * are not yet live, reading their caveats, and deciding. Uses the request-scoped
 * client so RLS applies.
 */
export async function listAllBenchmarks(tenantId: string): Promise<BenchmarkAdminRow[]> {
  const { createClient } = await import("@/lib/supabase/server");
  const supabase = await createClient();
  const { data, error } = await supabase
    .from("benchmarks")
    .select(
      `id, statistic, figure, pain_codes, industry_scope, market, source_url,
       publisher, published_date, is_vendor_sourced, caveat, verified_at, is_active`,
    )
    .eq("tenant_id", tenantId)
    .order("is_active", { ascending: false })
    .order("publisher", { ascending: true })
    .returns<BenchmarkAdminRow[]>();

  // The table may not exist yet (migration 0029 unapplied) — show an empty
  // page rather than a 500.
  if (error || !data) return [];
  return data;
}
