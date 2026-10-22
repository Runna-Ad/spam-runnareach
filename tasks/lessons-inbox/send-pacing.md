[2026-10-22] A "max per run" that is also the query LIMIT starves other inboxes once a per-inbox rule is added
WHAT HAPPENED: The follow-up route used MAX_PER_RUN = 30 both as the read window (`.limit(MAX_PER_RUN)`) and the run size. Cutting the run to 2 by lowering that constant would have read only the 2 oldest due rows; if both belong to one inbox, the second inbox's follow-ups are never seen. Split into DUE_WINDOW (read) and the pacer (send) in app/api/pitches/follow-up/route.ts.
RULE: When a per-run limit gains a per-key rule (per inbox, per tenant), the read window must stay wider than the send limit, or the head of the queue blocks every other key. Name the two numbers separately.
TAGS: send-path, cron, pacing

[2026-10-22] pg_cron installs locally with apt in the cloud container
WHAT HAPPENED: The brief allowed a stub `cron` schema if pg_cron couldn't be installed. `apt-get install -y postgresql-16-cron` worked in under a minute; initdb + `shared_preload_libraries='pg_cron'` in a dir the postgres user can traverse (/var/tmp, not the scratchpad under /tmp/claude-0) gave a real cron.alter_job to test 0052 against.
RULE: For a pg_cron migration, test against the real extension (apt postgresql-16-cron, cluster under /var/tmp) before reaching for a stub.
TAGS: migrations, testing, pg_cron

[2026-10-22] A schedule change has a ship order when the health check reads the schedule from code
WHAT HAPPENED: lib/reports/heartbeat.ts quotes each job's cron and the health check counts missed runs from it. Deploying the code that says "every 10 min" while pg_cron still ran the hourly job would make job_silent fire every window hour. My first PR body claimed the opposite; the conductor reproduced it (now 15:55, last ok 15:20:30 -> 3 missed). Fixed by writing SHIP ORDER into the 0052 header and a test that pins it.
RULE: When code quotes a pg_cron schedule (heartbeat.ts, health rules), work out both orders of "migration applied" vs "code deployed" before writing the PR body, and put the safe order in the migration header where the person applying it reads it.
TAGS: migrations, cron, health-check, deploy

[2026-10-22] Running a job more often multiplies the cost of every retry path that redoes paid work
WHAT HAPPENED: Hourly -> every 10 min made a follow-up that fails after its Claude compose (gate unavailable, no slot, recheck skip, Gmail failure) recompose up to 48x a day instead of 8x. Fixed with a 60-min back-off on those exits (lib/pitches/send-pacing.ts backOffFollowup, or the claim release writing retryAt) and the inbox used up for the run.
RULE: When a cron's cadence goes up, list every exit that leaves the item due after paid work (AI calls, API quota) and give it a back-off, or the cap pays for the cadence.
TAGS: cron, cost, follow-up

## Out of scope, noticed
- send-queue reads due pitches `.limit(50)` oldest first; with per-inbox pacing, 50+ due pitches on one inbox ahead of another inbox's would hide the second inbox for the run. Pre-existing class (conductor: not needed now).
- Follow-up time-budget exit at the claim (after a compose, run past 95 s) does not back off: the existing followup-path-hardening test pins "nothing awaited between that check and the claim". Rare; would need that test reshaped.
- Prospect-local send windows (brief: out of scope).
