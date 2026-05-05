-- Add prospect-size tier to notable_clients.
-- Used to prevent pitching enterprise name-drops to SMB prospects.
-- All current notable clients (Ford, La Comer, DiDi, Aeromexico, etc.)
-- are enterprise — the default value covers them without explicit UPDATEs.
--
-- Tier definitions (same as case_studies):
--   smb          < 50 employees / startup / boutique / single-location
--   mid_market   50–499 employees / regional brand / growing company
--   enterprise   500+ employees / national/global brand / public company

alter table notable_clients
  add column tier text not null default 'enterprise'
  check (tier in ('smb', 'mid_market', 'enterprise'));
