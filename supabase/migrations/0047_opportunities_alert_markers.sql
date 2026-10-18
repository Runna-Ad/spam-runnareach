-- 0047: durable booking alerts (Phase 3 batch 3, conductor wave 0, task
-- booking-alert-durability).
--
-- The calendar sync sent its lead alert from memory after the batch, so a Gmail
-- error or a kill at maxDuration lost it for good. The alert is now driven by
-- these markers, like replies.hot_alert_sent_at for reply alerts: a row is due
-- while its marker is null, claimed by setting it, released on a send that
-- reached nobody. meeting_start / meeting_time_zone keep what the alert shows,
-- so a later run can send it without the Google event. cancelled_at is when the
-- sync saw the cancellation: the cancellation alert's 48h window keys on it,
-- not on updated_at (the 0001 trigger bumps updated_at on every claim and
-- release, so a window on it never closes).
--
-- Rows that already exist were alerted by the old code (or predate alerts):
-- mark them so the first sweep does not re-send them. 0 calendar rows in prod on
-- 2026-10-18.

alter table public.opportunities
  add column if not exists booked_alert_sent_at timestamptz,
  add column if not exists cancelled_alert_sent_at timestamptz,
  add column if not exists meeting_start text,
  add column if not exists meeting_time_zone text,
  add column if not exists cancelled_at timestamptz;

update public.opportunities
   set booked_alert_sent_at = coalesce(booked_alert_sent_at, created_at)
 where source = 'calendar';

update public.opportunities
   set cancelled_alert_sent_at = coalesce(cancelled_alert_sent_at, updated_at),
       cancelled_at = coalesce(cancelled_at, updated_at)
 where source = 'calendar' and stage = 'lost' and loss_reason = 'booking cancelled';

comment on column public.opportunities.booked_alert_sent_at is
  'Calendar bookings: when the booking lead alert was claimed/sent; null = due (lib/opportunities/calendar-sync.ts).';
comment on column public.opportunities.cancelled_alert_sent_at is
  'Calendar bookings: when the cancellation lead alert was claimed/sent; null on a cancelled row = due.';
comment on column public.opportunities.meeting_start is
  'Calendar bookings: Google start (RFC 3339 dateTime, or YYYY-MM-DD for all-day).';
comment on column public.opportunities.cancelled_at is
  'Calendar bookings: when the sync marked the booking cancelled (stage lost, loss_reason ''booking cancelled'').';
comment on column public.opportunities.meeting_time_zone is
  'Calendar bookings: the event''s IANA time zone when Google gives one.';
