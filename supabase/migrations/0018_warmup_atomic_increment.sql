-- ─────────────────────────────────────────────────────────────────────────────
-- 0018_warmup_atomic_increment.sql
-- Atomic RPC for incrementing emails_sent_today.
--
-- Replaces the read-modify-write pattern in the warmup engine which could be
-- clobbered by concurrent runs (cron duplicate-fire or manual "Run now" click).
-- ─────────────────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION increment_warmup_sent_today(
  p_config_id       uuid,
  p_count           integer,
  p_last_buddy_index integer
)
RETURNS void
LANGUAGE sql
AS $$
  UPDATE warmup_config
  SET
    emails_sent_today  = emails_sent_today + p_count,
    last_buddy_index   = p_last_buddy_index,
    updated_at         = now()
  WHERE id = p_config_id;
$$;
