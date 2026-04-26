-- 0005 — make replies.pitch_id nullable.
--
-- Reasoning: pre-Phase 4 the team enters replies manually (when Pedro
-- gets a forwarded reply or pastes one from his existing inbox so the
-- pipeline state stays accurate). These have no `pitches` row to link
-- to. Once Phase 4's send loop lands, every replied-to email *will*
-- have a pitch_id so this becomes effectively required by the data
-- model — but enforcing it at the schema level today blocks the
-- manual flow.
--
-- Forward-compatible: when sent replies arrive in Phase 4, pitch_id
-- gets populated as before. The `idx_replies_pitch` partial index
-- keeps working for non-null values.

alter table replies
  alter column pitch_id drop not null;

-- Add a CHECK constraint so we don't accidentally lose ALL provenance —
-- a reply must reference at least one of pitch_id / prospect_id /
-- gmail_message_id so we can always trace back to a thing.
alter table replies
  add constraint replies_has_provenance
  check (pitch_id is not null or prospect_id is not null or gmail_message_id is not null);
