-- 0039 — Attribute audit-tool scans to the pitch that caused them.
--
-- Every S.P.A.M. pitch carries an attribution code in its audit-tool link
-- (&r=, pitches.attribution_code, 0038). runna-hunter now stores it on the
-- scan row (hunter_scans.ref). This trigger turns a matching scan into a
-- pitch_events 'audit_scan' row, and the scan's later contact-form submit
-- (contacted flipped to true by mark_hunter_contacted) into a second one, so
-- "this email made them run the check / ask to talk" is on the pitch's
-- timeline the moment it happens.
--
-- hunter_scans belongs to runna-hunter (shared project). Everything here is
-- additive, and the trigger swallows its own errors: S.P.A.M. bookkeeping must
-- never break a scan insert or the contact flow. SECURITY DEFINER because the
-- inserting role is anon, which cannot write pitch_events. The code space
-- (8 chars from 31) is unguessable, so a forged ref matches nothing.
--
-- Applied to prod 2026-10-17 via the MCP (no DROP statements: the MCP holds
-- destructive statements for a confirmation, see tasks/lessons.md).

alter table public.hunter_scans add column if not exists ref text;
create index if not exists hunter_scans_ref_idx on public.hunter_scans (ref) where ref is not null;
comment on column public.hunter_scans.ref is
  'Attribution code from the link that opened the Hunter (?r=), = pitches.attribution_code in S.P.A.M. Null for organic visits.';

create or replace function public.hunter_scan_to_pitch_event()
returns trigger
language plpgsql
security definer
set search_path = public
as $fn$
declare
  v_pitch uuid;
  v_tenant uuid;
begin
  if new.ref is null then
    return new;
  end if;
  -- On UPDATE only the first flip of contacted counts (the contact form).
  if tg_op = 'UPDATE' and not (new.contacted is true and old.contacted is distinct from true) then
    return new;
  end if;
  select id, tenant_id into v_pitch, v_tenant
  from pitches where attribution_code = new.ref limit 1;
  if v_pitch is null then
    return new;
  end if;
  insert into pitch_events (tenant_id, pitch_id, event_type, payload)
  values (
    v_tenant, v_pitch, 'audit_scan',
    jsonb_build_object(
      'stage', case when tg_op = 'INSERT' then 'scan' else 'contact_request' end,
      'scan_id', new.id,
      'industry', new.industry,
      'team_size', new.team_size,
      'timesink', new.timesink
    )
  );
  return new;
exception when others then
  -- Never break runna-hunter's insert or contact flow over S.P.A.M. bookkeeping.
  raise warning 'hunter_scan_to_pitch_event: %', sqlerrm;
  return new;
end;
$fn$;

create or replace trigger hunter_scans_pitch_event
  after insert or update of contacted on public.hunter_scans
  for each row execute function public.hunter_scan_to_pitch_event();
