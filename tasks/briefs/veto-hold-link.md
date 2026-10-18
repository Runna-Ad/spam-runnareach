# Brief: veto-hold-link

| | |
|---|---|
| Module | `lib/autopilot/` (digest in `tick.ts` + new `hold.ts`, `hold-token.ts`) + new route `app/api/autopilot/hold/route.ts` |
| Model / effort | opus-5.5 / high (stops scheduled sends; a public, token-authorized route) |
| Branch | `claude/veto-hold-link` from `claude/conductor-skill-board-tasks-cu74t5` |
| PR target | `claude/conductor-skill-board-tasks-cu74t5` |
| Reserved migration | none |
| Depends on | wave 0 (landed): `notify()` in tick.ts now sends through `lib/notify/send.ts` to the ops list |
| Conductor session | `session_018Qvu38cNFVCuWNq41wYfxJ` (send_message ONLY if blocked) |
| Size | M |

## Goal
At the veto stage the autopilot approves AUTO pitches, schedules them 18h out and emails
a digest saying "to hold one, move it back to draft on /pitches". Pedro reads that on his
phone. Give every line of the digest its own hold link: tap → a confirm page → one more
tap holds that email. A hold must be exactly what a person's veto is today (the tick
counts it as a veto and never re-queues it), must be race-safe against the send-queue,
and must never be triggerable by a mail scanner opening the link.

## Context the worker needs
- Read `lib/autopilot/tick.ts` §5 (schedule, ~lines 620–720) and §6 `evaluateStage`. A
  pitch the autopilot approved (`pitch_events` approved with `payload.autopilot = true`)
  that is back in `draft` is "held by a person": §5 moves it to the review lane for good,
  §6 counts it as a veto. Your hold must produce exactly that state.
- DO NOT call `transitionPitchStatusWith` for the hold: its update is unconditional (no
  current-status guard), so it could flip a row the send-queue just claimed
  (`sending`/`sent`) back to draft. Write the hold as ONE conditional update:
  `status = 'approved'` → `draft`, clear `scheduled_send_at`, `queued_at`,
  `sender_inbox_id`, set `autopilot_lane = 'review'`, `autopilot_reasons =
  ['held from the digest link']`, with `.eq("status","approved")` and a returned row
  count. 0 rows → read the row and answer "already sent / already held / not found".
- Audit: `audit_log` action `pitch.held`, entity pitch, metadata `{source: "digest_link"}`.
  No new `pitch_event_type` value (no migration this task).
- Token: `hold-token.ts`, HMAC-SHA256, payload `{p: pitchId, t: tenantId, exp}`; exp =
  the pitch's `scheduled_send_at` + 24h. Key derived from `TOKEN_ENCRYPTION_KEY` with a
  purpose label (e.g. `autopilot-hold-v1`) so an unsubscribe token
  (`lib/compliance/unsubscribe-token.ts`, read it for the pattern) can never verify as a
  hold token and vice versa. Fail closed without the key: no link in the digest, route
  answers "invalid".
- Route pattern: copy `app/api/unsubscribe/route.ts`. GET = confirm page (company,
  subject, scheduled send time, one "Hold this email" button that POSTs); POST = hold +
  a "Held. It will not send." page. GET never changes anything. No login: the token is
  the capability, for one pitch and one action. Service-role client
  (`lib/supabase/service-role`) is fine here behind a verified token, as in unsubscribe.
- Digest: each line `• Company: "subject"` gains `Hold: <appUrl>/api/autopilot/hold?t=<token>`.
  Keep the /pitches link and the veto sentence. English only (it goes to the team).

## Files
Allowed to edit:
- `lib/autopilot/tick.ts` (the veto digest block in §5 only)
- `lib/autopilot/hold.ts`, `lib/autopilot/hold-token.ts` (new)
- `app/api/autopilot/hold/route.ts` (new)
- `tests/autopilot-hold.test.ts` (new)

Read for context, do not edit: `app/api/unsubscribe/route.ts`, `lib/compliance/unsubscribe-token.ts`,
`lib/compliance/outbound.ts`, `lib/pitches/pitch-stage.ts`, `app/api/pitches/send-queue/route.ts`, `lib/notify/send.ts`.

Forbidden: everything else in `lib/autopilot/` and `lib/pitches/`, `lib/compliance/**`,
`lib/notify/**`, `vercel.json` (the route's default 60s is fine), `lib/supabase/types.ts`, migrations.

## Must not change (negative set)
- The scheduling itself: which pitches get approved, `sendAt`, inbox rotation, the
  "held by a person" detection and the veto counter in `evaluateStage`.
- The digest is still sent only when `scheduled.length > 0 && stage === "veto"`.
- A hold on a pitch in any status other than `approved` changes nothing.

## Acceptance checks
1. `npm test`: token round-trip; tampered, expired, wrong-purpose (an unsubscribe token)
   and missing-key cases all fail; hold logic (pure part, or with a fake db) moves only
   `approved` rows and reports already-sent / already-held / not-found.
2. A GET to the route never writes (test the handler or show the code path).
3. `npm run build` green.
4. PR body shows a rendered digest body with two hold links (from a test or a script).

## External prerequisites
none (`TOKEN_ENCRYPTION_KEY` and `NEXT_PUBLIC_APP_URL` are already set in Vercel).

## Prod verification
After the next veto digest: open one hold link (GET) → confirm page, pitch still
`approved`. Conductor checks `select status, autopilot_lane from pitches where id = '<id>'`
only after Pedro taps Hold: `draft`, `review`; and `audit_log` has `pitch.held`.

## Out of scope
- Making `transitionPitchStatusWith` status-guarded (write it in the lessons inbox; it is a
  real gap on /pitches too).
- Changing the 18h window or the stage rules.
