# Brief: send-path-safety-2 (follow-up to PR #21, same worker)

| | |
|---|---|
| Module | send paths: `app/api/pitches/follow-up/route.ts`, `lib/pitches/status-transitions.ts`, `lib/discover/dnc-check.ts` |
| Model / effort | opus-5.5 / high (send paths lane) |
| Branch | `claude/send-path-safety-2` from `claude/optimistic-tesla-3gceud` (PR #21 is merged there) |
| PR target | `claude/optimistic-tesla-3gceud` |
| Reserved migration | none |
| Depends on | send-path-safety (merged 0128b6b) |
| Conductor session | `session_017nqBxLFFXKbhDwKiPi6xLf` (send_message ONLY if blocked; the PR body is the report) |
| Size | S |

## Goal
Finish the last-moment rule on the one send path PR #21 left out, and make the
last-moment check fail closed on the DNC half too. Good = no send path calls Gmail
without re-reading the prospect and the DNC list after its claim, and a DNC query error
at that moment never sends.

## Context the worker needs
From the PR #21 review (verdict merge; these were optional there, they are the task here):
1. **Follow-up has no last-moment check.** `app/api/pitches/follow-up/route.ts` reads the
   prospect (~line 135), then a Claude compose call (~20s) runs before Gmail (~line 436).
   Its claim checks `sequence_paused_at`, which the reply poll sets on an opt-out, but a
   manual or bulk suppression (`lib/prospects/detail-actions.ts`, `lib/discover/bulk-actions.ts`)
   and a DNC entry added in that window are not seen. Call `recheckBeforeSend` right
   before its `sendGmailMessage`, after compose. Read how the follow-up claims its step
   (at-most-once) and release that claim on a block the way the route already releases
   it on a failed send (guarded on the claim state, as `releaseClaim` does for pitches).
   A do-not-send / DNC block pauses the sequence (`sequence_paused_at`), it is not retried.
   The first follow-ups from Monday's sends fall due around Thursday.
2. **DNC fails open at the last moment.** `isEmailOnDncList` returns `{blocked:false}` on
   a query error by design (its header explains why: the queue must not stall). Keep that
   for every existing caller, but make the error visible: return
   `{ blocked: false, error: string }` on a query error (additive; the `DncHit` type gains
   an optional `error` on the unblocked branch). `recheckBeforeSend` treats `error` as
   `unreadable` (release to approved / refuse the manual send, retried next run). The
   first-read DNC checks in send-queue and send-action stay fail-open.
3. **Test strength.** The claim → recheck → Gmail source-order tests only ban
   `getAccessToken(` and `setTimeout` between the recheck and Gmail. Assert instead that
   no `await` appears between the end of the recheck's blocked branch and
   `await sendGmailMessage(` (send-queue, send-action, and now follow-up).
4. **Wording.** `lib/pitches/pitch-stage.ts` ~1002: when the re-read after a 0-row
   UPDATE fails, the message says the pitch "is now gone" (an unobserved diagnosis). Say
   what was observed (the read error, or "Pitch not found.").

## Files
Allowed to edit:
- `app/api/pitches/follow-up/route.ts`
- `lib/pitches/status-transitions.ts`
- `lib/pitches/pitch-stage.ts` (the one message in `transitionPitchStatusWith`)
- `lib/discover/dnc-check.ts` (the error field only)
- `tests/send-path-safety.test.ts`, `tests/pitch-status-transitions.test.ts`, new tests

Read, do not edit: `app/api/pitches/send-queue/route.ts`, `lib/pitches/send-action.ts`
(no change needed there: `recheckBeforeSend` carries the DNC change).

Forbidden: `lib/pitches/queries.ts` and `/pitches` (another worker), `lib/pitches/exemplars.ts`
(another worker), `lib/autopilot/**`, `lib/supabase/types.ts`, `vercel.json`, migrations.

## Must not change (negative set)
- A due follow-up to a sendable prospect sends exactly as today (same compose, gate,
  template fallback, columns, event).
- Every caller of `isEmailOnDncList` other than `recheckBeforeSend` behaves as today on
  a query error (fail open).
- PR #21's behaviour and tests.

## Acceptance checks
1. Test: follow-up, prospect becomes `suppressed` (and separately DNC-listed) after the
   claim, during compose → no Gmail call, claim released, sequence paused. Shown failing
   on the integration branch (paste the count).
2. Test: DNC query error at the recheck → `unreadable`, no send; the same error on the
   first-read DNC check still proceeds (unchanged).
3. The stronger source-order test fails if an `await verifyRecipient(...)` is inserted
   between the recheck and Gmail in any of the three paths (show it with a local edit,
   then revert).
4. `npm run typecheck && npm run lint && npm test && npm run build` green.

## External prerequisites
none

## Prod verification
First follow-up run with due steps (pg_cron `20 15-22 * * 1-5`, first due ~Thu): the
`net._http_response` row for `/api/pitches/follow-up` → 200, no unexpected skips.

## Out of scope
Nudge route auth (`CRON_SECRET` only); the poll's `DEAD_STATUSES`; send volume. Lessons inbox.
