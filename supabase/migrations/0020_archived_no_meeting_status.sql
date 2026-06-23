-- ─────────────────────────────────────────────────────────────────────────────
-- 0020_archived_no_meeting_status.sql
-- Reply Funnel: add the 'archived_no_meeting' prospect status.
--
-- A prospect reaches this state when we've sent the max of 3 funnel replies
-- trying to book a meeting and still haven't booked one. We archive WITH a
-- captured learning (prospects.no_meeting_reason) so the future learning loop
-- can aggregate WHY deals stall (objection / bad timing / wrong person / etc).
--
-- IMPORTANT: `alter type ... add value` cannot run inside the same transaction
-- that later USES the new value. It lives in its own migration file so the
-- value is committed before 0021 (and application code) references it.
-- ─────────────────────────────────────────────────────────────────────────────

ALTER TYPE prospect_status ADD VALUE IF NOT EXISTS 'archived_no_meeting';
