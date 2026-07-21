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
import { generatePitch } from "@/lib/pitches/actions";
import { EMPTY_JOB_STATS, type DiscoveryJobStats } from "@/lib/discover/job-types";

// A discovering phase that keeps outliving the function cap would be killed and
// resumed forever, re-running every crawl. Three tries is generous; beyond that
// the ICP is too broad for one slice.
const MAX_DISCOVER_ATTEMPTS = 3;

// Prospects in these states are not pitch-eligible in the pitching phase.
const NON_PITCHABLE = ["suppressed", "no_match", "booked", "won", "lost"];

const PIPELINE_CAP = 50; // matches the prior client-side cap

// Time-budgeted slicing (prod functions are capped at 120s; a single heavy
// prospect can blow a fixed batch). Process prospects ONE at a time until we're
// out of budget, then hand off. A fresh slice has ~110s; we stop starting new
// prospects when less than MIN_START_REMAINING is left, and cap each prospect so
// it can never run the function past the limit.
const HARD_CAP_MS = 105_000; // stop STARTING prospects past this (under 120s)
const MIN_START_REMAINING_MS = 55_000; // don't begin a prospect we can't finish
const PER_PROSPECT_MAX_MS = 95_000; // hard upper bound for one prospect — enough
// for a high-scorer that also enriches (now bounded ~25s for anymail + ~17s hunter)
// so the best prospects COMPLETE instead of being skipped; optimistic advance makes
// an occasional overrun safe (the cursor is already past it).

// Process this many prospects CONCURRENTLY per batch. Each prospect is I/O-bound
// (scrape, Brave, Claude, Hunter — mostly waiting on the network), so a batch's
// wall-clock ≈ the slowest single prospect, not the sum. This turns ~1 prospect
// per slice into ~4, cutting a 50-prospect run from ~60min to ~15-20min WITHOUT
// reducing per-prospect depth: every prospect still runs the identical full chain.
// Bounded so parallel external calls don't burst past provider rate limits (Brave
// is additionally serialized by a throttle in brave-search.ts).
const PIPELINE_CONCURRENCY = 4;

// Target-seeking discovery loop. A "full" run keeps pulling batches of raw
// prospects, researching them, pruning the chaff, and refilling — until the ICP
// has banked TARGET_PITCHED pitched leads (score ≥70 + reachable) OR it has
// researched MAX_PROCESSED_PER_RUN prospects (a cost guard) OR raw is exhausted.
// b_list (50-69) and researched are KEPT (parked for review), never counted or
// deleted; only suppressed/errored prospects are pruned.
const TARGET_PITCHED = 50;
const MAX_PROCESSED_PER_RUN = 200;

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

// Heartbeat-only bump — safe to race (last-write-wins on a timestamp, no stats
// clobber). Called as each prospect in a concurrent batch settles so a long batch
// keeps the heartbeat fresh and the watchdog never falsely resumes a live slice.
async function bumpHeartbeat(supabase: AnySupabase, jobId: string) {
  await supabase
    .from("discovery_jobs")
    .update({ heartbeat_at: new Date().toISOString() })
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

      // Bound the restart loop. The discovering phase is NOT resumable: every
      // entry re-runs all crawls from scratch. If it keeps exceeding the
      // function's duration cap it would be killed → resumed → killed forever,
      // re-spending the API budget each lap. Stop and say so instead.
      const attempts = (stats.discover_attempts ?? 0) + 1;
      stats.discover_attempts = attempts;
      if (attempts > MAX_DISCOVER_ATTEMPTS) {
        await patchJob(supabase, job.id, {
          status: "failed",
          error_message:
            `Discovery restarted ${attempts - 1} times without finishing — stopped to protect API spend. ` +
            `The source crawls are taking longer than one slice allows; narrow the ICP's keywords and re-run.`,
          stats,
          completed_at: new Date().toISOString(),
        });
        return NextResponse.json({ ok: false, error: "discovery_restart_loop" });
      }
      await patchJob(supabase, job.id, { stats });

      let prospectIds: string[] = [];
      let partial = false;
      let discoverErrors: string[] = [];
      let newCount = 0;
      let dupCount = 0;

      let result: Awaited<ReturnType<typeof runAllSources>>;
      // KEEPALIVE. runAllSources is one long call (every source × every keyword)
      // and used to bump the heartbeat exactly zero times while it ran. The
      // client watchdog resumes any job silent longer than STALL_MS (100s), so
      // a discovery that legitimately took longer was declared dead and
      // RESTARTED FROM SCRATCH — repeatedly, roughly every 100s, re-running
      // every crawl and re-spending the API budget. It looked like the run
      // "resetting itself".
      //
      // Restoring Yellow Pages (2026-07-21) made this common: 3 pages/keyword
      // at a 1.5s rate limit is ~22s of deliberate sleeping before any parsing.
      // The phase isn't stalled, it's working — so say so on the wire.
      const keepalive = setInterval(() => {
        void bumpHeartbeat(supabase, job.id);
      }, 20_000);
      try {
        result = await runAllSources(job.icp_id);
      } catch (e) {
        // A 504 / thrown server-action error — fall back to whatever was inserted.
        result = { ok: false, error: e instanceof Error ? e.message : "Discovery failed." };
      } finally {
        // Must always clear: an orphaned interval keeps the serverless function
        // alive past its work and can push it into the maxDuration kill.
        clearInterval(keepalive);
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

      // Process prospects in concurrency-bounded BATCHES until we run low on
      // budget. The cursor is advanced + persisted BEFORE the slow work (optimistic
      // advance) so that if a batch hangs and its orphaned async work keeps the
      // function alive until Vercel kills it at maxDuration, the cursor is already
      // past it — the next slice (or the watchdog) skips it instead of retrying the
      // same prospects forever. Each prospect is also raced against a timeout so the
      // common slow case returns cleanly without hitting the cap at all.
      while (cursor < ids.length) {
        const remaining = HARD_CAP_MS - (Date.now() - startedAt);
        if (remaining < MIN_START_REMAINING_MS) break;

        const batch = ids.slice(cursor, cursor + PIPELINE_CONCURRENCY);
        cursor += batch.length;
        // Commit the advance + bump the heartbeat up front.
        await patchJob(supabase, job.id, { cursor, stats });

        const budget = Math.min(PER_PROSPECT_MAX_MS, remaining - 10_000);
        const outcomes = await Promise.all(
          batch.map(async (id): Promise<{ outcome: ProspectOutcome; error?: string }> => {
            try {
              const r = await Promise.race([
                processSingleProspect(id),
                new Promise<never>((_, reject) =>
                  setTimeout(() => reject(new Error("prospect-timeout")), budget),
                ),
              ]);
              // Keep the REASON, not just the count — a run where everything
              // errors previously reported "0 processed" with nothing to
              // diagnose from.
              return { outcome: r.outcome, error: r.error };
            } catch (e) {
              return {
                outcome: "error",
                error: e instanceof Error ? e.message : "unknown error",
              }; // timed out or threw — already skipped via the advance
            } finally {
              // Keep the heartbeat fresh as each prospect settles so a long batch
              // is never mistaken for a dead chain.
              void bumpHeartbeat(supabase, job.id);
            }
          }),
        );

        for (const { outcome, error } of outcomes) {
          if (outcome === "pitched") stats.pitched += 1;
          else if (outcome === "website_pitch") stats.website_pitch += 1;
          else if (outcome === "needs_review") stats.needs_review += 1;
          else if (outcome === "suppressed") stats.suppressed += 1;
          else {
            stats.error_count += 1;
            // Keep the first few distinct reasons so the UI can show WHY.
            const msg = error ?? "unknown error";
            if (stats.errors.length < 5 && !stats.errors.includes(msg)) {
              stats.errors.push(msg);
            }
          }
        }
        stats.processed = (stats.processed ?? 0) + batch.length;

        await patchJob(supabase, job.id, { stats });
      }

      // Still more of THIS batch to chew through — keep the same prospect_ids set,
      // just advance to the next slice.
      if (cursor < ids.length) {
        await patchJob(supabase, job.id, { cursor, stats });
        after(() => triggerNextSlice(job.id, cookieHeader, origin));
        return NextResponse.json({ ok: true, phase: "pipeline", cursor });
      }

      // This batch is fully processed. Manual "run these specific prospects" jobs
      // (skip_prune / no ICP) DON'T loop — go straight to the finish.
      const icpId = job.icp_id;
      if (!icpId || stats.skip_prune) {
        await patchJob(supabase, job.id, { cursor, stats, phase: "pruning" });
        after(() => triggerNextSlice(job.id, cookieHeader, origin));
        return NextResponse.json({ ok: true, phase: "pruning", cursor });
      }

      // ── Target-seeking discovery loop ──────────────────────────────────────
      // Forward-progress guard: any prospect in this batch still 'raw' (errored or
      // timed out) is reclassified to 'suppressed' so the next refill's raw query
      // can't re-select it forever. We do NOT delete suppressed rows here — they're
      // kept as dedup tombstones so future discovery doesn't re-surface known-bad
      // companies and waste research spend. b_list / pitched / researched survive.
      await supabase
        .from("prospects")
        .update({
          status: "suppressed",
          suppressed_reason: "Auto: pipeline did not complete (error/timeout)",
          suppressed_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        })
        .in("id", ids)
        .eq("tenant_id", user.tenantId)
        .eq("status", "raw");

      // Count the ICP's pitched leads (real + website pitches both carry status
      // 'pitched') — the cumulative pool the target measures against.
      const { count: pitchedCount } = await supabase
        .from("prospects")
        .select("id", { count: "exact", head: true })
        .eq("tenant_id", user.tenantId)
        .eq("icp_id", icpId)
        .eq("status", "pitched");
      stats.pitched_pool = pitchedCount ?? 0;

      const processedSoFar = stats.processed ?? 0;
      const targetReached = (pitchedCount ?? 0) >= TARGET_PITCHED;
      const capReached = processedSoFar >= MAX_PROCESSED_PER_RUN;

      if (!targetReached && !capReached) {
        // Refill with the next batch of raw prospects for this ICP and loop.
        const nextRaw = await getRawProspectIds(icpId);
        const nextIds = nextRaw.ok ? nextRaw.ids : [];
        if (nextIds.length > 0) {
          await patchJob(supabase, job.id, {
            phase: "pipeline",
            cursor: 0,
            prospect_ids: nextIds,
            stats,
          });
          after(() => triggerNextSlice(job.id, cookieHeader, origin));
          return NextResponse.json({ ok: true, phase: "pipeline", refill: nextIds.length, pitched: stats.pitched_pool });
        }
        // else: raw exhausted — fall through to finish.
      }

      // Target met, cap hit, or raw exhausted → finish (prune leftover raw + a
      // final pitching catch-up).
      await patchJob(supabase, job.id, { cursor, stats, phase: "pruning" });
      after(() => triggerNextSlice(job.id, cookieHeader, origin));
      return NextResponse.json({ ok: true, phase: "pruning", pitched: stats.pitched_pool });
    }

    // ── Phase: pruning ──────────────────────────────────────────────────────
    if (job.phase === "pruning") {
      const ids = job.prospect_ids ?? [];
      const icpId = job.icp_id;

      // Pruning depends on job type:
      //  • manual (skip_prune): keep everything the user hand-picked.
      //  • discovery loop: delete the leftover unprocessed raw overflow for this
      //    ICP — we hit the target/cap, so the rest of the wide net is discarded
      //    ("prune the rest"). Kept prospects (pitched/b_list/researched) survive.
      //  • legacy (no ICP): fall back to the old top-30 prune.
      let prune: { ok: true; kept: number; deleted: number } | { ok: false; error: string };
      if (stats.skip_prune) {
        prune = { ok: true, kept: ids.length, deleted: 0 };
      } else if (icpId) {
        const { data: del } = await supabase
          .from("prospects")
          .delete()
          .eq("tenant_id", user.tenantId)
          .eq("icp_id", icpId)
          .eq("status", "raw")
          .select("id");
        prune = { ok: true, kept: stats.pitched_pool ?? 0, deleted: (del ?? []).length };
      } else {
        prune = await pruneRunToTop30(ids);
      }
      const nextStats: DiscoveryJobStats = {
        ...stats,
        ...(prune.ok ? { pruned_kept: prune.kept, pruned_deleted: prune.deleted } : {}),
      };

      // Hand off to the PITCHING phase: high-scorers (>=70) that never got a pitch
      // (their pipeline slice ran out of time before the in-slice pitch step). For
      // a discovery loop, catch ALL such ≥70 for the ICP so the pitched pool is
      // topped up toward the target; for other jobs, just this run's set. Reuse the
      // cursor machinery — the pitching phase is identical in shape to the pipeline.
      const highScorersQuery = supabase
        .from("prospects")
        .select("id, status")
        .eq("tenant_id", user.tenantId)
        .gte("match_score", 70);
      const { data: highScorers } = icpId
        ? await highScorersQuery.eq("icp_id", icpId)
        : await highScorersQuery.in("id", ids);
      const eligible = ((highScorers ?? []) as Array<{ id: string; status: string }>)
        .filter((p) => !NON_PITCHABLE.includes(p.status))
        .map((p) => p.id);

      let pending: string[] = [];
      if (eligible.length > 0) {
        const { data: pitchRows } = await supabase
          .from("pitches")
          .select("prospect_id")
          .in("prospect_id", eligible)
          .eq("tenant_id", user.tenantId);
        const pitched = new Set((pitchRows ?? []).map((r: { prospect_id: string }) => r.prospect_id));
        pending = eligible.filter((id) => !pitched.has(id));
      }

      if (pending.length === 0) {
        await patchJob(supabase, job.id, {
          status: "done",
          stats: nextStats,
          completed_at: new Date().toISOString(),
        });
        return NextResponse.json({ ok: true, done: true });
      }

      await patchJob(supabase, job.id, {
        phase: "pitching",
        cursor: 0,
        prospect_ids: pending,
        stats: nextStats,
      });
      after(() => triggerNextSlice(job.id, cookieHeader, origin));
      return NextResponse.json({ ok: true, phase: "pitching", pending: pending.length });
    }

    // ── Phase: pitching (time-budgeted; catches high-scorers the pipeline cut) ─
    if (job.phase === "pitching") {
      const ids = job.prospect_ids ?? [];
      const startedAt = Date.now();
      let cursor = job.cursor;

      while (cursor < ids.length) {
        const remaining = HARD_CAP_MS - (Date.now() - startedAt);
        if (remaining < MIN_START_REMAINING_MS) break;

        const batch = ids.slice(cursor, cursor + PIPELINE_CONCURRENCY);
        cursor += batch.length;
        await patchJob(supabase, job.id, { cursor, stats }); // optimistic advance

        const budget = Math.min(PER_PROSPECT_MAX_MS, remaining - 10_000);
        const results = await Promise.all(
          batch.map(async (id): Promise<boolean> => {
            try {
              const r = await Promise.race([
                generatePitch(id),
                new Promise<never>((_, reject) =>
                  setTimeout(() => reject(new Error("pitch-timeout")), budget),
                ),
              ]);
              return !!(r && r.ok);
            } catch {
              return false; // timed out / failed (e.g. no usable contact) — skipped via advance
            } finally {
              void bumpHeartbeat(supabase, job.id);
            }
          }),
        );
        stats.pitched += results.filter(Boolean).length;
        await patchJob(supabase, job.id, { stats });
      }

      const moreToProcess = cursor < ids.length;
      await patchJob(supabase, job.id, {
        cursor,
        stats,
        ...(moreToProcess ? {} : { status: "done", completed_at: new Date().toISOString() }),
      });
      if (moreToProcess) after(() => triggerNextSlice(job.id, cookieHeader, origin));
      return NextResponse.json({ ok: true, phase: moreToProcess ? "pitching" : "done", cursor });
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
