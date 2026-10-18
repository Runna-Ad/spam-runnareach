[2026-10-18] An emergency is "due activity that did not happen", never "something is waiting"
WHAT HAPPENED: My first E3 ("approved, more than 24h past scheduled_send_at, after a whole send window") still fired every day on states the send-queue enters by design: paused inbox, the daily-cap drip (queueApprovedForSend sets scheduled_send_at=now for all), prospect cooldown, a Friday 22:51 "sending" row on Saturday. Review caught it; the old code alerts on 5/5 of the conductor's repro states. lib/reports/health.ts now judges only the last CLOSED send window, within 24h of its close: fire only if it had due pitches on an unpaused, connected, capped inbox with no cooldown AND that inbox sent nothing in it.
RULE: For every alert, list each reason the consumer skips an item (read its `continue`s) and make each one silent; then require evidence the consumer itself did nothing in a period it should have acted. A 24h dedupe turns any false positive into a daily email. Test a silent matrix, one case per skip reason, plus one true positive each.
TAGS: reports, alerts, pg_cron

[2026-10-18] An alert about the alert channel has to leave by another channel
WHAT HAPPENED: The "Google disconnected" emergency is emailed through Gmail. sendNotification (lib/notify/send.ts) picks the tenant's oldest connected inbox, so with one inbox, or the oldest one being the broken one, the alert could never go out. The health check now sends from an inbox whose token just worked (fromEmail), writes the dedupe row only after a delivery, and otherwise raises a fatal Sentry event (free, emails by itself) and retries next hour.
RULE: For every alert, ask "does the failure it reports also break its delivery?" If yes, pick the sender from the snapshot, never dedupe an undelivered alert, and keep a second channel.
TAGS: notify, reports, gmail

## Out of scope, noticed
- lib/audit/log.ts: `writeAuditLog` swallows insert errors, so callers that depend on the row (dedupe) can't react; `recordHealthAlert` inserts directly for that reason. A `{ ok }` return would let it use the shared writer.
- lib/anthropic/cost-tracking.ts: `DAILY_USD_CAP_DEFAULT` (6) isn't exported, so lib/reports/snapshot.ts repeats it; its doc comment at line ~66 still says "default $5".
- supabase/migrations/0016: `warmup_config.tenant_id` references auth.users, not tenants; the report finds warmup rows through the tenant's sending addresses instead.
