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

-- RENUMBERED 0005 -> 0028 and MADE IDEMPOTENT on 2026-07-22.
-- Semantics unchanged; this is bookkeeping only.
--
-- This file was originally 0005, colliding with 0005_case_study_tier.sql.
-- supabase_migrations.schema_migrations is keyed by VERSION, so two files
-- numbered 0005 can never both be recorded: `db push` applied this one's SQL
-- and then died on
--   duplicate key value violates unique constraint "schema_migrations_pkey"
-- which blocked every later migration from ever shipping. Renumbering is the
-- only fix — idempotency alone could not solve it.
--
-- The change itself was applied to prod long ago via the Management API:
-- replies.pitch_id is confirmed nullable there (absent from PostgREST's
-- required list). The statements below are therefore written to be safe to
-- replay, so re-applying under the new number is a no-op. `drop not null` was
-- already idempotent; the constraint needed a guard, because Postgres has no
-- ADD CONSTRAINT IF NOT EXISTS.
--
-- The number no longer reflects when this shipped (it predates 0006-0027).
-- That is deliberate: a truthful, applyable history beats a pretty ordering.

alter table replies
  alter column pitch_id drop not null;

-- Add a CHECK constraint so we don't accidentally lose ALL provenance —
-- a reply must reference at least one of pitch_id / prospect_id /
-- gmail_message_id so we can always trace back to a thing.
do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'replies_has_provenance'
  ) then
    alter table replies
      add constraint replies_has_provenance
      check (pitch_id is not null or prospect_id is not null or gmail_message_id is not null);
  end if;
end $$;
