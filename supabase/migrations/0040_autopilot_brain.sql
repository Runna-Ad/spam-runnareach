-- 0040 — The autopilot's memory: arms, insights, autonomy stage, pitch lanes.
--
-- learning_arms      Every option a learner chooses between (writer angles and
--                    subject styles, scout search cells, send windows), with
--                    its running reward and status. Champion / challenger /
--                    retired is decided by lib/learning/bandit.ts reviewArms.
--                    origin says who created it: seed, the learner itself
--                    (a challenger it proposed), or a person.
-- learning_insights  Append-only log of what the system learned and every
--                    autonomous change it made (promotions, retirements, new
--                    challengers, breaker trips, stage changes), each with the
--                    evidence. Nothing changes without a row here.
-- autonomy_state     Per tenant: the autopilot stage (off → shadow → veto →
--                    auto, lib/autopilot/governor.ts), when it entered it, the
--                    metrics behind the last decision, and the kill switch.
-- pitches.autopilot_lane / _reasons
--                    The governor's AUTO / REVIEW / DROP label. Mutable (the
--                    decision record stays immutable): in shadow it is only a
--                    label, measured against what a person decides.
--
-- All additive. S.P.A.M.-only tables. RLS: tenant isolation for signed-in
-- users; the autopilot uses the service role.

create table if not exists public.learning_arms (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  learner text not null,           -- 'writer.angle', 'writer.subject', 'scout.cell', 'send.window', ...
  key text not null,
  config jsonb not null default '{}'::jsonb,
  status text not null default 'challenger' check (status in ('champion', 'challenger', 'retired')),
  origin text not null default 'seed' check (origin in ('seed', 'learner', 'human')),
  parent_key text,
  reward double precision not null default 0,
  trials integer not null default 0,
  negatives integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  retired_at timestamptz,
  unique (tenant_id, learner, key)
);

create index if not exists learning_arms_active_idx
  on public.learning_arms (tenant_id, learner)
  where status <> 'retired';

create table if not exists public.learning_insights (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  learner text not null,
  kind text not null check (kind in ('promote', 'retire', 'challenger', 'observation', 'breaker', 'stage', 'proposal')),
  title text not null,
  detail text,
  evidence jsonb not null default '{}'::jsonb,
  applied boolean not null default false,
  created_at timestamptz not null default now()
);

create index if not exists learning_insights_recent_idx
  on public.learning_insights (tenant_id, created_at desc);

create table if not exists public.autonomy_state (
  tenant_id uuid primary key references public.tenants(id) on delete cascade,
  stage text not null default 'off' check (stage in ('off', 'shadow', 'veto', 'auto')),
  stage_since timestamptz not null default now(),
  metrics jsonb not null default '{}'::jsonb,
  reason text,
  -- Kill switch: when false the autopilot does nothing, whatever the stage.
  enabled boolean not null default false,
  updated_at timestamptz not null default now()
);

alter table public.pitches
  add column if not exists autopilot_lane text check (autopilot_lane in ('auto', 'review', 'drop')),
  add column if not exists autopilot_reasons text[];

comment on column public.pitches.autopilot_lane is
  'Governor label: auto | review | drop (lib/autopilot/governor.ts laneFor). In shadow stage a label only.';

alter table public.learning_arms enable row level security;
alter table public.learning_insights enable row level security;
alter table public.autonomy_state enable row level security;

create policy learning_arms_tenant on public.learning_arms
  for all to authenticated
  using (tenant_id = current_tenant_id()) with check (tenant_id = current_tenant_id());
create policy learning_insights_tenant on public.learning_insights
  for all to authenticated
  using (tenant_id = current_tenant_id()) with check (tenant_id = current_tenant_id());
create policy autonomy_state_tenant on public.autonomy_state
  for all to authenticated
  using (tenant_id = current_tenant_id()) with check (tenant_id = current_tenant_id());

revoke all on public.learning_arms, public.learning_insights, public.autonomy_state from anon;
