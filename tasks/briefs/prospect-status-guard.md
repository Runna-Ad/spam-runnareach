# Brief: prospect-status-guard

| | |
|---|---|
| Module | `lib/prospects/` (new `status.ts`) + two writers: `lib/replies/intent-actions.ts`, `lib/opportunities/actions.ts` |
| Model / effort | opus-5.5 / medium |
| Branch | `claude/prospect-status-guard` from `claude/conductor-skill-board-tasks-cu74t5` |
| PR target | `claude/conductor-skill-board-tasks-cu74t5` |
| Reserved migration | none |
| Depends on | none |
| Conductor session | `session_018Qvu38cNFVCuWNq41wYfxJ` (send_message ONLY if blocked) |
| Size | S–M |

## Goal
`prospects.status` has many writers and each has its own overwrite rule, so real outcomes
get erased: a bounce on a won client's address sets `suppressed` (the win vanishes from
analytics), and a "wants a meeting" reply from a won client sets `booked`. Build ONE pure
predicate that answers "may this writer set status X over status Y", adopt it in the two
writers you own, and give the conductor a one-line filter to adopt it in the three others.
Good = an invariant in code with a table-driven test over every (current, next) pair.

## Context the worker needs
Writers today (verify each with grep before relying on it):
| Writer | Sets | Guard today |
|---|---|---|
| `lib/compliance/opt-out.ts` (conductor adopts) | suppressed | not in (won,booked,lost) |
| `app/api/replies/poll/route.ts` bounce (conductor adopts) | suppressed | NONE |
| `app/api/replies/poll/route.ts` reply | replied | not in (archived_no_meeting,suppressed,booked,won,lost) |
| `lib/opportunities/calendar-sync.ts` markProspectBooked (conductor adopts) | booked | not in (won,lost) |
| `lib/replies/intent-actions.ts` wants_meeting (YOU) | booked | NONE |
| `lib/replies/intent-actions.ts` bounced (YOU) | suppressed | NONE |
| `lib/opportunities/actions.ts` won/lost (YOU) | won / lost | NONE (a person's explicit outcome) |
Manual status edits (`lib/prospects/detail-actions.ts`, `lib/discover/bulk-actions.ts`)
are a person choosing a status explicitly: out of scope, leave them unguarded.

Rule, stated as invariants (Pedro 2026-10-18 accepted Q6: a real outcome wins over a
later opt-out or bounce; sending stays blocked by DNC + paused sequences either way):
- I1 An automated writer never moves a prospect out of `won` or `lost`.
- I2 `booked` is overwritten only by `won` or `lost`.
- I3 `suppressed` never overwrites `booked`, `won`, `lost`.
- I4 `replied` never overwrites `archived_no_meeting`, `suppressed`, `booked`, `won`, `lost`.
- I5 No write makes a stopped prospect sendable: from a do-not-send status
  (`suppressed, archived_no_meeting, no_match, lost, won, booked`, the set in
  `lib/pitches/send-action.ts` MANUAL_DO_NOT_SEND) the next status is also do-not-send.
- I6 `by: "person"` relaxes only I1/I2 for outcomes: a person may set `won`/`lost` over
  anything (including correcting won ↔ lost). Everything else applies to people too.

Public API (FROZEN: the conductor adopts it in three files right after merge):
```ts
export type StatusWriter = "automation" | "person";
export const DO_NOT_SEND_STATUSES: ReadonlySet<string>;
export function mayOverwriteStatus(current: string | null | undefined, next: string, by: StatusWriter): boolean;
/** For `.not("status", "in", f)`: "(booked,won,lost)", or null when nothing is protected. */
export function protectedStatusFilter(next: string, by: StatusWriter): string | null;
```
`protectedStatusFilter` must be derived from `mayOverwriteStatus` over the full status
list (one source of truth), not written by hand. The `prospect_status` enum in prod
(checked 2026-10-18): raw, enriched, researched, scored, match, no_match, pitched, queued,
approved, sent, bounced, replied, booked, ghosted, lost, won, suppressed,
archived_no_meeting, b_list. Export it as a const tuple in `status.ts`.

## Files
Allowed to edit:
- `lib/prospects/status.ts` (new)
- `lib/replies/intent-actions.ts` (the two status updates only)
- `lib/opportunities/actions.ts` (the prospect status update only, if the predicate changes it)
- `tests/prospect-status.test.ts` (new)

Read for context, do not edit: the writers in the table, `lib/pitches/send-action.ts`,
`app/api/pitches/send-queue/route.ts`.

Forbidden: `lib/compliance/**`, `app/api/replies/poll/route.ts` and
`lib/opportunities/calendar-sync.ts` (another worker is editing them this batch),
`lib/supabase/types.ts`, `vercel.json`, migrations.

## Must not change (negative set)
- A prospect in raw / enriched / researched / scored / match / pitched / queued / approved /
  sent / bounced / replied / ghosted / b_list (any status not named in I1–I5) receives every write exactly as today.
- The poll route's `replied` guard and opt-out's guard are exactly what the predicate
  returns for those writes (assert both strings in a test).
- calendar-sync's guard: `protectedStatusFilter("booked","automation")` = "(won,lost)" (assert).

## Acceptance checks
1. `npm test` passes; `tests/prospect-status.test.ts` checks every (current, next, by)
   triple against I1–I6 as a property over the full status list, plus the three
   string assertions above.
2. intent-actions: a won prospect + wants_meeting stays won; a booked prospect + bounce
   stays booked (unit-test the update builder or show the `.not(...)` filter in the diff).
3. PR body section "Needs conductor" lists the exact replacement line for each of the
   three files the conductor adopts.

## External prerequisites
none

## Prod verification
After deploy: `select status, count(*) from prospects where status in ('won','lost','booked') group by 1;`
does not shrink across a week where bounces or opt-outs arrive for those prospects.

## Out of scope
Making the send paths read `DO_NOT_SEND_STATUSES` (two copies today): write it in your
lessons-inbox file; the conductor schedules it.

## Questions already answered
Q: Should a booking overwrite `suppressed`?  A: Yes (I3 is one-way; booked is also do-not-send).
