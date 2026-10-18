[2026-10-18] An alert built inside a draft branch only fires for the branch
WHAT HAPPENED: The reply poll's only team email was a "drafts awaiting review" digest pushed from inside the draft-created branch (`app/api/replies/poll/route.ts`), so opt-outs, wrong-person replies and any reply whose draft failed never reached anyone. Replaced with a collector (`lib/replies/lead-alert.ts`) fed from every human-reply branch, sent once after the loop.
RULE: Notify on the event the team cares about (a reply was stored), not on a side effect of handling it (a draft was made). And make the alert durable: when the stored row is the dedupe key, an in-memory alert list is lost for good on a 503 or a killed run. Drive the alert from the table (claim `hot_alert_sent_at` where null, send, release on zero delivery, sweep a recent window every run), never let the send throw into the job. (Review B1 on PR #15.)
TAGS: replies, notify

[2026-10-18] Google Calendar events carry start.timeZone even though our type does not
WHAT HAPPENED: `CalendarEvent.start` in `lib/opportunities/google-calendar.ts` declares only dateTime/date; the booking alert reads `start.timeZone` through a local widening in `calendar-sync.ts` because that file was outside the allow-list.
RULE: When a typed API shape omits a field you need, widen it locally and flag the shared type for the owner, rather than editing a file outside your brief.
TAGS: opportunities, calendar, types

## Out of scope, noticed
- `lib/opportunities/google-calendar.ts`: add `timeZone?: string` to `CalendarEvent.start` so `eventTimeZone()` in calendar-sync can drop its cast.
- Booking alerts stay in-memory (no column to claim). Google already notifies the organizer of each booking, so a lost booking alert is not a lost lead.
- A reply imported more than 48h after Gmail received it (a missed thread caught by the daily full sweep) falls outside the alert window, because the window keys on `received_at`. replies has no insert timestamp; `classified_at` is close to one but is rewritten on reclassification.
