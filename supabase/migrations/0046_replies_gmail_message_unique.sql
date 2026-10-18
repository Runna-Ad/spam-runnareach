-- 0046: one reply row per Gmail message (Phase 3 batch 3, conductor wave 0).
--
-- The reply poll dedupes with a SELECT before it inserts, so two overlapping
-- runs (pg_cron every 30 min and the Vercel daily backstop) could both store the
-- same message, classify it twice and act on it twice (two lead alerts, two
-- drafts). With this index the second insert fails with 23505 and the poll
-- skips that message: the run that stored it first owns its side effects.
--
-- Manual replies (lib/replies/actions.ts) carry no gmail_message_id and are not
-- constrained. Prod had 0 duplicate (tenant_id, gmail_message_id) pairs on
-- 2026-10-18 (32 rows); if this fails with a unique violation, find the pairs
-- with the query below, delete the later row of each, and re-run.
--   select tenant_id, gmail_message_id, count(*) from public.replies
--   where gmail_message_id is not null group by 1, 2 having count(*) > 1;

create unique index if not exists replies_tenant_gmail_message_uidx
  on public.replies (tenant_id, gmail_message_id)
  where gmail_message_id is not null;
