-- ─────────────────────────────────────────────────────────────────────────────
-- 0021_reply_funnel_fields.sql
-- Reply Funnel: counters + draft-review columns.
--
-- Flow: prospect replies → Gmail-API poll pulls the reply into `replies` →
-- Claude classifies + drafts a response → Pedro reviews + approves → we send
-- in-thread. Max 3 funnel replies per prospect; then archive with a learning.
-- ─────────────────────────────────────────────────────────────────────────────

-- ── Prospect-level counter + archive learning ────────────────────────────────
-- reply_attempts counts the funnel responses WE have sent to this prospect.
-- The 3-reply cap (book-a-meeting budget) is enforced against this counter.
ALTER TABLE prospects
  ADD COLUMN IF NOT EXISTS reply_attempts    integer     NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS no_meeting_reason text        NULL,
  ADD COLUMN IF NOT EXISTS archived_at       timestamptz NULL;

COMMENT ON COLUMN prospects.reply_attempts    IS 'Count of funnel replies WE have sent to this prospect (max 3 to book a meeting).';
COMMENT ON COLUMN prospects.no_meeting_reason IS 'Captured learning: why the prospect was archived without booking (feeds the learning loop).';
COMMENT ON COLUMN prospects.archived_at       IS 'When the prospect was archived as archived_no_meeting.';

-- ── Reply draft-review columns ───────────────────────────────────────────────
-- auto_draft_body / auto_draft_generated_at already exist (migration 0001).
-- These add the review + send lifecycle around the generated draft.
ALTER TABLE replies
  ADD COLUMN IF NOT EXISTS gmail_rfc_message_id  text        NULL,   -- RFC 2822 Message-ID of THEIR reply (for In-Reply-To threading)
  ADD COLUMN IF NOT EXISTS draft_subject         text        NULL,
  ADD COLUMN IF NOT EXISTS draft_status          text        NULL,   -- pending | approved | sent | skipped
  ADD COLUMN IF NOT EXISTS draft_model           text        NULL,
  ADD COLUMN IF NOT EXISTS draft_cost_usd        numeric(8,4) NULL,
  ADD COLUMN IF NOT EXISTS draft_sent_at         timestamptz NULL,
  ADD COLUMN IF NOT EXISTS draft_gmail_message_id text       NULL,
  ADD COLUMN IF NOT EXISTS draft_thread_id        text       NULL;

COMMENT ON COLUMN replies.draft_status IS 'Lifecycle of the auto-drafted response: pending (awaiting review) | approved | sent | skipped.';

-- Queue index: drafts awaiting Pedro's review, newest first.
CREATE INDEX IF NOT EXISTS idx_replies_draft_pending
  ON replies (tenant_id, received_at DESC)
  WHERE draft_status = 'pending';
