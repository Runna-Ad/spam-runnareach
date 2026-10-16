-- 0036 — Gate v2: store the send gate's verdict on each pitch, plus any
-- "approve anyway" a person gave for review-level flags.
--
-- gate_verdict  {version, pass, checked_at, failures:[{code, severity, detail}]}
--               Recomputed on generate, rewrite, edit, approve and at send time;
--               always describes the CURRENT subject/body.
-- gate_override {by, at, codes[]}
--               Review-level gate codes a person read and accepted when
--               approving. Block-level codes can never be overridden, and an
--               edit or rewrite clears the override (it accepted old text).
--
-- Nullable, no default, no backfill: a NULL verdict means "not checked yet",
-- and every approve/send path re-checks before acting, so old rows are safe.
-- pitches is S.P.A.M.-only (runna-hunter never reads it).

alter table public.pitches
  add column if not exists gate_verdict jsonb,
  add column if not exists gate_override jsonb;

comment on column public.pitches.gate_verdict is
  'Send gate v2 verdict for the current subject/body: {version, pass, checked_at, failures[{code,severity,detail}]}.';
comment on column public.pitches.gate_override is
  'Human approve-anyway for review-level gate codes: {by, at, codes[]}. Never covers block-level codes; cleared on edit.';
