/**
 * One observe run: claim due prospects, crawl each site while PageSpeed runs
 * beside it, save. Dependencies are injected so the budget and the outcomes are
 * testable without a network or a database (tests/site-crawl-observe.test.ts).
 *
 * Every step is bounded by the run's deadline (budget.ts). A row killed at
 * maxDuration stays 'pending' and the next claim marks it 'abandoned'.
 */

import { CLAIM_TIMEOUT_MS, PSI_TIMEOUT_MS, ROUTE_BUDGET_MS, SAVE_TIMEOUT_MS, SITES_PER_RUN, workWindowMs } from "./budget.ts";
import { crawlSite as defaultCrawl, SITE_BUDGET_MS, type CrawlOptions } from "./crawl.ts";
import type { PsiOutcome, RunPsi } from "./psi.ts";
import type { ObservationStatus, PsiStatus, SiteObservation } from "./types.ts";

export type DueSite = { id: string; tenant_id: string; prospect_id: string; url: string };

export type ObserveDeps = {
  claim: (limit: number, timeoutMs: number) => Promise<DueSite[]>;
  save: (site: DueSite, obs: SiteObservation, psi: PsiOutcome, timeoutMs: number) => Promise<{ ok: boolean; error?: string }>;
  runPsi: RunPsi;
  crawl?: (url: string, opts: CrawlOptions) => Promise<SiteObservation>;
  now?: () => number;
};

export type ObserveReport = {
  claimed: number;
  saved: number;
  statuses: Partial<Record<ObservationStatus, number>>;
  psi: Partial<Record<PsiStatus, number>>;
  errors: string[];
};

/**
 * PageSpeed's result only stands for a site we were allowed to read and that is
 * theirs: robots.txt said no, or the home redirects to another company → skipped.
 */
export function psiFor(obs: SiteObservation, psi: PsiOutcome): PsiOutcome {
  const robots = obs.status === "blocked" && obs.pages.some((p) => p.error?.startsWith("robots.txt"));
  if (obs.status === "offsite" || robots) return { status: "skipped", result: null, error: null };
  return psi;
}

export async function observeBatch(deps: ObserveDeps, start: number, limit = SITES_PER_RUN): Promise<ObserveReport> {
  const now = deps.now ?? Date.now;
  const crawl = deps.crawl ?? defaultCrawl;
  const report: ObserveReport = { claimed: 0, saved: 0, statuses: {}, psi: {}, errors: [] };

  const sites = await deps.claim(limit, CLAIM_TIMEOUT_MS);
  report.claimed = sites.length;
  if (sites.length === 0) return report;

  const window = workWindowMs(now(), start);
  const results = await Promise.all(
    sites.map(async (site) => {
      try {
        const [obs, psi] = await Promise.all([
          crawl(site.url, { siteBudgetMs: Math.min(SITE_BUDGET_MS, window), now }),
          deps.runPsi(site.url, Math.min(PSI_TIMEOUT_MS, window)).catch(
            (err: unknown): PsiOutcome => ({ status: "error", result: null, error: String(err).slice(0, 200) }),
          ),
        ]);
        return { site, obs, psi: psiFor(obs, psi) };
      } catch (err) {
        // A crawler bug, not a site fact: nothing is saved, the row stays
        // pending and the next claim marks it abandoned.
        report.errors.push(`${site.prospect_id}: crawl threw (${err instanceof Error ? err.message : String(err)})`.slice(0, 300));
        return null;
      }
    }),
  );
  const done = results.filter((r): r is NonNullable<typeof r> => r !== null);

  // Saves in parallel, inside what is left of the run budget.
  const saveTimeout = Math.max(1_000, Math.min(SAVE_TIMEOUT_MS, start + ROUTE_BUDGET_MS - now()));
  const saved = await Promise.all(
    done.map(({ site, obs, psi }) =>
      deps.save(site, obs, psi, saveTimeout).catch((err: unknown) => ({ ok: false, error: String(err) })),
    ),
  );
  done.forEach(({ site, obs, psi }, i) => {
    report.statuses[obs.status] = (report.statuses[obs.status] ?? 0) + 1;
    report.psi[psi.status] = (report.psi[psi.status] ?? 0) + 1;
    const s = saved[i];
    if (s?.ok) report.saved++;
    else report.errors.push(`${site.prospect_id}: not saved (${s?.error ?? "unknown"})`);
  });
  return report;
}
