# Brief: optout-alarm-people

| | |
|---|---|
| Module | `lib/autopilot/` (the opt_out_spike breaker's counting in the tick) |
| Model / effort | opus-5.5 / high (`lib/autopilot/` lane; a quality breaker pauses every inbox and demotes the stage) |
| Branch | `claude/optout-alarm-people` from `claude/phase3-batch5-integration` |
| PR target | `claude/phase3-batch5-integration` |
| Reserved migration | none |
| Depends on | none. Batch 5's other five tasks are already merged on your base |
| Conductor session | `session_017nqBxLFFXKbhDwKiPi6xLf` (send_message here ONLY if blocked; the PR body is the report) |
| Size | S |

## Goal
The opt-out alarm counts PEOPLE who opted out, not timeline events. Today one "remove me"
reply counts twice, so two people opting out in one week pause every sending inbox and drop
the autopilot from veto to shadow (re-paused every tick for 7 days). With automatic sends
starting at ~20 a day, two opt-outs in a week is ordinary for cold email, not a pitch-quality
signal. Pedro approved this fix on 2026-10-20 ("yes add the opt-out alarm fix").

## Context the worker needs
- The count (`lib/autopilot/tick.ts`): `countEvents` (`:258-268`) is a head count of
  `pitch_events` rows by `event_type` (+ optional `payload->>intent`) since a time. `runBreakers`
  (`:287-292`) calls it four times: `unsubscribe` and `reply`+`hard_no` for 7 days, the same for
  30 days. Then (`:331-332`) `optOutsThisWeek: unsubWeek + hardNoWeek` and
  `optOutWeeklyBaseline: ((unsubMonth + hardNoMonth) / 30) * 7`.
- The rule (`lib/autopilot/governor.ts:229`, do NOT change): trips `opt_out_spike` when
  `optOutsThisWeek >= 3 && optOutsThisWeek >= 3 * Math.max(optOutWeeklyBaseline, 1)`. It is a
  QUALITY breaker (batch 4): scope "all" pauses every inbox and demotes the stage.
- Why one opt-out counts twice: the reply poll records a `reply` event with
  `payload.intent = 'hard_no'` on the THREAD's pitch (`app/api/replies/poll/route.ts:337-341`,
  `pitchId: thread.pitch_id`, which can be a follow-up pitch), and `recordOptOut`
  (`lib/compliance/opt-out.ts:78-91`) records an `unsubscribe` event on the prospect's latest
  ROOT sent pitch. Two events, possibly on two different pitch ids, one person. A link click
  (`app/api/unsubscribe/route.ts` → recordOptOut) writes only the `unsubscribe` event.
- `pitch_events` (0001:625-634): `id, tenant_id, pitch_id, event_type, event_at, payload, ...`,
  no prospect column. `pitches.prospect_id` is `not null` (0001). So "one person" = one
  prospect id, reached through `pitch_id → pitches.prospect_id`.
- Prod today: 0 `unsubscribe` and 0 `reply`/hard_no events ever, so the baseline is 0 and the
  threshold is 3 (people, after this fix).
- `tick.ts` imports `server-only` and `@/` aliases, so node --test cannot load it (lesson
  2026-10-19): put the counting in an importable, db-injected module under `lib/autopilot/`
  (relative imports, no server-only), test it with a fake db that rejects columns the
  migrations don't create (pattern: `tests/optout-repair.test.ts`, `tests/send-path-hardening.test.ts`),
  and keep only the call in `tick.ts` (pin it with a source check).
- Other opt-out counters are NOT in scope: `lib/learning/reward.ts:121` (per-pitch reward) and
  the weekly report (`lib/reports/snapshot.ts`, counts `prospect.opted_out` audit rows per
  address, no double count).

## Brain lessons
- tasks/lessons.md 2026-10-19: "Keep the two kinds of trust separate" (PEDRO_OVERRIDE): only
  pitch-quality signals demote. A double count turns an ordinary week into a demotion.

## The changes
1. `optOutsThisWeek` and the 30-day count behind `optOutWeeklyBaseline` count DISTINCT
   prospects with an `unsubscribe` event or a `reply` event with intent `hard_no` in the
   window (one person with both events, on any of their pitches, counts once). Same windows,
   same formula for the baseline.
2. Fail toward the current behaviour on a read error: if the read fails, use the old event
   count for that window (never 0), and say so in the tick report's errors.
3. Bounded reads: the windows hold a handful of rows; select only `pitch_id` (+ the joined
   `prospect_id`), with a limit and a comment.

## Files
Allowed to edit:
- `lib/autopilot/tick.ts` (the four counts in `runBreakers` and the metric lines only)
- a new `lib/autopilot/opt-out-count.ts` (or similar name)
- `tests/*.test.ts`
Read for context, do not edit:
- `lib/autopilot/governor.ts`, `lib/compliance/opt-out.ts`, `app/api/replies/poll/route.ts`, `app/api/unsubscribe/route.ts`, `lib/replies/optout-repair.ts`, `supabase/migrations/0001_initial_schema.sql`
Forbidden: `lib/supabase/types.ts`, `vercel.json`, `CLAUDE.md`, `lib/{anthropic,gmail,compliance,supabase}/`, migrations, every other `lib/autopilot/` file.

## Must not change (negative set)
- The threshold rule in `governor.ts` and every other breaker (inbox_bounces, gmail_api, bounces_today, dmarc, blocklist, placement) and its inputs.
- Three different people opting out in a week with no history still trips `opt_out_spike` (the alarm keeps its meaning; only the double count goes).
- `reward.ts`, the weekly report, the opt-out repair sweep.

## Acceptance checks
1. `npm run typecheck && npm run lint && npm test` pass.
2. Fake-db tests through `evaluateBreakers` with the new counts, no history (baseline 0):
   one hard_no reply (reply + unsubscribe, different pitch ids, same prospect) → 1, no trip;
   two people (replies) → 2, no trip; one reply + one link click from another person → 2, no
   trip; three people → 3, trips; the same person replying twice → 1. A baseline case: 10
   people over the last 30 days → baseline ≈ 2.3, 5 people this week → no trip, 7 → trip.
3. A read error falls back to the event count and is reported.
4. Source check: `runBreakers` gets its opt-out numbers from the new module.
5. Mutation table in the PR (count events instead of people → test 2 fails).

## External prerequisites
none.

## Prod verification
After deploy: the next tick returns 200 with `breakers: []`. The first real opt-out reply
afterwards: the tick still shows no `opt_out_spike` (it is 1 person).

## Out of scope
The thresholds, the stage rules, other learners' counts, deduplicating the events themselves.
Lessons go to `tasks/lessons-inbox/optout-alarm-people.md`.

## Questions already answered
Q: Count by email instead of prospect?  A: By prospect (the event rows reach a prospect through the pitch; an email is not on the event).
Q: Should a bounce count?  A: No, as today.

## If blocked
Message the conductor with what you tried, what you need, and what you can still do meanwhile.
