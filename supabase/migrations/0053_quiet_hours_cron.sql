-- 0053 — The tick, the reply poll, the calendar sync and the health check keep their pace only while emails send.
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
--   spam-replies-poll              5-59/10 15-22 * * 1-5   in the window (was 5-59/10 * * * *, 0048)
--   spam-replies-poll-close        5 23 * * 1-5            right after it: the last sends' bounces and replies
--   spam-replies-poll-morning      5 13 * * *              once a day, every day
--   spam-autopilot-tick            */15 15-22 * * 1-5      in the window (was */15 * * * *, 0041)
--   spam-autopilot-tick-close      15 23 * * 1-5           right after it, after the poll
--   spam-autopilot-tick-evening    15 1 * * 1-6            the 01:00 veto digest, Mon-Sat in UTC
--   spam-autopilot-tick-morning    15 13 * * *             once a day, every day: the 13:00 digest
--   spam-autopilot-tick-prewindow  45 14 * * 1-5           the last pass before the first send
--   spam-calendar-sync             5 15-23 * * 1-5         hourly in the window and right after it (was 5 * * * *, 0044)
--   spam-calendar-sync-morning     5 13 * * *              once a day, every day
--   spam-health-check              25 15-23 * * 1-5        hourly in the window and right after it (was 25 * * * *, 0045)
--   spam-health-check-morning      25 13 * * *             once a day, every day
--
-- The health check's 23:25 run comes after the 23:15 tick, so it judges the
-- window that just closed (emails_stuck) with the day's last bounces counted.
-- Its Sentry monitor (app/api/reports/health/route.ts) expects the weekday runs
-- only; the weekend 13:25 runs are extra check-ins, as Vercel's daily 12:40 run
-- already is. The calendar sync reads events updated in the last 48 hours
-- (lib/opportunities/google-calendar.ts LOOKBACK_MS), so a 24-hour gap misses
-- no booking.
--
-- Why each extra tick:
--   close      the bounces_today and gmail_api breakers count from UTC midnight
--              (lib/autopilot/bounce-breaker.ts, send-failures.ts). The last
--              sends' bounces are recorded at 22:55 and 23:05, after the 22:45
--              tick; a tick that waits for 01:15 counts them as yesterday.
--   evening    a tick sends the veto digest BEFORE it schedules, so what it
--   morning    schedules waits for the next digest tick. A tick after each slot
--              (lib/autopilot/hold.ts DIGEST_SLOTS_UTC, 01:00 and 13:00) on the
--              evening before every send day (Monday 01:15 included: Sunday's
--              morning tick schedules Monday's emails) lists every email at
--              least 6 hours before it can send, as hold.ts promises.
--   prewindow  the kill switch's pull-back happens in a tick (the send routes do
--              not read the switch). Switched off between 13:15 and 14:45, it
--              still acts before the 15:00 send, as it did with 15-minute ticks;
--              and a failed 13:15 tick gets a retry.
-- Each tick runs after a poll, so a bounce is recorded before the breakers read
-- it. In Calgary 13:05 is 7:05 in summer time and 6:05 from 2026-11-01.
--
-- The poll misses nothing: a normal run reads threads with inbound mail from
-- the last 2 days (RECENT_INBOUND_DAYS) and the longest gap is now 24 hours.
-- A person's reply sent from /inbox asks Gmail for unread messages first
-- (lib/replies/send-reply-action.ts), so an opt-out the poll hasn't read yet
-- still stops it.
--
-- Calls a week: polls 1,008 → 252, ticks 672 → 183, calendar syncs 168 → 52,
-- health checks 168 → 52. Send-queue and follow-up are unchanged. 1,477 fewer
-- cold starts a week × 0.67-0.95s CPU each (measured locally 2026-10-26) ≈
-- 16-23 minutes of CPU a week, against 4 hours a month.
--
-- Switching the autopilot back on by hand: update autonomy_state set
-- enabled = true, updated_at = now(). A tick with the switch off never writes
-- updated_at, and the next tick can now be hours away: without it the health
-- check reports "Autopilot stopped running" until then.
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
-- twelve jobs. Drops and unschedules nothing.

do $$
declare
  v_spec record;
  v_job bigint;
  v_found boolean;
begin
  for v_spec in
    select * from (values
      ('spam-replies-poll', '5-59/10 15-22 * * 1-5', '/api/replies/poll'),
      ('spam-replies-poll-close', '5 23 * * 1-5', '/api/replies/poll'),
      ('spam-replies-poll-morning', '5 13 * * *', '/api/replies/poll'),
      ('spam-autopilot-tick', '*/15 15-22 * * 1-5', '/api/autopilot/tick'),
      ('spam-autopilot-tick-close', '15 23 * * 1-5', '/api/autopilot/tick'),
      ('spam-autopilot-tick-evening', '15 1 * * 1-6', '/api/autopilot/tick'),
      ('spam-autopilot-tick-morning', '15 13 * * *', '/api/autopilot/tick'),
      ('spam-autopilot-tick-prewindow', '45 14 * * 1-5', '/api/autopilot/tick'),
      ('spam-calendar-sync', '5 15-23 * * 1-5', '/api/opportunities/calendar-sync'),
      ('spam-calendar-sync-morning', '5 13 * * *', '/api/opportunities/calendar-sync'),
      ('spam-health-check', '25 15-23 * * 1-5', '/api/reports/health'),
      ('spam-health-check-morning', '25 13 * * *', '/api/reports/health')
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
