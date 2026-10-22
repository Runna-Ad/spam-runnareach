# Brief: reply-on-root

| | |
|---|---|
| Module | `app/api/replies/poll/route.ts` (reply poll) |
| Model / effort | opus-5.5 / high (routing: `lib/replies` is high for poll-route changes) |
| Branch | `claude/reply-on-root` from `claude/phase3-batch8-integration` |
| PR target | `claude/phase3-batch8-integration` |
| Reserved migration | none |
| Depends on | none (parallel with `tracked-links`, `presend-learning`) |
| Conductor session | `session_01HtEg7XG4MPQU4omrd2BX69` (send_message ONLY if blocked; the PR body is the report) |
| Size | S |

## Goal
Every reply, bounce or out-of-office is recorded on the conversation's FIRST email (the root pitch), whatever message in the thread it answers, so the learners, the exemplar shortlist and the weekly report see it. Today a reply that arrives after a follow-up is filed on the follow-up row and the learning never counts it. Good looks like: one timeline per conversation, the same row the follow-up route already uses for its "sent" event; old misfiled events moved once, nothing lost or doubled.

## Context the worker needs
- The poll keeps the NEWEST pitch per Gmail thread (`app/api/replies/poll/route.ts:150-171`, "Dedupe to one (most recent) pitch per thread") and records the event on it: `recordPitchEvent(supabase, { pitchId: thread.pitch_id, type: classification.intent === "bounced" ? "bounce" : "reply", ... })` (`:337-339`).
- The follow-up route records its "sent" event on the ROOT (`app/api/pitches/follow-up/route.ts:614`, comment "Recorded against the ROOT pitch: one timeline per conversation"). Follow-up rows have `parent_pitch_id` = the root id (`follow-up/route.ts:585`).
- Learners read only root pitches: `lib/autopilot/learn.ts:178-189` (`.is("parent_pitch_id", null)`), then their events. Same for the exemplar shortlist (`lib/pitches/exemplars.ts` / `exemplar-queries.ts`) and `lib/learning/reward.ts` `scoreOutcome`.
- `lib/pitches/root-pitch.ts` has `latestRootSentPitchId` (for opt-outs); the thread map already knows every pitch of the thread, so the root is the thread's row with `parent_pitch_id is null` (or the follow-up's `parent_pitch_id`). Choose one resolution, state it, test it.
- Other writes in the same poll iteration that key on the pitch (sequence pause, reply row's `pitch_id`, lead alert, DNC, opportunity hooks): list each and say whether it should stay on the thread's newest pitch or move to the root. Do NOT change the `replies.pitch_id` semantics unless a reader needs it; grep the readers of `replies.pitch_id` first and name them in the PR.
- Prod data shape (conductor, 2026-10-22): 9 follow-ups were sent 10-22 on threads whose roots went out 10-19; no human reply exists yet on any follow-up thread (replies since 10-17: 3 bounces). Misfiled events today are therefore few; the backfill still has to be correct for the future.
- Backfill: a SQL script in `scripts/` (not a migration) that moves `pitch_events` of type reply/bounce from a follow-up pitch to its root, idempotent, with a preview SELECT first. The conductor runs it after the deploy. It must not create a second "reply" on a root that already has the same reply (key on `payload->>'reply_id'`).

## Brain lessons
none matched (second brain not attached).

## Files
Allowed to edit: `app/api/replies/poll/route.ts`, `scripts/backfill-reply-events-to-root.sql` (new), `tests/reply-on-root.test.ts` (new), existing poll tests that pin the old pitch id (name them).
Read only: `lib/pitches/events.ts`, `lib/pitches/root-pitch.ts`, `app/api/pitches/follow-up/route.ts`, `lib/autopilot/learn.ts`, `lib/learning/reward.ts`, `lib/replies/*`.
Forbidden: `lib/supabase/*`, `lib/gmail/*`, `vercel.json`, migrations, `lib/pitches/*` (another worker this wave), `lib/learning/*`, `lib/autopilot/*`.

## Must not change (negative set)
- A reply on a thread with no follow-up: recorded exactly as today (same pitch id = root).
- Sequence pause, DNC on hard_no/bounce, lead alert, OOO postponement: same behaviour and same rows as today.
- The 23505 skip (a reply already stored) still means the first run owns the side effects.
- The poll's time budget (maxDuration 120, `vercel.json`) and its deferral of old threads after 100 s.

## Acceptance checks
1. Test: thread = root + follow-up; a human reply → the `reply` event's pitch_id is the root; a bounce → the `bounce` event on the root.
2. Test: thread with root only → unchanged.
3. Backfill script: preview SELECT shows rows to move; the UPDATE is idempotent (second run moves 0) and never duplicates a reply_id on the root. Run it against a local Postgres 16 with the 0038 `pitch_events` shape and paste the output.
4. `npm run typecheck && npm run lint && npm test` green; count reported.

## External prerequisites
none.

## Prod verification
After deploy + backfill: `select count(*) from pitch_events e join pitches p on p.id=e.pitch_id where e.event_type in ('reply','bounce') and p.parent_pitch_id is not null;` → 0.

## Out of scope
Poll coverage gaps (new-thread replies, silent token-failure skip) → next batch; send pacing; anything in lib/learning.

## If blocked
Message the conductor with what you tried, what you need, and what you can still do meanwhile.
