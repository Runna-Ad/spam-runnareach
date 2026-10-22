[2026-10-22] A breaker input hard-coded to 0 passes every pure test
WHAT HAPPENED: governor.evaluateBreakers had a tested gmail_api rule (≥ 3 errors), but lib/autopilot/tick.ts passed `apiErrorsToday: 0` for every inbox, and nothing durable recorded Gmail send failures, so the breaker could never fire. The pure tests fed the rule its number directly and stayed green.
RULE: For every rule in a pure governor, keep one test that drives the real caller (the tick through the loader-hook harness in tests/autopilot-trust-split.test.ts) from stored rows to the trip. A literal constant passed into a rule's input is a finding by itself.
TAGS: autopilot, breakers, testing

[2026-10-22] A clock restart must check its own write
WHAT HAPPENED: The veto restart's only guard against re-firing every 15 minutes is that the trip predates the new stage_since. tick.ts's existing stage write ignores its error; for the restart, an unrecorded write would restart, pull back and email on every tick. restartStageClock checks the write, still pulls back, and throws (into report.errors, so the tick_errors row shows it) without the email.
RULE: When "this event was already handled" is encoded as a timestamp the handler writes, check that write's error and skip the side effects (emails, insights) when it fails; keep only the idempotent safety action.
TAGS: autopilot, stage, idempotency

## Out of scope, noticed
- app/api/pitches/send-queue/route.ts:498 calls sendGmailMessage without `timeoutMs`, so a network error THROWS (lib/gmail/client.ts:113) instead of returning { ok:false }: the outer catch logs it and the claim stays 'sending' until the sweep. Those throws are not counted by the gmail_api breaker (only { ok:false } is). follow-up and send-action likewise pass no timeoutMs.
- lib/autopilot/tick.ts evaluateStage: the existing stage write `update({ stage: next.stage, stage_since })` for auto→veto and promotions ignores its error (left unchanged per the brief's negative set).

[2026-10-22] A clock that starts at the tick's `now` recounts what the same tick wrote
WHAT HAPPENED: Review of #55 found the veto clock restarting twice: restartStageClock (and the existing auto→veto write) set stage_since = the tick's start, but runBreakers had inserted the opt_out_spike insight milliseconds later in the same tick (DB now()), so the next tick's `created_at >= stage_since` counted it again. Fixed with governor.stageClockStart: the later of the write clock and 1 ms after the newest counted evidence.
RULE: A "since" boundary that decides what is already handled starts after the newest row it handled, never at a timestamp taken before that row was written. Test it with the evidence written INSIDE the first run and three runs in a row.
TAGS: autopilot, stage, time-windows, testing
