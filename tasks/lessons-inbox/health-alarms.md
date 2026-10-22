[2026-10-22] A new import in a cron route breaks every test that stubs that route's imports
WHAT HAPPENED: adding `import { withHeartbeat } from "@/lib/reports/heartbeat"` to the poll and tick routes failed 12 tests in tests/reply-on-root.test.ts, tests/optout-repair.test.ts and tests/autopilot-trust-split.test.ts. Their loader stubs every import of the route, and any stub without an answer throws "stub withHeartbeat called". Fixed with a pass-through entry in each file's `__stubValues`, three files outside the brief's allow-list.
RULE: before adding an import to a route, grep tests/ for the route's path (`replies/poll/route`, `autopilot/tick/route`, ...). Every hit that stubs imports needs an answer for the new name, so the brief's allow-list should include those test files.
TAGS: tests, cron routes, stubs

[2026-10-22] A "has it learned lately" alarm needs a column the learner writes, and learning_arms has none for trials
WHAT HAPPENED: learning_stalled was briefed as "no writer arm gained a trial in 7 days". learning_arms.trials is recomputed from scratch on every tick (lib/autopilot/learn.ts settleLearner), so its history is never stored. settleLearner does write `updated_at = now` on every arm on every tick it runs. The rule therefore reads two signals: trials = 0 while 5+ settled first emails exist, or the newest writer-arm write is 7+ days old.
RULE: before writing a "stopped changing" alarm, read the writer and find the column it sets on every run. updated_at only works when the learner is the table's only writer (true for writer.* arms). If no such column exists, compare against what the learner should have counted, using its own exclusions (test sends, bounces, pitches without arms).
TAGS: health, learning, alerts

## Out of scope, noticed
- app/api/pitches/send-queue/route.ts, follow-up/route.ts: the heartbeat write comes after the run's own time budget (up to 3s). If a run regularly ends within 3s of maxDuration (120s), the kill drops the heartbeat and job_silent would flag a job that is actually working. That needs a run near 117s, three times in a row. Worth a log check after the deploy.
- lib/settings/sending-actions.ts: daily_cap is `min(1)`, so Settings can't turn an inbox off on purpose except by pausing it. inbox_paused now sends a reminder every 24h for that kind of pause too.
