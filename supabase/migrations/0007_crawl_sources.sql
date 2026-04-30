-- Migration 0007: add yellowpages_ca + brave_search to discovery_source enum
-- IF NOT EXISTS is PG 9.3+ — Supabase is PG 15, safe.

alter type discovery_source add value if not exists 'yellowpages_ca';
alter type discovery_source add value if not exists 'brave_search';
