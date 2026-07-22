-- Sourced benchmark library.
--
-- WHY THIS EXISTS
-- The composer was inventing statistics ("casino properties that differentiate
-- see 20-30% lifts in first-time visit intent") because the prompt literally
-- instructed it to: "Use industry BENCHMARKS for any numbers" and "Cite a real
-- benchmark when you're confident it's accurate". Confidence is not a source.
-- Those instructions are gone. This table is where real numbers live instead.
--
-- THE RULE THAT MAKES THIS WORTH BUILDING
-- source_url is NOT NULL. A benchmark table without a citation on every row is
-- the same fabrication laundered through a database — worse, because it then
-- looks authoritative and nobody re-checks it. If we cannot cite it, we do not
-- store it, and the pitch simply goes out without a number.
--
-- HOW IT IS USED (Pedro's framing, 2026-07-22)
-- A case study says "we got X a 47% lift" — about us, reads as bragging, and
-- his campaigns show that underperforms. A benchmark says "businesses like you
-- lose Z at this step" — about THEM, reads as diagnosis. Same number, opposite
-- job. These size the PROSPECT's problem in the pain line; they never prove
-- Runna's competence.
--
-- Matched on pain AND industry. A DTC cart-abandonment figure quoted at a
-- construction firm is the same non-sequitur the composer already bans for
-- case studies, so industry_scope is part of the match, not decoration.

create table if not exists public.benchmarks (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,

  -- The claim, written as it would be quoted in an email. One sentence,
  -- diagnostic voice ("roughly 7 in 10 online carts are abandoned before
  -- checkout"), not promotional.
  statistic text not null,
  -- The bare figure for the send-gate to match against the body ("70%").
  figure text not null,

  -- Which pains this can be cited for. References pain_taxonomy.code (not id)
  -- so seeds stay readable and survive a taxonomy re-key.
  pain_codes text[] not null default '{}',
  -- Industries this legitimately applies to. Empty = universal, which should
  -- be RARE and deliberate — most benchmarks are scoped.
  industry_scope text[] not null default '{}',
  -- 'CA' | 'MX' | 'US' | 'GLOBAL'. Null means unscoped by geography.
  market text,

  -- ── Provenance. The whole point of the table. ───────────────────────────
  source_url text not null,
  publisher text not null,
  published_date date,
  -- Vendor platform data (Klaviyo, Omnisend, Rival IQ) is usable but must be
  -- labelled, because self-selected platform populations are not the market.
  is_vendor_sourced boolean not null default false,
  -- Anything a human should know before quoting it: sample size, geography,
  -- age, self-selection. Surfaced in the admin UI next to the row.
  caveat text,

  -- ── Human approval. Nothing is quotable until Pedro says so. ────────────
  verified_by uuid references public.users(id) on delete set null,
  verified_at timestamptz,
  is_active boolean not null default false,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- A row may only be active once a human has verified it.
alter table public.benchmarks
  add constraint benchmarks_active_requires_verification
  check (is_active = false or verified_at is not null);

create index if not exists idx_benchmarks_tenant_active
  on public.benchmarks (tenant_id, is_active);
create index if not exists idx_benchmarks_pain_codes
  on public.benchmarks using gin (pain_codes);
create index if not exists idx_benchmarks_industry_scope
  on public.benchmarks using gin (industry_scope);

alter table public.benchmarks enable row level security;

-- Matches the tenant-isolation pattern used by every other table here
-- (see 0023_discovery_jobs.sql): scope on public.users, and repeat the
-- predicate in `with check` so a write cannot move a row to another tenant.
create policy benchmarks_tenant_rw on public.benchmarks
  for all
  using (
    tenant_id = (select tenant_id from public.users where id = auth.uid())
  )
  with check (
    tenant_id = (select tenant_id from public.users where id = auth.uid())
  );

comment on table public.benchmarks is
  'Verified third-party benchmarks the pitch composer may cite. source_url is '
  'mandatory: an uncited benchmark is a fabricated one. Rows are inert until a '
  'human sets verified_at and is_active.';
