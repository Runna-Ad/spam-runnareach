-- Audit 2026-07-17 — review queries (READ-ONLY; paste in Supabase SQL editor)
-- Context: pitches were sent citing auto-discovered websites that don't exist,
-- and junk scraped emails bounced. Code fixes are in; these queries surface
-- rows created BEFORE the fixes so you can review/clean them.

-- 1. Unsent pitches whose prospect has the "website unreachable" pain.
--    These may cite a domain that was never verified — review before sending.
select p.id as pitch_id, pr.company_name, pr.domain, p.status, p.subject
from pitches p
join prospects pr on pr.id = p.prospect_id
join prospect_research r on r.prospect_id = pr.id
where p.status in ('draft', 'queued_for_approval', 'approved')
  and p.sent_at is null
  and r.pain_points::text like '%website_unreachable%';

-- 2. Contacts that would now FAIL the hardened email gate (glued digits ≥5,
--    run-together TLDs, builder placeholders). They can no longer be sent to
--    (the send path re-checks), but you can delete them for hygiene.
select c.id, pr.company_name, c.email, c.selected_by
from prospect_contacts c
join prospects pr on pr.id = c.prospect_id
where c.email ~ '^[0-9]{5,}[a-z]'                                  -- glued postal/phone prefix
   or c.email ~* '@.*\.(comreserv|com[a-z]{4,})$'                  -- run-together after .com
   or split_part(c.email, '@', 2) in ('godaddy.com','secureserver.net','wixsite.com')
   or split_part(c.email, '@', 1) in ('filler','placeholder');

-- 3. Prospects whose pitch was already SENT and whose research holds the
--    unreachable-website pain — the Acadian class. Nothing to unsend; useful
--    to know the blast radius (consider a manual apology/correction if any replied).
select pr.id, pr.company_name, pr.domain, pi.sent_at
from prospects pr
join prospect_research r on r.prospect_id = pr.id
join pitches pi on pi.prospect_id = pr.id and pi.sent_at is not null
where r.pain_points::text like '%website_unreachable%'
order by pi.sent_at desc;

-- ─────────────────────────────────────────────────────────────────────────────
-- CLEANUP (added after Pedro ran the review on 2026-07-17): delete the junk
-- contacts surfaced by query 2. Same predicate as the SELECT, so what you
-- audited is exactly what gets deleted. They are already unsendable (every
-- send path re-checks hasUsableEmail) — this is hygiene.
-- After the fixed code DEPLOYS, bulk re-scrape / "Re-enrich contacts" on the
-- affected prospects: the scraper now repairs same-domain glue
-- (info@neeralta.commonday → info@neeralta.com) and will re-insert the real
-- addresses, SMTP-screened.

delete from prospect_contacts c
where (
        c.email ~ '^[0-9]{5,}[a-z]'
     or (c.email ~* '@.*\.com[a-z]{2,}$'
         and c.email !~* '\.(community|company|computer|computers)$')
     or split_part(c.email, '@', 2) in ('godaddy.com','secureserver.net','wixsite.com')
     or split_part(c.email, '@', 1) in ('filler','placeholder')
      );
