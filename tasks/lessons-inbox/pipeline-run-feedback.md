[2026-10-20] A counter added to a multi-phase job counts each company once, in the phase that decides it
WHAT HAPPENED: The brief asked for `stats.skipped` "counted by the route for both phases". The pitching phase's isPastPipeline filter (`app/api/discover/run/route.ts`, pruning → pitching handoff) runs over the ICP's whole ≥70 pool for an ICP job, and over the same ids the pipeline phase already saw for a hand-picked job. Counting there would report dozens of skips for a one-company run, or count the same company twice, and the prod check (`stats->'skipped'` = 1) would fail. Only the pipeline phase counts.
RULE: Before adding a counter at a filter, ask what set the filter ranges over. If it is wider than "the companies this run was asked to process", or overlaps a set already counted, the count is not the run's; count where each company's outcome is decided, once.
TAGS: discover, job-stats, honesty

[2026-10-20] Prove a timer fix by removing the test's workaround, not by adding one
WHAT HAPPENED: tests/pipeline-guards.test.ts unref'd every setTimeout so the route's never-cleared race timers did not hold the process. Replacing the unref with a live-timer tracker (no unref) made the old route fail the new timer test and take 1m35s; the fixed route (`withDeadline`, clear in `finally`) runs the file in 0.6s.
RULE: A test shim that hides a leak (unref, fake timers advanced past it) also hides the regression. Track the resource instead and assert it is released; the slow suite on the old code is extra proof.
TAGS: testing, timers, serverless

## Out of scope, noticed
- `app/api/discover/run/route.ts` pitching phase: `stats.pitched` adds ICP-wide catch-up pitches (other runs' high scorers) to this run's tally; for an ICP job the toast's "N pitched" can include companies this run never researched. Meaning left unchanged (brief's negative set).
- `generatePitchWith` (lib/pitches/pitch-stage.ts) re-checks only DO_NOT_SEND_STATUSES (`:423`), not isPastPipeline; the pitching phase relies on the handoff filter, so a company that moved to sent or replied between the handoff and its pitching slice would still get a new draft (and a Claude call). Not changed (brief: which companies are pitched must not change).
