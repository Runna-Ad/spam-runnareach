-- 0048 — The reply poll every 10 minutes, 5 minutes after each send run.
--
-- On 2026-10-19 two Gmail bounce notices arrived 30 seconds after the 15:00
-- send run, the half-hourly poll recorded them at 15:30 and the autopilot tick
-- paused the inbox at 15:45: 13 more cold emails went out in between. The
-- send-queue now skips an inbox on the tick's own bounce rule
-- (lib/autopilot/bounce-breaker.ts), which only helps once the poll has
-- recorded the bounce. Send runs are at :00/:10/:20…, Mon–Fri 15–22 UTC
-- (0041); the poll now runs at :05/:15/:25…, so a bounce is recorded before
-- the next send run.
--
-- Cost: a poll run with no new mail reads Gmail and the database only; Claude
-- is called per NEW reply (classify, then draft), never per run.
--
-- Idempotent by construction: it only sets the schedule of the existing
-- 'spam-replies-poll' job(s) by job id (any owner), or creates the job from
-- 0041 if it is missing. Running it twice leaves the same single job. Drops
-- and unschedules nothing.

do $$
declare
  v_job bigint;
  v_found boolean := false;
begin
  for v_job in select jobid from cron.job where jobname = 'spam-replies-poll' loop
    perform cron.alter_job(job_id := v_job, schedule := '5-59/10 * * * *');
    v_found := true;
  end loop;
  if not v_found then
    perform cron.schedule('spam-replies-poll', '5-59/10 * * * *', $job$select public.spam_cron_call('/api/replies/poll')$job$);
  end if;
end
$$;
