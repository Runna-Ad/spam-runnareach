-- The original unique index on (tenant_id, email) prevented the same email
-- from being saved for more than one prospect per tenant. This meant that if
-- email A was scraped for prospect 1, scraping prospect 2 (a different company
-- that happens to share the email) would fail silently with 23505.
--
-- The correct scope is per-prospect: the same email can legitimately appear
-- on multiple prospects (e.g. an agency contact, or duplicate discovery).
-- De-duplication against sending the same person twice happens at send time.

drop index if exists idx_prospect_contacts_email;

create unique index idx_prospect_contacts_email
  on prospect_contacts(tenant_id, prospect_id, email)
  where email is not null;
