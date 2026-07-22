-- Persist the name a scraped site calls itself (og:site_name / <title>).
--
-- send-gate.ts rule 4 already holds any pitch where the stored company name
-- contradicts the site's own name — the exact guard that would have caught
-- "Corvex Manufacturing" being stored against linamar.com, "Holiday Inn
-- Niagara" against ihg.com, and "Canweld Group" against symposiumcafe.com.
--
-- That rule has never fired once. gate-dryrun.ts passes `siteName: null`
-- with the comment "Not persisted today", so the gate skips it every time.
-- The scraper has always extracted site_name; it was simply thrown away after
-- the request. This column is the missing link between the two.
--
-- Nullable on purpose: rows scraped before this migration have no value, and
-- the gate correctly skips the rule when it is null rather than guessing.

alter table public.prospect_research
  add column if not exists site_name text;

comment on column public.prospect_research.site_name is
  'The name the site calls itself (og:site_name, else <title> before a separator). '
  'Fed to send-gate rule 4 to catch prospects whose stored domain belongs to a '
  'different company. Null for rows scraped before 2026-07-22.';
