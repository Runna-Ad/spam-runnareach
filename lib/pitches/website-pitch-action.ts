"use server";

/**
 * Website pitch for prospects with no usable site.
 *
 * Browser-facing: every action here acts only for the logged-in user. The
 * logic lives in website-pitch-stage.ts and takes an explicit Actor so the autopilot can
 * run it too (lib/actor.ts). Never add an actor parameter here: anything
 * exported from a "use server" file can be called from a browser.
 */

import { sessionActor } from "@/lib/actor";
import { generateWebsitePitchWith, type WebsitePitchResult } from "./website-pitch-stage";

export type { WebsitePitchResult } from "./website-pitch-stage";

export async function generateWebsitePitch(prospectId: string): Promise<WebsitePitchResult> {
  return generateWebsitePitchWith(await sessionActor(), prospectId);
}
