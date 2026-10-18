[2026-10-18] An age threshold on queued work must follow the consumer's schedule, not the wall clock
WHAT HAPPENED: The brief's "approved with scheduled_send_at more than 24h ago" would have raised an emergency every weekend, because the send-queue only runs weekdays 15:00–22:50 UTC (0041) and the veto stage schedules sends 18h out at any hour. lib/reports/health.ts `isStuckApproved` now also requires one whole send window to have closed since the pitch was due. Two of my own fixtures failed first because they assumed wall-clock age too.
RULE: Before alerting on "X has waited too long", read the cron of the job that drains X and express the threshold in that job's run windows. Test it with a Friday-night item checked on Sunday.
TAGS: reports, alerts, pg_cron

[2026-10-18] An alert about the alert channel has to leave by another channel
WHAT HAPPENED: The "Google disconnected" emergency is emailed through Gmail. sendNotification (lib/notify/send.ts) picks the tenant's oldest connected inbox, so with one inbox, or the oldest one being the broken one, the alert could never go out. The health check now sends from an inbox whose token just worked (fromEmail), writes the dedupe row only after a delivery, and otherwise raises a fatal Sentry event (free, emails by itself) and retries next hour.
RULE: For every alert, ask "does the failure it reports also break its delivery?" If yes, pick the sender from the snapshot, never dedupe an undelivered alert, and keep a second channel.
TAGS: notify, reports, gmail

## Out of scope, noticed
- lib/notify/send.ts: `sendNotification` takes the oldest connected inbox without checking its token works; when that inbox is disconnected, EVERY notification (breaker trips, veto digest, weekly report) fails silently even if another inbox is fine. A fallback to the next connected inbox on a token error would fix it (conductor-only file).
- lib/audit/log.ts: `AuditAction` has no "health.alert"; lib/reports/snapshot.ts inserts into audit_log directly. Add it to the union and switch `recordHealthAlert` to `writeAuditLog`.
- lib/anthropic/cost-tracking.ts: `DAILY_USD_CAP_DEFAULT` (6) isn't exported, so lib/reports/snapshot.ts repeats it; its doc comment at line ~66 still says "default $5".
- supabase/migrations/0016: `warmup_config.tenant_id` references auth.users, not tenants; the report finds warmup rows through the tenant's sending addresses instead.
