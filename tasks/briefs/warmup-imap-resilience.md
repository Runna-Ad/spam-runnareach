# Brief: warmup-imap-resilience

| | |
|---|---|
| Module | `lib/warmup/` (IMAP client + placement checks) and the engine route that calls it |
| Model / effort | opus-5.5 / medium (`lib/warmup/` lane, isolated) |
| Branch | `claude/warmup-imap-resilience` from `claude/phase3-batch5-integration` |
| PR target | `claude/phase3-batch5-integration` |
| Reserved migration | none |
| Depends on | none. Parallel with the other four batch 5 tasks (disjoint files) |
| Conductor session | `session_017nqBxLFFXKbhDwKiPi6xLf` (send_message here ONLY if blocked; the PR body is the report) |
| Size | M |

## Goal
The daily warm-up run never crashes on a slow or dropped mail-server connection, and every
warm-up email it sends gets an inbox-or-spam check while the check can still find it. The
warm-up protects the young sending domain; its placement numbers feed the autopilot's
`placement` breaker and the warm-up's own spam pause, so a check that silently never runs
weakens both.

## Context the worker needs
- **The crash (Sentry SPAM-6, SPAM-7, 2026-10-20 14:22:34 UTC, release aa97013, GET /api/warmup/engine):**
  SPAM-6 `Error: Socket timeout`, level fatal, `mechanism auto.node.onuncaughtexception`, thrown from
  `node_modules/imapflow/lib/imap-flow.js` `_socketTimeout` (`const err = new Error('Socket timeout')`).
  SPAM-7 `Error: Connection not available`, `onunhandledrejection`, from `ImapFlow.close` →
  `createNoConnectionError`. The run still logged its 5 sends (last at 14:22:43).
- `lib/warmup/imap.ts:33-52` `makeImapClient` builds `new ImapFlow({... logger: false, connectionTimeout: 8_000, greetingTimeout: 5_000, socketTimeout: 12_000 })`
  with **no `.on("error")` listener**. imapflow 1.3.3: on a socket timeout outside IDLE it calls
  `emitError(err)` (`imap-flow.js:872-897`), which is `this.closeAfter(); this.emit('error', err)` (`:401-409`).
  With no listener Node throws: that is SPAM-6. `close()` then rejects the current request, the
  request queue and queued locks with `Connection not available` (`:1789+`).
- imapflow runs a hidden auto-IDLE: after each command in SELECTED state `run()` calls
  `autoidle()` (`:1586-1593`), a `setTimeout(() => this.idle()..., 15_000)` unless the client
  is built with `disableAutoIdle: true`. Our code never IDLEs on purpose.
- `processIncomingWarmupEmails` (`imap.ts:199-254`) keeps the IMAP connection open while it
  sends each buddy reply over SMTP (`await sendBuddyReply(...)` at `:231`); the IMAP socket is
  idle during that send, and `socketTimeout` is Node's inactivity timeout (`imap-flow.js:1671`).
- Placement checks, engine route `app/api/warmup/engine/route.ts:139-166`: `getPendingInboxChecks(config.id)`
  (`lib/warmup/queries.ts:214-228`: sends from the last **72 h**, `landed_in_inbox is null`,
  newest first, limit 20) then `.slice(0, 4)` with the comment "Cap at 4 per tick ... the rest
  are a sample we skip". The engine runs **once a day** (`vercel.json` `0 14 * * *`; the header
  comment at `route.ts:3` saying "every 30 minutes" is wrong), and step 2 runs BEFORE that day's
  sends. A skip (`continue`) still uses one of the 4 slots. After 72 h a row drops out of the
  query and stays null forever.
- `checkMessageInbox` returns null when credentials are missing (`:72`), the message is in no
  folder (`:141-143`), or anything throws (`:144-146`). The folder list has the Spanish
  `"[Gmail]/Todas las conversaciones"` but not `"[Gmail]/All Mail"` (`:100-105`).
- Prod, warm-up sends by day (5 a day to gmail.com buddies, all `message_id` RFC-shaped since the
  P1.6 fix): 10-16 4 of 5 checked, 10-17 4/5, 10-18 4/5, 10-19 3/5, 10-20 0/5 (checked
  tomorrow). 0 spam ever. Before 10-16 nothing was checked (old Message-ID bug, out of scope).
- Readers of `warmup_log.landed_in_inbox` (all treat null as "not measured", never as spam):
  `analyzeSpamRate` (`lib/warmup/intelligence.ts:57-86`, needs >= 5 checked, pauses at spam
  rate >= 0.20), the engine's step 3, `lib/autopilot/tick.ts:321-336` → `evaluateBreakers`
  `placement` breaker (`lib/autopilot/governor.ts:240-245`, trips below 0.8 inbox rate and pauses
  every sender inbox), `lib/warmup/reactivation.ts:96-107`, `components/warmup/warmup-dashboard.tsx`,
  `lib/reports/weekly.ts:166/210/341`.
- Time budget: `maxDuration` 120 s. `SEND_DEADLINE_MS = tickStart + 105_000` (`route.ts:95`, per
  config, includes steps 1-5). Order: day reset → checks → spam analysis (may pause and return)
  → day plan → sender auth → send loop → `incrementEmailsSentToday` → step 8
  `processIncomingWarmupEmails` for 2 buddies (no deadline check) → cron check-in + response.
  Sends are inserted as they happen (`insertWarmupLog` `:250`).

## Brain lessons
- serverless-durable-background-jobs.md: "Slice by time budget, not a fixed item count. Process
  until X ms left on the clock." and "Fire-and-forget does not exist: await every side effect"
  (a timer or event a library starts on our behalf counts).

## The changes
1. **No IMAP event escapes.** Every client gets an `error` listener (log a one-line warning with
   the buddy id, never the password) and no auto-IDLE. A timeout or drop at any step ends that
   check or that buddy's reply processing as a normal failure (check → row stays pending, as
   today). No uncaught exception and no unhandled rejection from `lib/warmup/imap.ts`, whatever
   step the connection dies in (connect, search, move, fetch, flags, logout, during the SMTP reply).
2. **Every send gets checked in time.** Replace the count cap with a time budget. Each daily run
   checks every pending row from the 72 h window (oldest first, so a row is retried before it
   ages out), stops starting new checks when its check budget is used, and never delays or
   skips that day's sends: the sends still start early enough to finish under `SEND_DEADLINE_MS`.
   A row that cannot be checked (no buddy, buddy inactive, no RFC id) does not use budget.
3. Add `"[Gmail]/All Mail"` next to the Spanish all-mail folder (and say in the PR if other
   locales are worth adding).
4. Fix the route header comment (once a day, Vercel cron `0 14 * * *`).

## Files
Allowed to edit:
- `lib/warmup/imap.ts`, `lib/warmup/queries.ts` (`getPendingInboxChecks` only), `lib/warmup/intelligence.ts` (only if a pure helper for the budget belongs there)
- `app/api/warmup/engine/route.ts`
- `tests/warmup-*.test.ts` (new tests always allowed)
Read for context, do not edit:
- `lib/autopilot/tick.ts`, `lib/autopilot/governor.ts`, `lib/warmup/reactivation.ts`, `lib/reports/weekly.ts`, `components/warmup/warmup-dashboard.tsx`, `node_modules/imapflow/lib/imap-flow.js`
Forbidden: `lib/supabase/types.ts`, `vercel.json`, `CLAUDE.md`, `lib/{anthropic,gmail,compliance,supabase}/` (the engine imports `lib/gmail/*`: do not change them), migrations.

## Must not change (negative set)
- The number of warm-up emails sent per day (`computeDayPlan`, daily target 5), buddy rotation, templates, the send deadline.
- A row is only ever set true (found in inbox/category/all-mail) or false (found in spam); "not found" and "error" leave it null. No new way to write false.
- The spam-rate pause rule and the `placement` breaker thresholds.

## Acceptance checks
1. `npm run typecheck && npm run lint && npm test` pass.
2. New tests with a fake ImapFlow (inject the client factory or the class; no network): a client
   that emits `error` / rejects with `Connection not available` at each step (connect, search,
   messageMove, fetchOne, messageFlagsAdd, logout, during the SMTP reply) → the function returns
   its failure value, and the test process records no `uncaughtException` and no
   `unhandledRejection` (attach listeners in the test and assert they never fired).
3. A test where 6 pending rows exist and checks are slow: the run checks oldest first within the
   budget, and the send step still runs. A test where a skip-able row (inactive buddy) does not
   consume budget.
4. Mutation table in the PR: remove the error listener / re-enable auto-IDLE / restore the count
   cap → the matching test fails.

## External prerequisites
none.

## Prod verification
After deploy: the next 14:00 UTC run has no SPAM-6/SPAM-7 event in Sentry; by the run after it,
`select date_trunc('day', created_at)::date d, count(*) filter (where landed_in_inbox is null) from warmup_log where direction='sent' and created_at > now() - interval '4 days' group by 1`
shows 0 unchecked for every day older than 24 h (unless a message is truly not found; the run's
JSON report should say how many were not found).

## Out of scope
Sends before 2026-10-16 (old Message-ID bug), the DMARC/postmaster syncs, reactivation rules,
warm-up volume. Lessons go to `tasks/lessons-inbox/warmup-imap-resilience.md`.

## Questions already answered
Q: Move the checks after the sends instead?  A: Your call, as long as sends never wait on checks and step 8 still has time; say which and why in the PR.
Q: Mark a never-found row as spam?  A: No. Not found is not spam; leave it null.

## If blocked
Message the conductor with what you tried, what you need, and what you can still do meanwhile.
