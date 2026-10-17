"use server";

/**
 * Run one discovery source crawl.
 *
 * Browser-facing: every action here acts only for the logged-in user. The
 * logic lives in crawl-stage.ts and takes an explicit Actor so the autopilot can
 * run it too (lib/actor.ts). Never add an actor parameter here: anything
 * exported from a "use server" file can be called from a browser.
 */

import { sessionActor } from "@/lib/actor";
import { runCrawlWith, closeStuckRunsWith, type CrawlInput, type CrawlResult } from "./crawl-stage";

export type { CrawlInput, CrawlResult } from "./crawl-stage";

export async function runCrawl(input: CrawlInput): Promise<CrawlResult> {
  return runCrawlWith(await sessionActor(), input);
}

export async function closeStuckRuns(): Promise<{ closed: number }> {
  return closeStuckRunsWith(await sessionActor());
}
