"use server";

/**
 * Background discovery jobs: start, resume, cancel, poll.
 *
 * Browser-facing: every action here acts only for the logged-in user. The
 * logic lives in job-stage.ts and takes an explicit Actor so the autopilot can
 * run it too (lib/actor.ts). Never add an actor parameter here: anything
 * exported from a "use server" file can be called from a browser.
 */

import { sessionActor } from "@/lib/actor";
import {
  cancelDiscoveryJobWith,
  getActiveBulkPipelineJobWith,
  getActiveJobForIcpWith,
  getDiscoveryJobWith,
  resumeDiscoveryJobWith,
  startDiscoveryJobWith,
  startPipelineJobForProspectsWith,
  type DiscoveryJobMode,
} from "./job-stage";
import type { DiscoveryJob } from "./job-types";

export type { DiscoveryJobMode } from "./job-stage";

export async function startDiscoveryJob(
  icpId: string,
  mode: DiscoveryJobMode = "full",
): Promise<{ ok: true; jobId: string } | { ok: false; error: string }> {
  return startDiscoveryJobWith(await sessionActor(), icpId, mode);
}

export async function resumeDiscoveryJob(jobId: string): Promise<{ ok: true; resumed: boolean } | { ok: false; error: string }> {
  return resumeDiscoveryJobWith(await sessionActor(), jobId);
}

export async function startPipelineJobForProspects(prospectIds: string[]): Promise<{ ok: true; jobId: string } | { ok: false; error: string }> {
  return startPipelineJobForProspectsWith(await sessionActor(), prospectIds);
}

export async function cancelDiscoveryJob(jobId: string): Promise<{ ok: true } | { ok: false; error: string }> {
  return cancelDiscoveryJobWith(await sessionActor(), jobId);
}

export async function getDiscoveryJob(jobId: string): Promise<DiscoveryJob | null> {
  return getDiscoveryJobWith(await sessionActor(), jobId);
}

export async function getActiveBulkPipelineJob(): Promise<DiscoveryJob | null> {
  return getActiveBulkPipelineJobWith(await sessionActor());
}

export async function getActiveJobForIcp(icpId: string): Promise<DiscoveryJob | null> {
  return getActiveJobForIcpWith(await sessionActor(), icpId);
}
