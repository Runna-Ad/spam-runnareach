# Brief: pipeline-guards

| | |
|---|---|
| Module | `lib/discover/` pipeline + its status writes (+ two "check before spending" guards in research and pitch generation) |
| Model / effort | opus-5.5 / medium (`lib/discover/`, `lib/prospects/` lanes) |
| Branch | `claude/pipeline-guards` from `claude/phase3-batch4-integration` |
| PR target | `claude/phase3-batch4-integration` |
| Reserved migration | none |
| Depends on | none. Parallel with autopilot-trust-split, send-path-hardening and address-trust (disjoint files) |
| Conductor session | `session_017nqBxLFFXKbhDwKiPi6xLf` (send_message here ONLY if blocked; the PR body is the report) |
| Size | M |

## Goal
The pipeline only ever moves a company forward in the funnel, and no Claude money is spent
on a company we may not email. Today a "Run pipeline" on /companies re-processes a company
we already emailed and can move it back to `pitched`/`b_list`/`suppressed`, and a pitch or
a deep research can be paid for and then refused by the status guard.

## Context the worker needs
- Status rule: `lib/prospects/status.ts` (`PROSPECT_STATUSES`, `DO_NOT_SEND_STATUSES`,
  `mayOverwriteStatus`, `protectedStatusFilter`). It allows `sent → pitched` (both sendable),
  which is why a re-run moves contacted companies backwards.
- `lib/discover/pipeline-stage.ts` `processSingleProspectWith` (~l.178) reads the prospect,
  runs discovery/scrape/research/score/pitch, and writes status through `writeStatus`
  (~l.218), which applies the rule's guard but has no notion of funnel order. Its
  `if (error) return true` treats a failed write as "allowed".
- `/companies` "Run pipeline" (app/api/discover/run/route.ts) accepts any status.
  `suppressUnfinished` (~l.119) sweeps only `raw`, so a prospect bumped to `researched`
  and then errored is neither swept nor re-selected.
- `lib/research/scrape-stage.ts` (raw → researched bump) and
  `lib/research/deep-research-stage.ts` (suppress write) ignore the write's `error`.
- Spend before refusal: `lib/pitches/pitch-stage.ts` `generatePitchWith` (~l.113) calls
  Claude before the guarded status write (a company parked mid-run gets an orphan draft);
  `lib/research/deep-research-action.ts` (the UI button) runs a paid deep research on a
  company whose status is in `DO_NOT_SEND_STATUSES`.

## Brain lessons
- capture-pipeline-silent-success-needs-a-dead-mans-switch.md: a write whose error is
  ignored looks identical to success. Check and surface every status write's error.

## The changes
1. **Forward only.** Add ONE exported predicate in `lib/prospects/status.ts` that names the
   statuses where a company has been contacted or decided (at least `pitched`, `queued`,
   `approved`, `sent`, `bounced`, `replied`, `ghosted`, and everything in
   `DO_NOT_SEND_STATUSES`). The pipeline run skips such a company before any paid step
   and reports "already contacted" (or the status) instead of re-processing it; a direct
   `processSingleProspectWith` call on one returns the same skip.
2. **Status writes check their error**: `writeStatus`, the scrape bump and the deep-research
   suppress write report a failed write (return/log it), never "allowed".
3. **Unfinished sweep**: `suppressUnfinished` also suppresses ids that the run moved to
   `researched` and then errored or timed out, guarded so it never touches a row another
   writer has moved on since.
4. **No spend on do-not-send**: `generatePitchWith` re-reads the status and stops before the
   Claude call when the company is in `DO_NOT_SEND_STATUSES` (or past the pipeline per 1);
   `deepResearchProspect` (UI) refuses the same companies before any paid call, with a
   clear message.

## Files
Allowed: `lib/prospects/status.ts` (add the predicate; do not change `mayOverwriteStatus`),
`lib/discover/pipeline-stage.ts`, `app/api/discover/run/route.ts`,
`lib/research/scrape-stage.ts`, `lib/research/deep-research-stage.ts`,
`lib/research/deep-research-action.ts`, `lib/pitches/pitch-stage.ts`, `tests/*.test.ts`.
Read only: `lib/discover/bulk-actions.ts`, `lib/research/*`, `lib/autopilot/tick.ts`.
Forbidden: `lib/supabase/types.ts`, `vercel.json`, `CLAUDE.md`, `lib/{anthropic,gmail,compliance,supabase}/`, migrations,
`lib/discover/enrich-contacts.ts` and `lib/research/anymail-finder.ts` (address-trust owns them).

## Must not change (negative set)
- A new company (`raw`) goes through the whole pipeline exactly as today.
- `mayOverwriteStatus` / `protectedStatusFilter` results for every (current, next, writer).
- A manual status change by a person (un-suppress included) works as today.
- The 100 prospects/day volume cap and the AI cost wrapper are untouched.

## Acceptance checks
1. `npm run typecheck && npm run lint && npm test` pass; new tests: run pipeline on a `sent`,
   a `replied` and a `pitched` company → skipped, status unchanged, no Claude call (count
   the fake's calls); `raw` → full run; a failed status write is reported; a company
   `researched` then errored is swept; `generatePitchWith` on a company suppressed between
   the read and the call makes no Claude call; deep research on `suppressed` refuses.
2. A table test: the new predicate over all 19 `PROSPECT_STATUSES`.
3. Mutation table in the PR.

## External prerequisites
none.

## Prod verification
After deploy: `select count(*) from prospects where status in ('pitched','sent','replied') and updated_at > <deploy time> and ...` shows no backwards move after a "Run pipeline" on a contacted company (the conductor runs one by hand on a test company).

## Out of scope
The status rule's invariants, scoring, research quality, Anymail/Hunter (address-trust).
Lessons go to `tasks/lessons-inbox/pipeline-guards.md`.

## Questions already answered
Q: Should a contacted company ever be re-researched?  A: Not from the pipeline run. A person can still open it and act by hand.
Q: Is `b_list` "contacted"?  A: No: it is a scoring outcome before any email. It may be re-run.

## If blocked
Message the conductor with what you tried, what you need, and what you can still do meanwhile.
