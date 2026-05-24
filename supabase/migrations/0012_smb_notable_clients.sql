-- Migration 0012 — SMB notable clients
--
-- Adds 8 SMB-tier clients (Canadian and Mexican) so the pitch generator's
-- Tier 2 / Tier 3 fallback can name-drop size-appropriate brands when pitching
-- to small businesses. Enterprise-tier clients (Ford, La Comer, DiDi, etc.)
-- are filtered out for SMB prospects — these fill that gap.
--
-- Clients provided by Pedro (2026-05-22):
--   CA/SMB:  SnapPad (Calgary), Lila (Toronto)
--   MX/SMB:  El Club (CDMX gym), Blues Real (real estate), Keep It Healthy
--            (food delivery), Kalida (insurance), Dike (college magazine),
--            Imaging Supplies de México (stamping foil mfg + distribution)
--
-- Safe to run multiple times: INSERT ... ON CONFLICT (id) DO UPDATE.

INSERT INTO notable_clients (
  id, tenant_id,
  name, tier, industry_tags, markets,
  relationship_description, services_provided, key_result,
  description_en, description_es,
  is_active, sort_order
) VALUES

  -- ── Canadian SMB clients ──────────────────────────────────────────────────

  ('cc000001-cc00-cc00-cc00-cc0000000001', '11111111-1111-1111-1111-111111111111',
   'SnapPad',
   'smb',
   array['DTC','ecommerce','outdoor','RV','hardware','lifestyle'],
   array['CA'],
   'brand identity and ecommerce design for their DTC outdoor accessories line',
   array['brand identity','ecommerce design','digital marketing'],
   null,
   'Runna CA partnered with SnapPad, a Calgary-based DTC brand making premium RV accessories, to build their brand identity and ecommerce storefront.',
   'Runna CA trabajó con SnapPad, una marca DTC de Calgary que fabrica accesorios para casas rodantes, desarrollando su identidad de marca y tienda de ecommerce.',
   true, 6),

  ('cc000002-cc00-cc00-cc00-cc0000000002', '11111111-1111-1111-1111-111111111111',
   'Lila',
   'smb',
   array['DTC','lifestyle','fashion','apparel','retail'],
   array['CA'],
   'brand and digital creative for this Toronto-based boutique brand',
   array['brand identity','social media','digital creative'],
   null,
   'Runna CA helped Lila, a Toronto small business, build their brand presence and digital creative across channels.',
   'Runna CA ayudó a Lila, una pequeña empresa de Toronto, a construir su presencia de marca y creatividad digital.',
   true, 7),

  -- ── Mexican SMB clients ───────────────────────────────────────────────────

  ('cc000003-cc00-cc00-cc00-cc0000000003', '11111111-1111-1111-1111-111111111111',
   'El Club',
   'smb',
   array['fitness','wellness','gym','sports','health','DTC'],
   array['MX'],
   'brand identity and digital campaigns for this Mexico City gym',
   array['brand identity','social media','digital campaigns'],
   null,
   'Rünna built El Club''s brand and digital presence — a boutique gym in Mexico City looking to stand out in a competitive fitness market.',
   'Rünna construyó la marca y presencia digital de El Club — un gimnasio boutique en la Ciudad de México que busca diferenciarse en un mercado fitness muy competido.',
   true, 8),

  ('cc000004-cc00-cc00-cc00-cc0000000004', '11111111-1111-1111-1111-111111111111',
   'Blues Real',
   'smb',
   array['real estate','property','development','professional services'],
   array['MX'],
   'brand identity and digital marketing for this Mexican real estate agency',
   array['brand identity','website design','digital marketing'],
   null,
   'Rünna designed the brand and digital presence for Blues Real, a real estate agency in Mexico focused on helping buyers navigate a competitive market.',
   'Rünna diseñó la marca y presencia digital de Blues Real, una agencia inmobiliaria en México especializada en guiar a compradores en un mercado competitivo.',
   true, 9),

  ('cc000005-cc00-cc00-cc00-cc0000000005', '11111111-1111-1111-1111-111111111111',
   'Keep It Healthy',
   'smb',
   array['food','delivery','DTC','health food','ecommerce','subscription'],
   array['MX'],
   'brand and social media for this healthy food delivery brand in Mexico',
   array['brand identity','social media','packaging design'],
   null,
   'Rünna helped Keep It Healthy — a Mexican healthy food delivery service — sharpen their brand and grow their customer base through targeted social content.',
   'Rünna ayudó a Keep It Healthy — un servicio de entrega de comida saludable en México — a fortalecer su marca y crecer su base de clientes con contenido social dirigido.',
   true, 10),

  ('cc000006-cc00-cc00-cc00-cc0000000006', '11111111-1111-1111-1111-111111111111',
   'Kalida',
   'smb',
   array['insurance','financial services','professional services','B2B'],
   array['MX'],
   'brand identity and digital presence for this insurance brokerage',
   array['brand identity','website design','digital marketing'],
   null,
   'Rünna built Kalida''s brand from the ground up — an insurance broker that needed to communicate trust and expertise in a market where visual credibility matters.',
   'Rünna construyó la marca de Kalida desde cero — un broker de seguros que necesitaba comunicar confianza y expertise en un mercado donde la credibilidad visual importa.',
   true, 11),

  ('cc000007-cc00-cc00-cc00-cc0000000007', '11111111-1111-1111-1111-111111111111',
   'Dike',
   'smb',
   array['media','publishing','youth','content','magazine','editorial'],
   array['MX'],
   'brand identity and digital strategy for this college-focused magazine',
   array['brand identity','content strategy','social media','digital design'],
   null,
   'Rünna designed the brand and digital strategy for Dike, an independent magazine targeting college students across Mexico — making editorial feel modern and shareable.',
   'Rünna diseñó la marca y estrategia digital de Dike, una revista independiente dirigida a universitarios en México — haciendo que el contenido editorial se sienta moderno y compartible.',
   true, 12),

  ('cc000008-cc00-cc00-cc00-cc0000000008', '11111111-1111-1111-1111-111111111111',
   'Imaging Supplies de México',
   'smb',
   array['manufacturing','printing','industrial','B2B','packaging materials','distribution'],
   array['MX'],
   'brand and trade marketing for this stamping foil manufacturer and distributor',
   array['brand identity','trade marketing','website design'],
   null,
   'Rünna partnered with Imaging Supplies de México — a manufacturer and distributor of stamping foil — to modernize their brand and support B2B trade marketing.',
   'Rünna trabajó con Imaging Supplies de México — fabricante y distribuidor de foil estampado — para modernizar su marca y apoyar su marketing B2B con clientes del sector impresión.',
   true, 13)

ON CONFLICT (id) DO UPDATE SET
  name                    = EXCLUDED.name,
  tier                    = EXCLUDED.tier,
  industry_tags           = EXCLUDED.industry_tags,
  markets                 = EXCLUDED.markets,
  relationship_description = EXCLUDED.relationship_description,
  services_provided       = EXCLUDED.services_provided,
  key_result              = EXCLUDED.key_result,
  description_en          = EXCLUDED.description_en,
  description_es          = EXCLUDED.description_es,
  is_active               = EXCLUDED.is_active,
  sort_order              = EXCLUDED.sort_order,
  updated_at              = NOW();
