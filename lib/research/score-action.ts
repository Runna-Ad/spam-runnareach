"use server";

/**
 * Score a prospect against its ICP.
 *
 * Browser-facing: every action here acts only for the logged-in user. The
 * logic lives in score-stage.ts and takes an explicit Actor so the autopilot can
 * run it too (lib/actor.ts). Never add an actor parameter here: anything
 * exported from a "use server" file can be called from a browser.
 */

import { sessionActor } from "@/lib/actor";
import { scoreProspectWith, type ScoreProspectResult } from "./score-stage";

export type { ScoreProspectResult } from "./score-stage";

export async function scoreProspect(prospectId: string): Promise<ScoreProspectResult> {
  return scoreProspectWith(await sessionActor(), prospectId);
}
