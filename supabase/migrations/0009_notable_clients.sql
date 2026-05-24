-- Notable clients table — stores Pedro's marquee clients (Ford, La Comer, etc.)
-- Used by the pitch generator's 3-tier fallback:
--   Tier 2: notable client with industry_tags overlap → named credibility hook
--   Tier 3: any notable clients → volume name-drop when no Tier 1/2 match

CREATE TABLE notable_clients (
  id                       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id                uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  name                     TEXT NOT NULL,
  industry_tags            TEXT[] NOT NULL DEFAULT '{}',
  markets                  TEXT[] NOT NULL DEFAULT '{}',
  relationship_description TEXT,
  services_provided        TEXT[] NOT NULL DEFAULT '{}',
  key_result               TEXT,
  description_en           TEXT,
  description_es           TEXT,
  is_active                BOOLEAN NOT NULL DEFAULT true,
  sort_order               INTEGER NOT NULL DEFAULT 0,
  created_at               TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at               TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE notable_clients ENABLE ROW LEVEL SECURITY;

CREATE POLICY "tenant isolation"
  ON notable_clients
  USING (tenant_id = (SELECT tenant_id FROM users WHERE id = auth.uid()));
