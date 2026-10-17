# S.P.A.M. core context for workers (refreshed 2026-10-17 after Phase 2)

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
  (node test runner, `tests/**/*.test.ts`, 499 tests at Phase 2 ship)
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
lib/autopilot/         governor (pure), tick, learn                 CONDUCTOR ONLY unless briefed
lib/learning/          bandit, reward, segments, outcomes, scout, icp, hunter-weights (pure)
lib/discover/  (33)    sources, dedupe, chain filter, DNC, enrich-contacts, pipeline-stage
lib/research/  (19)    scraper, scrape/deep-research/score stages, SnapVerify, verify-recipient
lib/pitches/   (25)    composer, review, gate, send-gate, queries, events, stages   THE HUB
lib/replies/   ( 8)    classify, bounce parse, draft, send-reply
lib/warmup/    (10)    deliverability, DMARC, IMAP, placement
lib/{gmail,compliance,anthropic,supabase,audit,sentry,cron-auth}  shared infra  CONDUCTOR ONLY
supabase/migrations/0001..0043   numbered; YOUR brief reserves yours (never the next free one)
vercel.json, CLAUDE.md, lib/supabase/types.ts, package.json         CONDUCTOR ONLY
```
Your brief lists the files you may edit. Anything outside it: say so in the PR body under
"Needs conductor", do not edit.

## Integrations (status, 2026-10-17)
Anthropic ✅ · Google Places ✅ (primary discovery) · Yellow Pages CA ✅ · Hunter.io ✅ ·
Anymail ✅ · Gmail OAuth ✅ (scopes: gmail.send/readonly/modify, postmaster.readonly) ·
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
6. Conductor messaged with the 20-line report. Then stop.
