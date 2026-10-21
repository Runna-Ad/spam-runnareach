/**
 * Review-page queries for the wanted-facts loop (migration 0050).
 *
 * A proposal is a benchmarks row research inserted for a wanted fact and nobody has
 * approved or rejected yet. Request-scoped client, so RLS applies. Two reads joined
 * here instead of a PostgREST embed: the hand-written types carry no relationships.
 */

import type { BenchmarkAdminRow } from "@/lib/benchmarks/queries";

export type WantedFactStatus = "open" | "proposed" | "no_source" | "dismissed";

export type WantedFactRow = {
  id: string;
  fact: string;
  pain_code: string | null;
  industry: string | null;
  market: string | null;
  source: "writer" | "critic" | "manual";
  request_count: number;
  last_requested_at: string;
  status: WantedFactStatus;
  research_note: string | null;
};

export type BenchmarkProposal = {
  id: string;
  statistic: string;
  figure: string;
  publisher: string;
  source_url: string;
  published_date: string | null;
  is_vendor_sourced: boolean;
  caveat: string | null;
  industry_scope: string[];
  market: string | null;
  proposal_note: string | null;
  proposed_at: string | null;
  wanted_fact: Pick<WantedFactRow, "id" | "fact" | "request_count"> | null;
};

export type RejectedBenchmark = {
  id: string;
  statistic: string;
  figure: string;
  publisher: string;
  source_url: string;
  rejected_at: string;
};

export type PainOption = { code: string; label: string };

const STATUS_ORDER: Record<WantedFactStatus, number> = {
  open: 0,
  proposed: 1,
  no_source: 2,
  dismissed: 3,
};

/** Open first, then proposed, no_source, dismissed; most-asked first within each. */
export function sortWantedFacts(rows: WantedFactRow[]): WantedFactRow[] {
  return [...rows].sort(
    (a, b) =>
      STATUS_ORDER[a.status] - STATUS_ORDER[b.status] || b.request_count - a.request_count,
  );
}

/**
 * The library list keeps showing everything it always did, minus pending proposals
 * (they appear only in the review section) and rejected rows (collapsed list only).
 */
export function leaveOutReviewQueue(
  all: BenchmarkAdminRow[],
  proposals: { id: string }[],
  rejected: { id: string }[],
): BenchmarkAdminRow[] {
  const hide = new Set([...proposals, ...rejected].map((r) => r.id));
  return all.filter((b) => !hide.has(b.id));
}

async function client() {
  const { createClient } = await import("@/lib/supabase/server");
  return createClient();
}

const PROPOSAL_COLUMNS = `id, statistic, figure, publisher, source_url, published_date,
  is_vendor_sourced, caveat, industry_scope, market, proposal_note, proposed_at, wanted_fact_id`;

export async function listBenchmarkProposals(tenantId: string): Promise<BenchmarkProposal[]> {
  const supabase = await client();
  const { data, error } = await supabase
    .from("benchmarks")
    .select(PROPOSAL_COLUMNS)
    .eq("tenant_id", tenantId)
    .not("wanted_fact_id", "is", null)
    .is("verified_at", null)
    .is("rejected_at", null)
    .order("proposed_at", { ascending: true })
    .returns<(Omit<BenchmarkProposal, "wanted_fact"> & { wanted_fact_id: string })[]>();
  // Migration 0050 unapplied: show no proposals rather than a 500.
  if (error || !data) return [];

  const ids = [...new Set(data.map((r) => r.wanted_fact_id))];
  const facts = new Map<string, NonNullable<BenchmarkProposal["wanted_fact"]>>();
  if (ids.length > 0) {
    const { data: wf } = await supabase
      .from("wanted_facts")
      .select("id, fact, request_count")
      .eq("tenant_id", tenantId)
      .in("id", ids)
      .returns<NonNullable<BenchmarkProposal["wanted_fact"]>[]>();
    for (const f of wf ?? []) facts.set(f.id, f);
  }

  return data.map(({ wanted_fact_id, ...row }) => ({
    ...row,
    wanted_fact: facts.get(wanted_fact_id) ?? null,
  }));
}

export async function listRejectedBenchmarks(tenantId: string): Promise<RejectedBenchmark[]> {
  const supabase = await client();
  const { data, error } = await supabase
    .from("benchmarks")
    .select("id, statistic, figure, publisher, source_url, rejected_at")
    .eq("tenant_id", tenantId)
    .not("rejected_at", "is", null)
    .order("rejected_at", { ascending: false })
    .returns<RejectedBenchmark[]>();
  if (error || !data) return [];
  return data;
}

export async function listWantedFacts(tenantId: string): Promise<WantedFactRow[]> {
  const supabase = await client();
  const { data, error } = await supabase
    .from("wanted_facts")
    .select(
      `id, fact, pain_code, industry, market, source, request_count, last_requested_at,
       status, research_note`,
    )
    .eq("tenant_id", tenantId)
    .order("request_count", { ascending: false })
    .returns<WantedFactRow[]>();
  if (error || !data) return [];
  return sortWantedFacts(data);
}

export async function listPainOptions(tenantId: string): Promise<PainOption[]> {
  const supabase = await client();
  const { data, error } = await supabase
    .from("pain_taxonomy")
    .select("code, display_name_en")
    .eq("tenant_id", tenantId)
    .eq("is_active", true)
    .order("display_name_en", { ascending: true })
    .returns<{ code: string; display_name_en: string }[]>();
  if (error || !data) return [];
  return data.map((p) => ({ code: p.code, label: p.display_name_en }));
}
