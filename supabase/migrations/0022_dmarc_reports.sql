-- ─────────────────────────────────────────────────────────────────────────────
-- 0022_dmarc_reports.sql
-- In-house DMARC aggregate-report ingestion (RFC 7489).
--
-- Why: Google Postmaster shows nothing until high volume. DMARC aggregate
-- reports (daily gzip/zip XML, emailed by Gmail/Yahoo/Microsoft/etc. to the
-- rua= address) work from email #1. runnareach.com already publishes
--   _dmarc.runnareach.com = v=DMARC1; p=none; rua=mailto:pedro@runnareach.com
-- so the reports ALREADY arrive in pedro@runnareach.com — the mailbox we
-- already poll via Gmail OAuth (lib/gmail/read.ts). We read, parse, store here.
--
-- Two tables: one report header per email/XML, many per-source records inside.
-- ─────────────────────────────────────────────────────────────────────────────

-- ── Report header (one row per aggregate-report XML) ─────────────────────────
CREATE TABLE IF NOT EXISTS dmarc_reports (
  id                 uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id          uuid        NOT NULL,
  -- RFC 7489 <report_metadata><report_id>. Globally unique per reporter; we
  -- dedupe on (tenant_id, report_id) so re-polling the same email is a no-op.
  report_id          text        NOT NULL,
  org_name           text        NULL,   -- reporter, e.g. "google.com"
  email              text        NULL,   -- reporter contact
  date_range_begin   timestamptz NULL,
  date_range_end     timestamptz NULL,
  policy_domain      text        NULL,   -- <policy_published><domain>
  policy_p           text        NULL,   -- none | quarantine | reject
  policy_pct         integer     NULL,
  gmail_message_id   text        NULL,   -- the email we parsed it from
  created_at         timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT dmarc_reports_tenant_report_uniq UNIQUE (tenant_id, report_id)
);

COMMENT ON TABLE  dmarc_reports            IS 'One RFC 7489 DMARC aggregate report (one report = one gzip/zip XML email).';
COMMENT ON COLUMN dmarc_reports.report_id  IS 'Reporter-assigned report id; (tenant_id, report_id) dedupes re-polls.';

CREATE INDEX IF NOT EXISTS idx_dmarc_reports_tenant_range
  ON dmarc_reports (tenant_id, policy_domain, date_range_end DESC);

-- ── Per-source records (one row per <record> inside a report) ─────────────────
CREATE TABLE IF NOT EXISTS dmarc_report_records (
  id             uuid     PRIMARY KEY DEFAULT gen_random_uuid(),
  report_fk      uuid     NOT NULL REFERENCES dmarc_reports (id) ON DELETE CASCADE,
  tenant_id      uuid     NOT NULL,
  source_ip      text     NULL,   -- sending IP (kept as text; may be IPv4 or IPv6)
  message_count  integer  NOT NULL DEFAULT 0,
  disposition    text     NULL,   -- none | quarantine | reject (applied policy)
  dkim_eval      text     NULL,   -- <row><policy_evaluated><dkim> pass | fail
  spf_eval       text     NULL,   -- <row><policy_evaluated><spf>  pass | fail
  dkim_aligned   boolean  NULL,   -- DKIM auth result aligned to header_from
  spf_aligned    boolean  NULL,   -- SPF auth result aligned to header_from
  dmarc_pass     boolean  NOT NULL DEFAULT false, -- (dkim pass+aligned) OR (spf pass+aligned)
  header_from    text     NULL    -- <identifiers><header_from>
);

COMMENT ON TABLE  dmarc_report_records           IS 'One sending-source row inside a DMARC aggregate report.';
COMMENT ON COLUMN dmarc_report_records.dmarc_pass IS 'DMARC alignment verdict: (DKIM pass & aligned) OR (SPF pass & aligned).';

CREATE INDEX IF NOT EXISTS idx_dmarc_records_report ON dmarc_report_records (report_fk);
CREATE INDEX IF NOT EXISTS idx_dmarc_records_tenant ON dmarc_report_records (tenant_id);
