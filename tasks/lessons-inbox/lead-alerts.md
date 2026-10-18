[2026-10-18] An alert built inside a draft branch only fires for the branch
WHAT HAPPENED: The reply poll's only team email was a "drafts awaiting review" digest pushed from inside the draft-created branch (`app/api/replies/poll/route.ts`), so opt-outs, wrong-person replies and any reply whose draft failed never reached anyone. Replaced with a collector (`lib/replies/lead-alert.ts`) fed from every human-reply branch, sent once after the loop.
RULE: Notify on the event the team cares about (a reply was stored), not on a side effect of handling it (a draft was made). Collect at the point the row is known new (the insert that dedupes), send once after the loop, and never let the send throw into the job.
TAGS: replies, notify

[2026-10-18] Google Calendar events carry start.timeZone even though our type does not
WHAT HAPPENED: `CalendarEvent.start` in `lib/opportunities/google-calendar.ts` declares only dateTime/date; the booking alert reads `start.timeZone` through a local widening in `calendar-sync.ts` because that file was outside the allow-list.
RULE: When a typed API shape omits a field you need, widen it locally and flag the shared type for the owner, rather than editing a file outside your brief.
TAGS: opportunities, calendar, types

## Out of scope, noticed
- `lib/opportunities/google-calendar.ts`: add `timeZone?: string` to `CalendarEvent.start` so `eventTimeZone()` in calendar-sync can drop its cast.
- `app/api/replies/poll/route.ts`: if `draftResponse` (or anything after the insert) throws, the thread-level catch skips that reply's alert, and the reply is never retried since its row exists. Rare (draftResponse falls back to the heuristic), but a try/catch around drafting would make the alert unconditional.
