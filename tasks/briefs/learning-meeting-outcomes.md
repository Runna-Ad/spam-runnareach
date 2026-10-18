# Brief: learning-meeting-outcomes

| | |
|---|---|
| Module | `lib/learning/` (reward.ts only) |
| Model / effort | opus-5.5 / medium (see tasks/routing.md) |
| Branch | `claude/learning-meeting-outcomes` from `claude/conductor-skill-board-tasks-cu74t5` |
| PR target | `claude/conductor-skill-board-tasks-cu74t5` (phase 3 batch 2 integration branch) |
| Reserved migration | none (`pitch_event_type` already has `meeting_booked`, `won`, `lost` since 0043) |
| Depends on | wave 0 (on the integration branch): `OUTCOME_EVENT_TYPES` exported from `reward.ts` and used by the exemplar shortlist |
| Conductor session | `session_018Qvu38cNFVCuWNq41wYfxJ` (send_message ONLY if blocked; the PR body is the report) |
| Size | S |

## Goal
A booked meeting is the best thing a cold email can produce, and today every learner is
blind to it: `scoreOutcome` reads only sent / reply / audit_scan / bounce / unsubscribe.
After this task, a pitch whose prospect booked a meeting (or became a won or lost deal)
scores as a full success for the writer and scout learners, counts points on the
dashboards, settles immediately, and qualifies as an exemplar. Good = one definition in
`reward.ts`, every consumer inherits it, nothing else moves.

## Context the worker needs
- Events are written on the ROOT pitch (`lib/pitches/root-pitch.ts`):
  `meeting_booked` by the calendar sync (`lib/opportunities/calendar-sync.ts`, payload
  `{opportunity_id, calendar_event_id, attendee, start}`); `won` / `lost` by
  `/opportunities` (`lib/opportunities/actions.ts`, payload `{opportunity_id, close_date,
  value?|loss_reason?}`); a cancelled booking also writes `lost` with
  `loss_reason: "booking cancelled"`.
- Consumers of `scoreOutcome`: `lib/autopilot/learn.ts` (loads ALL event types, so it
  inherits automatically), `lib/learning/outcomes.ts` (scout/ICP), `lib/pitches/exemplars.ts`
  (shortlist; its loader selects `OUTCOME_EVENT_TYPES`, so add the three types there).
- Decisions (Pedro, 2026-10-18, defaults accepted):
  - `meeting_booked`, `won`, `lost` each mean the email produced a meeting or a deal:
    value = 1, decisive (settles now). A lost deal is NOT the email's failure (Q7).
  - Points: `meeting_booked` 20, `won` 40 (on top of the meeting's points if both exist),
    `lost` 0 extra. Export them in `POINTS` like the others.
  - An opportunity event outweighs a bounce for `value`: a prospect who booked got the
    message. `addressOutcome` stays exactly as today (it judges the address, not the email).
  - Events with `payload.test === true` stay ignored, like every other type.
- `value` is `null` when there is no `sent` event; keep that (an opportunity on a pitch
  that never sent teaches the writer nothing).

## Files
Allowed to edit:
- `lib/learning/reward.ts`
- `tests/learning.test.ts`, `tests/outcomes.test.ts` (add cases), new tests allowed

Read for context, do not edit:
- `lib/learning/outcomes.ts`, `lib/autopilot/learn.ts`, `lib/pitches/exemplars.ts`,
  `lib/pitches/exemplar-queries.ts`, `lib/opportunities/calendar-sync.ts`, `lib/opportunities/actions.ts`

Forbidden (conductor-only): `lib/supabase/types.ts`, `vercel.json`, `CLAUDE.md`,
migrations, `lib/pitches/**` (a hub task is open there), `lib/autopilot/**`.

## Must not change (negative set)
- Every existing test in `tests/learning.test.ts` and `tests/outcomes.test.ts` passes
  unchanged (same values, points, status, signals for timelines without the new types).
- A timeline with only `sent` and no signal stays `pending` until 14 days, then settles at 0.
- A bounce with no opportunity event: `value` null, as today.
- Test events (payload.test) of any type, including the new ones: ignored.
- `addressOutcome` output for every input: unchanged.

## Acceptance checks
1. `npm test` passes; new tests cover: sent+meeting_booked → value 1, settled, points 20,
   signal `meeting_booked`; sent+meeting_booked+won → points 60; sent+meeting_booked+lost
   ("booking cancelled") → value 1, points 20; meeting_booked without sent → value null;
   sent+bounce+meeting_booked → value 1; a test-flagged meeting_booked → ignored.
2. `OUTCOME_EVENT_TYPES` contains the three new types (a test asserts it), so
   `selectExemplars` sees them: one test feeds a candidate whose only signal is
   `meeting_booked` through `selectExemplars` and shows it qualifies (score ≥ 0.5).
3. Show the new tests failing on the integration-branch `reward.ts` (paste the output).

## External prerequisites
none

## Prod verification
`select event_type, count(*) from pitch_events where event_type in ('meeting_booked','won','lost') group by 1;`
Today 0 rows. After the first booking, the weekly learner's arm for that pitch's writer
arm gains a success: `select learner, key, reward, trials from learning_arms order by updated_at desc limit 5;`

## Out of scope
- Sharing the audit_scan "level" rule with `lib/pitches/hot-lead.ts` (pitches is the hub).
- Any UI. The /learning page reads arms and needs no change.

## Questions already answered
Q: Should `lost` be negative?  A: No. The meeting happened; the email did its job.
Q: Should a cancelled booking score lower?  A: No, same as lost (value 1, points 20 from the booking).
