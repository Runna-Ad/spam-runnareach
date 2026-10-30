// ─────────────────────────────────────────────────────────────────────────────
// app/api/research/observe/route.ts
// Reads researched prospects' websites and stores what was seen (migration
// 0054, lib/research/site-crawl/). Supabase pg_cron calls it every 30 minutes
// in the weekday send window ('spam-site-observe'); it can also be called by
// hand with the cron secret.
//
// Each run claims up to SITES_PER_RUN prospects (researched, with a website, no
// observation in 30 days, newest-researched first), crawls them in parallel
// with PageSpeed Insights beside each crawl (PAGESPEED_API_KEY; without it
// psi_status = "no_key" and the crawl still runs), and saves one row each. No AI
// call, no paid API. Worst case fits the 60 s default maxDuration
// (lib/research/site-crawl/budget.ts).
//
// Auth: Authorization: Bearer <CRON_SECRET>, or pg_cron's Vault-held token
// (lib/cron-auth.ts isSchedulerAuthorized).
// ─────────────────────────────────────────────────────────────────────────────

import { type NextRequest, NextResponse } from "next/server";
import { isSchedulerAuthorized } from "@/lib/cron-auth";
import { withHeartbeat } from "@/lib/reports/heartbeat";
import { observeBatch } from "@/lib/research/site-crawl/observe";
import { makeRunPsi } from "@/lib/research/site-crawl/psi";
import { claimDueSites, saveObservation, type ObservationsDb } from "@/lib/research/site-crawl/store";
import { CRAWLER_VERSION } from "@/lib/research/site-crawl/types";
import { createServiceRoleClient } from "@/lib/supabase/service-role";

export const dynamic = "force-dynamic";

async function handle(req: NextRequest) {
  const start = Date.now();
  if (!(await isSchedulerAuthorized(req))) {
    return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });
  }
  return withHeartbeat("site-observe", () => runObserve(start));
}

/** One authorized run (its heartbeat is written by handle). */
async function runObserve(start: number) {
  // site_observations (0054) isn't in the generated types.
  const db = createServiceRoleClient() as unknown as ObservationsDb;
  try {
    const report = await observeBatch(
      {
        claim: (limit, timeoutMs) => claimDueSites(db, limit, CRAWLER_VERSION, timeoutMs),
        save: (site, obs, psi, timeoutMs) => saveObservation(db, site, obs, psi, timeoutMs),
        runPsi: makeRunPsi(process.env.PAGESPEED_API_KEY),
      },
      start,
    );
    return NextResponse.json({ ok: true, ms: Date.now() - start, ...report });
  } catch (err) {
    return NextResponse.json(
      { ok: false, error: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    );
  }
}

export const GET = handle;
export const POST = handle;
