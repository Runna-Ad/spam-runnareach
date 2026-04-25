-- ============================================================================
-- Migration 0004 — prospect_research
--
-- 1:1 table that stores everything we know about a prospect from research.
-- Initially populated by hand via the /companies/[id] UI; later by the site
-- scraper (Slice "Site scraper") and ultimately by Claude (Phase 2). The same
-- table accepts all three sources via the `research_method` column.
--
-- Why a separate table (not JSONB on prospects):
--   1. Research grows over time and gets re-run — keeping it joined lets us
--      version it later without bloating the prospects row.
--   2. RLS + audit are cleaner per-table.
--   3. Phase 2's research_quality_score gate writes back to prospects, so
--      keeping the heavy text out of prospects keeps that path fast.
-- ============================================================================

create table if not exists prospect_research (
  id                 uuid primary key default gen_random_uuid(),
  tenant_id          uuid not null references tenants(id) on delete cascade,
  prospect_id        uuid not null references prospects(id) on delete cascade,

  -- What we learned
  what_they_do       text,
  tech_stack         text[] not null default '{}',
  pain_points        jsonb not null default '[]'::jsonb,  -- [{pain_id, evidence_quote, evidence_url, confidence}]
  notes              text,                                 -- free-form for the human researcher

  -- Where it came from
  research_method    text not null default 'manual',       -- 'manual' | 'scraped' | 'claude_assisted'
  evidence_urls      text[] not null default '{}',
  raw_html_snapshot_url text,                              -- pointer to Storage when scraper lands
  last_scraped_at    timestamptz,

  -- Audit
  last_edited_by_user_id uuid references users(id),
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),

  -- One research row per prospect.
  unique (tenant_id, prospect_id)
);

create index if not exists idx_prospect_research_prospect on prospect_research(prospect_id);
create index if not exists idx_prospect_research_tenant on prospect_research(tenant_id);

-- RLS — same pattern as the rest of the app: users can only see/edit research
-- in their own tenant. Service-role bypasses for cron + scraper jobs.
alter table prospect_research enable row level security;

drop policy if exists "tenant_isolation_select" on prospect_research;
create policy "tenant_isolation_select"
  on prospect_research for select
  using (
    tenant_id = (
      select tenant_id from public.users where id = auth.uid()
    )
  );

drop policy if exists "tenant_isolation_insert" on prospect_research;
create policy "tenant_isolation_insert"
  on prospect_research for insert
  with check (
    tenant_id = (
      select tenant_id from public.users where id = auth.uid()
    )
  );

drop policy if exists "tenant_isolation_update" on prospect_research;
create policy "tenant_isolation_update"
  on prospect_research for update
  using (
    tenant_id = (
      select tenant_id from public.users where id = auth.uid()
    )
  );

drop policy if exists "tenant_isolation_delete" on prospect_research;
create policy "tenant_isolation_delete"
  on prospect_research for delete
  using (
    tenant_id = (
      select tenant_id from public.users where id = auth.uid()
    )
  );

-- updated_at trigger — auto-bumps on any update so the UI can show "edited 5m ago".
create or replace function bump_prospect_research_updated_at()
  returns trigger as $$
begin
  new.updated_at = now();
  return new;
end;
$$ language plpgsql;

drop trigger if exists prospect_research_updated_at on prospect_research;
create trigger prospect_research_updated_at
  before update on prospect_research
  for each row execute function bump_prospect_research_updated_at();
