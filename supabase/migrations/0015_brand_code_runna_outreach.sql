-- Add RUNNA_OUTREACH to brand_code enum for the combined outreach brand instance
-- (covers both CA and MX markets, sends from runnareach.com)
alter type brand_code add value if not exists 'RUNNA_OUTREACH';
