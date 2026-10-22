# Brief: health-alarms

| | |
|---|---|
| Module | `lib/reports/health.ts` + `lib/reports/snapshot.ts` (hourly health check), heartbeats in 4 cron routes |
| Model / effort | opus-5.5 / high (routing: reports/alerts is medium; high here because of migration 0051 + 4 cron routes) |
| Branch | `claude/health-alarms` from `claude/phase3-batch8-integration` |
| PR target | `claude/phase3-batch8-integration` |
| Reserved migration | **0051** → `supabase/migrations/0051_cron_heartbeats.sql` (the conductor applies it) |
| Depends on | none. Reads the `autopilot.tick_errors` audit row written by `handsoff-autopilot` (parallel; contract below) |
| Conductor session | `session_01HtEg7XG4MPQU4omrd2BX69` (send_message ONLY if blocked; the PR body is the report) |
| Size | L |

## Goal
When the machine stops or degrades, Pedro hears about it within about an hour, by email AND in Sentry (so a dead Gmail token cannot hide its own alarm), and keeps hearing once a day until it is fixed. Readiness check `tasks/audit-2026-10-22-autonomy.md` items 5, 7, 9. Good looks like: a paused inbox, a tick that keeps erroring, a learning step that silently stopped, or a cron job that stopped running each raise one alert per 24h; every state the system enters by design stays silent.

## Context the worker needs
**The health check today** (`lib/reports/health.ts`, header comment `:1-20` is the design: "an emergency is activity that was due in a period and did not happen"). Rules are pure functions over a `HealthSnapshot` (`:38-56`) gathered by `gatherHealthSnapshot` (`lib/reports/snapshot.ts:313+`); `HEALTH_RULES` (`:182`); 24h dedupe through `audit_log` `health.alert` rows (`:17-19`, `newProblems :189`, `recordHealthAlert` in snapshot.ts ~393-410). Delivery: `sendNotification` (`lib/notify/send.ts:64`), which only reports to Sentry when NO inbox could send (`:95`). Hourly cron `spam-health-check` (0045). Tests: `tests/reports-health.test.ts`. Batch 2 lesson (routing.md row "Reports / alerts"): an emergency rule fired on a designed state → rework. Test every designed state stays silent.
**Gaps:**
- A paused inbox is silent by design (`health.ts:122`, "a breaker, which the tick already emails") — the tick emails once at the trip (`tick.ts:~339-345`), then nothing while sending is stopped. With one inbox that is a full stop.
- Tick errors: never stored today. `handsoff-autopilot` (parallel) adds, FROZEN CONTRACT: `audit_log` row `action = "autopilot.tick_errors"`, `entity_type = "tenant"`, `entity_id = tenant_id`, `metadata = { errors: string[] }` (≤ 20, each ≤ 300 chars), one per tick that had errors, none otherwise. Ticks run every 15 min (0041).
- Learning: no alarm when it stalls. Learners run in the tick (`lib/autopilot/learn.ts`, `learnFromOutcomes`); outcomes settle 14 days after a send at the latest (`lib/learning/reward.ts` ATTRIBUTION_WINDOW_DAYS); writer arms in `learning_arms` (learner `writer.evidence` / `writer.guidance`). Today every writer arm has 0 trials because no send is 14 days old yet (autopilot sends began 2026-10-17): that is a DESIGNED state and must stay silent.
- Cron jobs: no check that tick / send-queue / follow-up / reply poll actually ran. Sentry cron monitors were considered and dropped: they are a paid add-on beyond one monitor (cost rule, CLAUDE.md). Build it internally.

**Decisions (conductor):**
1. New rule `inbox_paused`: an inbox with a working token and `daily_cap > 0` is `paused` → alert (title, which inbox, since when if known from the breaker's `learning_insights`/`audit_log` row, what it stops, how to resume: Settings → Sending). The 24h dedupe gives the daily reminder. `emails_stuck` keeps ignoring paused inboxes (no double alert).
2. New rule `tick_errors`: ≥ 3 `autopilot.tick_errors` rows in the last 2 hours (i.e. most ticks failing) → alert listing the distinct error prefixes (text before the first ":"), up to 5. A single failing tick is silent.
3. New rule `learning_stalled`: alert when outcomes are due but none settled — at least 5 ROOT pitches with `sent_at` between 15 and 30 days ago exist, and no `writer.*` arm in `learning_arms` gained a trial in the last 7 days (use whatever column records it; if none does, say so and use the cheapest durable signal you can read, and name it). Also alert when a tick-errors row in the last 24 h has an error from the learning step (`learn`/`settle`/`presend`, read the `step()` names in tick.ts). Must be silent today (no 15-day-old sends).
4. Cron heartbeats, migration **0051**: table `public.cron_heartbeats (job text primary key, last_ok_at timestamptz, last_error_at timestamptz, last_error text, updated_at timestamptz default now())`, RLS on with NO policies (service role only), no tenant column (jobs are global). Helper `lib/reports/heartbeat.ts` `recordHeartbeat(job, { ok, error? })` (service-role client, never throws). Call it at the end of `app/api/autopilot/tick/route.ts`, `app/api/pitches/send-queue/route.ts`, `app/api/pitches/follow-up/route.ts`, `app/api/replies/poll/route.ts` — one call per run, on the authorized path, ok=false with a short error when the run returns 5xx. Read each job's real schedule from the migrations (0041, 0048, …) and quote it. New rule `job_silent`: a job whose `last_ok_at` is older than 3× its interval INSIDE its active window (send-queue only weekdays 15:00-22:50 UTC; judge it like `emails_stuck` judges windows) → alert naming the job and the Supabase/Vercel place to look. A job with no heartbeat row yet (first hours after deploy) is silent.
5. Every alert email also goes to Sentry: `Sentry.captureMessage("S.P.A.M. health: <title>", { level: "warning" })` once per delivered or undelivered alert, deduped exactly like the email. Do not change `lib/notify/*`.
6. Update the header comment of health.ts: the rule list, and that a paused inbox now re-alerts daily.

## Brain lessons
none matched (second brain not attached). Routing note: reports b2 rework = an emergency rule fired on a designed state. Core-context: read meaning into an absent input only after excluding every path that empties it on purpose (no heartbeat row yet, no 15-day-old sends, weekend, outside the send window).

## Files
Allowed to edit: `lib/reports/health.ts`, `lib/reports/snapshot.ts`, `lib/reports/heartbeat.ts` (new), `supabase/migrations/0051_cron_heartbeats.sql` (new), `app/api/reports/health/route.ts` (deps only), the 4 cron routes above (ONE heartbeat call each, nothing else), `tests/health-alarms.test.ts` (new), `tests/reports-health.test.ts` (extend).
Read only: `lib/autopilot/*`, `lib/notify/*`, `lib/learning/*`, migrations.
Forbidden: `lib/supabase/*` (types: list new table types under "Needs conductor"; use a local row type meanwhile), `lib/autopilot/*` (other worker), `lib/notify/*`, `lib/gmail/*`, `vercel.json`, any other migration number.

## Must not change (negative set)
- Existing rules fire exactly as today (google_disconnected, autopilot_stopped, emails_stuck); dedupe 24h unchanged.
- Designed states stay silent: budget cap, cooldowns, weekend, outside the window, daily-cap drip, no heartbeat row yet, no 15-day-old sends, a single failing tick.
- The 4 cron routes behave and respond exactly as today apart from the heartbeat write (a heartbeat failure never changes the response).
- Health check stays one email per run listing all new problems.

## Acceptance checks
1. Each new rule: one firing test and one test per designed silent state listed above.
2. 0051 on local Postgres 16: table created, RLS on, an anon/authenticated select returns nothing / is denied; upsert by job works. Paste output.
3. Heartbeat: each of the 4 routes calls it once per authorized run (source-order or fake test); unauthorized requests write nothing.
4. Sentry capture happens once per new problem, not on deduped ones.
5. `npm run typecheck && npm run lint && npm test && npm run build` green; count reported.

## External prerequisites
Migration 0051 applied before the deploy (conductor). Whether Sentry emails Pedro on a warning-level message: the conductor checks Sentry's alert rules.

## Prod verification
After deploy: `select job, last_ok_at, last_error_at from cron_heartbeats order by job;` → 4 rows within their intervals. `select metadata->>'kind', created_at from audit_log where action='health.alert' and created_at > '<deploy>';` → expected: `inbox_paused` only if an inbox is paused at that time; nothing else today.

## Out of scope
Changing breakers or the stage (other worker); send pacing; a second alert channel beyond Sentry.

## If blocked
Message the conductor with what you tried, what you need, and what you can still do meanwhile.
