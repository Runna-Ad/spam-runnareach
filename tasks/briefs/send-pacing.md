# Brief: send-pacing

| | |
|---|---|
| Module | send-queue + follow-up cron routes (per-run limits, spacing), follow-up schedule |
| Model / effort | opus-5.5 / high (routing: send path + pg_cron migration) |
| Branch | `claude/send-pacing` from `claude/phase3-batch8-integration` |
| PR target | `claude/phase3-batch8-integration` |
| Reserved migration | **0052** → `supabase/migrations/0052_follow_up_every_10min.sql` (the conductor applies it) |
| Depends on | wave 2 merged (heartbeats in both routes, `lib/reports/heartbeat.ts` job table) |
| Conductor session | `session_01HtEg7XG4MPQU4omrd2BX69` (send_message ONLY if blocked; the PR body is the report) |
| Size | S |

## Goal
Emails leave our inbox the way a person sends them: a few an hour, spread across the afternoon, never a burst. Readiness check `tasks/audit-2026-10-22-autonomy.md` item 10: on 2026-10-22, 6 first emails went out at 15:00, then 9 follow-ups between 15:20:20 and 15:21:16 (about 8 s apart). Burst sending from a young domain is a spam-filter signal. Good looks like: at most one first email and one follow-up per inbox in any 10-minute run, with the two jobs offset by 5 minutes, so an inbox never sends two emails within ~5 minutes of each other.

## Context the worker needs
- send-queue (`app/api/pitches/send-queue/route.ts`): `SEND_PER_TICK = 6` (`:53`), jitter up to 8 s between sends (`:54`, `:480`). The comment at `:48-52` is stale: it says the cron runs daily, but pg_cron runs it `*/10 15-22 * * 1-5` (0041:85). Due pitches are read oldest-first, 50 at a time (`:209-218`); the inbox daily cap is enforced by `reserveSendSlot` (0049).
- follow-up (`app/api/pitches/follow-up/route.ts`): `MAX_PER_RUN = 30` (`:112`), pg_cron `20 15-22 * * 1-5` (0041:86), i.e. 8 runs a day, all due follow-ups in a burst. Time budget helpers `hasTimeToCompose` / `hasTimeToClaim` (`lib/pitches/daily-cap.ts`). Check whether follow-ups take a daily slot through the same RPC; say so in the PR.
- Health check (wave 2): `lib/reports/heartbeat.ts` `JOBS["follow-up"]` quotes the follow-up cron and migration, and a test reads it back from the migrations. A schedule change must update that entry.
- Both routes run `withHeartbeat` (wave 2); an early return with nothing due answers 200 (counts as ok).

**Decisions (conductor):**
1. send-queue: at most 1 send per inbox per run and at most 2 per run in total (`SEND_PER_TICK = 2`, plus a per-inbox counter). Keep the jitter only between sends from different inboxes. Rewrite the stale comment with the real schedule and the resulting ceiling (6 per inbox per hour, the daily cap is still the hard limit).
2. follow-up: same rule, 1 per inbox per run and 2 per run in total. Migration 0052 moves `spam-follow-up` to `5-59/10 15-22 * * 1-5` (every 10 min, offset 5 min from the send-queue) with `cron.alter_job` (or unschedule + schedule; idempotent; quote how 0041 created it), and the `JOBS["follow-up"]` entry in `lib/reports/heartbeat.ts` changes to that cron and migration `0052`.
3. Order inside the limit: oldest due first, as today. Nothing else about which pitch is chosen changes.
4. Out of scope (note it, do not build): sending in the prospect's local morning/afternoon.

## Brain lessons
none matched (second brain not attached). Core-context: the `vercel.json` / migration a test reads back must change in the same commit as the code that relies on it (batch 7 conductor miss).

## Files
Allowed to edit: `app/api/pitches/send-queue/route.ts` and `app/api/pitches/follow-up/route.ts` (limits, per-inbox counter, comments), `lib/reports/heartbeat.ts` (the follow-up `JOBS` entry only), `supabase/migrations/0052_follow_up_every_10min.sql` (new), `tests/send-pacing.test.ts` (new), existing tests that pin `SEND_PER_TICK`/`MAX_PER_RUN` or the follow-up schedule (name them).
Read only: `lib/pitches/daily-cap.ts`, `lib/pitches/status-transitions.ts`, `lib/reports/health.ts`, migrations 0041, 0049.
Forbidden: `lib/supabase/*`, `lib/gmail/*`, `lib/compliance/*`, `lib/autopilot/*`, `vercel.json`, any other migration number.

## Must not change (negative set)
- Every send-path safety check (claim, slot, DNC/recheck, gate, bounce block, follow-up stop rules, thread re-read) runs exactly as today.
- The daily cap stays the hard ceiling; a capped inbox is skipped as today.
- recoverStuckSends and the heartbeat wrapper unchanged.
- Responses keep their shape (`results` entries; a skipped pitch says why, e.g. "Run limit reached — next run").

## Acceptance checks
1. Tests: 5 due pitches on one inbox → 1 sent this run, the rest left `approved` untouched (no claim); 2 inboxes with 3 each → 1 per inbox; follow-up the same.
2. 0052 on local Postgres 16 with pg_cron (or, if pg_cron can't be installed locally, a SQL test against a stub `cron` schema that records the call — say which): the job's schedule becomes `5-59/10 15-22 * * 1-5`, re-running is harmless.
3. The heartbeat test that reads schedules back from the migrations passes with 0052.
4. `npm run typecheck && npm run lint && npm test && npm run build` green; count reported.

## External prerequisites
0052 applied (conductor, at ship time). Until then the follow-up route still runs hourly and sends at most 2 per run (slower, still safe).

## Prod verification
After deploy + 0052: `select schedule from cron.job where jobname='spam-follow-up';` → `5-59/10 15-22 * * 1-5`. Next weekday: `select sent_at from pitches where sent_at::date = current_date order by sent_at;` → no two sends from one inbox less than ~4 minutes apart.

## Out of scope
Prospect-local send windows; the veto day-skip (audit item 12); anything in the tick.

## If blocked
Message the conductor with what you tried, what you need, and what you can still do meanwhile.
