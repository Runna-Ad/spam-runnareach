-- 0042: delete the test-era data (Pedro, 2026-10-17: everything before the
-- autopilot was testing; no value in keeping it or reviewing it).
--
-- Cutoff: the first autopilot job, 2026-10-17 05:39 UTC.
--
-- Deleted: unsent drafts from before the cutoff, prospects from before the
-- cutoff that were never emailed (their contacts, research and scores go with
-- them by cascade), and the old discovery jobs and runs.
--
-- Kept on purpose: every business that WAS emailed, with its sent pitches,
-- replies and suppression. That record is what stops the autopilot from
-- cold-emailing the same business a second time, and it is the opt-out and
-- communication record CASL requires. Also kept: everything the autopilot made
-- since the cutoff (its prospects feed the scout's learning), the do-not-contact
-- list, cost and audit logs, and runna-hunter's hunter_scans.
--
-- Guards are "at most" counts (measured right before applying), so replaying
-- this on an empty database deletes nothing and does not fail.

do $$
declare
  cutoff constant timestamptz := '2026-10-17 05:39:00+00';
  n int;
begin
  delete from pitches where created_at < cutoff and sent_at is null and status = 'draft';
  get diagnostics n = row_count;
  if n > 1 then raise exception 'unsent drafts: expected at most 1, got %', n; end if;

  delete from prospects p
  where p.created_at < cutoff
    and not exists (select 1 from pitches x where x.prospect_id = p.id and x.sent_at is not null)
    and not exists (select 1 from pitches x where x.prospect_id = p.id and x.created_at >= cutoff)
    and not exists (select 1 from discovery_jobs j where j.created_at >= cutoff and p.id = any(j.prospect_ids))
    and not exists (select 1 from replies r where r.prospect_id = p.id);
  get diagnostics n = row_count;
  if n > 649 then raise exception 'never-emailed prospects: expected at most 649, got %', n; end if;

  delete from discovery_jobs where created_at < cutoff;
  get diagnostics n = row_count;
  if n > 36 then raise exception 'discovery_jobs: expected at most 36, got %', n; end if;

  delete from discovery_runs where created_at < cutoff;
  get diagnostics n = row_count;
  if n > 206 then raise exception 'discovery_runs: expected at most 206, got %', n; end if;
end $$;
