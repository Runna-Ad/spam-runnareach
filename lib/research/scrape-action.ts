"use server";

/**
 * Scrape a prospect's website.
 *
 * Browser-facing: every action here acts only for the logged-in user. The
 * logic lives in scrape-stage.ts and takes an explicit Actor so the autopilot can
 * run it too (lib/actor.ts). Never add an actor parameter here: anything
 * exported from a "use server" file can be called from a browser.
 */

import { sessionActor } from "@/lib/actor";
import { scrapeWebsiteWith, type ScrapeWebsiteResult } from "./scrape-stage";

export type { ScrapeWebsiteResult } from "./scrape-stage";

export async function scrapeWebsite(prospectId: string): Promise<ScrapeWebsiteResult> {
  return scrapeWebsiteWith(await sessionActor(), prospectId);
}
