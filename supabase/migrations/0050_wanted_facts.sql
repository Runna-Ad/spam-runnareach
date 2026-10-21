-- 0050 — "Wanted facts" loop (phase 3 batch 7, Pedro 2026-10-21).
--
-- WHY
-- The writer may only cite a statistic from public.benchmarks (0029). When it
-- wants a number the library lacks, today that wish is lost (or, worse, the
-- critic holds an invented figure). This records the wish so a weekly research
-- step can look for a solid source, and Pedro decides before anything goes live.
--
-- FLOW
--   writer / critic / Pedro  -> record_wanted_fact()  -> wanted_facts (open)
--   weekly research (pg_cron Wed 14:20 UTC, /api/benchmarks/research)
--        -> proposes benchmarks rows: is_active = false, verified_at = null,
--           wanted_fact_id set, proposed_at set   -> wanted_facts.status = 'proposed'
--        -> or finds nothing solid                -> status = 'no_source'
--   Pedro on /benchmarks -> approves (setBenchmarkActive stamps verified_by/at)
--        or rejects (rejected_at set, row kept so it is never re-proposed). The 0029 CHECK (is_active = false or verified_at is not null)
--        keeps "nothing activates unseen" true at the database level.
--
-- OLD CODE IN THE GAP (migration applied before the deploy): nothing reads or
-- writes these columns/table yet. The cron fires weekly; until the route ships it
-- gets a 404 from Vercel (logged in net._http_response, no side effects).

create table if not exists public.wanted_facts (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,

  -- The fact wanted, in plain words ("share of small online stores with no
  -- abandoned-cart email"). Never a number: the number is what we lack.
  fact text not null check (length(btrim(fact)) between 8 and 300),
  -- Dedupe key: lower-case, punctuation folded to spaces, spaces collapsed.
  -- Computed by record_wanted_fact(); callers never write it.
  fact_key text not null,
  -- pain_taxonomy.code (not id), like benchmarks.pain_codes. Null = not tied to a pain.
  pain_code text,
  -- Segment that asked (the prospect's industry / market at request time).
  industry text,
  market text,

  -- Who asked first. Later requests only bump the counters.
  source text not null check (source in ('writer', 'critic', 'manual')),
  request_count integer not null default 1 check (request_count >= 1),
  last_pitch_id uuid references public.pitches(id) on delete set null,
  first_requested_at timestamptz not null default now(),
  last_requested_at timestamptz not null default now(),

  -- open      -> waiting for research
  -- proposed  -> research inserted >= 1 inactive benchmark row for it
  -- no_source -> research found nothing solid (retried after 30 days by the research step)
  -- dismissed -> Pedro said not worth looking for
  status text not null default 'open'
    check (status in ('open', 'proposed', 'no_source', 'dismissed')),
  researched_at timestamptz,
  research_note text,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index if not exists wanted_facts_tenant_key_pain
  on public.wanted_facts (tenant_id, fact_key, coalesce(pain_code, ''));
create index if not exists wanted_facts_tenant_status
  on public.wanted_facts (tenant_id, status, request_count desc);

create trigger set_updated_at_wanted_facts
  before update on public.wanted_facts
  for each row execute function set_updated_at();

alter table public.wanted_facts enable row level security;

create policy wanted_facts_tenant_rw on public.wanted_facts
  for all
  using (tenant_id = (select tenant_id from public.users where id = auth.uid()))
  with check (tenant_id = (select tenant_id from public.users where id = auth.uid()));

comment on table public.wanted_facts is
  'Facts the pitch writer/critic (or Pedro) wanted but the benchmark library lacks. '
  'The weekly research step proposes sourced, INACTIVE benchmarks for them; a human activates.';

-- One call per request. Security INVOKER: RLS applies to a logged-in caller;
-- the service-role client (crons, autopilot) bypasses RLS and passes the tenant.
-- Never throws on a duplicate: bumps request_count / last_requested_at /
-- last_pitch_id instead. Status is left alone (a dismissed fact stays dismissed).
create or replace function public.record_wanted_fact(
  p_tenant_id uuid,
  p_fact text,
  p_source text,
  p_pain_code text default null,
  p_industry text default null,
  p_market text default null,
  p_pitch_id uuid default null
) returns uuid
language sql
security invoker
set search_path = public
as $$
  insert into public.wanted_facts as w
    (tenant_id, fact, fact_key, pain_code, industry, market, source, last_pitch_id)
  values (
    p_tenant_id,
    btrim(p_fact),
    btrim(regexp_replace(regexp_replace(lower(p_fact), '[^[:alnum:]]+', ' ', 'g'), '\s+', ' ', 'g')),
    nullif(btrim(p_pain_code), ''),
    nullif(btrim(p_industry), ''),
    nullif(btrim(p_market), ''),
    p_source,
    p_pitch_id
  )
  on conflict (tenant_id, fact_key, coalesce(pain_code, '')) do update
    set request_count = w.request_count + 1,
        last_requested_at = now(),
        last_pitch_id = coalesce(excluded.last_pitch_id, w.last_pitch_id)
  returning w.id;
$$;

-- Proposal provenance on the benchmark rows the research step inserts.
alter table public.benchmarks
  add column if not exists wanted_fact_id uuid references public.wanted_facts(id) on delete set null,
  add column if not exists proposed_at timestamptz,
  -- Why the research step thinks the source is solid, and the sentence it read
  -- the figure from. For Pedro's review only; never sent to the writer.
  add column if not exists proposal_note text,
  -- Pedro rejected this proposal on /benchmarks. Kept (not deleted) so the
  -- research step never proposes the same source + figure again.
  add column if not exists rejected_at timestamptz;

-- A rejected row can never be live.
alter table public.benchmarks
  add constraint benchmarks_rejected_not_active
  check (rejected_at is null or is_active = false);

create index if not exists idx_benchmarks_wanted_fact
  on public.benchmarks (wanted_fact_id) where wanted_fact_id is not null;

-- Weekly research. Wednesday 14:20 UTC (08:20 Mexico City), mid-week so a Monday
-- report and a Tuesday review never share the budget. Uses 0041's helper.
select cron.schedule('spam-fact-research', '20 14 * * 3', $job$select public.spam_cron_call('/api/benchmarks/research')$job$);
