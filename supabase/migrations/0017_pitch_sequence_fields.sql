-- ─────────────────────────────────────────────────────────────────────────────
-- 0017_pitch_sequence_fields.sql
-- Add follow-up sequence tracking to the pitches table.
--
-- sequence_step:      1 = initial pitch, 2 = follow-up 1, 3 = follow-up 2 (final)
-- next_followup_at:   when the next follow-up should fire (null = no more follow-ups)
-- sequence_paused_at: set when a reply is received — stops the sequence
-- ─────────────────────────────────────────────────────────────────────────────

ALTER TABLE pitches
  ADD COLUMN IF NOT EXISTS sequence_step       integer     NOT NULL DEFAULT 1,
  ADD COLUMN IF NOT EXISTS next_followup_at    timestamptz NULL,
  ADD COLUMN IF NOT EXISTS sequence_paused_at  timestamptz NULL;

-- Backfill existing sent pitches: mark them as step 1 with no follow-up scheduled
-- (they predate the sequence system — don't auto-send follow-ups retroactively)
UPDATE pitches
SET    sequence_step = 1,
       next_followup_at = NULL
WHERE  status = 'sent'
AND    sequence_step = 1;

-- Index for the follow-up cron: find pitches due for follow-up
CREATE INDEX IF NOT EXISTS idx_pitches_followup_due
  ON pitches (next_followup_at)
  WHERE status = 'sent'
    AND sequence_paused_at IS NULL
    AND next_followup_at IS NOT NULL;

COMMENT ON COLUMN pitches.sequence_step      IS '1=initial pitch, 2=follow-up 1, 3=follow-up 2 (final)';
COMMENT ON COLUMN pitches.next_followup_at   IS 'When the next follow-up should be sent. NULL = sequence complete.';
COMMENT ON COLUMN pitches.sequence_paused_at IS 'Set when a reply is received. Stops follow-up sequence.';
