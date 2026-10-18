# Brief: send-path-safety

| | |
|---|---|
| Module | send paths: `lib/pitches/send-action.ts`, `app/api/pitches/send-queue/route.ts`, `app/api/pitches/follow-up/route.ts`, `app/api/replies/nudge/route.ts`, plus `transitionPitchStatusWith` in `lib/pitches/pitch-stage.ts` |
| Model / effort | opus-5.5 / high (send paths lane: serialize, high) |
| Branch | `claude/send-path-safety` from `claude/optimistic-tesla-3gceud` |
| PR target | `claude/optimistic-tesla-3gceud` |
| Reserved migration | none |
| Depends on | none |
| Conductor session | `session_017nqBxLFFXKbhDwKiPi6xLf` (send_message ONLY if blocked; the PR body is the report) |
| Size | M |

## Goal
On Monday 15:00 UTC the autopilot starts sending its first 19 AUTO emails, unattended.
Every way a send path can email a prospect who must not be emailed, or a pitch a person
pulled back, is closed by this task. Good = the four send paths ask ONE question ("may
this prospect be emailed") with ONE set, ask it at the last moment before the Gmail call,
fail closed when they cannot read the answer, and no person's or autopilot's status
change can move a pitch out of `sending`/`sent` or undo a rejection.

## Context the worker needs
Pitch statuses (prod enum): draft, queued_for_approval, approved, auto_rejected,
reviewer_rejected, sending, sent, bounced, failed. The send-queue and the manual "Send
now" claim a row with `approved → sending` (`.eq("status","approved").select("id")`),
then send, then write `sent` unconditionally.

Five holes, all verified on the integration branch:
1. **Four copies of the do-not-send set.** `MANUAL_DO_NOT_SEND` (send-action.ts:33),
   `DO_NOT_SEND_STATUSES` (send-queue route:34, follow-up route:87), `INACTIVE_STATUSES`
   (nudge route:46). Same 6 values today; nothing stops them drifting. Use
   `DO_NOT_SEND_STATUSES` from `lib/prospects/status.ts` everywhere (it already exists;
   do not change its contents). Do not export anything new from `send-action.ts`: it is
   a `"use server"` file (only async functions may be exported).
2. **Fail open on an unreadable prospect.** send-queue: `if (prospectRow && DO_NOT_SEND…)`
   sends when the prospect query errors or returns nothing. send-action:
   `pitch.prospects?.status ?? null` sends when the join is null. follow-up and nudge drop
   the query error. Rule: no prospect row, or a query error → do not send (skip, keep
   the pitch as it is, report the observed error). Never `dropFromQueue` on a read error.
3. **The check is not at the last moment.** send-queue reads the prospect status, then
   runs DNC, first-touch, `verifyRecipient` (DNS), the gate, the claim, the token
   exchange and a random jitter sleep of up to 8s before `sendGmailMessage`. An opt-out
   the reply poll records in that window is not seen. Same shape in send-action. Rule:
   AFTER the claim and immediately before `sendGmailMessage`, re-read the prospect's
   status and cooldown and re-run `isEmailOnDncList` for the recipient. Do-not-send →
   no Gmail call; release the claim (queue: `auto_rejected` with the reason, as
   `dropFromQueue` does; manual: back to `approved` and return the reason).
4. **Unguarded rollbacks.** After a failed token exchange or send, both paths do
   `update({status:"approved"}).eq("id", …)`. If a person rejected the pitch while it was
   `sending`, this re-approves it and the next run sends it. Every release from `sending`
   carries `.eq("status","sending")`. (`recoverStuckSends` already does.)
5. **`transitionPitchStatusWith` (pitch-stage.ts:899) updates status unconditionally.**
   A stale /pitches tab can reject a row the queue already claimed, or move a `sent` row
   to draft (which can then be approved and sent again). Put the from-state in the
   UPDATE's WHERE (`.in("status", allowedFrom(next))` + `.select("id")`), not in a prior
   read. Allowed:
   - `queued_for_approval` ← draft
   - `approved` ← draft, queued_for_approval
   - `reviewer_rejected` ← draft, queued_for_approval, approved, auto_rejected
   - `draft` ← queued_for_approval, approved, reviewer_rejected, auto_rejected
   Same status as now → `{ ok: true }`, no write, no event, no audit (idempotent; the
   autopilot and a double-click both hit this). 0 rows updated otherwise → re-read the
   row and return `{ ok: false, error: "This pitch is now <status>; nothing was changed." }`
   (the observed status). The approve gate check still runs before the update, as today.
   Put the table and `allowedFrom` in a new PURE file `lib/pitches/status-transitions.ts`
   (relative imports only, so the node test runner can load it).

Readers of what you change (match them):
- `lib/autopilot/tick.ts:690` calls `transitionPitchStatusWith(actor, {next_status:"approved"})`
  and on `!ok` writes `autopilot_reasons: ["approval refused: " + error]` and lane review.
  Your error text must never start with `HELD_BY_PERSON` (`lib/autopilot/governor.ts`,
  "held by a person"): the governor treats that prefix as a person's hold.
- `components/pitches/pitches-page.tsx` shows `res.error` as-is; keep it one sentence.
- The send-queue response's `results[].reason` is read by the weekly report and the
  health check only as free text; keep `status` values (`sent`/`skipped`/`error`) as they are.

Time budget: send-queue and follow-up have `maxDuration` 120 (vercel.json), the queue
sends at most 6 per run. Two extra queries per send are fine; add no new network calls.

## Files
Allowed to edit:
- `lib/pitches/send-action.ts`
- `lib/pitches/pitch-stage.ts` (`transitionPitchStatusWith` only)
- `lib/pitches/status-transitions.ts` (new, pure)
- `app/api/pitches/send-queue/route.ts`
- `app/api/pitches/follow-up/route.ts` (the set + prospect read error only)
- `app/api/replies/nudge/route.ts` (the set + prospect read error only)
- new tests: `tests/send-path-safety.test.ts`, `tests/pitch-status-transitions.test.ts`

Read for context, do not edit: `lib/prospects/status.ts`, `lib/autopilot/tick.ts` (660–700),
`lib/autopilot/governor.ts`, `lib/autopilot/hold.ts`, `lib/discover/dnc-check.ts`,
`components/pitches/pitches-page.tsx`.

Forbidden: every other file in `lib/pitches/` (two other workers are in `exemplars.ts`
and, later, `queries.ts`), `lib/prospects/status.ts`, `lib/autopilot/**`,
`lib/supabase/types.ts`, `vercel.json`, migrations.

## Must not change (negative set)
- A sendable prospect + an approved pitch sends exactly as today: same Gmail call, same
  columns written on success (`sent`, `sent_at`, `body_sent`, ids, `sequence_step`,
  `next_followup_at`), same `sent` pitch event.
- The `sent` write after a successful Gmail call stays unconditional: an email that went
  out is recorded as sent whatever happened to the row meanwhile.
- The contents of `DO_NOT_SEND_STATUSES`; `bulkApprovePitchesWith`; `lib/autopilot/hold.ts`.
- Cooldown still skips without dropping; DNC, first-touch, verify and gate behave as today.

## Acceptance checks
1. `grep -rn '"suppressed", "archived_no_meeting"' app lib` → only `lib/prospects/status.ts`.
   A test reads the four route/action sources and fails if any defines its own status set.
2. `tests/pitch-status-transitions.test.ts`: all 9 × 4 (current, next) pairs match the table
   above, including sending→anything and sent→anything refused, same-status = no-op.
3. A test (pure helper or in-memory fake client, your choice) shows, for send-queue and
   send-action: prospect becomes `suppressed` (and, separately, DNC-listed) between the
   claim and the send → no Gmail call, claim released as specified. Shown failing on the
   integration branch's code (paste the fail count).
4. A test shows a prospect read error / missing row → no send and no drop.
5. A test shows the failed-send rollback does not touch a row that is no longer `sending`.
6. `npm run typecheck && npm run lint && npm test && npm run build` green.

## External prerequisites
none

## Prod verification
After the deploy, the first weekday send-queue run that has due AUTO pitches (first
ones Mon 15:00 UTC): the conductor reads the latest `net._http_response` rows for
`/api/pitches/send-queue` → 200, `sent` > 0, no result reason saying the prospect could
not be read; and `select status, count(*) from pitches where autopilot_lane = 'auto' and
scheduled_send_at < now() group by 1` shows them `sent`.

## Out of scope
- Whether follow-ups should wait for the AI instead of the template (Pedro's decision).
- The 3-email sequence length; send volume; `SEND_PER_TICK`.
- Any change to the reply poll or the autopilot tick. Note what you see in the lessons inbox.

## Questions already answered
Q: Release a queue claim to `approved` or `auto_rejected` on a last-moment do-not-send?
A: `auto_rejected` with the reason (it can never send; leaving it approved re-tries it
every run). Manual send: back to `approved` and tell the person why.
Q: Should a failed re-read (query error) after the claim send anyway? A: No. Release to
`approved` (guarded) and report the error; the next run retries.
