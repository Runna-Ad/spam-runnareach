"use server";

/**
 * Run every discovery source for an ICP.
 *
 * Browser-facing: every action here acts only for the logged-in user. The
 * logic lives in run-all-stage.ts and takes an explicit Actor so the autopilot can
 * run it too (lib/actor.ts). Never add an actor parameter here: anything
 * exported from a "use server" file can be called from a browser.
 */

import { sessionActor } from "@/lib/actor";
import { runAllSourcesWith, previewRunAllSourcesWith, type RunAllResult, type RunAllPreview } from "./run-all-stage";

export type { RunAllResult, RunAllPreview } from "./run-all-stage";

export async function runAllSources(icpId: string): Promise<RunAllResult> {
  return runAllSourcesWith(await sessionActor(), icpId);
}

export async function previewRunAllSources(icpId: string): Promise<RunAllPreview | null> {
  return previewRunAllSourcesWith(await sessionActor(), icpId);
}
