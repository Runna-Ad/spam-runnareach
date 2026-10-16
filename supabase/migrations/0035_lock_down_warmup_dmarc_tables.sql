-- 0035: close four tables that were readable AND writable with the public anon key.
--
-- warmup_buddies, warmup_templates, dmarc_reports and dmarc_report_records were
-- created without row level security, and Supabase's default grants gave anon and
-- authenticated full INSERT/UPDATE/DELETE/TRUNCATE on them. The anon key ships to
-- every browser, so anyone could have rewritten the warmup templates (which the
-- engine sends from the real sender inbox) or pointed a buddy at another address.
--
-- Every reader and writer in the app uses the service-role client, which bypasses
-- RLS (lib/warmup/queries.ts, lib/warmup/dmarc-*.ts, app/api/warmup/*,
-- app/(dashboard)/warmup/page.tsx). So: RLS on with no policies (deny-all for
-- anon/authenticated) plus revoked grants as a second layer. Nothing in the app
-- changes behaviour.

alter table public.warmup_buddies       enable row level security;
alter table public.warmup_templates     enable row level security;
alter table public.dmarc_reports        enable row level security;
alter table public.dmarc_report_records enable row level security;

revoke all on table public.warmup_buddies       from anon, authenticated;
revoke all on table public.warmup_templates     from anon, authenticated;
revoke all on table public.dmarc_reports        from anon, authenticated;
revoke all on table public.dmarc_report_records from anon, authenticated;
