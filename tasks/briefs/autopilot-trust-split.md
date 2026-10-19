# Brief: autopilot-trust-split

| | |
|---|---|
| Module | `lib/autopilot/` (+ the Settings sending drawer, one weekly-report count) |
| Model / effort | opus-5.5 / high (autopilot lane, one at a time; touches stage + breakers) |
| Branch | `claude/autopilot-trust-split` from `claude/phase3-batch4-integration` |
| PR target | `claude/phase3-batch4-integration` |
| Reserved migration | none |
| Depends on | none. Runs in parallel with send-path-hardening (send-queue/follow-up routes), pipeline-guards and address-trust; see "Runtime neighbours" |
| Conductor session | `session_017nqBxLFFXKbhDwKiPi6xLf` (send_message here ONLY if blocked; the PR body is the report) |
| Size | M |

## Goal
The autopilot's level (off / shadow / veto / auto) must measure ONE thing: whether its
pitches are good enough to send without a person. Today any breaker trip on automatic
sends drops it a level, so two dead mailboxes on 2026-10-19 sent it veto → shadow, where
it needs 7 days and 100 decisions to climb back. Pedro (PEDRO_OVERRIDE, tasks/lessons.md
2026-10-19): "that had nothing to do with the quality of the pitches." After this task,
delivery problems pause sending (as today) but never move the level, and the review's
leftover gaps around pausing, resuming and the kill switch are closed.

## Context the worker needs
- `governor.nextStage` demotes on `m.autoBreakerTrips > 0 || m.autoFactualErrors > 0`.
  `tick.ts` (stage step, ~l.860) fills `autoBreakerTrips` by counting `learning_insights`
  rows `kind='breaker'` since `stage_since`, whatever the breaker. Each breaker insight's
  `evidence` is the `BreakerTrip` (`{scope, inboxId?, code, reason}`).
- Breaker codes (`evaluateBreakers`): `inbox_bounces`, `gmail_api`, `bounces_today`,
  `dmarc`, `blocklist`, `placement` are DELIVERY; `opt_out_spike` (opt-outs + hard no's)
  is about what we send and to whom, so it is QUALITY.
- `runTick` returns at `if (!s || !s.enabled || s.stage === "off")` (~l.158) BEFORE
  `runBreakers`, so with the autopilot off a send-queue bounce block
  (`inboxBounceBlock`, app/api/pitches/send-queue) never becomes a pause + email, and the
  kill switch leaves `approved` automatic pitches scheduled (the send-queue sends them).
  `holdAutoApprovals` (hold.ts) already runs on a demotion to shadow/off and on later
  shadow ticks.
- Resume (`lib/autopilot/inbox-resume.ts saveSenderInbox`): writes the unpause, THEN the
  `sender_inbox.resumed` audit row (a tick between the two writes re-pauses; ms window).
  The drawer (`components/settings/sender-inbox-drawer.tsx`) seeds `paused` from the page
  load, so a stale page saved after a breaker pause counts as a resume.
- `lib/reports/weekly.ts` (~l.182, ~l.302) counts "Held by a person (vetoes)" as any
  autopilot-approved pitch now in draft, so demotion pull-backs (`HELD_BY_AUTOPILOT`
  reason) show as a person's vetoes.
- `scheduleAuto`'s finder relabel loop (tick.ts ~l.700) is pinned only by a source
  regex; deleting the loop passes every test. The stage is veto again since 2026-10-19
  19:57 UTC, so this code runs now.

## Brain lessons
- tasks/lessons.md 2026-10-19 (merged inbox): "A guard that only matters in a race needs a
  race in the fake, or deleting it passes every test." Applies to every guarded UPDATE.

## The changes
1. **Only quality demotes.** `nextStage` demotes on `autoFactualErrors > 0` or a QUALITY
   breaker trip (today: `opt_out_spike`) in the stage. Delivery trips never change the
   stage. Keep the breaker classification in ONE exported place in `governor.ts`
   (a predicate or a code → kind map), used by the tick's count.
2. **Breakers and the pull-back run when the autopilot is off.** With `enabled=false` or
   stage `off`, the tick still runs `runBreakers` (pause + email) and `holdAutoApprovals`,
   and nothing else it skips today.
3. **Resume order + stale form.** Write the audit row before the unpause (a stray row on a
   still-paused inbox is harmless: the next real resume writes a newer one). The drawer
   sends the `paused` value it loaded; the server records a resume (and unpauses) only
   when the person saw "paused" and saved "not paused". A save from a form that loaded
   "not paused" while the DB says paused keeps the pause and tells the person to reload.
4. **Weekly report.** "Held by a person" excludes pitches whose reasons start with
   `HELD_BY_AUTOPILOT`.
5. **Test the relabel loop** with a fake db (a finder-address draft labelled AUTO before the
   rule change is relabelled, never approved).

## Runtime neighbours (same batch)
- send-path-hardening changes the send-queue and follow-up routes (atomic send slots, a
  time budget, the bounce block on follow-ups). It READS `inboxBounceBlock` from
  `lib/autopilot/bounce-breaker.ts`: do not change that function's signature.
- address-trust edits ONE line in `governor.ts` (`TRUSTED_SOURCES` becomes an import from
  `lib/research/verify-recipient.ts`). Do not touch `TRUSTED_SOURCES` or `laneFor`'s use of it.

## Files
Allowed: `lib/autopilot/governor.ts`, `lib/autopilot/tick.ts`, `lib/autopilot/hold.ts`,
`lib/autopilot/inbox-resume.ts`, `lib/settings/sending-actions.ts`,
`components/settings/sender-inbox-drawer.tsx`, `lib/reports/weekly.ts`, `tests/*.test.ts`.
Read only: `lib/autopilot/bounce-breaker.ts`, `app/api/pitches/send-queue/route.ts`.
Forbidden: `lib/supabase/types.ts`, `vercel.json`, `CLAUDE.md`, `lib/{anthropic,gmail,compliance,supabase}/`, migrations.

## Must not change (negative set)
- Every breaker's trip condition and threshold, and what it pauses.
- A factual/recipient error on an automatic pitch still demotes at once.
- Promotion rules (`STAGE_RULES`) and their metrics.
- A resume from a form that loaded "paused" works exactly as today (audit row, cut-off).
- `holdPitch` (digest link) and person approvals: never held by the autopilot.

## Acceptance checks
1. `npm run typecheck && npm run lint && npm test` pass; new tests: veto + `inbox_bounces`
   trip → stage stays veto, inbox paused; veto + `opt_out_spike` → shadow; veto + factual
   error → shadow; `enabled=false` + 2 fresh bounces → paused + email; kill switch holds
   pending automatic approvals; stale form save keeps the pause; relabel loop.
2. Mutation table in the PR: revert each change, the matching test fails.
3. The weekly report test: a demotion pull-back is not counted as a person's veto.

## External prerequisites
none.

## Prod verification
After deploy: `select stage, reason from autonomy_state` unchanged by the next ticks; the
next breaker insight (if any) is a delivery code and the stage stays.

## Out of scope
Changing breaker thresholds, the promotion rules, bounces_today across 2+ inboxes, the
send-queue/follow-up routes. Lessons go to `tasks/lessons-inbox/autopilot-trust-split.md`.

## Questions already answered
Q: Is an opt-out spike quality or delivery?  A: Quality (people asking to be left alone is about what and whom we send). Demotes.
Q: Should a delivery trip at least be visible?  A: Yes, it already is: the pause email and the insight row. No stage change.

## If blocked
Message the conductor with what you tried, what you need, and what you can still do meanwhile.
