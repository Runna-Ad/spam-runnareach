[2026-10-19] A status rule that allows a move is not a funnel order
WHAT HAPPENED: `mayOverwriteStatus` allows `sent → pitched` (both sendable), so a "Run pipeline" on an emailed company re-researched it and could move it back to pitched or b_list. The rule answers "may this writer overwrite X", never "is this a step forward". Fixed with one predicate, `isPastPipeline` in lib/prospects/status.ts, checked by `processSingleProspectWith` before any paid step and by the run route's pitching phase.
RULE: A guard that only forbids the forbidden still lets a pipeline go backwards. When an automated stage can be re-entered (a re-run button, a refill), check "has this row already passed me" at its entry, before any spend, with a predicate shared by every entry point.
TAGS: discover, prospects, status, pipeline

[2026-10-19] Spend checks belong right before the paid call, not at the start of the function
WHAT HAPPENED: generatePitchWith (lib/pitches/pitch-stage.ts) did seconds of awaits (contacts, case studies, notable clients, benchmarks, exemplars) before Claude; the pipeline's guarded status write then refused the pitch for a company suppressed meanwhile, after Claude was paid and a draft was left. A fresh, fail-closed status re-read now sits immediately before the Claude call.
RULE: A "may we spend on this row" check runs after the last await before the paid call, reads fresh, and refuses on an error or a missing row, the same shape as the send-time check.
TAGS: pitches, cost, anthropic

[2026-10-19] Loader-hook tests: unref the route's race timers
WHAT HAPPENED: driving app/api/discover/run/route.ts in a test held the process ~95s because `Promise.race` against a `setTimeout` never clears its timer. Unref'ing timers in the test brought the file to 0.4s.
RULE: When a test drives a route that races work against timers, wrap `setTimeout` to `unref()` in the test; a slow suite is a hidden leaked timer more often than slow code.
TAGS: tests, discover

## Out of scope, noticed
- lib/discover/job-types.ts + components/companies/companies-page.tsx: no `skipped` counter, so a Run pipeline where every company was already contacted toasts "0 pitched · 0 review · 0 suppressed (0 processed)". Needs a `skipped` field and a toast line (conductor/UI brief).
- lib/discover/bulk-actions.ts `bulkRunPipeline` counts `skipped` as "affected" (non-error). Should report skipped separately.
- app/api/discover/run/route.ts: each prospect's `Promise.race` timeout timer is never cleared (keeps the function's event loop busy up to 95s after a fast prospect). Harmless today; clearTimeout in a finally would be cleaner.
- The researched sweep runs per batch; a slice killed between a batch's settle and its sweep leaves that batch's errored `researched` rows as they were (same exposure as today). A start-of-run sweep would need the errored ids persisted in job stats (job-types.ts).
