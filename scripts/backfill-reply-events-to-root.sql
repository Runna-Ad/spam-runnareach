-- scripts/backfill-reply-events-to-root.sql
--
-- One-off repair (reply-on-root, batch 8). Run by the conductor AFTER the poll
-- fix is deployed, in the Supabase SQL editor or psql. Not a migration.
--
-- Before the fix, the reply poll recorded a reply/bounce event on the thread's
-- NEWEST pitch, so a reply that arrived after a follow-up sat on the follow-up
-- row. Learners, exemplars and the weekly report read only root pitches
-- (parent_pitch_id is null) and never saw it. This moves those events to the
-- conversation's root.
--
-- What it does, per reply/bounce event on a follow-up pitch:
--   * root = the follow-up's top ancestor (walks parent_pitch_id up, so an old
--     chained row fu2 -> fu1 -> root resolves too), same tenant.
--   * the root already holds an event with the same payload reply_id -> the
--     follow-up's copy is deleted (the reply is already counted once).
--   * two follow-up events of one root share a reply_id -> one is kept.
--   * otherwise pitch_id is set to the root. event_at is untouched (no event is
--     re-dated) and payload gains answered_pitch_id = the follow-up's id, as the
--     poll now writes.
--
-- HOW TO RUN: run section 1 (preview) ALONE first and read its output. Pasting
-- or running the whole file executes section 2 (the apply) right after it.
-- Then run sections 2 and 3 together; section 3 rolls everything back if
-- anything is left on a follow-up.
--
-- Idempotent: a second run finds no reply/bounce on a follow-up and changes 0 rows.
-- Other event types (sent, unsubscribe, audit_scan ...) are left alone.

-- ── 1. Preview (read only) ──────────────────────────────────────────────────
with recursive up as (
  select p.id as pitch_id, p.parent_pitch_id as ancestor, 1 as depth
  from pitches p
  where p.parent_pitch_id is not null
  union all
  select up.pitch_id, a.parent_pitch_id, up.depth + 1
  from up join pitches a on a.id = up.ancestor
  where a.parent_pitch_id is not null and up.depth < 10
),
root_of as (
  select distinct on (pitch_id) pitch_id, ancestor as root_id
  from up order by pitch_id, depth desc
),
moving as (
  select e.id, e.event_type, e.event_at, e.pitch_id as from_pitch, r.root_id,
         e.payload->>'reply_id' as reply_id,
         row_number() over (
           partition by r.root_id, coalesce(e.payload->>'reply_id', e.id::text)
           order by e.event_at, e.id
         ) as rn
  from pitch_events e
  join root_of r on r.pitch_id = e.pitch_id
  join pitches rp on rp.id = r.root_id and rp.parent_pitch_id is null and rp.tenant_id = e.tenant_id
  where e.event_type in ('reply', 'bounce')
)
select m.id, m.event_type, m.event_at, m.from_pitch, m.root_id, m.reply_id,
       case
         when m.rn > 1 then 'delete (duplicate among follow-ups)'
         when m.reply_id is not null and exists (
           select 1 from pitch_events x
           where x.pitch_id = m.root_id and x.event_type in ('reply', 'bounce')
             and x.payload->>'reply_id' = m.reply_id
         ) then 'delete (root already has this reply)'
         else 'move to root'
       end as action
from moving m
order by m.event_at;

-- ── 2. Apply (one transaction) ──────────────────────────────────────────────
begin;

with recursive up as (
  select p.id as pitch_id, p.parent_pitch_id as ancestor, 1 as depth
  from pitches p
  where p.parent_pitch_id is not null
  union all
  select up.pitch_id, a.parent_pitch_id, up.depth + 1
  from up join pitches a on a.id = up.ancestor
  where a.parent_pitch_id is not null and up.depth < 10
),
root_of as (
  select distinct on (pitch_id) pitch_id, ancestor as root_id
  from up order by pitch_id, depth desc
),
moving as (
  select e.id, e.pitch_id as from_pitch, r.root_id,
         e.payload->>'reply_id' as reply_id,
         row_number() over (
           partition by r.root_id, coalesce(e.payload->>'reply_id', e.id::text)
           order by e.event_at, e.id
         ) as rn
  from pitch_events e
  join root_of r on r.pitch_id = e.pitch_id
  join pitches rp on rp.id = r.root_id and rp.parent_pitch_id is null and rp.tenant_id = e.tenant_id
  where e.event_type in ('reply', 'bounce')
),
dupes as (
  select m.id from moving m
  where m.rn > 1
     or (m.reply_id is not null and exists (
           select 1 from pitch_events x
           where x.pitch_id = m.root_id and x.event_type in ('reply', 'bounce')
             and x.payload->>'reply_id' = m.reply_id
         ))
),
deleted as (
  delete from pitch_events d using dupes where d.id = dupes.id
  returning d.id
),
moved as (
  update pitch_events e
  set pitch_id = m.root_id,
      payload = case when e.payload ? 'answered_pitch_id' then e.payload
                     else e.payload || jsonb_build_object('answered_pitch_id', m.from_pitch) end
  from moving m
  where e.id = m.id and not exists (select 1 from dupes where dupes.id = m.id)
  returning e.id
)
select (select count(*) from moved) as moved, (select count(*) from deleted) as deleted_duplicates;

-- ── 3. Check: anything still on a follow-up aborts the transaction ──────────
-- (the COMMIT below then rolls back). Non-zero means a follow-up whose top
-- ancestor is missing or in another tenant: look at those rows by hand.
do $$
declare left_over bigint;
begin
  select count(*) into left_over
  from pitch_events e join pitches p on p.id = e.pitch_id
  where e.event_type in ('reply', 'bounce') and p.parent_pitch_id is not null;
  if left_over > 0 then
    raise exception 'backfill: % reply/bounce events still on follow-up pitches; rolled back', left_over;
  end if;
end $$;

commit;
