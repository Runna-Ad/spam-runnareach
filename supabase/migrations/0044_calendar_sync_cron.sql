-- 0044 — Hourly Google Calendar booking sync (task opportunities-calendar-sync).
--
-- Appointment-schedule bookings have no webhook, so pg_cron polls the route at
-- :05 every hour; it turns bookings into meeting_booked opportunities and
-- cancellations into lost ones. Idempotent (unique calendar_event_id, 0043).
-- Uses public.spam_cron_call and the Vault-held scheduler token from 0041.

select cron.schedule('spam-calendar-sync', '5 * * * *', $job$select public.spam_cron_call('/api/opportunities/calendar-sync')$job$);
