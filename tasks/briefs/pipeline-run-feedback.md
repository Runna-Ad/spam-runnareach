# Brief: pipeline-run-feedback

| | |
|---|---|
| Module | `lib/discover/` run route + job stats, and the UI that reports them (`components/companies`, `components/discover`, `components/prospects`) |
| Model / effort | opus-5.5 / medium (`lib/discover/` + dashboard components lanes) |
| Branch | `claude/pipeline-run-feedback` from `claude/phase3-batch5-integration` |
| PR target | `claude/phase3-batch5-integration` |
| Reserved migration | none |
| Depends on | none. Parallel with the other batch 5 tasks (disjoint files) |
| Conductor session | `session_017nqBxLFFXKbhDwKiPi6xLf` (send_message here ONLY if blocked; the PR body is the report) |
| Size | S/M |

## Goal
When Pedro runs the pipeline on /companies, the result tells the truth: how many companies were
skipped because they were already contacted or parked, how many were processed, pitched, sent
to review, suppressed or failed. Today a run where every company was already contacted says
"0 pitched · 0 review · 0 suppressed (0 processed)", which reads like a broken run. Plus small
honesty fixes left from batch 4 (timers, an ignored write error, a duplicated status list,
dead code).

## Context the worker needs
- Outcomes: `lib/discover/pipeline-stage.ts:45` `ProspectOutcome = "suppressed" | "needs_review" |
  "pitched" | "website_pitch" | "skipped" | "error"`; the skip is at `:223-225`
  (`isPastPipeline(p.status)` → `outcome: "skipped"`, `error: "Skipped: already contacted (<status>)"`
  or `"parked"`).
- The run route tallies at `app/api/discover/run/route.ts:380-395`; `skipped` is only
  `console.info`'d (`:386`), counted nowhere. `processed` = non-skipped (`:398-400`), plus
  `processed_ids`. The pitching phase (`:586-595`) can skip too (filters with `isPastPipeline`).
- `DiscoveryJobStats` (`lib/discover/job-types.ts:11-67`): no `skipped` field. `EMPTY_JOB_STATS`
  `:83-92`. Stored in `discovery_jobs.stats` jsonb (0023; shape enforced only by the TS type).
- **Server readers of the stats (their meaning must not change):** `lib/autopilot/tick.ts:414`
  (`stats->pitched`, `stats->processed`), `:431`, `:433` (`stats->>started_by`);
  `lib/autopilot/learn.ts:200` (`focus`, `new`, `found_ids`), `:286` (`processed_ids`).
  So `processed` stays "researched (not skipped)"; add `skipped` as a new optional field.
- UI: `components/companies/companies-page.tsx:183-210` builds the completion toast
  (`done = pitched + website_pitch + needs_review + suppressed`; the detail line omits
  `website_pitch`; "N processed" is `done + errored`). `components/discover/run-all-modal.tsx`
  shows outcome tiles (`:563-576`, `:629-644`).
- Timers: per-prospect `Promise.race` against `setTimeout(... "prospect-timeout", budget)`
  (`route.ts:353-361`) and the pitching phase's `"pitch-timeout"` race (`:586-595`) are never
  cleared; `tests/pipeline-guards.test.ts:304-311` unrefs `setTimeout` to work around it.
- `lib/discover/bulk-actions.ts`: `bulkRunPipeline` (`:264-290`) has **no callers** (the UI uses
  the job route); `ADVANCED_STATUSES` (`:51-54`) is a strict subset of `isPastPipeline`'s set
  (`lib/prospects/status.ts:75-83`: it lacks `pitched`, `queued`, `approved`); its only use is
  `bulkGeneratePitches` (`:559`, "N already sent/replied").
- Deep research and scrape return `status_write_error?: string`
  (`lib/research/deep-research-stage.ts:38-51`, `:404-406`; `scrape-stage.ts:21`, `:406`); the UI
  callers in `components/prospects/prospect-detail.tsx` (`:710` scrape, `:740` deep research)
  never show it, so a failed status write looks like success.

## Brain lessons
- serverless-durable-background-jobs.md: a keepalive or timer must be "cleared in a `finally`,
  since an orphaned interval keeps a serverless function alive and can push it into the very
  timeout you're avoiding."

## The changes
1. `skipped?: number` in `DiscoveryJobStats`, counted by the route for both phases. The
   /companies toast shows skipped companies (with a plain reason, e.g. "3 already contacted"),
   includes `website_pitch`, and when every company was skipped says so plainly instead of
   "0 processed". The run-all modal shows skipped when > 0.
2. Clear both race timers in a `finally`. The test's unref workaround may stay but must not be
   what keeps the suite fast (prove it: the route test passes in about the same time without it).
3. Delete `bulkRunPipeline` (and anything only it uses), after a fresh grep shows no caller.
4. One status list: export the "already sent or later" set from `lib/prospects/status.ts`
   (defined from the existing sets, not a new hand-written list) and use it in
   `bulkGeneratePitches`; behaviour identical for all 19 statuses.
5. Show `status_write_error` from scrape and deep research in prospect-detail as a warning
   (the research result still shows).

## Files
Allowed to edit:
- `lib/discover/job-types.ts`, `app/api/discover/run/route.ts`, `lib/discover/bulk-actions.ts`, `lib/prospects/status.ts` (add an export; do not change existing sets or `mayOverwriteStatus`)
- `components/companies/companies-page.tsx`, `components/discover/run-all-modal.tsx`, `components/prospects/prospect-detail.tsx`
- `tests/*.test.ts`
Read for context, do not edit:
- `lib/discover/pipeline-stage.ts`, `lib/discover/job-stage.ts`, `lib/autopilot/tick.ts`, `lib/autopilot/learn.ts`, `lib/research/deep-research-stage.ts`, `lib/research/scrape-stage.ts`
Forbidden: `lib/supabase/types.ts`, `vercel.json`, `CLAUDE.md`, `lib/{anthropic,gmail,compliance,supabase}/`, migrations.

## Must not change (negative set)
- `processed`, `processed_ids`, `pitched`, `error_count`, `errors` mean exactly what they mean today.
- Which companies the pipeline skips, researches, pitches or suppresses.
- `bulkGeneratePitches` skips exactly the same statuses as today (table test over all 19).
- The volume cap and the AI cost wrapper.

## Acceptance checks
1. `npm run typecheck && npm run lint && npm test` pass.
2. Route test (existing loader-hook harness in `tests/pipeline-guards.test.ts`): a slice with 2
   skipped + 2 processed → `skipped: 2`, `processed: 2`, `processed_ids` = the 2.
3. A pure test of the toast text (extract the formatter): all skipped; mixed with website_pitch;
   all failed (unchanged wording).
4. A timer test: after a fast prospect, no pending race timer remains (e.g. count live timers or
   spy on `clearTimeout`).
5. Table test for the status export used by `bulkGeneratePitches`.
6. Mutation table in the PR.

## External prerequisites
none.

## Prod verification
The conductor runs "Run pipeline" on one already-contacted company after the deploy: the toast
says it was skipped as already contacted, and `select stats->'skipped' from discovery_jobs order by created_at desc limit 1` = 1.

## Out of scope
Pipeline order, research cost, the 500-row /companies limit, any status-rule change. Lessons go
to `tasks/lessons-inbox/pipeline-run-feedback.md`.

## Questions already answered
Q: Count skipped into `processed`?  A: No. The autopilot reads `processed` as "researched".
Q: Show skipped companies' names?  A: No, a count and the reason are enough.

## If blocked
Message the conductor with what you tried, what you need, and what you can still do meanwhile.
