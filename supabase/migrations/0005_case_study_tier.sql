-- Add prospect-size tier to case studies.
-- Used by the 3-stage pitch composer to avoid pitching enterprise logos
-- (Ford, DiDi, Aeromexico) to small boutique prospects.
--
-- Tier definitions:
--   smb          < 50 employees / startup / boutique / single-location
--   mid_market   50–499 employees / regional brand / growing company
--   enterprise   500+ employees / national/global brand / public company

alter table case_studies
  add column tier text not null default 'smb'
  check (tier in ('smb', 'mid_market', 'enterprise'));

-- Set tiers for existing Rünna case studies
update case_studies set tier = 'enterprise' where id in (
  '55555555-5555-5555-5555-555555555551', -- Ford (training platform)
  '55555555-5555-5555-5555-555555555552', -- DiDi (main LATAM)
  '55555555-5555-5555-5555-555555555553', -- Aeromexico VR
  '55555555-5555-5555-5555-555555555554', -- Bayer / Aspirina Protect
  '55555560-5555-5555-5555-555555555560', -- Walt Disney Studios
  '55555561-5555-5555-5555-555555555561', -- Ford Edge 360
  '55555562-5555-5555-5555-555555555562', -- Ford Pass Lincoln
  '55555563-5555-5555-5555-555555555563', -- Santander Universidades
  '55555564-5555-5555-5555-555555555564', -- Estadio Azteca
  '5555555b-5555-5555-5555-55555555555b', -- DiDi Food
  '5555555c-5555-5555-5555-55555555555c'  -- DiDi TikTok paid
);

update case_studies set tier = 'mid_market' where id in (
  '55555555-5555-5555-5555-555555555555', -- Golden Hills
  '55555555-5555-5555-5555-555555555556', -- ANA Seguros
  '55555555-5555-5555-5555-555555555557'  -- Pet's Club
);

-- smb is already the default; explicitly set for clarity
update case_studies set tier = 'smb' where id in (
  '55555555-5555-5555-5555-555555555558', -- SnapPad
  '55555555-5555-5555-5555-555555555559', -- Niki
  '55555555-5555-5555-5555-55555555555a', -- DevFest Calgary 2024
  '5555555d-5555-5555-5555-55555555555d', -- Blues Real
  '5555555e-5555-5555-5555-55555555555e', -- El Club
  '5555555f-5555-5555-5555-55555555555f'  -- Lila
);
