/**
 * Pipeline run feedback (brief tasks/briefs/pipeline-run-feedback.md): the
 * /companies completion toast tells the truth about skipped companies, and bulk
 * pitch generation skips exactly the statuses it skipped before the shared export.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { EMPTY_JOB_STATS, type DiscoveryJobStats } from "../lib/discover/job-types.ts";
import { summarizePipelineRun } from "../lib/discover/run-summary.ts";
import { PROSPECT_STATUSES, isPastPipeline, isSentOrParked } from "../lib/prospects/status.ts";

const done = (stats: Partial<DiscoveryJobStats>, error_message: string | null = null) =>
  summarizePipelineRun({ status: "done", stats: { ...EMPTY_JOB_STATS, ...stats }, error_message });

// ── Toast text ───────────────────────────────────────────────────────────────

test("toast: every company skipped says so, never '0 processed'", () => {
  const one = done({ skipped: 1 });
  assert.equal(one.tone, "ok");
  assert.equal(one.text, "Nothing to run: the company was already contacted or parked, so the pipeline skipped it.");
  const many = done({ skipped: 3 });
  assert.equal(many.text, "Nothing to run: all 3 companies were already contacted or parked, so the pipeline skipped them.");
  assert.doesNotMatch(many.text, /0 processed/);
});

test("toast: mixed run counts website pitches and shows the skipped count with its reason", () => {
  const r = done({ pitched: 2, website_pitch: 1, needs_review: 1, suppressed: 1, error_count: 1, skipped: 3 });
  assert.equal(r.tone, "ok");
  assert.equal(
    r.text,
    "Pipeline done — 2 pitched · 1 website pitch · 1 review · 1 suppressed · 1 failed (6 processed) · 3 skipped: already contacted or parked.",
  );
});

test("toast: a run with no skips and no website pitches keeps today's wording", () => {
  assert.equal(
    done({ pitched: 2, needs_review: 1, suppressed: 0 }).text,
    "Pipeline done — 2 pitched · 1 review · 0 suppressed (3 processed).",
  );
});

test("toast: all failed keeps its wording (with and without a first error)", () => {
  const withErr = done({ error_count: 2, errors: ["Final score failed: x"] });
  assert.equal(withErr.tone, "warn");
  assert.equal(withErr.text, "Pipeline finished but every prospect failed (2). First error: Final score failed: x");
  const noErr = done({ error_count: 1 });
  assert.equal(noErr.text, "Pipeline finished but every prospect failed (1). Check the prospect's Activity tab for details.");
  // Skips alongside failures are added, the failure wording stays first.
  assert.equal(
    done({ error_count: 1, skipped: 2 }).text,
    "Pipeline finished but every prospect failed (1). Check the prospect's Activity tab for details. 2 skipped: already contacted or parked.",
  );
});

test("toast: a failed job shows its error message", () => {
  const r = summarizePipelineRun({ status: "failed", stats: { ...EMPTY_JOB_STATS, skipped: 4 }, error_message: "Slice failed." });
  assert.deepEqual(r, { tone: "warn", text: "Slice failed." });
  const fallback = summarizePipelineRun({ status: "failed", stats: EMPTY_JOB_STATS, error_message: null });
  assert.equal(fallback.text, "Pipeline run failed — try again.");
});

test("source: /companies builds its completion toast from summarizePipelineRun", () => {
  const src = readFileSync(new URL("../components/companies/companies-page.tsx", import.meta.url), "utf8");
  assert.match(src, /setBulkToast\(summarizePipelineRun\(j\)\)/);
  assert.doesNotMatch(src, /every prospect failed/);
});

// ── One status list for bulk pitch generation ────────────────────────────────

// The list bulkGeneratePitches carried before this change (ADVANCED_STATUSES).
const OLD_ADVANCED = new Set([
  "sent", "replied", "booked", "won", "lost", "ghosted", "bounced",
  "suppressed", "archived_no_meeting", "no_match",
]);

test("isSentOrParked over all 19 statuses = the old bulk-generate skip list", () => {
  assert.equal(PROSPECT_STATUSES.length, 19);
  for (const s of PROSPECT_STATUSES) {
    assert.equal(isSentOrParked(s), OLD_ADVANCED.has(s), s);
  }
  assert.equal(isSentOrParked(null), false);
  assert.equal(isSentOrParked(undefined), false);
});

test("isSentOrParked is a subset of isPastPipeline; the difference is the drafted-but-unsent statuses", () => {
  const diff = PROSPECT_STATUSES.filter((s) => isPastPipeline(s) && !isSentOrParked(s));
  assert.deepEqual(diff, ["pitched", "queued", "approved"]);
  for (const s of PROSPECT_STATUSES) if (isSentOrParked(s)) assert.ok(isPastPipeline(s), s);
});

test("source: bulkGeneratePitches uses the shared export, and the dead bulkRunPipeline is gone", () => {
  const src = readFileSync(new URL("../lib/discover/bulk-actions.ts", import.meta.url), "utf8");
  assert.match(src, /if \(isSentOrParked\(status\)\) \{ skippedAdvanced \+= 1; continue; \}/);
  assert.doesNotMatch(src, /ADVANCED_STATUSES|bulkRunPipeline|processSingleProspect/);
});

// ── A failed status write is shown, not read as success ──────────────────────

test("source: prospect-detail shows status_write_error from scrape and deep research as a warning", () => {
  const src = readFileSync(new URL("../components/prospects/prospect-detail.tsx", import.meta.url), "utf8");
  const uses = src.match(/result\.status_write_error !== undefined/g) ?? [];
  assert.ok(uses.length >= 3, `expected scrape (part + tone) and deep research checks, got ${uses.length}`);
  assert.match(src, /tone: statusWarning \? "warn" : "ok"/);
});
