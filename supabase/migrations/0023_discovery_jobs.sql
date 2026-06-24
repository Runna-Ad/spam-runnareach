-- 0023_discovery_jobs.sql
-- Background discovery jobs — server-orchestrated "Run All Sources" that
-- survives the browser tab closing. A job is driven by a self-chaining worker
-- route (/api/discover/run): each invocation does one bounded slice (discovery,
-- a pipeline batch, or the prune), advances `cursor`, updates `stats`, bumps
-- `heartbeat_at`, then re-triggers the next slice. The Stop button sets
-- status='cancelled'; the next slice's guard halts the chain. A daily janitor
-- cron fails jobs whose heartbeat has gone stale (worker crash / lost chain).

create table if not exists public.discovery_jobs (
  id            uuid primary key default gen_random_uuid(),
  tenant_id     uuid not null references public.tenants(id) on delete cascade,
  icp_id        uuid references public.icps(id) on delete set null,
  created_by    uuid references public.users(id) on delete set null,

  -- running | cancelled | done | failed
  status        text not null default 'running',
  -- discovering | pipeline | pruning
  phase         text not null default 'discovering',

  -- pipeline cursor: index into prospect_ids of the next unprocessed prospect
  cursor        integer not null default 0,
  prospect_ids  uuid[] not null default '{}',

  -- aggregate counters + per-outcome tallies + non-fatal errors (jsonb)
  stats         jsonb not null default '{}'::jsonb,
  error_message text,

  heartbeat_at  timestamptz not null default now(),
  created_at    timestamptz not null default now(),
  completed_at  timestamptz
);

-- Look up the active job for an ICP (resume-on-reopen) and the janitor's
-- stale-running sweep both filter by status; index it.
create index if not exists discovery_jobs_tenant_status_idx
  on public.discovery_jobs (tenant_id, status, created_at desc);

create index if not exists discovery_jobs_icp_status_idx
  on public.discovery_jobs (icp_id, status);

-- RLS: same-tenant isolation (mirrors prospect_research / discovery_runs). The
-- worker authenticates as the user (forwarded session cookie → auth.uid()), so
-- user-scoped RLS applies to it too; the janitor cron uses the service-role key
-- which bypasses RLS.
alter table public.discovery_jobs enable row level security;

drop policy if exists discovery_jobs_tenant_rw on public.discovery_jobs;
create policy discovery_jobs_tenant_rw on public.discovery_jobs
  for all
  using (
    tenant_id = (select tenant_id from public.users where id = auth.uid())
  )
  with check (
    tenant_id = (select tenant_id from public.users where id = auth.uid())
  );
