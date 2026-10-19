# Brief: send-path-hardening

| | |
|---|---|
| Module | send paths: `app/api/pitches/send-queue`, `app/api/pitches/follow-up`, `lib/pitches/send-action.ts` |
| Model / effort | opus-5.5 / high (send path) |
| Branch | `claude/send-path-hardening` from `claude/phase3-batch4-integration` |
| PR target | `claude/phase3-batch4-integration` |
| Reserved migration | `0049_reserve_send_slot.sql` (do not take another number) |
| Depends on | none. Parallel with autopilot-trust-split, pipeline-guards and address-trust (disjoint files; see "Runtime neighbours") |
| Conductor session | `session_017nqBxLFFXKbhDwKiPi6xLf` (send_message here ONLY if blocked; the PR body is the report) |
| Size | M |

## Goal
Every email the system sends counts against the inbox's daily cap exactly once, even when
two sending runs overlap; a long send run stops cleanly before it is killed; nothing the
autopilot approved goes out if its address became doubtful after approval; and follow-ups
obey the same bounce stop as first emails. The cap protects a young sending domain: an
under-count lets it send more than its warm-up allows.

## Context the worker needs
- Three writers bump `sender_inboxes.sends_today` by read-then-write:
  `app/api/pitches/send-queue/route.ts` (~l.484–488, a running count written back after
  each send), `lib/pitches/send-action.ts` (~l.297, manual send) and
  `app/api/pitches/follow-up/route.ts` (~l.527–530). Helpers `effectiveSendsToday` /
  `bumpSendsTodayPayload` reset at the UTC day boundary via `last_reset_date`.
- Two send-queue runs DO overlap: `vercel.json` crons `/api/pitches/send-queue` at
  `0 15 * * 1-5` (backstop) and pg_cron `spam-send-queue` `*/10 15-22 * * 1-5` both fire at
  15:00 UTC. Claims are guarded (approved → sending), so no pitch sends twice, but the two
  runs' `sends_today` write-backs clobber each other (batch 3 audit: 19 sent, count lower).
- Both routes have `maxDuration` 120 s (vercel.json). The send-queue loop has no time
  budget: a slow Gmail call near the end can be killed after the send and before the
  pitch row and the count are written.
- At send time the send-queue re-runs the recipient verifier and only stops on `drop`
  (~l.347); a `review` verdict still sends, even for a pitch the AUTOPILOT approved
  (approval event payload `autopilot: true`). A person-approved pitch with `review` is the
  person's call and must still send.
- `inboxBounceBlock` (lib/autopilot/bounce-breaker.ts) is the shared bounce rule the
  send-queue checks once per inbox per run (since #31). The follow-up route does not.

## Brain lessons
- atomic-writes-never-client-read-then-write.md: never compute a counter on the client;
  push the arithmetic into one SQL statement / RPC (`SET n = n + 1 ... WHERE n < cap`).

## The changes
1. **Migration 0049**: `public.spam_reserve_send_slot(p_inbox uuid) returns boolean` (and
   `spam_release_send_slot(p_inbox uuid)`) as single UPDATE statements: reset to 0 when
   `last_reset_date` is not today (UTC), take a slot only `WHERE sends_today < daily_cap`,
   return whether a slot was taken. `security definer`, `set search_path = public`,
   grant execute to `service_role` and `authenticated` only; idempotent (`create or replace`).
   No DROP of anything that exists.
2. All three writers reserve a slot BEFORE the Gmail send and release it if the send
   fails; no read-then-write of `sends_today` remains (grep proves it). Call the RPC
   untyped if `lib/supabase/types.ts` lacks it (conductor-only file; say so in the PR).
3. **Send-queue time budget**: stop claiming new pitches when less than ~25 s of the 120 s
   remain; a claimed pitch is either sent and recorded, or released back to `approved`.
4. **Doubtful address after an automatic approval**: if the send-time verdict is `review`
   and the pitch's latest approval event is the autopilot's, do not send; move it back to
   draft in the review lane with a reason string that `governor.heldAction` LEAVES ALONE
   (read `heldAction`; add the reason prefix there only if no existing prefix fits, and
   say so in the PR, since `lib/autopilot/governor.ts` belongs to another worker).
5. **Follow-ups obey the bounce stop**: the follow-up route calls `inboxBounceBlock` once per
   inbox per run and skips (never pauses) the same way the send-queue does.

## Runtime neighbours (same batch)
- autopilot-trust-split changes the tick (breakers run when the autopilot is off; only
  quality trips demote). It does not change `inboxBounceBlock`'s signature.
- The old code runs against migration 0049 until the deploy: the new functions are unused
  by it, so nothing changes in that gap. Say this in the migration header.

## Files
Allowed: `app/api/pitches/send-queue/route.ts`, `app/api/pitches/follow-up/route.ts`,
`lib/pitches/send-action.ts`, the file that holds `effectiveSendsToday`/`bumpSendsTodayPayload`,
`supabase/migrations/0049_reserve_send_slot.sql`, `tests/*.test.ts`.
Read only: `lib/autopilot/bounce-breaker.ts`, `lib/autopilot/governor.ts`, `lib/research/verify-recipient.ts`, `vercel.json`.
Forbidden: `lib/supabase/types.ts`, `vercel.json`, `CLAUDE.md`, `lib/{anthropic,gmail,compliance,supabase}/`, any other migration.

## Must not change (negative set)
- The daily cap value, the send window, the drip size per run, the Gmail send itself.
- A person-approved pitch with a `review` verdict still sends; `drop` still never sends.
- A paused inbox, a do-not-contact address or a suppressed prospect still never sends.
- The send-queue's existing bounce block (#31) behaves as today.

## Acceptance checks
1. `npm run typecheck && npm run lint && npm test` pass; new tests: two overlapping runs
   against a fake that serializes the RPC never exceed the cap and count every send once;
   a failed Gmail send releases its slot; the time budget stops claiming; an autopilot
   approval with `review` goes back to draft, a person approval with `review` sends;
   follow-up skips on 2 fresh bounces.
2. `grep -n "sends_today" app lib` shows no read-then-write left (reads for display ok).
3. Migration 0049 applied twice on a local Postgres (stub `sender_inboxes`): same result,
   no error; show the SQL and the run in the PR.
4. Mutation table in the PR.

## External prerequisites
none (the conductor applies 0049 after Pedro's "ship it").

## Prod verification
After deploy + 0049: the next 15:00 UTC run (both crons fire) leaves `sends_today` equal
to the number of pitches with `sent_at` today for that inbox.

## Out of scope
Removing the Vercel backstop cron (conductor), warm-up caps, spacing, reply sending
(`lib/replies/send-reply-action.ts`). Lessons go to `tasks/lessons-inbox/send-path-hardening.md`.

## Questions already answered
Q: Release the slot on every failure?  A: On any failure where Gmail did not accept the message. If Gmail accepted it and our DB write failed, keep the slot (it was sent).
Q: Count follow-ups against the cap?  A: Yes, as today.

## If blocked
Message the conductor with what you tried, what you need, and what you can still do meanwhile.
