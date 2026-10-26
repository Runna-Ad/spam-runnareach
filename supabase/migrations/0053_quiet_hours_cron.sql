-- 0053 — The autopilot tick and the reply poll keep their pace only while emails send.
--
-- Vercel's free plan includes 4 hours of function CPU a month (Fluid Active
-- CPU), and every project on the team pauses when it runs out. On 2026-10-26
-- the team was at 75%. In the 7 days before, pg_cron called this app about
-- 2,300 times (cron.job_run_details): 994 reply polls and 672 ticks, every
-- 10 and 15 minutes, all day, every day. Each call starts the app from cold,
-- and the start alone costs CPU. Outside the send window (weekdays
-- 15:00-22:59 UTC, 0041) nothing is sent, so those runs mostly found nothing.
--
-- Pedro 2026-10-26: keep the pace inside the window; after it, one check right
-- after it closes, then once a day.
--
--   spam-replies-poll            5-59/10 15-22 * * 1-5   in the window (was 5-59/10 * * * *, 0048)
--   spam-replies-poll-evening    5 23 * * 1-5            right after it: the last sends' bounces and replies
--   spam-replies-poll-morning    5 13 * * *              once a day, every day
--   spam-autopilot-tick          */15 15-22 * * 1-5      in the window (was */15 * * * *, 0041)
--   spam-autopilot-tick-evening  15 1 * * 1-6            Mon-Sat in UTC: after each weekday's window, and Sunday evening
--   spam-autopilot-tick-morning  15 13 * * *             once a day, every day
--
-- The minutes: each tick runs after a poll (a bounce is recorded before the
-- breakers read it), and after a veto digest slot (lib/autopilot/hold.ts
-- DIGEST_SLOTS_UTC, 01:00 and 13:00). A tick sends the digest BEFORE it
-- schedules, so an email it schedules waits for the next digest tick; with an
-- evening tick before every send day (Monday 01:15 included: Sunday's morning
-- tick schedules Monday's emails), each one is listed at least 6 hours before
-- it can send, as hold.ts promises. The morning runs end at 13:15, before the
-- first send at 15:00. In Calgary 13:05 is 7:05 in summer time and 6:05 from
-- 2026-11-01.
--
-- The poll misses nothing: a normal run reads threads with inbound mail from
-- the last 2 days (RECENT_INBOUND_DAYS) and the longest gap is now 24 hours.
-- A person's reply sent from /inbox asks Gmail for unread messages first
-- (lib/replies/send-reply-action.ts), so an opt-out the poll hasn't read yet
-- still stops it. Calls a week: polls 1,008 → 252, ticks 672 → 173.
-- Send-queue and follow-up are unchanged.
--
-- SHIP ORDER: deploy the code that goes with it FIRST, then apply this
-- migration. The new health check (lib/reports/heartbeat.ts CRON_JOBS,
-- autopilot_stopped) counts the old, more frequent runs as on time. The other
-- order alarms: with this schedule live under the old code, job_silent fires
-- for the tick and the poll at the first health check about an hour after the
-- window closes (00:25 UTC), every weekday.
--
-- Idempotent by construction: each job's schedule is set by job id (any owner),
-- or the job is created when it is missing. Running it twice leaves the same
-- six jobs. Drops and unschedules nothing.

do $$
declare
  v_spec record;
  v_job bigint;
  v_found boolean;
begin
  for v_spec in
    select * from (values
      ('spam-replies-poll', '5-59/10 15-22 * * 1-5', '/api/replies/poll'),
      ('spam-replies-poll-evening', '5 23 * * 1-5', '/api/replies/poll'),
      ('spam-replies-poll-morning', '5 13 * * *', '/api/replies/poll'),
      ('spam-autopilot-tick', '*/15 15-22 * * 1-5', '/api/autopilot/tick'),
      ('spam-autopilot-tick-evening', '15 1 * * 1-6', '/api/autopilot/tick'),
      ('spam-autopilot-tick-morning', '15 13 * * *', '/api/autopilot/tick')
    ) as s(jobname, schedule, route)
  loop
    v_found := false;
    for v_job in select jobid from cron.job where jobname = v_spec.jobname loop
      perform cron.alter_job(job_id := v_job, schedule := v_spec.schedule);
      v_found := true;
    end loop;
    if not v_found then
      perform cron.schedule(v_spec.jobname, v_spec.schedule, format('select public.spam_cron_call(%L)', v_spec.route));
    end if;
  end loop;
end
$$;
