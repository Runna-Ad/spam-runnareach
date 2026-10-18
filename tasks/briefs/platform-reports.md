# Brief: platform-reports

| | |
|---|---|
| Module | `lib/reports/` (new) + routes `app/api/reports/{weekly,health}/route.ts` (new) |
| Model / effort | opus-5.5 / medium. Routing puts pg_cron work on high; this migration is two `cron.schedule` rows copied from 0044's pattern and the conductor applies it, so medium |
| Branch | `claude/platform-reports` from `claude/conductor-skill-board-tasks-cu74t5` |
| PR target | `claude/conductor-skill-board-tasks-cu74t5` |
| Reserved migration | `supabase/migrations/0045_reports_cron.sql` (cron schedules only; do not take another number) |
| Depends on | wave 0 (landed): `lib/notify/send.ts`, `kind: "ops"` = pedro@runnareach.com + petedv31@gmail.com |
| Conductor session | `session_018Qvu38cNFVCuWNq41wYfxJ` (send_message ONLY if blocked) |
| Size | M–L |

## Goal
The autopilot runs unattended, and Pedro has no summary of what it did and no warning
when it silently stops. Pedro, 2026-10-18: "I don't want daily reports unless there's an
emergency, I'd rather just have weekly." Build (1) a weekly report every Monday 07:10
Mexico City time (13:10 UTC) of what the platform did and how healthy it is, and (2) an
hourly health check that emails ONLY when something is wrong, at most once per problem
per 24h, and is silent otherwise. Good = Pedro can read the weekly email in a minute and
trust every number in it; an emergency email names the problem, what it stops, and the
one thing to do about it. No AI calls: plain SQL and text, $0.

## Context the worker needs
- Send with `sendNotification(db, tenantId, { kind: "ops", ... })` (`lib/notify/send.ts`).
  Never pass an address. Service-role client (`lib/supabase/service-role`); tenants =
  rows of `autonomy_state` (one today).
- Auth: both routes `isSchedulerAuthorized(req)` (`lib/cron-auth.ts`), GET, `dynamic =
  "force-dynamic"`, return JSON (`{sent, failed, …}`). `?dry=1` (still authorized) returns
  the text it would send without sending, for the conductor's check.
- Schedule (your migration): copy `0044_calendar_sync_cron.sql`:
  `spam-health-check` at `25 * * * *` → `/api/reports/health`;
  `spam-weekly-report` at `10 13 * * 1` → `/api/reports/weekly`. pg_cron is UTC.
- Weekly report (plain text, ≤ 60 lines, this week vs last week where it helps):
  sent first emails + follow-ups; replies by intent; meetings booked; won / lost (value);
  opt-outs; bounces. Pipeline: discovery jobs, prospects researched, drafts, AUTO
  scheduled, held by a person (vetoes), auto-rejected (top 3 reasons). Autopilot: stage +
  `autonomy_state.reason`, breaker trips this week. Learning: top arms by trials from
  `learning_arms` (rates only with ≥ 20 trials, else "too early"), insights this week from
  `learning_insights`. Health: AI spend this week from `cost_tracking` (sum `cost_usd`,
  `incurred_at`) vs the cap (`ANTHROPIC_DAILY_USD_CAP` × 7), warmup inbox placement if
  measured, emergencies raised this week. Test addresses excluded from every count
  (`lib/compliance/test-addresses.ts`, `pitch_events.payload.test`). Missing data says
  "n/a", never 0.
- Emergencies (each a pure rule over a snapshot; the route gathers the snapshot):
  - E1 Google disconnected: `getAccessToken` fails for a connected `sender_inboxes` row.
    Stops: sending, reply reading, calendar sync. Do: reconnect in Settings → Sending.
  - E2 Autopilot stopped: `autonomy_state.enabled` and no tick evidence for 2h. Candidate
    signal: `autonomy_state.updated_at` (written by `evaluateStage` in
    `lib/autopilot/tick.ts`). VERIFY it is written on every tick, including when sending
    is halted or capacity is full; if not, find a per-tick write that is, or say so under
    "Needs conductor" instead of adding a table.
  - E3 Emails stuck: `pitches` in `approved` with `scheduled_send_at` more than 24h ago,
    or in `sending` for over 1h.
  - NOT emergencies: the AI budget cap (by design), breaker trips (the tick already
    emails them), a quiet day.
  - Dedupe: before sending, look for an `audit_log` row action `health.alert` with
    `metadata.kind` = the rule in the last 24h; after sending, write one. One email lists
    every new problem of that run.

## Files
Allowed to edit:
- `lib/reports/*` (new: e.g. `weekly.ts`, `health.ts` pure; `snapshot.ts` queries)
- `app/api/reports/weekly/route.ts`, `app/api/reports/health/route.ts` (new)
- `supabase/migrations/0045_reports_cron.sql` (new)
- `tests/reports-weekly.test.ts`, `tests/reports-health.test.ts` (new)

Read for context, do not edit: `lib/autopilot/tick.ts`, `lib/notify/*`, `lib/cron-auth.ts`,
`lib/audit/*`, `lib/learning/report.ts`, `supabase/migrations/0041_autopilot_scheduler.sql`, `0044_*.sql`.

Forbidden: `vercel.json` (ask under "Needs conductor": a daily Vercel cron backstop for
`/api/reports/health`), `lib/autopilot/**`, `lib/notify/**`, `lib/supabase/types.ts`, any other migration number.

## Must not change (negative set)
- No existing route, cron or table changes. No AI call anywhere in `lib/reports/`.
- A healthy snapshot produces NO email (test). The same problem two hours running
  produces ONE email (test). A problem that clears and returns after 24h emails again.

## Acceptance checks
1. `npm test`: weekly formatter over a fixture snapshot (numbers, "n/a", "too early",
   test addresses excluded); each emergency rule fires on its bad snapshot and not on a
   healthy one; dedupe window.
2. `npm run build` green; both routes 401 without the scheduler token.
3. PR body pastes a rendered weekly email and an emergency email from fixtures.

## External prerequisites
The conductor applies 0045 after the deploy (as with 0044). Nothing for Pedro.

## Prod verification
After deploy + 0045: `select jobname, schedule from cron.job where jobname like 'spam-%report%' or jobname = 'spam-health-check';`
→ both rows. Conductor runs `/api/reports/weekly?dry=1` and `/api/reports/health?dry=1`
via `spam_cron_call` and checks the text against a few direct queries; the first hourly
`net._http_response` for the health path shows `{sent: 0}` on a healthy system.

## Out of scope
A daily digest of any kind (Pedro said no). SMS/WhatsApp. A dashboard page.
