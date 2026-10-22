-- 0051: cron heartbeats (Phase 3 batch 8, task health-alarms).
--
-- One row per scheduled job, written at the end of each authorized run by
-- lib/reports/heartbeat.ts: last_ok_at when the run answered below 500,
-- last_error_at + last_error when it answered 5xx or threw. The hourly health
-- check (lib/reports/health.ts, rule job_silent) alerts when a job's last_ok_at
-- is three scheduled runs old inside its active window. Jobs (0041, 0048):
--   autopilot-tick   spam-autopilot-tick  */15 * * * *
--   replies-poll     spam-replies-poll    5-59/10 * * * *
--   send-queue       spam-send-queue      */10 15-22 * * 1-5
--   follow-up        spam-follow-up       20 15-22 * * 1-5
--
-- Global, not per tenant: one run serves every tenant. Service role only: RLS
-- on with no policies, and no grants to anon/authenticated. created_at is when
-- the job was first seen, the baseline for a job that has never succeeded.
--
-- Additive. The old code (before the deploy) never reads or writes it. No
-- heartbeat row yet = the health check stays silent for that job.

create table if not exists public.cron_heartbeats (
  job text primary key,
  last_ok_at timestamptz,
  last_error_at timestamptz,
  last_error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz default now()
);

alter table public.cron_heartbeats enable row level security;
revoke all on table public.cron_heartbeats from anon, authenticated;

comment on table public.cron_heartbeats is
  'Last successful / failed run of each scheduled job (lib/reports/heartbeat.ts). Read by the hourly health check (job_silent). Service role only.';
