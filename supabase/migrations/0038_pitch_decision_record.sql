-- 0038 — Decision record per pitch, pitch events, verifier verdicts on contacts.
--
-- Phase 1 of the audit ("make good measurable"): nothing recorded which prompt
-- wrote which email, whether it quoted a statistic, what the AI reviewer
-- thought of it, or what happened after it was sent. Without that, no outcome
-- can ever be traced back to a choice, and nothing can be learned.
--
-- pitches.decision          Immutable JSONB written once at generation: path,
--                           prompt version, model, fallback reason, language,
--                           register, segment, pain, benchmarks offered and
--                           cited, attribution code, recipient type, AI review
--                           verdict, gate verdict at generation. A trigger
--                           refuses to change it once set.
-- pitches.attribution_code  Short code appended to the audit-tool link (&r=),
--                           so a scan can be tied to the email that caused it
--                           (runna-hunter must store the parameter for that).
-- pitch_events              Existing, never-written table. New event types for
--                           the whole lifecycle; one row per generate /
--                           approve / gate hold / send / reply / bounce /
--                           unsubscribe, append-only.
-- prospect_contacts.verify_* The last SPAM Verify verdict per address, so a
--                           contact's trust is visible without re-running it.
--
-- All additive and nullable. pitches / pitch_events / prospect_contacts are
-- S.P.A.M.-only tables (runna-hunter never reads them).

alter table public.pitches
  add column if not exists decision jsonb,
  add column if not exists attribution_code text;

create unique index if not exists pitches_attribution_code_key
  on public.pitches (attribution_code)
  where attribution_code is not null;

comment on column public.pitches.decision is
  'Immutable generation record: {v, path, prompt_version, model, fallback_reason, lang, register, segment, pain, benchmarks_offered, benchmark_cited, attribution_code, recipient, critic, gate}. Write once.';
comment on column public.pitches.attribution_code is
  'Short code carried in the audit-tool link (&r=) to attribute scans to this pitch.';

create or replace function public.pitches_decision_write_once()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if old.decision is not null and new.decision is distinct from old.decision then
    raise exception 'pitches.decision is immutable once written (pitch %)', old.id;
  end if;
  return new;
end;
$$;

drop trigger if exists pitches_decision_write_once on public.pitches;
create trigger pitches_decision_write_once
  before update of decision on public.pitches
  for each row execute function public.pitches_decision_write_once();

alter type public.pitch_event_type add value if not exists 'generated';
alter type public.pitch_event_type add value if not exists 'approved';
alter type public.pitch_event_type add value if not exists 'gate_held';
alter type public.pitch_event_type add value if not exists 'audit_scan';

alter table public.prospect_contacts
  add column if not exists verify_verdict text,
  add column if not exists verify_reasons text[],
  add column if not exists verify_checked_at timestamptz;

comment on column public.prospect_contacts.verify_verdict is
  'Last SPAM Verify verdict for this address: send | review | drop.';
