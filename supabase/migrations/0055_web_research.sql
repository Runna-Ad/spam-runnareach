-- 0055 — Web research: what the rest of the web says about a prospect (task web-dive).
--
-- WHY
-- Prod 2026-11-09: CrushCamp, a Calgary fitness studio, was told "I didn't see
-- the viewport setting" and replied a hard no. The claim came from a crawler bug
-- plus a research sentence our AI wrote. Pedro: "whatever we claim we are 100%
-- sure its correct", and "do a deep dive on the web and if we cant find
-- anything other than the website fine but look 1st". So before a prospect's
-- first email, it is looked at twice: its own site (0054, the crawler) and the
-- rest of the web (this table). A web fact is kept only when code can show the
-- page URL and the exact words on it, about THIS business
-- (lib/research/web-dive/keep.ts).
--
-- FLOW
--   The pipeline no longer drafts the first email: a prospect that passes every
--   gate goes to status 'match' (pitch_gate_passed true). /api/research/web-dive
--   (pg_cron below) claims 'match' prospects here, one Claude call with the
--   web_search tool each, and stores one row per dive. The autopilot tick
--   drafts the first email once the site look and this look are finished, or
--   after a day of the dive's schedule ("looks timed out").
--
-- ROWS
--   One per dive. claim_web_research() inserts it as 'pending' (that is the
--   claim). The route updates it to:
--     ok         the search ran and 1+ facts were kept (facts = WebFact[])
--     empty      the search ran and nothing was kept: "we looked and found
--                nothing", cached 60 days like ok
--     failed     error, timeout, pause_turn, unparseable answer, search disabled
--     abandoned  the run was killed before it saved (swept by the next claim)
--   A prospect is retried once after a failed or abandoned dive, on a later run
--   (a row in the last 10 minutes blocks a claim); after 2 in 60 days the tick
--   drafts without web facts (gave up). READERS (webFactsFor) take the newest
--   ok/empty row younger than 60 days and re-validate its facts.
--   dropped = the candidates the keep-check refused, with the reason (debugging).
--
-- SCHEDULE
--   spam-web-dive   3,18,33,48 15-22 * * 1-5   (weekday send window, every 15
--   min, minutes no other job uses: tick :00/:15/:30/:45, poll :05/:15…, send
--   queue :00/:10…, follow-ups :07/:17…, site observe :12/:42).
--   At most 2 dives a run, 25 started per tenant in 24h, and only with $0.50 of
--   the AI cap left. Designed load: 10-24 first drafts a day. Cost: ~$0.21 a
--   dive (Sonnet, 4 searches, measured in weekly fact research) = $2-5 a day
--   once WEB_DIVE_ENABLED=1; $0 while it stays unset (see SHIP ORDER).
--
-- VERCEL CPU (free plan, ~4 h Fluid CPU a month)
--   Before: 0 calls. After: 160 calls a week (32 a weekday × 5).
--   Cold starts: 160 calls/week × ~1 s CPU = ~160 s a week (~11 min a month).
--   A dive waits on Claude (I/O, not CPU); parsing one answer is milliseconds.
--
-- SHIP ORDER: deploy the code FIRST, then apply this migration (as 0054 did).
-- The other way, the job calls a route that does not exist yet (32 wasted cold
-- starts a weekday, a 404 each). Apply this right after the deploy.
-- WEB_DIVE_ENABLED STAYS UNSET (Pedro 2026-11-09: the sample run kept employee
-- reviews, auto-generated summaries and dead job posts; the search is tightened
-- in a later task). Unset, every spam-web-dive call is a no-op: the route
-- answers { ok: true, skipped: "disabled" } inside its heartbeat, with no
-- claim, no Claude call and no cost, and the tick counts the web look as done,
-- so a prospect's first email waits only for its site look (or the timeout).
-- Setting WEB_DIVE_ENABLED=1 in Vercel is that later task's switch.
-- In the gap (new code, no migration): the pipeline writes 'match' and the tick
-- drafts once the site look is done; with the flag set it would also wait for
-- the look timeout (no web_research table to read). OLD CODE IN THE GAP
-- (migration before code): never reads or writes this table, and no prospect
-- is in 'match' for the claim to pick.
--
-- ROLLBACK: select cron.unschedule('spam-web-dive');  (the table and function
-- can stay; nothing else calls them). With the flag set, prospects already in
-- 'match' are then drafted by the tick after the look timeout.

create table if not exists public.web_research (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  prospect_id uuid not null references public.prospects(id) on delete cascade,
  status text not null default 'pending'
    check (status in ('pending', 'ok', 'empty', 'failed', 'abandoned')),
  -- [{ fact, quote, url, title, kind }] (lib/research/web-dive/facts.ts WebFact); [] unless ok.
  facts jsonb not null default '[]'::jsonb,
  -- web_search requests the call made (usage.server_tool_use).
  searches integer not null default 0,
  cost_usd numeric,
  model text,
  error text,
  -- [{ candidate: { fact, quote, url, kind }, reason }]
  dropped jsonb not null default '[]'::jsonb,
  started_at timestamptz not null default now(),
  finished_at timestamptz
);

create index if not exists idx_web_research_latest
  on public.web_research (tenant_id, prospect_id, started_at desc);
-- One claim at a time per prospect.
create unique index if not exists web_research_one_pending
  on public.web_research (prospect_id) where status = 'pending';

alter table public.web_research enable row level security;

-- Tenant users read their own rows; only the service role (the web-dive route) writes.
create policy web_research_tenant_read on public.web_research
  for select
  using (tenant_id = (select tenant_id from public.users where id = auth.uid()));

comment on table public.web_research is
  'One row per web dive about a prospect (lib/research/web-dive): facts from pages other than its own site, '
  'each with the page URL and the exact quote. Written by /api/research/web-dive (service role).';

-- Sweep, then claim up to p_limit prospects waiting for their first email.
-- The status list is DO_NOT_SEND_STATUSES in lib/prospects/status.ts (a test
-- keeps the two lists equal); with status 'match' it can't match, and says so.
create or replace function public.claim_web_research(p_limit integer)
returns table (
  id uuid, tenant_id uuid, prospect_id uuid,
  company_name text, city text, region text, country_code text, domain text, website_url text, industry text
)
language plpgsql
security invoker
set search_path = public
as $$
#variable_conflict use_column
begin
  update public.web_research w
     set status = 'abandoned', finished_at = now(), error = 'run killed before it saved'
   where w.status = 'pending'
     and w.started_at < now() - interval '10 minutes';

  return query
  with due as (
    select p.id as pid, p.tenant_id as tid, p.company_name, p.city, p.region, p.country_code,
           p.domain, p.website_url, p.industry
      from public.prospects p
     where p.status = 'match'
       and p.pitch_gate_passed = true
       and p.status not in ('suppressed', 'archived_no_meeting', 'no_match', 'lost', 'won', 'booked')
       and not exists (
         select 1 from public.web_research w
          where w.tenant_id = p.tenant_id
            and w.prospect_id = p.id
            and w.status in ('ok', 'empty')
            and w.started_at > now() - interval '60 days'
       )
       and (select count(*) from public.web_research w
             where w.tenant_id = p.tenant_id
               and w.prospect_id = p.id
               and w.status in ('failed', 'abandoned')
               and w.started_at > now() - interval '60 days') < 2
       -- A retry waits for a later run.
       and not exists (
         select 1 from public.web_research w
          where w.tenant_id = p.tenant_id
            and w.prospect_id = p.id
            and w.started_at > now() - interval '10 minutes'
       )
       and not exists (
         select 1 from public.pitches pi
          where pi.tenant_id = p.tenant_id
            and pi.prospect_id = p.id
       )
     order by p.updated_at asc
     limit greatest(0, least(p_limit, 10))
       for update of p skip locked
  ),
  ins as (
    insert into public.web_research as wr (tenant_id, prospect_id, status)
    select d.tid, d.pid, 'pending' from due d
    on conflict do nothing
    returning wr.id, wr.tenant_id, wr.prospect_id
  )
  select ins.id, ins.tenant_id, ins.prospect_id,
         d.company_name, d.city, d.region, d.country_code, d.domain, d.website_url, d.industry
    from ins
    join due d on d.pid = ins.prospect_id;
end;
$$;

revoke all on function public.claim_web_research(integer) from public, anon, authenticated;
grant execute on function public.claim_web_research(integer) to service_role;

select cron.schedule('spam-web-dive', '3,18,33,48 15-22 * * 1-5', $job$select public.spam_cron_call('/api/research/web-dive')$job$);
