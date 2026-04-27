-- 0006 — make pitches.case_study_id nullable.
--
-- Reasoning: when the heuristic AND Claude can't find a case study that
-- genuinely addresses the prospect's pain (e.g. tag table is sparse, or
-- no case actually fits the pain shape), we want to ship a pitch
-- WITHOUT a fake "we helped X" bridge. Better to omit a weak case than
-- fabricate a strong-looking one.
--
-- The original NOT NULL was a "schema-level guarantee that every pitch
-- cites a case study" — but in practice that pushed the generator to
-- pick the least-bad option even when none fit. The new contract is
-- enforced at the application layer: if case_study_id is set, the body
-- must reference it; if null, the body must NOT name any client.

alter table pitches
  alter column case_study_id drop not null;
