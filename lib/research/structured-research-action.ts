"use server";

/**
 * Structured research (pain points, contacts) for a prospect.
 *
 * Browser-facing: every action here acts only for the logged-in user. The
 * logic lives in structured-research-stage.ts and takes an explicit Actor so the autopilot can
 * run it too (lib/actor.ts). Never add an actor parameter here: anything
 * exported from a "use server" file can be called from a browser.
 */

import { sessionActor } from "@/lib/actor";
import { runStructuredResearchWith, type StructuredResearchResult } from "./structured-research-stage";

export type { StructuredResearchResult } from "./structured-research-stage";

export async function runStructuredResearch(prospectId: string): Promise<StructuredResearchResult> {
  return runStructuredResearchWith(await sessionActor(), prospectId);
}
