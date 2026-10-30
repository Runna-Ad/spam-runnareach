-- 0054 — Site observations: what we SAW on a prospect's website (phase 3 batch 10, task site-crawler).
--
-- WHY
-- The writer had nothing real to point to: research reads a summary paragraph,
-- never the site, so "I checked your site: no way to book" was a guess (prod
-- 2026-10-28: the top critic blocker is claims about the site nobody saw).
-- /api/research/observe (lib/research/site-crawl/) reads each researched
-- prospect's site with plain fetch (home + up to 7 pages), runs deterministic
-- detectors, and stores one row per crawl here. Every check is
-- { found: true | false | null, evidence: [{ url, text | href }] }, where null
-- means "could not see" (a page did not load, or draws its links with
-- JavaScript) and false is written only when every page read was readable.
-- Wave 2 (dossier + writer) reads it; nothing reads it yet.
--
-- ROWS
--   One per crawl. claim_site_observations() inserts it as 'pending' (that is
--   the claim: a second run never picks the same prospect), the route updates
--   it to the outcome. A pending row older than 15 minutes was killed at the
--   route's maxDuration: the next claim marks it 'abandoned' (swept at the
--   START of a run). Any row, abandoned included, counts as "observed": no
--   prospect is crawled twice in 30 days.
--   Newest per prospect: idx (tenant_id, prospect_id, crawled_at desc).
--
-- SCHEDULE
--   spam-site-observe   12,42 15-22 * * 1-5   (weekday send window, every 30 min)
--   Up to 12 prospects per run (SITES_PER_RUN, lib/research/site-crawl/budget.ts),
--   crawls and PageSpeed calls in parallel inside a 60 s route.
--   Designed load: 100 researched prospects a day (MAX_PROSPECTS_PER_DAY) = 700
--   a week, crawled in 5 weekdays = 140 a weekday; capacity 16 runs × 12 = 192
--   a weekday (960 a week), the rest drains the backlog of prospects researched
--   before this shipped.
--
-- VERCEL CPU (free plan, ~4 h Fluid CPU a month)
--   Before: 0 calls. After: 80 calls a week (16 a weekday × 5).
--   Cold starts: 80 calls/week × ~1 s CPU = ~80 s a week (~6 min a month).
--   Crawl + parse: 0.27 s CPU per site on average (median 0.24, max 0.60;
--   measured on the 33-site study in the dev container, 2026-10-30, 8 pages
--   max, 1.5 MB page cap, htmlparser2) × 700 sites a week = ~190 s a week
--   (~14 min a month) at the designed load. Waiting on the sites and on
--   PageSpeed is I/O, not CPU.
--   Total at full load: ~4.5 min a week, ~20 min a month (~8% of the 4 h).
--
-- SHIP ORDER: deploy the code FIRST, then apply this migration. The other way,
-- the job calls a route that does not exist yet (16 wasted cold starts a
-- weekday, a 404 each, no data written). With the code deployed and no
-- migration, nothing calls the route (a hand call answers 500: the claim
-- function is missing). OLD CODE IN THE GAP: never reads or writes this table.
--
-- No change to prospect_research, the tick, research or pitch routes.

create table if not exists public.site_observations (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  prospect_id uuid not null references public.prospects(id) on delete cascade,

  -- The URL we were asked to read (prospects.website_url, else https://domain),
  -- and where the home page landed after redirects.
  url text not null,
  final_url text,

  -- Claim time while pending; crawl start once done.
  crawled_at timestamptz not null default now(),
  crawler_version text not null,

  -- pending      claimed, crawl running
  -- ok           home page read (checks hold real true/false/null values)
  -- unreachable  DNS, timeout, network or HTTP error on the home page
  -- blocked      bot wall (Cloudflare challenge, 429) or robots.txt asks us out
  -- not_html     the URL is not a web page (PDF, image…)
  -- offsite      the home page redirects to another company's domain
  -- abandoned    the run was killed before it saved (swept by the next claim)
  -- Every status but ok stores checks with found = null throughout.
  status text not null default 'pending'
    check (status in ('pending', 'ok', 'unreachable', 'blocked', 'not_html', 'offsite', 'abandoned')),

  -- { html, text, links }: true only when EVERY page read had it.
  readable jsonb not null default '{"html": false, "text": false, "links": false}'::jsonb,
  -- [{ url, role, http_status, title, text_chars, links_seen, readable, error? }]
  pages jsonb not null default '[]'::jsonb,
  -- { booking: { found, kind, evidence }, ecommerce, chat, contact_form, tel, mailto, social,
  --   mobile_viewport, jsonld, jsonld_opening_hours, jsonld_rating, copyright_year, builder,
  --   languages, analytics }  (types: lib/research/site-crawl/types.ts SiteChecks)
  checks jsonb not null default '{}'::jsonb,

  -- PageSpeed Insights (mobile): { scores: {performance, seo, accessibility,
  -- best_practices}, lcp_ms, cls, tbt_ms, third_party_domains, final_url, fetched_at },
  -- or { error } when psi_status is timeout / error. Null when no_key / skipped.
  psi jsonb,
  psi_status text check (psi_status in ('ok', 'no_key', 'timeout', 'error', 'skipped')),

  duration_ms integer,
  created_at timestamptz not null default now()
);

create index if not exists idx_site_observations_latest
  on public.site_observations (tenant_id, prospect_id, crawled_at desc);
-- One claim at a time per prospect.
create unique index if not exists site_observations_one_pending
  on public.site_observations (prospect_id) where status = 'pending';

alter table public.site_observations enable row level security;

-- Tenant users read their own rows; only the service role (the observe route) writes.
create policy site_observations_tenant_read on public.site_observations
  for select
  using (tenant_id = (select tenant_id from public.users where id = auth.uid()));

comment on table public.site_observations is
  'One row per crawl of a prospect website (lib/research/site-crawl): checked facts with evidence, '
  'found=null when the page could not be seen. Written by /api/research/observe (service role).';

-- Sweep, then claim up to p_limit researched prospects with a website and no
-- observation in the last 30 days, newest-researched first. Researched = deep
-- research ran (research_method 'claude_assisted', lib/research/deep-research-stage.ts).
-- Prospects we may not email are skipped: the statuses are DO_NOT_SEND_STATUSES
-- in lib/prospects/status.ts (a test keeps the two lists equal).
create or replace function public.claim_site_observations(p_limit integer, p_crawler_version text)
returns table (id uuid, tenant_id uuid, prospect_id uuid, url text)
language plpgsql
security invoker
set search_path = public
as $$
#variable_conflict use_column
begin
  update public.site_observations o
     set status = 'abandoned'
   where o.status = 'pending'
     and o.crawled_at < now() - interval '15 minutes';

  return query
  with due as (
    select pr.tenant_id, pr.prospect_id,
           coalesce(nullif(btrim(p.website_url), ''), 'https://' || btrim(p.domain)) as url,
           pr.last_scraped_at
      from public.prospect_research pr
      join public.prospects p on p.id = pr.prospect_id and p.tenant_id = pr.tenant_id
     where pr.research_method = 'claude_assisted'
       and pr.last_scraped_at is not null
       and (nullif(btrim(p.website_url), '') is not null or nullif(btrim(p.domain), '') is not null)
       and p.status not in ('suppressed', 'archived_no_meeting', 'no_match', 'lost', 'won', 'booked')
       and not exists (
         select 1 from public.site_observations o
          where o.tenant_id = pr.tenant_id
            and o.prospect_id = pr.prospect_id
            and o.crawled_at > now() - interval '30 days'
       )
     order by pr.last_scraped_at desc
     limit greatest(0, least(p_limit, 50))
       for update of pr skip locked
  )
  insert into public.site_observations as so (tenant_id, prospect_id, url, crawler_version, status)
  select d.tenant_id, d.prospect_id, d.url, p_crawler_version, 'pending' from due d
  on conflict do nothing
  returning so.id, so.tenant_id, so.prospect_id, so.url;
end;
$$;

revoke all on function public.claim_site_observations(integer, text) from public, anon, authenticated;
grant execute on function public.claim_site_observations(integer, text) to service_role;

select cron.schedule('spam-site-observe', '12,42 15-22 * * 1-5', $job$select public.spam_cron_call('/api/research/observe')$job$);
