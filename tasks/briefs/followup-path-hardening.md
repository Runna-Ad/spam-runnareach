# Brief: followup-path-hardening

| | |
|---|---|
| Module | send paths: `app/api/pitches/follow-up/route.ts`, `lib/pitches/status-transitions.ts` (follow-up claim release), `lib/pitches/daily-cap.ts`, the two "who approved this pitch last" helpers |
| Model / effort | opus-5.5 / high (send path) |
| Branch | `claude/followup-path-hardening` from `claude/phase3-batch5-integration` |
| PR target | `claude/phase3-batch5-integration` |
| Reserved migration | none |
| Depends on | none. Parallel with the other batch 5 tasks. `replies-optout-durability` edits `app/api/replies/poll/route.ts`, which you only READ (its `postponeSequence` is the writer you protect) |
| Conductor session | `session_017nqBxLFFXKbhDwKiPi6xLf` (send_message here ONLY if blocked; the PR body is the report) |
| Size | M |

## Goal
A follow-up never goes out during a contact's out-of-office week, never starts work it cannot
finish before the 120 s function limit, and every automatic pause of a follow-up leaves an audit
row. Plus two clean-ups the batch 4 review asked for: one shared "who approved this pitch last"
helper, and the dead `bumpSendsTodayPayload` removed.

## Context the worker needs
- **Out-of-office race (a real send risk).** The follow-up claim (`follow-up/route.ts:451-458`)
  writes `sequence_step: nextStep, next_followup_at: nextFollowupAt`. Every give-back after the
  claim (slot refused `:477`, recheck pause `:493`, Gmail failure `:521`) calls
  `release(...)` → `releaseFollowupClaim` (`lib/pitches/status-transitions.ts:199-207`):
  `.update({ sequence_step: args.priorStep, next_followup_at: args.priorFollowupAt, ...pause })
  .eq("id", args.pitchId).eq("sequence_step", args.claimedStep)`. `priorFollowupAt` is the value
  read at the start of the run (already due). Meanwhile the reply poll's `postponeSequence`
  (`app/api/replies/poll/route.ts:674-690`, `intent === "auto_reply"`, `OOO_POSTPONE_DAYS = 7`)
  can set `next_followup_at = now + 7d` on the same row (its filters still match a claimed row).
  The release then writes the stale due date back: the next run sends during the OOO week.
  The manual snooze in `lib/replies/intent-actions.ts:189-196` (+14 days) has the same exposure.
- **Time budget.** `lib/pitches/daily-cap.ts:101-111`: `SEND_ROUTE_MAX_MS = 120_000`,
  `CLAIM_RESERVE_MS = 25_000`, `hasTimeToClaim(startMs, nowMs)`. The send-queue checks it at the
  loop top and again right before its claim (`send-queue/route.ts:229-232`, `:437-441`). The
  follow-up route has its own `TIME_BUDGET_MS = 90_000` (`:90-91`) checked only at the loop top
  (`:650-656`, with `continue`). Inside one follow-up: compose with Claude (`composeFollowupWithClaude`,
  default 20 s timeout, no retries; paid) → gate → claim → slot → last-moment recheck → Gmail.
  A follow-up started at 89 s can run past 110 s; a compose that cannot be sent in time is money
  spent for nothing.
- **Pauses without audit.** The last-moment recheck pause (`:485-501`: `const pause =
  followupPausesFor(lastCheck); await releaseSendSlot(...); await release(pause);`) pauses the
  sequence on do-not-contact / do-not-send but writes no `audit_log` row. The gate pause does
  (`auditGateHold`, action `pitch.gate_held`). Shape to copy: `lib/pitches/send-time-hold.ts:97-104`
  (`action: "pitch.held"`, `entity_type: "pitch"`, metadata with `source`), or `writeAuditLog`
  (`lib/audit/log.ts:65`; `AuditAction` union at `:8-46` needs the new action; the DB column is
  free text, no CHECK).
- **Two "latest approval" helpers.** `lib/pitches/send-time-hold.ts:40-53` `latestApproval`
  (one pitch; desc + limit 1 on `pitch_events.event_at`, `event_type='approved'`; returns
  `autopilot | person | none | unreadable`; caller send-queue `:360`: `none` → hold, `unreadable`
  → skip). `lib/autopilot/hold.ts:180-242` `holdAutoApprovals` inlines its own (batched,
  asc + last wins; missing event → not touched; read error → abort the sweep; also requires
  `autopilot_lane='auto'`). Both have their own `isAutopilotApproval` (`payload.autopilot === true || "true"`).
  Callers of `holdAutoApprovals`: `lib/autopilot/tick.ts:172`, `:890`, `:907`.
- **Dead code.** `bumpSendsTodayPayload` (`daily-cap.ts:53`) has no caller outside its file and
  `tests/send-path-hardening.test.ts` (`:21`, `:240`, `:269`, `:631-635`); the comment at
  `:50-51` and the test title at `:631` wrongly say the nudge route still uses it.
- Wave 0 (on your base): `lib/supabase/types.ts` now types `spam_reserve_send_slot` /
  `spam_release_send_slot`. Typing the `SlotClient` calls is optional.
- Source-shape guards exist on these routes (`tests/send-path-safety.test.ts:364-371`, `:465`;
  `tests/send-path-hardening.test.ts:218-264`, `:608-624`). Keep them passing by keeping the code
  shape; change a guard only when the shape it pins is what this brief changes, and say which.

## Brain lessons
- serverless-durable-background-jobs.md: "Budget cumulative timeouts: per-attempt timeout × retries,
  summed, must fit under the function cap."
- tasks/lessons.md 2026-10-19: "A guard that only matters in a race needs a race in the fake, or
  deleting it passes every test."

## The changes
1. **A give-back never moves `next_followup_at` earlier than a date another writer set after the
   claim.** State it as an invariant in `releaseFollowupClaim`'s doc comment and enforce it in
   the write (e.g. restore the old date only while the row still holds the claim's date; otherwise
   restore the step and keep the newer date). The step and pause still release as today.
2. **No follow-up starts unless it can finish.** Use the shared budget helpers from
   `daily-cap.ts` (add a follow-up variant if the compose needs a larger reserve): do not start
   a compose without time for compose + gate + claim + recheck + Gmail, re-check right before the
   claim, and stop the loop (`break`) once out of time. Name the reserve and show the arithmetic.
3. **Audit every automatic follow-up pause** at the last-moment recheck (one row per pause, the
   block kind in metadata).
4. **One helper** for "who approved this pitch last" used by both callers, each keeping its own
   rule for `none` and read errors (the caller decides; the helper only reports).
5. Delete `bumpSendsTodayPayload`, fix the stale comment and test title.

## Files
Allowed to edit:
- `app/api/pitches/follow-up/route.ts`, `lib/pitches/status-transitions.ts`, `lib/pitches/daily-cap.ts`, `lib/pitches/send-time-hold.ts`, `lib/autopilot/hold.ts` (the approval lookup only), `lib/audit/log.ts` (the `AuditAction` union only)
- `tests/*.test.ts`
Read for context, do not edit:
- `app/api/replies/poll/route.ts` (`postponeSequence`; another worker edits this file), `lib/replies/intent-actions.ts`, `app/api/pitches/send-queue/route.ts`, `lib/autopilot/tick.ts`, `lib/pitches/followup-composer.ts`, `lib/pitches/send-guards.ts`
Forbidden: `lib/supabase/types.ts`, `vercel.json`, `CLAUDE.md`, `lib/{anthropic,gmail,compliance,supabase}/`, migrations.

## Must not change (negative set)
- A release with no concurrent writer restores exactly what it restores today (step, date, pause).
- The daily cap, slot reserve/release rules, the send window, MAX_PER_RUN, the Gmail send.
- `holdAutoApprovals` holds exactly the same pitches as today for every event history; the
  send-time hold decides exactly as today (table test over: no event, person, autopilot,
  person then autopilot, autopilot then person, read error).
- The send-queue route is not edited.

## Acceptance checks
1. `npm run typecheck && npm run lint && npm test` pass.
2. A race test: claim → the fake runs `postponeSequence`'s update between the claim and the
   release → after the release `next_followup_at` is the OOO date and the step is restored.
   Same for the 14-day snooze shape. Deleting the guard fails the test.
3. Budget tests with an injected clock: a follow-up at elapsed T where compose cannot finish is
   not composed (0 Claude calls); one claimed late enough is not claimed; the loop stops.
4. An audit row per recheck pause, with the kind.
5. `grep -rn bumpSendsTodayPayload lib app tests` returns nothing.
6. Mutation table in the PR.

## External prerequisites
none.

## Prod verification
After deploy: the next follow-up run (`20 15-22 * * 1-5`) returns 200 with no new error kinds;
`select count(*) from audit_log where action = '<your new action>'` grows only with real pauses.

## Out of scope
`recoverStuckSends` slot accounting (over-counts by one, the safe side), the send-queue route,
the poll route, OOO detection itself. Lessons go to `tasks/lessons-inbox/followup-path-hardening.md`.

## Questions already answered
Q: Should the release ever push the date LATER than the claim's?  A: No; it only must not pull a newer date back.
Q: Count a follow-up skipped for time as an error?  A: No, same as the send-queue: a "Time budget reached — next run" result.

## If blocked
Message the conductor with what you tried, what you need, and what you can still do meanwhile.
