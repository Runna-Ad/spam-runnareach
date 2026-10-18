-- One-off (2026-10-18): give the autopilot discovery jobs that ran before the
-- worker recorded stats.found_ids the same record, so the scout credits each
-- cell with everything its crawl found (lib/learning/scout.ts scoutCredits).
-- Without it those jobs fall back to prospect_ids: only the last list each job
-- worked through (the pitching phase overwrote it with 2-3 ids on three jobs),
-- 45 of the 119 prospects the six jobs of 2026-10-17 found.
--
-- A job's crawl = its ICP's discovery_runs created between the job's start and
-- its completion. The autopilot runs one job at a time, so for these jobs that
-- is exact; as a guard, a job is only updated when the prospects found that way
-- number exactly stats.new (what the crawl reported inserting).
-- Safe to replay: jobs that already carry found_ids are skipped. Run in the
-- SQL editor; the deployed code ignores the key until this change ships, so
-- before or after the deploy both work.

-- 1) Preview: will_update must be true for every row you expect to change.
with crawl as (
  select j.id as job_id,
         coalesce(array_agg(p.id order by p.created_at, p.id) filter (where p.id is not null), '{}') as found
  from discovery_jobs j
  left join discovery_runs r
    on r.tenant_id = j.tenant_id and r.icp_id = j.icp_id
   and r.created_at >= j.created_at and r.created_at <= coalesce(j.completed_at, now())
  left join prospects p on p.discovery_run_id = r.id
  where j.stats -> 'focus' is not null and not (j.stats ? 'found_ids')
  group by j.id
)
select j.created_at, j.stats -> 'focus' ->> 'cell_key' as cell,
       (j.stats ->> 'new')::int as new, cardinality(c.found) as found,
       coalesce(array_length(j.prospect_ids, 1), 0) as credited_before,
       cardinality(c.found) = (j.stats ->> 'new')::int as will_update
from crawl c join discovery_jobs j on j.id = c.job_id
order by j.created_at;

-- 2) Backfill.
with crawl as (
  select j.id as job_id,
         coalesce(array_agg(p.id order by p.created_at, p.id) filter (where p.id is not null), '{}') as found
  from discovery_jobs j
  left join discovery_runs r
    on r.tenant_id = j.tenant_id and r.icp_id = j.icp_id
   and r.created_at >= j.created_at and r.created_at <= coalesce(j.completed_at, now())
  left join prospects p on p.discovery_run_id = r.id
  where j.stats -> 'focus' is not null and not (j.stats ? 'found_ids')
  group by j.id
)
update discovery_jobs j
set stats = j.stats || jsonb_build_object('found_ids', to_jsonb(c.found))
from crawl c
where j.id = c.job_id
  and cardinality(c.found) = (j.stats ->> 'new')::int;
