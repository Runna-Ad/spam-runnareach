-- ─────────────────────────────────────────────────────────────────────────────
-- SEND-GATE DRY RUN — review queries
--
-- The gate records what it WOULD decide about every generated pitch. It blocks
-- nothing. Run these after a week or two of real pitches to decide whether it
-- has earned the right to auto-send.
--
-- The number that matters is FALSE POSITIVES: pitches the gate would have held
-- that you were happy to send. If that's ~0, auto-send is safe. If it's high,
-- the rules are too strict and we tune them BEFORE enabling anything.
-- ─────────────────────────────────────────────────────────────────────────────

-- 1. Headline: how much would auto-send, how much would come to you?
select
  count(*)                                                as pitches_evaluated,
  count(*) filter (where (metadata->>'pass')::boolean)    as would_auto_send,
  count(*) filter (where not (metadata->>'pass')::boolean) as would_be_held,
  round(100.0 * count(*) filter (where (metadata->>'pass')::boolean) / nullif(count(*),0), 1)
                                                          as auto_send_pct
from audit_log
where action = 'pitch.gate_dryrun';

-- 2. WHY things get held — ranked. This is the tuning list: a reason that fires
--    constantly on good pitches is a rule that needs loosening, not a win.
select
  code                       as failure_reason,
  count(*)                   as times,
  count(distinct entity_id)  as pitches
from audit_log,
     lateral jsonb_array_elements_text(metadata->'failure_codes') as code
where action = 'pitch.gate_dryrun'
group by code
order by times desc;

-- 3. THE KEY QUESTION — false positives.
--    Pitches the gate would have HELD but that you approved and sent anyway.
--    Read a few of these. If the gate was wrong, tell me which rule and why.
select
  p.id            as pitch_id,
  pr.company_name,
  p.subject,
  p.sent_at,
  a.metadata->'failure_codes' as gate_would_have_held_for
from audit_log a
join pitches   p  on p.id = a.entity_id
join prospects pr on pr.id = p.prospect_id
where a.action = 'pitch.gate_dryrun'
  and not (a.metadata->>'pass')::boolean
  and p.sent_at is not null
order by p.sent_at desc
limit 50;

-- 4. The reassuring inverse — held pitches you ALSO rejected or never sent.
--    These are the gate agreeing with you (and would have saved you the review).
select
  pr.company_name,
  p.status,
  a.metadata->'failure_codes' as reasons
from audit_log a
join pitches   p  on p.id = a.entity_id
join prospects pr on pr.id = p.prospect_id
where a.action = 'pitch.gate_dryrun'
  and not (a.metadata->>'pass')::boolean
  and p.sent_at is null
order by a.created_at desc
limit 50;

-- 5. Full detail for one pitch (paste an id from query 3).
-- select metadata from audit_log
-- where action = 'pitch.gate_dryrun' and entity_id = '<pitch_id>';
