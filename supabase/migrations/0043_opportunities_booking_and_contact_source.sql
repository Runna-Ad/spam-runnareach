-- 0043: Phase 3 batch 1 shared schema (conductor, wave 0).
--
-- 1. opportunities gains a source and a calendar event id so the Google Calendar
--    booking sync (task opportunities-calendar-sync) is idempotent.
-- 2. pitch_event_type gains meeting_booked / won / lost so the funnel can record
--    outcomes (tasks opportunities-calendar-sync, opportunities-pipeline-ui).
-- 3. prospect_contacts gains source_url: the page the address was mined from
--    (task contact-source-url), which later enables a just-in-time freshness check.
--
-- Enum values added here are only USED by code that ships with this batch; nothing
-- in this file reads them (Postgres forbids using a new enum value in the same
-- transaction that adds it).

alter table public.opportunities
  add column if not exists source text not null default 'manual'
    check (source in ('manual', 'calendar')),
  add column if not exists calendar_event_id text;

create unique index if not exists opportunities_calendar_event_uidx
  on public.opportunities (tenant_id, calendar_event_id)
  where calendar_event_id is not null;

alter type public.pitch_event_type add value if not exists 'meeting_booked';
alter type public.pitch_event_type add value if not exists 'won';
alter type public.pitch_event_type add value if not exists 'lost';

alter table public.prospect_contacts
  add column if not exists source_url text;

comment on column public.prospect_contacts.source_url is
  'Page the address was mined from (scraper/research). Null for provider or manual contacts.';
comment on column public.opportunities.calendar_event_id is
  'Google Calendar event id for bookings created by the calendar sync; unique per tenant.';
