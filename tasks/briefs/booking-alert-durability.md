# Brief: booking-alert-durability

| | |
|---|---|
| Module | `lib/opportunities/` (calendar-sync alerts) + its route |
| Model / effort | opus-5.5 / high (deviation from the alerts lane's medium: the same claim/kill-safety class cost lead-alerts 2 reworks in batch 2) |
| Branch | `claude/booking-alert-durability` from `claude/optimistic-tesla-3gceud` |
| PR target | `claude/optimistic-tesla-3gceud` |
| Reserved migration | 0047, ALREADY WRITTEN by the conductor: `supabase/migrations/0047_opportunities_alert_markers.sql`. Read it; do not edit it or add another. |
| Depends on | wave 0 (0047 file on the integration branch) |
| Conductor session | `session_017nqBxLFFXKbhDwKiPi6xLf` (send_message ONLY if blocked; the PR body is the report) |
| Size | M |

## Goal
A meeting booked through Pedro's calendar link is the most valuable event the platform
sees. Today the sync sends its lead alert from memory after the batch: a Gmail 429/503,
a token failure or a kill at maxDuration loses it for good (the opportunity row exists,
so the next run sees a duplicate and never alerts). Make every booking and every
cancellation produce exactly one lead alert, eventually, and never two.

## Context the worker needs
Read `lib/opportunities/calendar-sync.ts` (all), `lib/opportunities/booking-alert.ts`,
`app/api/opportunities/calendar-sync/route.ts`, and the reply-alert implementation of the
same pattern in `lib/replies/lead-alert.ts` lines 1–30 and 130–275 (copy its shape, do
not import it). Migration 0047 adds to `opportunities`: `booked_alert_sent_at`,
`cancelled_alert_sent_at` (timestamptz, null = not alerted), `meeting_start`,
`meeting_time_zone` (text), and marks every existing calendar row as alerted.
`opportunities` is not in `lib/supabase/types.ts`; the sync already uses the any-typed
client (`AnySupabase`), keep doing that.

Invariants (state them in the file's header comment and test each):
- D1 Due: a `source = 'calendar'` opportunity is due a booking alert while
  `booked_alert_sent_at` is null and it was created in the last 48h; due a cancellation
  alert while it is `stage = 'lost'`, `loss_reason = CANCELLED_LOSS_REASON`,
  `cancelled_alert_sent_at` is null, updated in the last 48h. Manual opportunities never.
- D2 Claim before send: set the marker only where it is still null and send only the rows
  this run won (atomic UPDATE … RETURNING id). A send that reached nobody (`sent === 0`)
  releases the claim (marker back to null); partial delivery keeps it (no duplicate to
  those who got it). Overlapping runs can never both send one alert.
- D3 Newest state wins: a row due both alerts (booked, never alerted, now cancelled) gets
  only the cancellation alert, and both markers are set.
- D4 The alert is rebuilt from the database (row + prospect company/market + contact
  email via `contact_id`), not from the Google event: `createOpportunity` now stores
  `meeting_start` (the event start you already compute) and `meeting_time_zone`. The
  cancellation path keeps the row's stored start. Text from `formatBookingAlert`, unchanged.
- D5 Kill safety. The route has `maxDuration` 120 (vercel.json). One lead notification
  is one Gmail send per recipient (3 recipients for kind "lead"), each with a 15s timeout
  (`lib/notify/send.ts`), plus a token exchange: budget ~50s per alert. Rule, as in the
  reply poll: sweep due rows at the START of every run (before listing events), and send
  this run's new rows at the END only if at least 60s remain before maxDuration;
  otherwise claim nothing and leave them for the next run's start sweep (hourly, pg_cron
  at :05). Pass the run's start time from the route; tests inject a clock.
- D6 An alert failure never fails the sync. The route's JSON keeps `alerts: {sent, failed}`
  (summed over tenants) and every other field as today.

## Files
Allowed to edit:
- `lib/opportunities/calendar-sync.ts`
- `lib/opportunities/booking-alert.ts`
- `app/api/opportunities/calendar-sync/route.ts`
- `tests/opportunities-calendar-sync.test.ts`, new `tests/booking-alert-durability.test.ts`

Read for context, do not edit: `lib/replies/lead-alert.ts`, `lib/notify/send.ts`,
`lib/notify/recipients.ts`, `supabase/migrations/0043_*.sql`, `0047_*.sql`.

Forbidden: `lib/notify/**`, `lib/replies/**`, `lib/supabase/types.ts`, `vercel.json`,
any migration, every other module.

## Must not change (negative set)
- Matching, planning and status writes: `planEvent`, `bookingCandidates`,
  `organizedByInbox`, `markProspectBooked`, the meeting_booked / lost pitch events, the
  audit row. Every existing test in `tests/opportunities-calendar-sync.test.ts` passes
  (adapt only the alert assertions, and say which in the PR body).
- A duplicate event whose opportunity is already alerted sends nothing.
- Rows marked alerted by 0047 never alert. Manual opportunities never alert.
- Alert wording, sender name ("S.P.A.M Bookings") and the kind "lead" recipients.
- needsReconnect / truncated / auth-failure reports: no alert sweep is attempted without
  a working token (nothing to send from), and the report says what it observed.

## Acceptance checks
1. Tests (in-memory store, injected clock and notify):
   a. notify returns `{sent:0}` for the run that books → no alert, marker null; next run's
      start sweep sends it once; a third run sends nothing.
   b. notify throws → same as (a).
   c. the end step with <60s left claims nothing; the next run sends it.
   d. two overlapping runs over one due row → exactly one notify call (the claim decides).
   e. booked-then-cancelled before any alert → one cancellation alert, both markers set.
   f. a row older than 48h with a null marker → not sent.
   g. partial delivery (`sent:1, failed:[…]`) → marker kept, not re-sent.
   Show (a), (b) and (d) failing on the integration branch's code (paste the fail count).
2. `npm run typecheck && npm run lint && npm test` green (`npm run build` too: you touch `app/`).

## External prerequisites
Conductor applies 0047 before the deploy (additive; existing code ignores the columns).

## Prod verification
After the deploy and 0047: `select count(*) from opportunities where source = 'calendar'
and booked_alert_sent_at is null and created_at < now() - interval '2 hours'` → 0; the
next `net._http_response` row for `/api/opportunities/calendar-sync` → 200 with
`alerts.failed` = [].

## Out of scope
- Dedupe of opportunities per prospect on rebook (Pedro accepted two rows); warning when
  CALENDAR_BOOKING_INBOX matches no inbox; needsReconnect visibility. Lessons inbox.
- Any change to reply alerts or the poll route.

## Questions already answered
Q: Use `hot_alert_sent_at`-style single column?  A: No: one row can need two alerts
(booked, later cancelled); 0047 gives one marker each.
Q: Alert a booking older than 48h that never went out?  A: No (same window as reply
alerts); Google already emailed the organizer; the opportunity is on /opportunities.
