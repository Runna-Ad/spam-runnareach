-- ============================================================================
-- Migration 0002 — Rebrand to Runna CA
--
-- The Canadian arm of Rünna uses the public name "Runna CA".
--
-- This migration is IDEMPOTENT. It handles any prior state:
--   - Fresh 0001 (enum is 'SAGA', 'RUNNA')
--   - An intermediate rebrand to 'RUNNIK' (draft that briefly landed)
--   - Already-final state (enum is 'RUNNA_CA', 'RUNNA')
-- Safe to run any number of times.
-- ============================================================================

-- Rename the enum value to 'RUNNA_CA' if it's still in a prior state.
do $$
begin
  if exists (
    select 1 from pg_type t
      join pg_enum e on e.enumtypid = t.oid
     where t.typname = 'brand_code' and e.enumlabel = 'SAGA'
  ) then
    alter type brand_code rename value 'SAGA' to 'RUNNA_CA';
  end if;

  if exists (
    select 1 from pg_type t
      join pg_enum e on e.enumtypid = t.oid
     where t.typname = 'brand_code' and e.enumlabel = 'RUNNIK'
  ) then
    alter type brand_code rename value 'RUNNIK' to 'RUNNA_CA';
  end if;
end $$;

-- Normalize tenant code + display from any prior state
update tenants
   set code = 'RUNNA_CA',
       display_name = 'Runna CA'
 where code in ('SAGA_CA', 'RUNNIK_CA');

-- Normalize brand_instances display + website
update brand_instances
   set display_name = 'Runna CA',
       website_url = 'https://runna.agency'
 where code = 'RUNNA_CA';

-- Scrub any stale prompt copy (SAGA or Runnik) from system prompts
update prompt_variants
   set system_prompt = replace(replace(system_prompt, 'SAGA', 'Runna CA'), 'Runnik', 'Runna CA')
 where system_prompt like '%SAGA%' or system_prompt like '%Runnik%';

update prompt_variants
   set user_prompt_template = replace(replace(user_prompt_template, 'SAGA', 'Runna CA'), 'Runnik', 'Runna CA')
 where user_prompt_template like '%SAGA%' or user_prompt_template like '%Runnik%';

update prompts
   set description = replace(replace(description, 'SAGA', 'Runna CA'), 'Runnik', 'Runna CA')
 where description like '%SAGA%' or description like '%Runnik%';
