# Brief: opportunities-calendar-sync

| | |
|---|---|
| Module | `lib/opportunities/` (new) + `app/api/opportunities/` (new) |
| Model / effort | opus-5.5 / high (touches OAuth and a cron-reachable route) |
| Branch | `claude/opportunities-calendar-sync` from `claude/gallant-gauss-gly093` |
| PR target | `claude/gallant-gauss-gly093` (phase 3 integration branch) |
| Reserved migration | `supabase/migrations/0044_calendar_sync_cron.sql` (cron schedule only) |
| Depends on | none (0043 already on the integration branch adds the columns and enum values) |
| Conductor session | `session_012bGmp5nHP9Lx5ke69JkaBk` (send_message when done or blocked) |
| Size | M |

## Goal
Today the system has no place where a booked meeting is recorded, so the funnel ends at
"replied". Pedro will put a Google Calendar appointment-schedule link in front of
interested prospects. When a prospect books, that must become an `opportunities` row at
stage `meeting_booked` and a `pitch_events` row, with no human step, and it must never
create the same opportunity twice or create one for our own addresses. A good solution is
a pure matcher with tests plus a thin, idempotent, scheduler-authorized route.

## Context the worker needs
- Google Calendar appointment schedules create ordinary events on the connected
  account's primary calendar, with the booker as an attendee. There is no booking
  webhook, so this is an hourly poll: `events.list` on `primary` with `updatedMin` = now
  minus 48h, `singleEvents=true`, `showDeleted=true`, `maxResults=100`. Cancelled
  bookings arrive as `status: "cancelled"`.
- Access tokens: `lib/gmail/client.ts` already refreshes a Google access token from the
  stored refresh token for a sender inbox. Reuse that refresh path; do not store tokens
  anywhere new. The Calendar API needs scope
  `https://www.googleapis.com/auth/calendar.readonly`, which the existing refresh tokens
  do not have. Append it to `SCOPES` in `app/api/auth/google/connect/route.ts` (append
  only; keep the existing scopes and order). Until Pedro reconnects Google, the Calendar
  call returns 403 `insufficientPermissions`: handle that as a normal outcome
  (`{ needsReconnect: true }`, logged once, HTTP 200), never as a thrown error.
- Schema already landed (migration 0043): `opportunities.source` ('manual'|'calendar'),
  `opportunities.calendar_event_id` (unique per tenant when not null),
  `pitch_event_type` values `meeting_booked`, `won`, `lost`. `opportunities` already has
  `prospect_id`, `contact_id`, `stage` (`meeting_booked` default), `notes`.
- Matching rule: for each event attendee whose email is not the inbox's own address and
  is not a test address (there is an existing test-address helper; `tests/test-addresses.test.ts`
  shows it), look up `prospect_contacts` by `tenant_id` + lower-cased email. First match
  wins. No match → count as `unmatched`, do nothing.
- Insert pattern for `pitch_events`: `lib/pitches/events.ts` (the table is not in the
  hand-written types; follow the file's own cast pattern). Attach the event to the most
  recent sent pitch for that prospect if one exists, else skip the pitch event and still
  create the opportunity.
- Route auth: `isSchedulerAuthorized(req) || isCronAuthorized(req)` from `lib/cron-auth.ts`,
  service-role client via `systemActor` (`lib/actor.ts`). Look at
  `app/api/autopilot/tick/route.ts` for the route shape, Sentry check-in flush and the
  `errors: []` response convention.
- Cron: migration 0044 adds exactly one line in the 0041 style:
  `select cron.schedule('spam-calendar-sync', '5 * * * *', $job$select public.spam_cron_call('/api/opportunities/calendar-sync')$job$);`
- Which inbox owns the booking calendar: the sender inbox flagged as primary for the
  tenant (see how `send-queue` picks the inbox); if there is no such flag, the first
  active inbox. Say which you used in the PR body.

## Files
Allowed to edit:
- `lib/opportunities/calendar-sync.ts` (new; pure matcher + `syncCalendarWith(actor, deps)`)
- `lib/opportunities/google-calendar.ts` (new; the API call, `AbortSignal.timeout(10_000)`)
- `app/api/opportunities/calendar-sync/route.ts` (new)
- `app/api/auth/google/connect/route.ts` (append one scope only)
- `supabase/migrations/0044_calendar_sync_cron.sql` (new, one `cron.schedule` line)
- `tests/opportunities-calendar-sync.test.ts` (new)

Read, do not edit: `lib/gmail/client.ts`, `lib/cron-auth.ts`, `lib/actor.ts`,
`lib/pitches/events.ts`, `lib/pitches/test-addresses.ts` (or wherever the helper lives),
`app/api/autopilot/tick/route.ts`, `app/api/pitches/send-queue/route.ts`,
`supabase/migrations/0041_autopilot_scheduler.sql`, `supabase/migrations/0043_*.sql`.

Forbidden: `lib/opportunities/queries.ts` and `lib/opportunities/actions.ts` (another
worker owns them), `vercel.json`, `lib/supabase/types.ts`, anything in `lib/autopilot/`.

## Must not change (negative set)
- Existing Gmail scopes, their order, and the OAuth callback behaviour.
- Any existing cron job, route or `vercel.json` entry.
- `opportunities` rows with `source = 'manual'` are never touched by the sync.

## Acceptance checks
1. Pure matcher tests: attendee matching a contact → one opportunity; the inbox's own
   address and a test address → ignored; the same event id twice → one opportunity;
   a cancelled event for an existing `meeting_booked` opportunity → stage `lost`,
   `loss_reason` "booking cancelled"; a cancelled event with no opportunity → nothing.
2. Route returns 401 without the scheduler token, 200 with it (test with a `Request`).
3. 403 from Google → `{ needsReconnect: true }` and HTTP 200, no throw.
4. Migration 0044 contains exactly one `cron.schedule` line for
   `/api/opportunities/calendar-sync`.
5. `npm run typecheck && npm run lint && npm test` green; report the test count.

## Out of scope
The UI list of opportunities and the won/lost actions (another worker). Writing the
booking link into pitches. Any change to the governor or the tick.

## Questions already answered
Q: Booking tool? A: Google Calendar appointment schedules (Pedro, 2026-10-17). Free.
Q: Who reconnects Google for the new scope? A: Pedro, once, after ship. Put a one-line
"Needs Pedro" note in the PR body.
