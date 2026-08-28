-- ============================================================================
-- Migration 0033 — prompt_purpose: add generic pitch purposes
--
-- SPLIT FROM the original 0004_pitch_improvements draft on purpose.
-- Postgres forbids USING a newly added enum value in the same transaction that
-- added it. The original single-file version added these values and then
-- INSERTed prompts referencing them, which fails with
--   "unsafe use of new value ... of enum type prompt_purpose".
-- Keeping the ADD VALUEs in their own migration commits them first, so 0034
-- can reference them safely.
-- ============================================================================

alter type prompt_purpose add value if not exists 'pitch_en_generic';
alter type prompt_purpose add value if not exists 'pitch_es_generic';
