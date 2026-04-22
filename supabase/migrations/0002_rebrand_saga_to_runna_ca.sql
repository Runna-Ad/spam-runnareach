-- ============================================================================
-- Migration 0002 — Rebrand SAGA → Runna CA
--
-- The Canadian arm of Rünna uses the public name "Runna CA" (not "SAGA").
-- This migration renames the enum value that 0001 created, renames the tenant
-- code + display name, and scrubs any seeded prompt copy that hardcoded SAGA.
--
-- Safe whether seed.sql has been run or not — all statements are idempotent.
-- ============================================================================

-- Rename the enum value. Existing rows referencing 'SAGA' are atomically updated.
alter type brand_code rename value 'SAGA' to 'RUNNA_CA';

-- Update tenant code + display name (no-op if seed.sql hasn't been run)
update tenants
   set code = 'RUNNA_CA',
       display_name = 'Runna CA'
 where code = 'SAGA_CA';

-- Update brand_instances display name for the newly-renamed enum value
update brand_instances
   set display_name = 'Runna CA',
       website_url = 'https://runna.agency'
 where code = 'RUNNA_CA';

-- Scrub any prompt copy that hardcoded SAGA in system prompts or user-prompt templates
update prompt_variants
   set system_prompt = replace(system_prompt, 'SAGA', 'Runna CA')
 where system_prompt like '%SAGA%';

update prompt_variants
   set user_prompt_template = replace(user_prompt_template, 'SAGA', 'Runna CA')
 where user_prompt_template like '%SAGA%';

update prompts
   set description = replace(description, 'SAGA', 'Runna CA')
 where description like '%SAGA%';
