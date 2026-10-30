/**
 * site_observations (0054) reads and writes, service role only. The claim
 * function inserts the 'pending' row; save turns it into the outcome, only
 * while it is still pending (a row the next run swept to 'abandoned' stays so).
 */

import type { DueSite } from "./observe.ts";
import type { PsiOutcome } from "./psi.ts";
import type { SiteObservation } from "./types.ts";

/** The slice of the Supabase client used here (site_observations isn't in the generated types). */
export type ObservationsDb = {
  rpc: (fn: string, args: Record<string, unknown>) => { abortSignal: (s: AbortSignal) => PromiseLike<{ data: unknown; error: { message: string } | null }> };
  from: (table: string) => {
    update: (values: Record<string, unknown>) => {
      eq: (col: string, v: string) => {
        eq: (col: string, v: string) => {
          select: (cols: string) => { abortSignal: (s: AbortSignal) => PromiseLike<{ data: unknown[] | null; error: { message: string } | null }> };
        };
      };
    };
  };
};

export const SITE_OBSERVATION_COLUMNS = [
  "id", "tenant_id", "prospect_id", "url", "final_url", "crawled_at", "crawler_version", "status",
  "readable", "pages", "checks", "psi", "psi_status", "duration_ms", "created_at",
] as const;

export async function claimDueSites(db: ObservationsDb, limit: number, crawlerVersion: string, timeoutMs: number): Promise<DueSite[]> {
  const { data, error } = await db
    .rpc("claim_site_observations", { p_limit: limit, p_crawler_version: crawlerVersion })
    .abortSignal(AbortSignal.timeout(timeoutMs));
  // Presence, not truthiness: an empty-body 5xx comes back as { message: "" }.
  if (error) throw new Error(`claim_site_observations: ${error.message || "empty error"}`);
  return Array.isArray(data) ? (data as DueSite[]) : [];
}

/** The row's columns for one finished crawl. */
export function observationRow(obs: SiteObservation, psi: PsiOutcome): Record<string, unknown> {
  return {
    final_url: obs.final_url,
    crawled_at: obs.crawled_at,
    crawler_version: obs.crawler_version,
    status: obs.status,
    readable: obs.readable,
    pages: obs.pages,
    checks: obs.checks,
    psi: psi.result ?? (psi.error ? { error: psi.error } : null),
    psi_status: psi.status,
    duration_ms: obs.duration_ms,
  };
}

export async function saveObservation(
  db: ObservationsDb,
  site: DueSite,
  obs: SiteObservation,
  psi: PsiOutcome,
  timeoutMs: number,
): Promise<{ ok: boolean; error?: string }> {
  const { data, error } = await db
    .from("site_observations")
    .update(observationRow(obs, psi))
    .eq("id", site.id)
    .eq("status", "pending")
    .select("id")
    .abortSignal(AbortSignal.timeout(timeoutMs));
  if (error) return { ok: false, error: error.message || "empty error" };
  if (!data || data.length === 0) return { ok: false, error: "row no longer pending (swept as abandoned)" };
  return { ok: true };
}
