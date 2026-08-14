-- 0032_warmup_rewarm_overlay.sql
-- Auto-reactivation ("re-warm") overlay for the email warmup engine.
--
-- Until now a domain's daily send target was a pure function of current_day, so
-- after day 28 it sat permanently at the 5/day maintenance floor with no way to
-- climb again short of hand-editing the day counter. When deliverability dips
-- (inbox rate slips, DMARC alignment drops, domain graded AT RISK) we want the
-- engine to automatically re-enter a short, gentle ramp — and settle back to
-- maintenance once health recovers. These columns hold that state; all default
-- to "not re-warming", so existing rows keep behaving exactly as before.

alter table warmup_config
  add column if not exists rewarm_started_at     timestamptz,
  add column if not exists rewarm_day            integer     not null default 0,
  add column if not exists rewarm_reason         text,
  add column if not exists healthy_streak        integer     not null default 0,
  add column if not exists last_health_eval_date date;

comment on column warmup_config.rewarm_started_at is
  'When the current auto/manual re-warm began. NULL = not re-warming (normal day-based schedule applies).';
comment on column warmup_config.rewarm_day is
  '1-indexed day within the current re-warm; drives the re-warm target curve. 0 when idle.';
comment on column warmup_config.rewarm_reason is
  'Why the re-warm was triggered — a dip signal description, or "manual".';
comment on column warmup_config.healthy_streak is
  'Consecutive daily health evaluations that came back healthy. Exits re-warm at the recovery threshold.';
comment on column warmup_config.last_health_eval_date is
  'YYYY-MM-DD of the last reactivation evaluation. Guards exactly one evaluation per calendar day.';
