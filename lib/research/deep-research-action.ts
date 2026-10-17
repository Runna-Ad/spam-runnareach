"use server";

/**
 * Deep-research a prospect.
 *
 * Browser-facing: every action here acts only for the logged-in user. The
 * logic lives in deep-research-stage.ts and takes an explicit Actor so the autopilot can
 * run it too (lib/actor.ts). Never add an actor parameter here: anything
 * exported from a "use server" file can be called from a browser.
 */

import { sessionActor } from "@/lib/actor";
import { deepResearchProspectWith, type DeepResearchResult } from "./deep-research-stage";

export type { DeepResearchResult } from "./deep-research-stage";

export async function deepResearchProspect(prospectId: string,
  options?: { skipScore?: boolean }): Promise<DeepResearchResult> {
  return deepResearchProspectWith(await sessionActor(), prospectId, options);
}
