# Brief: pipeline-status-rule

| | |
|---|---|
| Module | prospect status writers in discovery/research: `lib/discover/pipeline-stage.ts` (`processSingleProspectWith`), `lib/discover/bulk-actions.ts` (`bulkScoreProspects` restore only), `lib/research/deep-research-stage.ts` (its one status write) |
| Model / effort | opus-5.5 / medium (`lib/prospects/` status-rule lane; conductor adopts nothing in shared files) |
| Branch | `claude/pipeline-status-rule` from `claude/optimistic-tesla-3gceud` (main 9c98448 + b08c324) |
| PR target | `claude/optimistic-tesla-3gceud` |
| Reserved migration | none |
| Depends on | b08c324 (already on the base: removed the explicit reactivation branch) |
| Conductor session | `session_017nqBxLFFXKbhDwKiPi6xLf` (send_message ONLY if blocked; the PR body is the report) |
| Size | M |

## Goal
Pedro (2026-10-18): a parked prospect (suppressed / no_match) is never reactivated by the
pipeline; the status rule wins. Commit b08c324 removed the one branch that did it
explicitly, but a review found the same re-run still un-parks a prospect three other ways.
Good = no AUTOMATED writer of `prospects.status` can move a prospect against
`lib/prospects/status.ts` (I1–I5), and a re-run of a do-not-send prospect costs nothing.

## Context the worker needs
Read `lib/prospects/status.ts` (the rule, `mayOverwriteStatus`, `protectedStatusFilter`,
`DO_NOT_SEND_STATUSES`) and how batch 2 adopted it (`lib/compliance/opt-out.ts`, the poll
route's bounce/replied writes, `lib/opportunities/calendar-sync.ts` markProspectBooked):
`.not("status", "in", protectedStatusFilter(next, "automation")!)` in the UPDATE's WHERE.

The holes (all reproduced by the reviewer; line numbers on base b08c324):
1. `pipeline-stage.ts` ~612: after a successful pitch, `update({ status: "pitched" })` with
   only id + tenant in the WHERE. A suppressed prospect re-run from /companies (filter
   Suppressed → Run pipeline → `startPipelineJobForProspectsWith` → `/api/discover/run` →
   `processSingleProspectWith`) ends up `pitched` with a stale suppressed_reason; worse
   than before, a draft pitch is attached. Also ~312 (no-website lane → pitched) and ~527
   (score 50–69 → `b_list`, clears suppressed_reason/at; b_list is sendable).
2. Nothing at the top of `processSingleProspectWith` (~192–197) checks the status it
   reads, so a do-not-send prospect runs the whole paid pipeline (deep research, scoring,
   Claude pitch).
3. Timing gap with no person involved: an autopilot job takes its raw ids up front and works
   through them over many slices (`app/api/discover/run/route.ts` ~295, ~441); a prospect
   bulk-suppressed meanwhile can still be un-parked by 1.
4. `bulk-actions.ts` ~345–380 (`bulkScoreProspects` restore): an Auto-suppressed or
   no_match prospect scoring ≥ 40 goes back to `researched` with the suppression cleared:
   the exact twin of the branch b08c324 removed.
5. `deep-research-stage.ts` ~373–385: suppresses from its own set
   (`raw/researched/needs_review`, read at the start of the run) with no from-state in the
   WHERE: a prospect booked during the run is suppressed (breaks I3).

Do:
- (a) Every status write in `processSingleProspectWith` (~259, 291, 310, 328, 399, 506, 525,
  592, 611), the `bulkScoreProspects` restore/suppress writes, and the deep-research
  suppress write carry `.not("status", "in", protectedStatusFilter(<next>, "automation")!)`
  (skip the filter only when it is null). The bulkScore restore of a parked prospect goes
  away entirely (it is refused by I5 anyway; remove the dead branch, as b08c324 did).
- (b) At the top of `processSingleProspectWith`, a prospect whose current status is in
  `DO_NOT_SEND_STATUSES` returns early (outcome `"suppressed"`, no deep research, no score,
  no pitch, no Claude spend). Keep (a) too, for the timing gap in 3.
- (c) The outcome counted for a prospect that stayed parked is `"suppressed"`, never
  `"needs_review"` (the job stats and /companies count it, and the Active view hides it).
- (d) Fix b08c324's over-claim: its comment and test name say "never reactivates"; make
  them true and replace the single-string source grep with a test that every
  `.update({ status:` in `processSingleProspectWith` carries the guard (source test is
  fine; a fake-client test is better where it is cheap).

Readers: `app/api/discover/run/route.ts` counts outcomes (~366) and its catch-up uses
`NON_PITCHABLE` (~49); `components/companies/*` show the counts. Do not change them.

## Files
Allowed to edit:
- `lib/discover/pipeline-stage.ts` (`processSingleProspectWith` only)
- `lib/discover/bulk-actions.ts` (`bulkScoreProspects` only)
- `lib/research/deep-research-stage.ts` (the status write only)
- `tests/prospect-status.test.ts`, new `tests/pipeline-status-rule.test.ts`

Read, do not edit: `lib/prospects/status.ts`, `app/api/discover/run/route.ts`,
`lib/discover/job-stage.ts`, `lib/pitches/pitch-stage.ts` (generatePitchWith already guards
its own status write to raw/researched/b_list).

Forbidden: `lib/prospects/status.ts` (the rule itself), `lib/discover/bulk-actions.ts`
`bulkTransitionStatus`, `lib/prospects/detail-actions.ts` `transitionStatus` (manual status
changes: a pending question to Pedro, see below), `lib/replies/**`, `lib/supabase/types.ts`,
`vercel.json`, migrations.

## Must not change (negative set)
- A raw / researched / scored prospect runs the pipeline exactly as today (same Claude
  calls, same statuses, same outcomes).
- Manual status changes (`bulkTransitionStatus`, `transitionStatus`) untouched.
- `DO_NOT_SEND_STATUSES` and the rule's contents untouched.

## Acceptance checks
1. A test (fake client or pure helper) shows, for each of `suppressed`, `no_match`, `won`,
   `lost`, `booked`, `archived_no_meeting`: `processSingleProspectWith` writes no status, makes
   no Claude call and returns `"suppressed"`. Shown failing on the base (paste the count).
2. A test shows the guards: a row that turns `suppressed` between the read and each write is
   not moved (the UPDATE's WHERE refuses it).
3. bulkScore: a parked prospect scoring ≥ 40 stays parked; a booked prospect scoring < 40 is
   not suppressed. Deep research: a booked prospect scoring < 40 is not suppressed.
4. `npm run typecheck && npm run lint && npm test && npm run build` green.

## External prerequisites
none

## Prod verification
After the deploy: `select count(*) from prospects where status in ('pitched','b_list','researched')
and suppressed_reason is not null` should not grow (today's count goes in the PR body).

## Out of scope
- Manual un-suppress (Pedro's call, pending). `send-reply-action.ts:421` (archived_no_meeting
  over booked/won/lost) and `NON_PITCHABLE` in the run route: lessons inbox.

## Questions already answered
Q: Return early or still re-research a do-not-send prospect?  A: Return early (Pedro:
"reactivation skips them"; it also saves Claude spend under the $3/24h cap).
