"use server";

/**
 * Pitch actions: generate, rewrite, edit, approve.
 *
 * Browser-facing: every action here acts only for the logged-in user. The
 * logic lives in pitch-stage.ts and takes an explicit Actor so the autopilot can
 * run it too (lib/actor.ts). Never add an actor parameter here: anything
 * exported from a "use server" file can be called from a browser.
 */

import { sessionActor } from "@/lib/actor";
import {
  bulkApprovePitchesWith,
  generatePitchWith,
  rewritePitchWithAngleWith,
  savePitchEditWith,
  transitionPitchStatusWith,
  type GeneratePitchResult,
  type PitchActionResult,
  type RewritePitchResult,
} from "./pitch-stage";

export type { GeneratePitchResult, PitchActionResult, RewritePitchResult } from "./pitch-stage";

export async function generatePitch(prospectId: string): Promise<GeneratePitchResult> {
  return generatePitchWith(await sessionActor(), prospectId);
}

export async function rewritePitchWithAngle(
  input: Parameters<typeof rewritePitchWithAngleWith>[1],
): Promise<RewritePitchResult> {
  return rewritePitchWithAngleWith(await sessionActor(), input);
}

export async function savePitchEdit(input: Parameters<typeof savePitchEditWith>[1]): Promise<PitchActionResult> {
  return savePitchEditWith(await sessionActor(), input);
}

export async function transitionPitchStatus(
  input: Parameters<typeof transitionPitchStatusWith>[1],
): Promise<PitchActionResult> {
  return transitionPitchStatusWith(await sessionActor(), input);
}

export async function bulkApprovePitches(
  input: Parameters<typeof bulkApprovePitchesWith>[1],
): ReturnType<typeof bulkApprovePitchesWith> {
  return bulkApprovePitchesWith(await sessionActor(), input);
}
