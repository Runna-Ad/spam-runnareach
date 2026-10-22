-- 0052 — Follow-ups every 10 minutes, 5 minutes after each send run.
--
-- On 2026-10-22, 6 first emails went out at 15:00 and then 9 follow-ups
-- between 15:20:20 and 15:21:16, about 8 seconds apart: the hourly follow-up
-- run sent everything due in one burst, and burst sending from a young domain
-- is a spam-filter signal. Both routes now send at most one email per inbox
-- and two in total per run (lib/pitches/send-pacing.ts). Send runs are at
-- :00/:10/:20…, Mon–Fri 15–22 UTC (0041); follow-up runs move from :20 once an
-- hour to :05/:15/:25…, so an inbox never sends two emails within ~5 minutes.
--
-- 0041 created the job with:
--   select cron.schedule('spam-follow-up', '20 15-22 * * 1-5', $job$select public.spam_cron_call('/api/pitches/follow-up')$job$);
--
-- Cost: a run with nothing due reads the database only; Claude is called per
-- follow-up composed (at most two per run), never per run.
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
    perform cron.alter_job(job_id := v_job, schedule := '5-59/10 15-22 * * 1-5');
    v_found := true;
  end loop;
  if not v_found then
    perform cron.schedule('spam-follow-up', '5-59/10 15-22 * * 1-5', $job$select public.spam_cron_call('/api/pitches/follow-up')$job$);
  end if;
end
$$;
