-- 0041 — The autopilot's schedule: Supabase pg_cron + pg_net (free), and the
-- autopilot switched on.
--
-- Vercel's tier runs crons once a day; the autopilot needs a heartbeat. pg_cron
-- calls the app's routes over HTTP with pg_net:
--
--   every 15 min                 /api/autopilot/tick   (breakers, watchdog, scout,
--                                                       labels, scheduling, stage)
--   every 30 min                 /api/replies/poll     (was once a day)
--   every 10 min, Mon–Fri 15–22 UTC  /api/pitches/send-queue  (≈ 9:00–16:59 in
--                                                       Calgary / Mexico City)
--   hourly at :20, Mon–Fri 15–22 UTC /api/pitches/follow-up
--
-- The Vercel daily crons stay as a backstop; the routes are idempotent.
--
-- Auth: a random token generated INSIDE the database and kept in Supabase
-- Vault. pg_cron reads it from Vault to call the routes; the app checks a
-- presented token with scheduler_token_valid() (service role only). The token
-- is never printed, never in an env var, never in this file.
--
-- Finally, the autopilot is turned on for the Rünna tenant in the VETO stage
-- (Pedro, 2026-10-17: "the end goal is total automation"): AUTO pitches are
-- approved and scheduled 18 hours out with a digest email, and send unless a
-- person holds them. It promotes itself to full auto after 14 days with < 5%
-- vetoes and < 2% bounces, and demotes itself on any breaker trip.
-- Kill switch: update autonomy_state set enabled = false.

create extension if not exists pg_cron;
create extension if not exists pg_net;

-- The scheduler's token, generated server-side.
select vault.create_secret(
  encode(extensions.gen_random_bytes(32), 'hex'),
  'spam_scheduler_token',
  'Bearer token Supabase pg_cron sends to the S.P.A.M. cron routes'
)
where not exists (select 1 from vault.secrets where name = 'spam_scheduler_token');

create or replace function public.scheduler_token_valid(token text)
returns boolean
language sql
stable
security definer
set search_path = ''
as $fn$
  select exists (
    select 1 from vault.decrypted_secrets
    where name = 'spam_scheduler_token' and decrypted_secret = token
  );
$fn$;

revoke all on function public.scheduler_token_valid(text) from public, anon, authenticated;
grant execute on function public.scheduler_token_valid(text) to service_role;

-- Call one of the app's routes with the scheduler token (fire-and-forget).
create or replace function public.spam_cron_call(path text, method text default 'GET')
returns bigint
language plpgsql
security definer
set search_path = ''
as $fn$
declare
  v_token text;
  v_url text := 'https://spam-runnareach.vercel.app' || path;
  v_headers jsonb;
begin
  select decrypted_secret into v_token from vault.decrypted_secrets where name = 'spam_scheduler_token';
  if v_token is null then
    raise warning 'spam_cron_call: scheduler token missing';
    return null;
  end if;
  v_headers := jsonb_build_object('Authorization', 'Bearer ' || v_token);
  if method = 'POST' then
    return net.http_post(url := v_url, headers := v_headers || '{"Content-Type":"application/json"}'::jsonb,
                         body := '{}'::jsonb, timeout_milliseconds := 130000);
  end if;
  return net.http_get(url := v_url, headers := v_headers, timeout_milliseconds := 130000);
end;
$fn$;

revoke all on function public.spam_cron_call(text, text) from public, anon, authenticated;

select cron.schedule('spam-autopilot-tick', '*/15 * * * *', $job$select public.spam_cron_call('/api/autopilot/tick')$job$);
select cron.schedule('spam-replies-poll', '*/30 * * * *', $job$select public.spam_cron_call('/api/replies/poll')$job$);
select cron.schedule('spam-send-queue', '*/10 15-22 * * 1-5', $job$select public.spam_cron_call('/api/pitches/send-queue')$job$);
select cron.schedule('spam-follow-up', '20 15-22 * * 1-5', $job$select public.spam_cron_call('/api/pitches/follow-up')$job$);

-- Switch the autopilot on for the Rünna tenant, in the veto stage.
insert into public.autonomy_state (tenant_id, stage, enabled, reason)
values ('11111111-1111-1111-1111-111111111111', 'veto', true, 'Turned on by Pedro, 2026-10-17')
on conflict (tenant_id) do nothing;
