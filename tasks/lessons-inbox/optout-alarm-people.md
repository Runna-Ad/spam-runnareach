[2026-10-20] A breaker that counts timeline rows counts one human action as many
WHAT HAPPENED: opt_out_spike summed `unsubscribe` + `reply`/hard_no rows (lib/autopilot/tick.ts countEvents). One "remove me" reply writes both (the poll on the thread's pitch, recordOptOut on the root pitch), so two people tripped a quality breaker that pauses every inbox and demotes the stage. Fixed in lib/autopilot/opt-out-count.ts: distinct prospects via pitch_id → pitches.prospect_id, falling back to the event count on a failed or truncated read.
RULE: Before a breaker or learner counts pitch_events, list every writer of each event type it counts (grep `event_type: "<type>"` / `recordEvent`) and ask whether one human action writes more than one row. If it does, count the subject (prospect), not rows. A bounded read that hits its limit is a failed read: fall back to the exact count, never to a short one.
TAGS: autopilot, breakers, pitch_events, counting

[2026-10-20] Adding a module to tick.ts means adding it to the trust-split loader's REAL list
WHAT HAPPENED: tests/autopilot-trust-split.test.ts stubs every tick.ts import not in its REAL map; a stubbed function throws when called, so a new `./opt-out-count` import made the kill-switch route test report `breakers: stub optOutMetrics called`.
RULE: A new import in lib/autopilot/tick.ts that the breakers or safety steps call goes into REAL in tests/autopilot-trust-split.test.ts in the same commit.
TAGS: autopilot, tests, loader-hook

## Out of scope, noticed
- lib/autopilot/tick.ts runBreakers: the inbox and DMARC/warmup reads ignore their `error` (a failed read reads as "no data"), same pattern the opt-out count had. Not a trip risk (fails quiet), but a silent blind spot.
