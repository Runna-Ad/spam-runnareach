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

-- ─────────────────────────────────────────────────────────────────────────────
-- 2026-07-21: contacts with the site's own DOMAIN glued onto the local-part
-- (e.g. julien-cormier.cavfournier@julien-cormier.ca — really vfournier@...).
-- These passed every previous check and reached DRAFT PITCHES. They are now
-- unsendable (hasUsableEmail rejects them), but review + re-scrape to recover
-- the real address.
select c.id, pr.company_name, c.email, c.selected_by,
       split_part(c.email,'@',2) as domain
from prospect_contacts c
join prospects pr on pr.id = c.prospect_id
where position(split_part(c.email,'@',2) in split_part(c.email,'@',1)) = 1;

-- Unsent pitches whose recipient is now unusable — these would have gone to a
-- garbage address. Review/regenerate after re-enriching the prospect.
select p.id as pitch_id, pr.company_name, c.email, p.status, p.subject
from pitches p
join prospects pr on pr.id = p.prospect_id
join prospect_contacts c on c.id = p.contact_id
where p.sent_at is null
  and p.status in ('draft','queued_for_approval','approved')
  and position(split_part(c.email,'@',2) in split_part(c.email,'@',1)) = 1;

-- ─────────────────────────────────────────────────────────────────────────────
-- REMEDIATION for the one affected prospect (Julien & Cormier, 2026-07-21).
-- The real addresses were confirmed live on julien-cormier.ca:
--   pjcormier@julien-cormier.ca · rgjulien@julien-cormier.ca · vfournier@julien-cormier.ca
-- Step 1: delete the draft pitch built on the garbage address.
delete from pitches where id = 'b6f8a98f-165b-469b-80bd-4d9e2590abca';

-- Step 2: delete the glued contact (the re-scrape will insert the real ones).
delete from prospect_contacts
where position(split_part(email,'@',2) in split_part(email,'@',1)) = 1;

-- Step 3: in the app, open Julien & Cormier → "Re-enrich contacts" (or re-run
-- the pipeline on it), then "Generate pitches". With the fixes deployed the
-- scraper recovers vfournier@julien-cormier.ca and the greeting addresses the
-- ACTUAL recipient (or the firm, since these are initial+surname locals).

-- ─────────────────────────────────────────────────────────────────────────────
-- 2026-07-21 (b): contact-page LABEL fused onto the address, e.g.
--   "Emails:" + rgjulien@x.ca -> emailsrgjulien@x.ca
-- Root cause fixed at extraction (the scraper now keeps element boundaries), so
-- a re-scrape recovers the real addresses. These legacy rows are already
-- unsendable; delete them, then Re-enrich (which now re-scrapes first).
select c.id, pr.company_name, c.email, c.selected_by
from prospect_contacts c
join prospects pr on pr.id = c.prospect_id
where split_part(c.email,'@',1) ~* '^(emails|correos|telefono|telephone|direccion)[a-z]{4,}';

-- delete from prospect_contacts
-- where split_part(email,'@',1) ~* '^(emails|correos|telefono|telephone|direccion)[a-z]{4,}';
