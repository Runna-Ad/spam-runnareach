[2026-10-18] A "last line of defense" check that runs before the slow steps is not the last line
WHAT HAPPENED: send-queue and the manual send read the prospect's status first, then ran DNC, first-touch, DNS verify, the gate, the claim, a token exchange and up to 8 s of jitter before `sendGmailMessage`; an opt-out recorded in that window was never seen. Both also treated an unreadable prospect (`if (prospectRow && …)`, `?.status ?? null`) as sendable, and rolled `sending` back to `approved` with no status guard, which re-approved a pitch a person rejected mid-send. Fixed with `recheckBeforeSend` + `releaseClaim` in `lib/pitches/status-transitions.ts`.
RULE: A send-time permission check runs after the claim and immediately before the external call, reads fresh, and fails closed on "no row" as well as on a query error (`if (row && bad(row))` is fail-open). Every write that releases a claim carries the claimed status in its WHERE. A status transition puts its allowed from-states in the UPDATE's WHERE (`.in("status", from).select("id")`), never only in a prior read.
TAGS: pitches, send-queue, send-action, fail-closed, races

[2026-10-18] Route files can't be unit-tested under the node runner; test the helper behaviourally and the call site structurally
WHAT HAPPENED: The routes and the "use server" action import `@/` aliases and Next, so `node --test` can't load them. The behaviour lives in a pure helper tested against an in-memory Supabase stand-in (filters actually applied, so "the guarded update matched 0 rows" is observable); the call sites are pinned by source-order tests (claim < recheck < Gmail, nothing that waits in between, no unguarded rollback). The source tests are what fail on the old code (9 of 64).
RULE: When a fix is about WHERE a call happens in a route, a helper test alone passes on the old code. Add a source-order test for the call site and show it failing on the base.
TAGS: tests, routes

## Out of scope, noticed
- `lib/discover/dnc-check.ts` `isEmailOnDncList` fails OPEN on a query error (documented choice). The last-moment recheck inherits that: a DNC read error at send time sends. The prospect-status half of the recheck fails closed. Pedro/conductor call whether the send-time DNC read should fail closed too.
- `lib/autopilot/hold.ts:8` comment says "transitionPitchStatusWith is not used: its update has no current-status guard" — stale after this PR (it now has one). Conductor-owned file.
- `lib/prospects/status.ts:29` comment references `MANUAL_DO_NOT_SEND` in send-action.ts, which no longer exists.
- `app/api/replies/poll/route.ts:84` `DEAD_STATUSES` (booked, suppressed, archived_no_meeting, won, lost) is a 5-value private set, missing `no_match`; it gates reply drafting, not a send, so not changed here. Worth deciding whether it should be `DO_NOT_SEND_STATUSES`.
- `app/api/replies/nudge/route.ts` auth uses only `CRON_SECRET` (`isAuthorized`), unlike send-queue/follow-up which use `isSchedulerAuthorized` (pg_cron Vault token). If the nudge is scheduled from pg_cron it would 401.
- follow-up route: a prospect-read error is now reported as "skipped" with the error; the step stays due (no claim was made yet), so the next run retries.
