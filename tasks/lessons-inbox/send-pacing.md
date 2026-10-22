[2026-10-22] A "max per run" that is also the query LIMIT starves other inboxes once a per-inbox rule is added
WHAT HAPPENED: The follow-up route used MAX_PER_RUN = 30 both as the read window (`.limit(MAX_PER_RUN)`) and the run size. Cutting the run to 2 by lowering that constant would have read only the 2 oldest due rows; if both belong to one inbox, the second inbox's follow-ups are never seen. Split into DUE_WINDOW (read) and the pacer (send) in app/api/pitches/follow-up/route.ts.
RULE: When a per-run limit gains a per-key rule (per inbox, per tenant), the read window must stay wider than the send limit, or the head of the queue blocks every other key. Name the two numbers separately.
TAGS: send-path, cron, pacing

[2026-10-22] pg_cron installs locally with apt in the cloud container
WHAT HAPPENED: The brief allowed a stub `cron` schema if pg_cron couldn't be installed. `apt-get install -y postgresql-16-cron` worked in under a minute; initdb + `shared_preload_libraries='pg_cron'` in a dir the postgres user can traverse (/var/tmp, not the scratchpad under /tmp/claude-0) gave a real cron.alter_job to test 0052 against.
RULE: For a pg_cron migration, test against the real extension (apt postgresql-16-cron, cluster under /var/tmp) before reaching for a stub.
TAGS: migrations, testing, pg_cron

## Out of scope, noticed
- Follow-up now runs at :05, the same minute as the reply poll (0048, `5-59/10 * * * *`). A bounce from the :00 first email may not be recorded before the :05 follow-up from the same inbox. Previously the :20 follow-up ran 5 min after the :15 poll. A `7-59/10` follow-up offset (or poll at :03) would restore "poll before every send run".
- Prospect-local send windows (brief: out of scope).
