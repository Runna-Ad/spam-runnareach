/**
 * The /companies "Run pipeline" completion message, as a pure function so its
 * wording is testable. Client-safe: no server imports.
 */

import type { DiscoveryJob } from "./job-types";

export type RunSummary = { tone: "ok" | "warn"; text: string };

export function summarizePipelineRun(
  job: Pick<DiscoveryJob, "status" | "stats" | "error_message">,
): RunSummary {
  const s = job.stats;
  if (job.status === "failed") {
    return { tone: "warn", text: job.error_message ?? "Pipeline run failed — try again." };
  }

  const errored = s.error_count ?? 0;
  const skipped = s.skipped ?? 0;
  const done = s.pitched + s.website_pitch + s.needs_review + s.suppressed;
  const skippedNote = skipped > 0 ? `${skipped} skipped: already contacted or parked` : null;

  // Nothing ran because every company was past the pipeline: say that, not "0 processed".
  if (done === 0 && errored === 0 && skipped > 0) {
    return {
      tone: "ok",
      text: `Nothing to run: ${skipped === 1 ? "the company was" : `all ${skipped} companies were`} already contacted or parked, so the pipeline skipped ${skipped === 1 ? "it" : "them"}.`,
    };
  }

  if (done === 0 && errored > 0) {
    const firstError = s.errors?.[0] ?? job.error_message ?? null;
    return {
      tone: "warn",
      text:
        `Pipeline finished but every prospect failed (${errored}).` +
        (firstError ? ` First error: ${firstError}` : " Check the prospect's Activity tab for details.") +
        (skippedNote ? ` ${skippedNote}.` : ""),
    };
  }

  const detail = [
    `${s.pitched} pitched`,
    ...(s.website_pitch > 0 ? [`${s.website_pitch} website pitch`] : []),
    `${s.needs_review} review`,
    `${s.suppressed} suppressed`,
    ...(errored > 0 ? [`${errored} failed`] : []),
  ].join(" · ");
  return {
    tone: "ok",
    text: `Pipeline done — ${detail} (${done + errored} processed)${skippedNote ? ` · ${skippedNote}` : ""}.`,
  };
}
