# Brief: lead-alerts

| | |
|---|---|
| Module | reply poll (`app/api/replies/poll/route.ts`) + calendar sync (`lib/opportunities/calendar-sync.ts`), with pure formatters in `lib/replies/lead-alert.ts` and `lib/opportunities/booking-alert.ts` (new) |
| Model / effort | opus-5.5 / medium |
| Branch | `claude/lead-alerts` from `claude/conductor-skill-board-tasks-cu74t5` |
| PR target | `claude/conductor-skill-board-tasks-cu74t5` |
| Reserved migration | none |
| Depends on | wave 0 (landed): `lib/notify/send.ts` with `kind: "lead"` = pedro@runnareach.com, petedv31@gmail.com, nila@runna.com.mx |
| Conductor session | `session_018Qvu38cNFVCuWNq41wYfxJ` (send_message ONLY if blocked) |
| Size | M |

## Goal
Pedro, 2026-10-18: every reply from a prospect and every calendar booking must reach
him, petedv31@gmail.com and nila@runna.com.mx. Today only replies that got an AI draft
produce an email ("N reply drafts awaiting review"), and bookings produce nothing. After
this task: each poll run that stored new prospect replies sends ONE lead alert listing
them (hot ones first, with what they actually wrote), and each new booking or
cancellation sends one alert. Good = the team can act from the email alone, no alert is
ever sent twice for the same reply or booking, and an alert failure never breaks the
poll or the sync.

## Context the worker needs
- Recipients and sending: call `sendNotification` / `sendNotificationWithToken` from
  `lib/notify/send.ts` with `kind: "lead"`. Never pass an address yourself.
- Poll (`app/api/replies/poll/route.ts`): a reply row is inserted once (`insertedReply`
  is null on a duplicate, then `continue`), then handled by intent. `sendDraftDigest` at
  the end sends the current digest (wave 0 already routes it to `kind: "lead"`). Replace
  that digest with the lead alert: collect every newly inserted reply whose intent is NOT
  `bounced` or `auto_reply` (those go in the weekly report, not an alert). Per reply:
  company, contact address, intent in plain words ("wants a meeting", "wants more
  info", "not now", "wrong person", "opted out: removed automatically", "unclear"),
  language, the prospect's OWN text (quoted thread already stripped for classification;
  reuse that text, first ~600 chars), whether a draft reply is waiting, and the /inbox
  link. Order: wants_meeting, wants_info, then the rest. Subject: one reply →
  `Reply from <Company>: <intent>`; several → `<n> new replies (<k> want a meeting)`.
  Test addresses (`isTestAddress`) are still alerted but marked `[test]` in the line.
- Self-loop: alerts are sent FROM the connected inbox TO pedro@runnareach.com, which is
  that same inbox, and the poll lists recent inbound mail on it. Verify in the code that
  a notification thread can never be stored as a prospect reply (the poll only keeps
  threads it can tie to a sent pitch), and add a test or a precise explanation in the PR.
- Calendar sync (`applyCalendarEvents`): on `plan.kind === "create"` after the
  opportunity row exists, and on a successful cancel, record what happened in the result
  (e.g. `bookings: Array<{kind:"booked"|"cancelled", prospectId, company?, attendee, start}>`)
  and send the alerts from the outer sync function after the loop, one email per booking
  or cancellation: `Meeting booked: <Company> (<start>)` with attendee, start time in the
  event's own time zone if the event carries one (else UTC, stated), the prospect's
  market, and the /opportunities link; cancellation: `Booking cancelled: <Company>`.
  Company name: look it up from the prospect (one query for the batch). Idempotency
  already holds (unique `calendar_event_id`; a duplicate never reaches "created").
- Formatters are pure (subject + body from plain data) and unit-tested.

## Files
Allowed to edit:
- `app/api/replies/poll/route.ts` (digest/alert section + collecting the items; do NOT
  touch the status writes at the bounce and `replied` updates; another worker owns the
  status rule and the conductor adopts it there)
- `lib/opportunities/calendar-sync.ts` (result shape + alert sending; do NOT touch
  `markProspectBooked`'s filter, same reason)
- `app/api/opportunities/calendar-sync/route.ts` (only if the result shape needs it)
- `lib/replies/lead-alert.ts`, `lib/opportunities/booking-alert.ts` (new)
- tests: `tests/lead-alert.test.ts` (new), `tests/opportunities-calendar-sync.test.ts` (add)

Read for context, do not edit: `lib/notify/*`, `lib/replies/classify.ts`, `lib/compliance/test-addresses.ts`.

Forbidden: `lib/replies/intent-actions.ts` and `lib/opportunities/actions.ts` (another
worker), `lib/notify/**`, `lib/gmail/**`, `lib/supabase/types.ts`, `vercel.json`, migrations.

## Must not change (negative set)
- Classification, DNC, suppression, sequence pausing/postponing, draft creation, pitch
  events: identical (diff shows no change in those blocks).
- Calendar sync counts and errors for every existing test: identical.
- A poll run with no new human reply sends nothing.

## Acceptance checks
1. `npm test`: formatter tests (one reply, several, ordering, `[test]` marking, opt-out
   wording, ES reply text kept verbatim, long text clipped); booking + cancel alert
   tests; calendar-sync tests assert the new `bookings` result.
2. A test (or a fake-db run) shows a poll that inserted 2 replies (wants_meeting +
   hard_no) and 1 bounce calls the notifier once, with 2 lines, kind `lead`.
3. Self-loop explanation or test (above).
4. `npm run build` green.

## External prerequisites
none. Optional for Pedro: env `NOTIFY_EMAILS` / `LEAD_NOTIFY_EMAILS` override the lists.

## Prod verification
The poll's and the sync's JSON responses gain `alerts: {sent, failed}` (add it). The
conductor reads them from `net._http_response` for `/api/replies/poll` and
`/api/opportunities/calendar-sync`: the first run with a new reply or booking must show
`sent: 3` (one per recipient) and `failed: []`.

## Out of scope
- Weekly/emergency reports (another task). SMS/WhatsApp. Changing the inbox UI.
