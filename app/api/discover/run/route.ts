// ─────────────────────────────────────────────────────────────────────────────
// app/api/discover/run/route.ts
// Background discovery WORKER — self-chaining slice runner.
//
// Each POST processes ONE bounded slice of a discovery_jobs row, then re-triggers
// the next slice by calling itself (via after() so the platform keeps the
// function alive to send the request). This decouples a "Run All Sources" run
// from the browser tab: closing the tab no longer stops the run.
//
// Auth: the START action forwards the user's session cookie, and each slice
// forwards it onward — so getCurrentUser()/requireUser() resolve the same user
// across the whole chain WITHOUT any session-less pipeline refactor.
//
// Slice state machine (job.phase):
//   discovering -> run all crawl sources, collect raw prospect ids, -> pipeline
//   pipeline    -> process the next batch of 5 prospects, advance cursor
//   pruning     -> prune to top 30, mark done
//
// A guard at the top of every slice halts the chain if status !== 'running'
// (Stop button sets 'cancelled'). The janitor cron fails stale-heartbeat jobs.
// ─────────────────────────────────────────────────────────────────────────────

import { type NextRequest, NextResponse } from "next/server";
import { after } from "next/server";
import { getCurrentUser } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { runAllSources } from "@/lib/discover/run-all-action";
import {
  getProspectIdsForRuns,
  getRawProspectIds,
  processSingleProspect,
  pruneRunToTop30,
  type ProspectOutcome,
} from "@/lib/discover/pipeline-action";
import { triggerNextSlice } from "@/lib/discover/job-trigger";
import { EMPTY_JOB_STATS, type DiscoveryJobStats } from "@/lib/discover/job-types";

const PIPELINE_CAP = 50; // matches the prior client-side cap

// Time-budgeted slicing (prod functions are capped at 120s; a single heavy
// prospect can blow a fixed batch). Process prospects ONE at a time until we're
// out of budget, then hand off. A fresh slice has ~110s; we stop starting new
// prospects when less than MIN_START_REMAINING is left, and cap each prospect so
// it can never run the function past the limit.
const HARD_CAP_MS = 100_000; // stop STARTING prospects past this (well under 120s)
const MIN_START_REMAINING_MS = 50_000; // don't begin a prospect we can't finish
const PER_PROSPECT_MAX_MS = 70_000; // hard upper bound for one prospect, so the
// function returns with plenty of headroom for after()/the next trigger to fire.

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnySupabase = any;

type JobRow = {
  id: string;
  tenant_id: string;
  icp_id: string | null;
  status: string;
  phase: string;
  cursor: number;
  prospect_ids: string[];
  stats: DiscoveryJobStats | null;
};

async function patchJob(supabase: AnySupabase, jobId: string, patch: Record<string, unknown>) {
  await supabase
    .from("discovery_jobs")
    .update({ ...patch, heartbeat_at: new Date().toISOString() })
    .eq("id", jobId);
}

export async function POST(req: NextRequest) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ ok: false, error: "Unauthenticated" }, { status: 401 });

  let jobId: string;
  try {
    const body = (await req.json()) as { jobId?: string };
    if (!body.jobId) throw new Error("missing jobId");
    jobId = body.jobId;
  } catch {
    return NextResponse.json({ ok: false, error: "Bad request" }, { status: 400 });
  }

  const supabase = await createClient();
  const cookieHeader = req.headers.get("cookie") ?? "";
  // Chain stays on the exact host/port this request arrived on.
  const origin = new URL(req.url).origin;

  // Load + guard the job. Only same-tenant running jobs proceed.
  const { data: job } = await supabase
    .from("discovery_jobs")
    .select("id, tenant_id, icp_id, status, phase, cursor, prospect_ids, stats")
    .eq("id", jobId)
    .eq("tenant_id", user.tenantId)
    .maybeSingle<JobRow>();

  if (!job) return NextResponse.json({ ok: false, error: "Job not found" }, { status: 404 });
  if (job.status !== "running") {
    // Cancelled / done / failed — halt the chain.
    return NextResponse.json({ ok: true, halted: job.status });
  }

  const stats: DiscoveryJobStats = { ...EMPTY_JOB_STATS, ...(job.stats ?? {}) };

  try {
    // ── Phase: discovering ──────────────────────────────────────────────────
    if (job.phase === "discovering") {
      if (!job.icp_id) throw new Error("Job has no ICP.");

      let prospectIds: string[] = [];
      let partial = false;
      let discoverErrors: string[] = [];
      let newCount = 0;
      let dupCount = 0;

      let result: Awaited<ReturnType<typeof runAllSources>>;
      try {
        result = await runAllSources(job.icp_id);
      } catch (e) {
        // A 504 / thrown server-action error — fall back to whatever was inserted.
        result = { ok: false, error: e instanceof Error ? e.message : "Discovery failed." };
      }

      if (result.ok) {
        newCount = result.candidatesNew;
        dupCount = result.candidatesDuplicate;
        discoverErrors = result.errors;
        if (result.candidatesNew > 0) {
          const ids = await getProspectIdsForRuns(result.runIds);
          prospectIds = ids.ok ? ids.ids : [];
          if (prospectIds.length === 0) {
            const raw = await getRawProspectIds(job.icp_id);
            prospectIds = raw.ok ? raw.ids : [];
          }
        }
      } else {
        // Discovery errored/timed out — process anything inserted before the cut.
        const raw = await getRawProspectIds(job.icp_id);
        prospectIds = raw.ok ? raw.ids : [];
        if (prospectIds.length === 0) {
          // Nothing inserted — fail the job with the discovery error.
          await patchJob(supabase, job.id, {
            status: "failed",
            error_message: result.error,
            completed_at: new Date().toISOString(),
          });
          return NextResponse.json({ ok: false, error: result.error });
        }
        partial = true;
        newCount = prospectIds.length;
        discoverErrors = [result.error];
      }

      prospectIds = prospectIds.slice(0, PIPELINE_CAP);

      const nextStats: DiscoveryJobStats = {
        ...stats,
        new: newCount,
        dup: dupCount,
        errors: discoverErrors,
        partial,
      };

      if (prospectIds.length === 0) {
        // Found nothing to process — done.
        await patchJob(supabase, job.id, {
          phase: "pruning",
          status: "done",
          stats: nextStats,
          completed_at: new Date().toISOString(),
        });
        return NextResponse.json({ ok: true, done: true, new: newCount });
      }

      await patchJob(supabase, job.id, {
        phase: "pipeline",
        cursor: 0,
        prospect_ids: prospectIds,
        stats: nextStats,
      });
      after(() => triggerNextSlice(job.id, cookieHeader, origin));
      return NextResponse.json({ ok: true, phase: "pipeline", total: prospectIds.length });
    }

    // ── Phase: pipeline (time-budgeted, one prospect at a time) ──────────────
    if (job.phase === "pipeline") {
      const ids = job.prospect_ids ?? [];
      const startedAt = Date.now();
      let cursor = job.cursor;

      // Process prospects until we run low on budget. The cursor is advanced +
      // persisted BEFORE the slow work (optimistic advance) so that if a single
      // "poison" prospect hangs and its orphaned async work keeps the function
      // alive until Vercel kills it at maxDuration, the cursor is already past it
      // — the next slice (or the watchdog) skips it instead of retrying the same
      // prospect forever. Each prospect is also raced against a timeout so the
      // common slow case returns cleanly without hitting the cap at all.
      while (cursor < ids.length) {
        const remaining = HARD_CAP_MS - (Date.now() - startedAt);
        if (remaining < MIN_START_REMAINING_MS) break;

        const id = ids[cursor]!;
        cursor += 1;
        // Commit the advance + bump the heartbeat up front.
        await patchJob(supabase, job.id, { cursor, stats });

        const budget = Math.min(PER_PROSPECT_MAX_MS, remaining - 10_000);
        let outcome: ProspectOutcome = "error";
        try {
          const r = await Promise.race([
            processSingleProspect(id),
            new Promise<never>((_, reject) =>
              setTimeout(() => reject(new Error("prospect-timeout")), budget),
            ),
          ]);
          outcome = r.outcome;
        } catch {
          outcome = "error"; // timed out or threw — already skipped via the advance
        }

        if (outcome === "pitched") stats.pitched += 1;
        else if (outcome === "website_pitch") stats.website_pitch += 1;
        else if (outcome === "needs_review") stats.needs_review += 1;
        else if (outcome === "suppressed") stats.suppressed += 1;
        else stats.error_count += 1;

        await patchJob(supabase, job.id, { stats });
      }

      const moreToProcess = cursor < ids.length;
      await patchJob(supabase, job.id, {
        cursor,
        stats,
        ...(moreToProcess ? {} : { phase: "pruning" }),
      });
      after(() => triggerNextSlice(job.id, cookieHeader, origin));
      return NextResponse.json({ ok: true, phase: moreToProcess ? "pipeline" : "pruning", cursor });
    }

    // ── Phase: pruning ──────────────────────────────────────────────────────
    if (job.phase === "pruning") {
      const ids = job.prospect_ids ?? [];
      const prune = await pruneRunToTop30(ids);
      const nextStats: DiscoveryJobStats = {
        ...stats,
        ...(prune.ok ? { pruned_kept: prune.kept, pruned_deleted: prune.deleted } : {}),
      };
      await patchJob(supabase, job.id, {
        status: "done",
        stats: nextStats,
        completed_at: new Date().toISOString(),
      });
      return NextResponse.json({ ok: true, done: true });
    }

    return NextResponse.json({ ok: false, error: `Unknown phase: ${job.phase}` }, { status: 500 });
  } catch (e) {
    const message = e instanceof Error ? e.message : "Slice failed.";
    await patchJob(supabase, job.id, {
      status: "failed",
      error_message: message,
      completed_at: new Date().toISOString(),
    });
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}
