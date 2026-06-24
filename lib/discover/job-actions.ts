"use server";

/**
 * Server actions for background discovery jobs.
 *
 * startDiscoveryJob  — create a job row + kick the first worker slice, return jobId.
 * cancelDiscoveryJob — flip status to 'cancelled'; the next slice's guard halts the chain.
 * getDiscoveryJob    — poll status/progress (client polls this to render the run).
 * getActiveJobForIcp — resume-on-reopen: find an in-flight job for an ICP.
 *
 * The actual work runs in /api/discover/run (the self-chaining worker). These
 * actions never block on the run — they return immediately so the browser tab is
 * free to close.
 */

import { cookies, headers } from "next/headers";
import { after } from "next/server";
import { z } from "zod";
import { requireUser } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { EMPTY_JOB_STATS, type DiscoveryJob, type DiscoveryJobStatus, type DiscoveryJobPhase } from "./job-types";
import { triggerNextSlice, originFromHeaders } from "./job-trigger";
import { getRawProspectIds } from "./pipeline-action";

/** "full" = discover then pipeline; "pending" = pipeline-only over existing raw prospects. */
export type DiscoveryJobMode = "full" | "pending";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyStats = any;

type JobRow = {
  id: string;
  icp_id: string | null;
  status: string;
  phase: string;
  cursor: number;
  prospect_ids: string[];
  stats: AnyStats;
  error_message: string | null;
  heartbeat_at: string;
  created_at: string;
  completed_at: string | null;
};

function toJob(r: JobRow): DiscoveryJob {
  return {
    id: r.id,
    icp_id: r.icp_id,
    status: r.status as DiscoveryJobStatus,
    phase: r.phase as DiscoveryJobPhase,
    cursor: r.cursor,
    total: (r.prospect_ids ?? []).length,
    stats: { ...EMPTY_JOB_STATS, ...(r.stats ?? {}) },
    error_message: r.error_message,
    heartbeat_at: r.heartbeat_at,
    created_at: r.created_at,
    completed_at: r.completed_at,
  };
}

const JOB_COLS =
  "id, icp_id, status, phase, cursor, prospect_ids, stats, error_message, heartbeat_at, created_at, completed_at";

/** Serialize the current request's cookies for forwarding to the worker. */
async function currentCookieHeader(): Promise<string> {
  const store = await cookies();
  return store
    .getAll()
    .map((c) => `${c.name}=${c.value}`)
    .join("; ");
}

export async function startDiscoveryJob(
  icpId: string,
  mode: DiscoveryJobMode = "full",
): Promise<{ ok: true; jobId: string } | { ok: false; error: string }> {
  const idParse = z.string().uuid().safeParse(icpId);
  if (!idParse.success) return { ok: false, error: "Invalid ICP id." };

  const user = await requireUser();
  if (user.role === "viewer") return { ok: false, error: "Viewers cannot run discovery." };

  const supabase = await createClient();

  // Don't stack jobs: reuse an already-running job for this ICP if one exists.
  const { data: existing } = await supabase
    .from("discovery_jobs")
    .select("id")
    .eq("tenant_id", user.tenantId)
    .eq("icp_id", idParse.data)
    .eq("status", "running")
    .limit(1)
    .maybeSingle<{ id: string }>();
  if (existing) return { ok: true, jobId: existing.id };

  // "pending" mode skips discovery: preload existing raw prospects and start
  // straight in the pipeline phase. "full" mode starts in discovering.
  let phase: DiscoveryJobPhase = "discovering";
  let prospectIds: string[] = [];
  if (mode === "pending") {
    const raw = await getRawProspectIds(idParse.data);
    prospectIds = raw.ok ? raw.ids : [];
    if (prospectIds.length === 0) {
      return { ok: false, error: "No raw prospects waiting to process." };
    }
    phase = "pipeline";
  }

  const { data, error } = await supabase
    .from("discovery_jobs")
    .insert({
      tenant_id: user.tenantId,
      icp_id: idParse.data,
      created_by: user.id,
      status: "running",
      phase,
      cursor: 0,
      prospect_ids: prospectIds,
      stats: EMPTY_JOB_STATS,
    } as never)
    .select("id")
    .single<{ id: string }>();

  if (error || !data) return { ok: false, error: error?.message ?? "Could not start the job." };

  // Kick the first slice. after() keeps this action's function alive long enough
  // to actually send the trigger once the response has returned. Origin is taken
  // from the incoming request so the chain stays on this exact host/port.
  const cookieHeader = await currentCookieHeader();
  const origin = originFromHeaders(await headers());
  const jobId = data.id;
  if (!origin) return { ok: false, error: "Could not resolve request origin." };
  after(async () => {
    await triggerNextSlice(jobId, cookieHeader, origin);
  });

  return { ok: true, jobId };
}

export async function cancelDiscoveryJob(
  jobId: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const idParse = z.string().uuid().safeParse(jobId);
  if (!idParse.success) return { ok: false, error: "Invalid job id." };

  const user = await requireUser();
  const supabase = await createClient();

  const { error } = await supabase
    .from("discovery_jobs")
    .update({ status: "cancelled", completed_at: new Date().toISOString() } as never)
    .eq("id", idParse.data)
    .eq("tenant_id", user.tenantId)
    .eq("status", "running");

  if (error) return { ok: false, error: error.message };
  return { ok: true };
}

export async function getDiscoveryJob(jobId: string): Promise<DiscoveryJob | null> {
  const idParse = z.string().uuid().safeParse(jobId);
  if (!idParse.success) return null;

  const user = await requireUser();
  const supabase = await createClient();

  const { data } = await supabase
    .from("discovery_jobs")
    .select(JOB_COLS)
    .eq("id", idParse.data)
    .eq("tenant_id", user.tenantId)
    .maybeSingle<JobRow>();

  return data ? toJob(data) : null;
}

export async function getActiveJobForIcp(icpId: string): Promise<DiscoveryJob | null> {
  const idParse = z.string().uuid().safeParse(icpId);
  if (!idParse.success) return null;

  const user = await requireUser();
  const supabase = await createClient();

  const { data } = await supabase
    .from("discovery_jobs")
    .select(JOB_COLS)
    .eq("tenant_id", user.tenantId)
    .eq("icp_id", idParse.data)
    .eq("status", "running")
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle<JobRow>();

  return data ? toJob(data) : null;
}
