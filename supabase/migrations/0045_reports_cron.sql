-- 0045 — Weekly report + hourly health check (task platform-reports).
--
-- spam-weekly-report  Mondays 13:10 UTC (07:10 Mexico City): what the platform
--                     did in the last 7 days vs the 7 before.
-- spam-health-check   hourly at :25: emails ONLY on an emergency (Google
--                     disconnected, autopilot stopped, emails stuck), at most
--                     once per problem per 24h (audit_log health.alert rows).
-- pg_cron is UTC. Uses public.spam_cron_call and the Vault-held scheduler token
-- from 0041. Schedules only: no table changes.

select cron.schedule('spam-health-check', '25 * * * *', $job$select public.spam_cron_call('/api/reports/health')$job$);
select cron.schedule('spam-weekly-report', '10 13 * * 1', $job$select public.spam_cron_call('/api/reports/weekly')$job$);
