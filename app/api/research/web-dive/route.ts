// ─────────────────────────────────────────────────────────────────────────────
// app/api/research/web-dive/route.ts
// Searches the web about prospects waiting for their first email (migration
// 0055, lib/research/web-dive/). Supabase pg_cron calls it every 15 minutes in
// the weekday send window ('spam-web-dive'); it can also be called by hand
// with the cron secret.
//
// Each run dives at most 2 prospects (status match, gate passed, no pitch yet),
// one Claude call with the web_search tool each, and saves one web_research row
// per dive: ok (facts kept), empty (searched, nothing kept) or failed. Before
// each dive: $0.50 of the rolling-24h AI cap left (a cap read error = no dive)
// and fewer than 25 dives started in 24h. The time budget is in
// lib/research/web-dive/run.ts; vercel.json gives the route 120 s.
//
// Model: WEB_DIVE_MODEL, else the default Sonnet.
//
// SWITCHED OFF unless WEB_DIVE_ENABLED is exactly "1" (lib/research/web-dive/
// flag.ts, Pedro 2026-11-09): off, a run answers { ok: true, skipped: "disabled" }
// inside its heartbeat, with no claim, no Claude call and no cost.
//
// Auth: Authorization: Bearer <CRON_SECRET>, or pg_cron's Vault-held token
// (lib/cron-auth.ts isSchedulerAuthorized).
// ─────────────────────────────────────────────────────────────────────────────

import { type NextRequest, NextResponse } from "next/server";
import { ANTHROPIC_DEFAULT_MODEL } from "@/lib/anthropic/client";
import { isUnderDailyCap, recordClaudeCall } from "@/lib/anthropic/cost-tracking";
import { defaultCreate } from "@/lib/benchmarks/research";
import { isSchedulerAuthorized } from "@/lib/cron-auth";
import { withHeartbeat } from "@/lib/reports/heartbeat";
import { runDive, type WebDiveCostInput } from "@/lib/research/web-dive/dive";
import { webDiveEnabled } from "@/lib/research/web-dive/flag";
import { DB_TIMEOUT_MS, runWebDives, type CapState } from "@/lib/research/web-dive/run";
import {
  claimWebResearch,
  divesStartedSince,
  releaseWebResearch,
  saveWebResearch,
  spentLast24h,
  type WebDiveDb,
} from "@/lib/research/web-dive/store";
import { createServiceRoleClient } from "@/lib/supabase/service-role";

export const dynamic = "force-dynamic";

async function handle(req: NextRequest) {
  const start = Date.now();
  if (!(await isSchedulerAuthorized(req))) {
    return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });
  }
  return withHeartbeat("web-dive", () => runWebDive(start));
}

/** The cap from isUnderDailyCap (it reads ANTHROPIC_DAILY_USD_CAP), the spend re-read failing closed. */
async function capState(db: WebDiveDb, tenantId: string): Promise<CapState> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const [cap, spent] = await Promise.all([
      Promise.race([
        isUnderDailyCap(tenantId),
        new Promise<null>((resolve) => {
          timer = setTimeout(() => resolve(null), DB_TIMEOUT_MS);
        }),
      ]),
      spentLast24h(db, tenantId, new Date(), DB_TIMEOUT_MS),
    ]);
    if (!cap) return { error: "cap read timed out" };
    if ("error" in spent) return { error: spent.error };
    return { spentUsd: spent.usd, capUsd: cap.cap_usd };
  } finally {
    clearTimeout(timer);
  }
}

/** One authorized run (its heartbeat is written by handle). */
async function runWebDive(start: number) {
  // Off: the job still completes (its heartbeat stays fresh) and nothing else happens.
  if (!webDiveEnabled()) return NextResponse.json({ ok: true, skipped: "disabled" });
  // web_research (0055) isn't in the generated types.
  const db = createServiceRoleClient() as unknown as WebDiveDb;
  const model = process.env.WEB_DIVE_MODEL?.trim() || ANTHROPIC_DEFAULT_MODEL;
  const recordCost = (input: WebDiveCostInput) => recordClaudeCall(input);
  try {
    const report = await runWebDives(
      {
        claim: () => claimWebResearch(db, 1, DB_TIMEOUT_MS),
        capState: (tenantId) => capState(db, tenantId),
        startedLast24h: (tenantId, excludeId) => divesStartedSince(db, tenantId, new Date(Date.now() - 86_400_000), excludeId, DB_TIMEOUT_MS),
        release: (researchId) => releaseWebResearch(db, researchId, DB_TIMEOUT_MS),
        dive: (due) => runDive(due, { create: defaultCreate, recordCost, model }, { researchId: due.research_id }),
        save: (researchId, outcome) => saveWebResearch(db, researchId, outcome, new Date(), DB_TIMEOUT_MS),
      },
      start,
    );
    return NextResponse.json({ ok: true, ms: Date.now() - start, model, ...report });
  } catch (err) {
    return NextResponse.json(
      { ok: false, error: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    );
  }
}

export const GET = handle;
export const POST = handle;
