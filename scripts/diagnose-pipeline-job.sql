-- Diagnose the last "Run pipeline" jobs (/companies bulk action).
-- Shows what the worker ACTUALLY did — the UI summary was hiding failures.

select
  created_at,
  status,                                   -- running | done | failed | cancelled
  phase,                                    -- pipeline | pruning
  cursor,                                   -- how many of the selected it got through
  coalesce(array_length(prospect_ids, 1), 0) as selected_count,
  error_message,                            -- set when the JOB failed outright
  stats->>'pitched'      as pitched,
  stats->>'needs_review' as needs_review,
  stats->>'suppressed'   as suppressed,
  stats->>'error_count'  as errored,        -- per-prospect failures (was hidden in the UI)
  stats->'errors'        as error_messages, -- only populated after the new deploy
  heartbeat_at
from discovery_jobs
order by created_at desc
limit 5;

-- What actually happened to those prospects (did they move, or stay b_list?)
select status, count(*), max(updated_at) as last_touched
from prospects
where updated_at > now() - interval '2 hours'
group by status
order by count(*) desc;
