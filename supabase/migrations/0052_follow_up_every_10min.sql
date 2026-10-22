-- 0052 — Follow-ups every 10 minutes, at :07, between the reply poll and the next send run.
--
-- SHIP ORDER: apply this migration BEFORE deploying the code that goes with it.
-- The deployed lib/reports/heartbeat.ts expects a follow-up run every 10
-- minutes; with the code live and pg_cron still on the hourly :20 job, the
-- health check's job_silent fires every window hour (~:50, three 10-minute
-- runs "missed"). The other order is the safe one: the old health check
-- expects less, and the old route, run every 10 minutes until the deploy,
-- sends what is due as it does today. Keep that gap short.
--
-- On 2026-10-22, 6 first emails went out at 15:00 and then 9 follow-ups
-- between 15:20:20 and 15:21:16, about 8 seconds apart: the hourly follow-up
-- run sent everything due in one burst, and burst sending from a young domain
-- is a spam-filter signal. Both routes now send at most one email per inbox
-- and two in total per run (lib/pitches/send-pacing.ts). Send runs are at
-- :00/:10/:20…, Mon–Fri 15–22 UTC (0041), the reply poll at :05/:15/… (0048);
-- follow-up runs move from :20 once an hour to :07/:17/:27…: 2 minutes after
-- the poll (a bounce from the :00 send is recorded before a follow-up leaves
-- that inbox) and 3 before the next send run.
--
-- 0041 created the job with:
--   select cron.schedule('spam-follow-up', '20 15-22 * * 1-5', $job$select public.spam_cron_call('/api/pitches/follow-up')$job$);
--
-- Cost: a run with nothing due reads the database only; Claude is called per
-- follow-up composed (at most one per inbox per run; a follow-up that fails
-- after its compose waits an hour before the next try), never per run.
--
-- Idempotent by construction: it only sets the schedule of the existing
-- 'spam-follow-up' job(s) by job id (any owner), or creates the job from 0041
-- if it is missing. Running it twice leaves the same single job. Drops and
-- unschedules nothing.

do $$
declare
  v_job bigint;
  v_found boolean := false;
begin
  for v_job in select jobid from cron.job where jobname = 'spam-follow-up' loop
    perform cron.alter_job(job_id := v_job, schedule := '7-59/10 15-22 * * 1-5');
    v_found := true;
  end loop;
  if not v_found then
    perform cron.schedule('spam-follow-up', '7-59/10 15-22 * * 1-5', $job$select public.spam_cron_call('/api/pitches/follow-up')$job$);
  end if;
end
$$;
