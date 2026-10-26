# Brief: digest-once

| | |
|---|---|
| Module | `lib/autopilot/hold.ts` (digest builder) + `lib/autopilot/tick.ts` `sendVetoDigest` |
| Model / effort | opus-5.5 / high (routing: `lib/autopilot/` briefed tasks) |
| Branch | `claude/digest-once` from `claude/phase3-batch9-integration` |
| PR target | `claude/phase3-batch9-integration` |
| Reserved migration | none |
| Depends on | none (parallel with `writer-honesty`, disjoint files) |
| Conductor session | `session_01HtEg7XG4MPQU4omrd2BX69` (send_message ONLY if blocked; the PR body is the report) |
| Size | S |

## Goal
Pedro gets one heads-up per email the autopilot will send, not the same prospects again and again. Pedro (2026-10-26): "I got like 6-8 emails saying it would send … for the same emails … in all emails the same prospect was there … 1 or 2 heads up is more than enough." Good looks like: each scheduled email is listed in exactly one digest before it can send (so a person can still hold it), a digest with nothing new is not sent, and the digest never claims a send time that isn't true.

## Context the worker needs
- `sendVetoDigest` (`lib/autopilot/tick.ts:~984-1037`) runs at the slots `DIGEST_SLOTS_UTC = [1, 13]` (`hold.ts:315`) and lists EVERY approved AUTO pitch with `scheduled_send_at <= now + DIGEST_HORIZON_HOURS (24)`, overdue ones included (`hold.ts:318`). It records the slot as `audit_log` action `autopilot.digest`, metadata `{count, slot}`.
- Pitches are scheduled +`VETO_WINDOW_HOURS` (18) ahead (`hold.ts:317`). Sending runs only weekdays 15:00-22:59 UTC, and since batch 8 at most 1 email per inbox per 10-min run, so an approved email can wait days (weekend), and every digest in between lists it again.
- Prod 2026-10-21..26 (conductor query): 12 digests, counts 9, 13, 6, 8, 3, 7, 4, 9, 9, 11, 12, 12. Weekend digests (10-24/25) listed the same queue each time.
- Subject today: "Autopilot: N emails will send in the next 24h unless held" (`hold.ts:~368`): false for anything waiting past a weekend.
- The hold link per line (`signHoldToken`, `holdExpiry`) and the /pitches route must keep working for every email, including ones announced in an earlier digest.

**Decisions (conductor):**
1. A digest lists only emails NOT announced before: an email counts as announced when an earlier `autopilot.digest` row listed the same `(pitch_id, scheduled_send_at)`. Record the listed pairs in that row's metadata (`items: [{pitch_id, send_at}]`, plus `count`, `slot`). Look back 14 days of digest rows. A pitch held and re-approved later (new `scheduled_send_at`) is announced again.
2. No new emails → no email sent, but the slot is still recorded (as today for an empty slot).
3. The digest adds one line, no list: "N emails from earlier digests are still waiting to send (sending runs weekdays 15:00-23:00 UTC): <appUrl>/pitches". Omit it when N = 0.
4. Truthful subject: "Autopilot: N new emails scheduled to send (hold any before they go)". Body keeps each line's scheduled time and hold link.
5. The safety rule stays true: every email is listed in at least one digest before it can send (18h veto window > 12h slot gap; horizon 24h). Keep a test that proves it, including the weekend case.
6. Digests from before this deploy have no `items`: treat their emails as NOT announced (they get one more mention after the deploy, then never again). Say so in the PR.

## Brain lessons
none matched (second brain not attached). Core-context: a "since" or "already handled" record must be written only after the side effect succeeded (the digest row is written only after the email reached an inbox; keep that).

## Files
Allowed to edit: `lib/autopilot/hold.ts` (digest section), `lib/autopilot/tick.ts` (`sendVetoDigest` only), `tests/digest-once.test.ts` (new), existing digest tests that pin the old subject/listing (name them; grep tests/ for `buildVetoDigest` and `sendVetoDigest`).
Read only: `lib/autopilot/governor.ts`, `app/api/autopilot/hold/route.ts`, `lib/notify/*`.
Forbidden: `lib/pitches/*` (other worker), `lib/supabase/*`, `lib/reports/*`, migrations, `vercel.json`.

## Must not change (negative set)
- Slots (01:00 and 13:00 UTC), the 18h veto window, hold links and their expiry, the hold route.
- The digest row is written only after delivery (a failed send retries next tick), and an empty slot is recorded.
- The tick's other steps.

## Acceptance checks
1. Two slots in a row with the same queue: first lists all, second sends nothing (and records the slot).
2. A new email between slots: the next digest lists only it, plus the "N still waiting" line.
3. Held then re-approved with a new time: listed again once.
4. Weekend: Friday 13:00 digest lists X; Sat/Sun/Mon 01:00 digests send nothing for X; X still sends Monday.
5. Old digest rows without `items`: their emails are listed once more, then not again.
6. Subject and body wording as decided; a pitch scheduled at any time is listed before its send time (property test over slot times).
7. `npm run typecheck && npm run lint && npm test && npm run build` green; count reported.

## External prerequisites
none.

## Prod verification
After deploy: `select created_at, metadata->>'count', jsonb_array_length(metadata->'items') from audit_log where action='autopilot.digest' and created_at > '<deploy>' order by 1;` → next digests list only new emails; Pedro gets at most one digest per slot and none when nothing new.

## Out of scope
The health check emails; per-email notifications; digest timing.

## If blocked
Message the conductor with what you tried, what you need, and what you can still do meanwhile.
