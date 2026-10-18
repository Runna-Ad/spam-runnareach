[2026-10-18] A status guard written as invariants exposes gaps the hand-written lists hid
WHAT HAPPENED: Deriving the `replied` guard from I1–I5 (`lib/prospects/status.ts`) adds `no_match` to the poll route's hand-written list `(archived_no_meeting,suppressed,booked,won,lost)`: a no_match prospect that replies became `replied`, a sendable status, which breaks I5. I3 and I4 turned out to be implied by I1/I2/I5, so the predicate only encodes three rules.
RULE: When several writers each carry their own `.not("status","in",…)` list, write the invariants once, derive every list from them, and table-test every (current, next, writer) triple. Compare guard lists as sets, not strings: PostgREST `in` is order-free and the derived order (enum order) differs from the hand-written ones.
TAGS: prospects, status, invariants

## Out of scope, noticed
- Two copies of the do-not-send set: `MANUAL_DO_NOT_SEND` in `lib/pitches/send-action.ts` and the one in `app/api/pitches/send-queue/route.ts`; both should read `DO_NOT_SEND_STATUSES` from `lib/prospects/status.ts`.
- `app/api/replies/poll/route.ts` bounce suppress (~line 345) has no tenant filter (`.eq("id", thread.prospect_id)` only) as well as no status guard.
