"use server";

/**
 * Automated prospect pipeline (scrape, research, score, triage, pitch).
 *
 * Browser-facing: every action here acts only for the logged-in user. The
 * logic lives in pipeline-stage.ts and takes an explicit Actor so the autopilot can
 * run it too (lib/actor.ts). Never add an actor parameter here: anything
 * exported from a "use server" file can be called from a browser.
 */

import { sessionActor } from "@/lib/actor";
import { getProspectIdsForRunsWith, getRawProspectIdsWith, countRawProspectsWith, discardRawProspectsWith, processSingleProspectWith, reEnrichProspectContactsWith, pruneRunToTop30With, type SinglePipelineResult } from "./pipeline-stage";

export type { ProspectOutcome, SinglePipelineResult, PipelineSummary } from "./pipeline-stage";

export async function getProspectIdsForRuns(runIds: string[]): Promise<{ ok: true; ids: string[] } | { ok: false; error: string }> {
  return getProspectIdsForRunsWith(await sessionActor(), runIds);
}

export async function getRawProspectIds(icpId?: string): Promise<{ ok: true; ids: string[] } | { ok: false; error: string }> {
  return getRawProspectIdsWith(await sessionActor(), icpId);
}

export async function countRawProspects(icpId?: string): Promise<{ ok: true; count: number } | { ok: false; error: string }> {
  return countRawProspectsWith(await sessionActor(), icpId);
}

export async function discardRawProspects(icpId?: string): Promise<{ ok: true; deleted: number } | { ok: false; error: string }> {
  return discardRawProspectsWith(await sessionActor(), icpId);
}

export async function processSingleProspect(prospectId: string): Promise<SinglePipelineResult> {
  return processSingleProspectWith(await sessionActor(), prospectId);
}

export async function reEnrichProspectContacts(prospectId: string): Promise<
  | { ok: true; found: boolean; email?: string; method?: string }
  | { ok: false; error: string }
> {
  return reEnrichProspectContactsWith(await sessionActor(), prospectId);
}

export async function pruneRunToTop30(prospectIds: string[]): Promise<{ ok: true; kept: number; deleted: number } | { ok: false; error: string }> {
  return pruneRunToTop30With(await sessionActor(), prospectIds);
}
