# S.P.A.M. core context for workers (refreshed 2026-10-21 for Phase 3 batch 7)

This is the ONLY project history a worker loads. Do not open `tasks/lessons.md`,
`tasks/session-log.md`, `tasks/todo.md`, `tasks/project-state.md` or
`tasks/audit-2026-10-16.md` unless your brief names a section.

## What this is
Human-in-the-loop AI sales engine for Rünna CA. Discovers Canadian/Mexican SMB prospects,
researches and scores them, writes bilingual (EN/ES) cold pitches, sends from warmed Gmail
inboxes, runs the reply/follow-up funnel. Owner: Pedro De Velasco. The reputation of a
real agency rides on every email: quality beats speed.

**The autopilot is LIVE in production** (veto stage): `pg_cron` calls `/api/autopilot/tick`
every 15 min, reply poll every 30 min, send-queue every 10 min on weekdays. Nothing you
build runs in prod until Pedro says "ship it", but the Vercel preview of any branch
shares the prod database. So: never run SQL or migrations against the database, never
add or change `cron.schedule` jobs outside a reserved migration, never touch
`lib/autopilot/tick.ts` or the send paths unless your brief says so.

## Stack and commands
Next.js 16 App Router (Turbopack, React 19) · TypeScript strict, `noUncheckedIndexedAccess`,
no `any` · Tailwind 4 · Supabase Postgres + RLS + pgvector (ref `ybbrpqzbedaxsmotgtkh`,
SHARED with runna-hunter: never assume a table is SPAM-only) · Anthropic SDK through the
cost-tracked, daily-capped wrapper in `lib/anthropic/` · Gmail API · Sentry · Vercel Hobby.

- `npm ci` once on a fresh clone, then `npm run typecheck` · `npm run lint` · `npm test`
  (node test runner, `tests/**/*.test.ts`, 1258 tests at batch 7 start)
- `npm run build` before claiming a UI change works. `npm run db:types` is conductor-only;
  `lib/supabase/types.ts` is hand-maintained and conductor-only.
- Pre-commit (lefthook) runs tsc + eslint; CI runs all three on every PR.

## Pedro's standing rules (never argue, never re-litigate)
1. Near-free: AI API spend is fine, paid platforms/SaaS are not. Our own data, DNS,
   Postgres, `pg_cron` + `pg_net`, Gmail/Google APIs. Ask before any paid service.
2. Never name a client in a pitch. Capability-led, industry-level framing.
3. Never fabricate a number. Source it or leave it out. Don't delete sourced numbers.
4. Run builds, tests and checks yourself. Hand off only credentials, purchases,
   business decisions, browser-only UI checks, and prod deploy approval.
5. Never trust a handoff summary; check disk state.
6. `main` = prod. Nothing merges to `main` without Pedro's explicit "ship it".
7. Test addresses (`RUNNA_TEST_EMAILS`, pedrojr22@gmail.com, +tags, Gmail dots) are
   excluded from every metric and never counted as prospects.
8. Every cold-email CTA goes to the runna-hunter audit tool. No calls, no Loom.
9. Volume rule (2026-10-17): while the platform learns, the autopilot researches at most
   100 prospects a day (`MAX_PROSPECTS_PER_DAY`, `lib/learning/scout.ts`) and Claude spend
   is capped at $3 per rolling 24h (`ANTHROPIC_DAILY_USD_CAP`). Never raise either.

## Engineering rules (distilled from 105+ lessons)
- **Actor model** (`lib/actor.ts`): every pipeline stage lives in a `*-stage.ts` file as
  `xxxWith(actor, …)`; the `"use server"` `*-action.ts` files are thin session wrappers.
  Crons and the autopilot pass `systemActor` (service role + explicit tenant). Never call
  `requireUser()` from inside another server action; never use the cookie client in
  anything a cron can reach.
- One predicate per question. If two paths ask "is this contact usable" or "may this
  send", they call the same function. A gate and the UI that announces it share it.
- Every claim an outbound email makes about the prospect is verified where it is used.
- Any `fetch` has `AbortSignal.timeout`; sum worst-case time × retries under the route's
  `maxDuration` (`vercel.json`: Vercel uses the FIRST matching pattern); emit a heartbeat
  from the work itself; `Promise.race` is not cancellation.
- Sentry cron check-ins flush before the route returns; `checkinMargin` is 60.
- LLM output: zod with `.transform` clipping (never hard `.max`), `max_tokens` sized to
  the worst-case schema, banned characters stripped at output, JSON parsed by a parser.
- Displayed rates are gated on sample size with an explicit confidence label; an
  observation-only view says so. n=1 is not a signal.
- When a fix breaks a test, check the fixture against production shape first.
- Second repair heuristic for the same source → stop, fix the extractor.
- After a column rename, grep every query for the old name. New enum value: TS union
  (conductor) + migration (reserved number) + every switch/regex on the union.
- Server-only types live in a `types.ts` with zero server imports; hooks in client files.
- `noUncheckedIndexedAccess`: `.charAt(0)`, `.find`, defaults.
- Errors shown to humans state what was observed, never an unreproduced diagnosis.
- Timeline events (opt-out, meeting booked, won, lost) are recorded on the ROOT pitch:
  use `latestRootSentPitchId()` in `lib/pitches/root-pitch.ts`. Follow-ups are child rows
  with a later `sent_at`; "latest sent pitch" picks the wrong row.
- A scrubber, filter or classifier is a list of rules and will miss cases. Guard it with
  an output invariant that fails closed, plus a property test, and show the new tests
  failing on the old code.
- Enum values added by a migration ship with their TS union in the same commit.
- A fail-closed check must not reuse the code it guards: give it its own, coarser
  matching (letters-only fold, substring), and give the property test a third.
- A route's last step runs after its time budget. Anything there must be safe to be
  killed at maxDuration: claim/mark only when there is time to finish, and sweep
  leftovers at the START of the next run.
- An alert or emergency rule is "due activity did not happen in a closed window", never
  "something is waiting"; every state the system enters by design must stay silent.
- A value you write that another module reads (reason strings, statuses): grep the
  reader and match its check exactly; share the constant (e.g. `HELD_BY_PERSON`).
- Prospect status writes go through `lib/prospects/status.ts` (`protectedStatusFilter`);
  a real outcome (booked/won/lost) is never overwritten by an automated writer.
- A send-time permission check (prospect status, cooldown, DNC) runs AFTER the claim and
  immediately before the external call (no `await` in between), reads fresh, and fails
  closed on "no row" as well as on an error (`if (row && bad(row))` is fail-open). Every
  release of a claim carries the claimed state in its WHERE; a status transition puts its
  allowed from-states in the UPDATE's WHERE (`lib/pitches/status-transitions.ts`).
- Test an error field for presence, not truthiness: postgrest-js reports an empty-body
  502/503/504 as `{ message: "" }`, and `if (error.message)` then reads as success.
- Never key a "recent" window on `updated_at`: the 0001 trigger bumps it on every write,
  your own claim/release included. Use a column only the event writes (`cancelled_at`).
- A migration is applied before the deploy, so the OLD code runs against the new schema
  for a while: say what happens to rows it writes in that gap (null new columns, side
  effects the new code will repeat) and add the cleanup step to the brief.
- An overlap/race test proves itself: delete the guard, see the test fail, restore. A fake
  read snapshots its rows BEFORE it yields, or two "concurrent" runs never overlap.
- A fake db must reject a column the real table does not have: check every selected/ordered
  column against the migration's `create table` (tests/send-path-hardening.test.ts has a
  helper). Batch 4: `pitch_events.created_at` (the column is `event_at`) passed every test.
- A repair or backfill that calls a shared routine writes whatever that routine writes, dated
  now. Before calling it, grep who counts those rows by time (autopilot breakers, learners,
  reports) and write only the missing state (batch 5: a DNC repair would have dated two July
  opt-outs today and tripped the opt_out_spike breaker on the deploy week).
- A deadline or time budget is checked at the largest load the code is designed for (read the
  schedules and constants, e.g. warm-up ramp and re-warm reach 50 sends a day), and every
  step between two deadlines gets its own reserve (batch 5: a check budget that fit 5 a day
  ate the sends at 50, then the next fix starved the reply step at 20-50).
- Record a Claude call's cost when `usage` is non-null, never on `ok`: parse and schema
  failures are paid. A helper that calls Claude without a tenant in scope returns the call
  (model + usage) to its caller, which records it. A `"use server"` export that spends money
  checks the login before the call (batch 6: an unauthenticated paid Haiku action).
- Before handing stored text back to a model (a rewrite, a revision), reverse every step
  the code applied after the model answered: filled `{hunter_url}` links (they carry the
  pitch's attribution code), appended lines. Test with a fake model that copies its input
  (batch 6: a rewrite would have kept the old pitch's code and lost its scans).
- Client state (`useState`) survives `router.refresh()`: when a server prop disables a
  control, derive the effective state from both (`hotOnly && !unavailable`), never from
  the raw state alone.
- Every notification email to the team (alerts, digests, reports, lead alerts) goes
  through `lib/notify/send.ts` with `kind: "ops"` (everything: Pedro's two addresses) or
  `kind: "lead"` (prospect replies and bookings: ops + the sales team). Never read a
  `*_NOTIFY_EMAIL` variable or hard-code an address. Pedro wants a weekly report and
  emergency-only alerts, never a routine daily email.
- Don't widen scope. Unrelated bugs go in your lessons-inbox file; if one is the root
  cause of your own task's risk, say so at the top of your report.

## Repo map and ownership
```
app/(dashboard)/*      pages (analytics, benchmarks, companies, discover, funnel, icp, inbox,
                       learning, notable-clients, opportunities, pitches, settings, warmup …)
app/api/*              cron/job routes: autopilot/tick, pitches/{send-queue,follow-up},
                       replies/{poll,nudge}, warmup/*, discover/{run,janitor}, public/hunter-signals
components/*           mirrors pages, plus ui/ (Chip, Button, Card, EmptyState …)
lib/actor.ts           Actor type, systemActor, session actor      CONDUCTOR ONLY
lib/autopilot/         governor (pure), tick, learn, hold, bounce-breaker, inbox-resume   CONDUCTOR ONLY unless briefed
lib/learning/          bandit, reward, segments, outcomes, scout, icp, hunter-weights (pure)
lib/discover/  (33)    sources, dedupe, chain filter, DNC, enrich-contacts, pipeline-stage
lib/research/  (19)    scraper, scrape/deep-research/score stages, SnapVerify, verify-recipient
lib/pitches/   (25)    composer, review, gate, send-gate, queries, events, stages   THE HUB
lib/replies/   ( 8)    classify, bounce parse, draft, send-reply, intent-actions
lib/opportunities/ (5) calendar-sync (hourly), google-calendar, outcome, actions, queries
lib/prospects/  ( 2)  detail actions + queries (status writers live in several modules)
lib/hunter/     ( 3)  hunter_scans → prospects (table shared with runna-hunter)
lib/benchmarks/ ( 2)  sourced statistics: lookup for the writer (queries), approve action; wanted_facts (0050)
lib/warmup/    (10)    deliverability, DMARC, IMAP, placement
lib/{gmail,compliance,anthropic,supabase,audit,sentry,cron-auth,notify}  shared infra  CONDUCTOR ONLY
supabase/migrations/0001..0050   numbered; YOUR brief reserves yours (never the next free one)
vercel.json, CLAUDE.md, lib/supabase/types.ts, package.json         CONDUCTOR ONLY
```
Your brief lists the files you may edit. Anything outside it: say so in the PR body under
"Needs conductor", do not edit.

## Integrations (status, 2026-10-18)
Anthropic ✅ · Google Places ✅ (primary discovery) · Yellow Pages CA ✅ · Hunter.io ✅ ·
Anymail ✅ · Gmail OAuth ✅ (scopes: gmail.send/readonly/modify, postmaster.readonly, calendar.readonly; Calendar API enabled in GCP) ·
Brave ⚠ quota · DENUE ❌ off (key invalid) · Yelp ❌ removed.

Pipeline: discovery → scrape → deep research → SnapVerify → score → triage → draft →
gate v2 → review loop (Haiku critic) → governor lane (AUTO/REVIEW/DROP) → veto digest →
send-queue → follow-ups → reply poll. Paid enrichment fires only at score ≥ 70.

## Definition of done for a worker task
1. Only files in the brief's allow-list changed (plus new tests).
2. `npm run typecheck && npm run lint && npm test` green locally; count of tests reported.
   `npm run build` green if you touched `app/` or `components/`.
3. Acceptance checks in the brief demonstrated (command output) in the PR body.
4. PR opened against the branch named in the brief, body per `.claude/skills/worker/SKILL.md`.
5. `tasks/lessons-inbox/<slug>.md` written (even if "nothing new").
6. The Report block at the top of the PR body is filled in. No message to the conductor
   unless blocked (the PR event wakes it). Then stop.
