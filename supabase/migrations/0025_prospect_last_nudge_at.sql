-- 0025_prospect_last_nudge_at.sql
-- Reply-funnel nudge: when a prospect replied once then went quiet, a daily cron
-- sends a soft re-engagement (auto-send if the draft is clearly good, else held
-- for review). last_nudge_at records when we last chased so the cron waits the
-- full delay before nudging again and never double-fires.

alter table public.prospects
  add column if not exists last_nudge_at timestamptz;
