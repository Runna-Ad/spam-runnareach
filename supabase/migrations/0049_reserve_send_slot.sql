-- 0049_reserve_send_slot.sql
--
-- One atomic statement per send-slot change on sender_inboxes.sends_today.
--
-- Until now three writers (send-queue, manual send, follow-up) read the counter,
-- added one in TypeScript and wrote the total back. Two send-queue runs fire at
-- 15:00 UTC (the Vercel backstop and pg_cron spam-send-queue), and their
-- write-backs clobbered each other: batch 3 audit saw 19 sends and a lower
-- count. An under-count lets a young domain send past its warm-up cap.
--
-- spam_reserve_send_slot(inbox)  takes one slot BEFORE the Gmail call:
--   resets to 0 when last_reset_date is not today (UTC), adds 1 only
--   WHERE the effective count < daily_cap. Returns the UTC day the slot was
--   counted on, or null when no slot was taken (cap reached, unknown inbox).
--   Concurrent callers serialize on the row lock and re-check the WHERE on the
--   committed row, so the cap holds under any overlap.
-- spam_release_send_slot(inbox, day)  gives a slot back when Gmail did not
--   accept the message. `day` is what the reserve returned: only that day's
--   count goes down, never below 0, so a release after UTC midnight never
--   takes a slot from the new day.
--
-- Callers: the service role (crons) and authenticated users (manual send).
-- security definer bypasses RLS, so an authenticated caller only reaches an
-- inbox of its own tenant (auth.uid() is null for the service role).
--
-- Deploy gap: this migration is applied before the deploy. Until then the old
-- code keeps its read-then-write and never calls these functions, so nothing
-- changes in that gap. Idempotent: create or replace, no DROP.

create or replace function public.spam_reserve_send_slot(p_inbox uuid)
returns date
language sql
volatile
security definer
set search_path = public
as $fn$
  with taken as (
    update public.sender_inboxes
       set sends_today = case
             when last_reset_date = (now() at time zone 'utc')::date then sends_today + 1
             else 1
           end,
           last_reset_date = (now() at time zone 'utc')::date,
           last_send_at = now()
     where id = p_inbox
       and (case
              when last_reset_date = (now() at time zone 'utc')::date then sends_today
              else 0
            end) < daily_cap
       and (auth.uid() is null or tenant_id = public.current_tenant_id())
    returning last_reset_date
  )
  select (select last_reset_date from taken);
$fn$;

create or replace function public.spam_release_send_slot(p_inbox uuid, p_day date)
returns boolean
language sql
volatile
security definer
set search_path = public
as $fn$
  with given as (
    update public.sender_inboxes
       set sends_today = sends_today - 1
     where id = p_inbox
       and sends_today > 0
       and last_reset_date = p_day
       and (auth.uid() is null or tenant_id = public.current_tenant_id())
    returning 1
  )
  select exists (select 1 from given);
$fn$;

revoke all on function public.spam_reserve_send_slot(uuid) from public, anon;
revoke all on function public.spam_release_send_slot(uuid, date) from public, anon;
grant execute on function public.spam_reserve_send_slot(uuid) to service_role, authenticated;
grant execute on function public.spam_release_send_slot(uuid, date) to service_role, authenticated;
