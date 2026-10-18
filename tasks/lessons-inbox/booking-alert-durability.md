[2026-10-18] A start-of-run sweep also takes time away from the route's main work
WHAT HAPPENED: booking-alert-durability moved the calendar lead alert to a sweep at the START of every run (lib/opportunities/calendar-sync.ts). With the plain "claim while 60s remain" rule the start sweep could send two leftovers (~55s each worst case: 10s token + 3 × 15s Gmail) and leave ~5s for the event list and the batch writes, so a kill could land between createOpportunity and the meeting_booked pitch event / audit row, which are never retried (the next run sees a duplicate). The start sweep now stops 40s earlier than the end sweep (CALENDAR_SYNC_WORK_RESERVE_MS).
RULE: When you add a sweep at the start of a route, give it a deadline that leaves the route's own non-retryable writes their time, not just the sweep's own reserve. Add up worst-case time for both: sweep items × per-item worst case, plus the main work, under maxDuration.
TAGS: opportunities, kill-safety, alerts

[2026-10-18] The updated_at trigger moves any window keyed on updated_at
WHAT HAPPENED: opportunities has the 0001 set_updated_at trigger, so every claim and release of an alert marker bumps updated_at. The cancellation alert is due while updated_at is in the last 48h, so a cancellation whose send keeps reaching nobody keeps retrying hourly past 48h (each release restarts the window). Bookings key on created_at and are not affected.
RULE: Before you key a "recent" window on updated_at, check for the trigger and list every writer of that row, your own marker writes included. A window that has to stay closed needs a column that only the event itself writes (fixed in review: 0047 now adds `cancelled_at`, set by markCancelled).
TAGS: supabase, opportunities, windows

## Out of scope, noticed
- `lib/opportunities/calendar-sync.ts` `applyCalendarEvents`: a kill between `createOpportunity` and `recordEvent` loses the meeting_booked pitch event and the audit row for good (the next run sees a duplicate). This was already true before this change. The fix is to sweep for calendar rows with no pitch event, or to write all of them in one RPC.

[2026-10-18] An in-memory fake must snapshot BEFORE it yields, or it can't model a race
WHAT HAPPENED: in tests/booking-alert-durability.test.ts, `dueAlerts` awaited a setTimeout and THEN copied `rows`, so run A finished its claim and send before run B read the table. B never reached `claimAlert`, and the overlap test passed even with `if (!claimed) continue;` deleted. The conductor caught it. Taking the snapshot first and then yielding makes both runs read the row as due, and the mutant then fails 2 vs 1.
RULE: An overlap test has to prove it exercises the guard. Run it once with the guard deleted, see it fail, then restore. A fake read takes its snapshot at the moment the query would, and only then yields.
TAGS: tests, concurrency, claims
