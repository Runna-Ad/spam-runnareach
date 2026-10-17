# S.P.A.M. core context for workers

This is the ONLY project history a worker loads. Do not open `tasks/lessons.md`,
`tasks/session-log.md`, `tasks/todo.md` or `tasks/audit-2026-10-16.md` unless your
brief names a section. The conductor keeps this file under ~150 lines and refreshes it
after every retro.

## What this is
Human-in-the-loop AI sales engine for Rünna CA. Discovers Canadian/Mexican SMB prospects,
researches and scores them, writes bilingual (EN/ES) cold pitches, sends from warmed Gmail
inboxes, runs the reply/follow-up funnel. Owner: Pedro De Velasco. The product's reputation
rides on every email, so quality beats speed.

## Stack and commands
Next.js 16 App Router (Turbopack, React 19) · TypeScript strict, no `any` · Tailwind 4 ·
Supabase Postgres + RLS + pgvector (ref `ybbrpqzbedaxsmotgtkh`, SHARED with runna-hunter:
never assume a table is SPAM-only) · Anthropic SDK (cost-tracked, daily-capped wrapper in
`lib/anthropic/`) · Gmail API · Sentry · Vercel Hobby.

- `npm run typecheck` · `npm run lint` · `npm test` (node test runner, `tests/**/*.test.ts`)
- `npm run build` before claiming a UI change works. `npm run db:types` is conductor-only.
- Pre-commit (lefthook) runs tsc + eslint on staged files; CI runs all three on every PR.

## Pedro's standing rules (never argue, never re-litigate)
1. Near-free: AI API spend is fine, paid platforms/SaaS are not. Build it with our own
   data, DNS, Postgres, `pg_cron` + `pg_net`, Gmail API. Ask before any paid service.
2. Never name a client in a pitch. Capability-led framing, industry level, always.
3. Never fabricate a number. Source it (benchmarks table) or leave it out. Don't delete
   sourced numbers.
4. Run builds, tests and SQL yourself. Hand off only: UI checks needing a browser login,
   credentials, purchases, business decisions, prod deploy approval.
5. Never trust a handoff summary. Check disk/DB state before building on it.
6. `main` = prod. Nothing merges to `main` without Pedro's explicit "ship it".
7. Test addresses (`RUNNA_TEST_EMAILS`, pedrojr22@gmail.com and +tags) are excluded from
   every metric.
8. All cold-email CTAs go to the runna-hunter audit tool. No calls, no Loom, no video offers.

## Engineering rules (distilled from 105 lessons)
- Any helper a cron can reach uses the service-role client with an explicit tenant id,
  never the cookie client. Never call `requireUser()` from inside another server action.
- Every outbound-mail claim about the prospect (name, site, pain) is verified at the point
  it is used, never trusted from auto-discovered data.
- One predicate per question. If two code paths ask "does this prospect have a usable
  contact?" they call the same function. Gates and the UI that announces them share it.
- When a filter's failure is silent deletion (chain filter, DNC), test false positives.
- Encoders need a strict-decoder round-trip test, in every language we send.
- A scary external signal (DNSBL, DNS, 4xx from a source) gets a control query before
  automation acts on it. Reproduce with a raw tool first.
- Under Vercel's duration cap: budget by elapsed time not item count, every `fetch` gets
  `AbortSignal.timeout`, sum worst-case timeouts × retries, emit a heartbeat from the work
  itself, and self-chain via `after()` + fetch. A `Promise.race` timeout is not cancellation.
- Sentry cron check-ins are flushed before the route returns; `checkinMargin` is 60.
- LLM output: validate with zod, clip with `.transform` (never hard `.max`), size
  `max_tokens` to the worst-case schema, strip banned characters at output time, parse
  tool/JSON with a real parser. Keep new Claude calls inside the cost-tracking wrapper.
- Follow-ups and nudges re-read the Gmail thread and the DNC list right before sending.
- A bounce is not an out-of-office: NDRs suppress, OOO postpones.
- When a fix breaks a test, check whether the fixture matches production shape before
  touching the fix.
- Second repair heuristic for the same source → stop, fix the extractor.
- After a column rename, grep every query for the old name.
- Server-only types live in a `types.ts` with zero server imports; hooks live in client
  files.
- `noUncheckedIndexedAccess` is on: use `.charAt(0)`, `.find`, defaults.
- New enum value or discovery source: TS union + zod + UI meta + dispatch + migration.
- Error text shown to a human states what was observed, never an unreproduced diagnosis.
- Don't widen scope. If you see an unrelated bug, write it to your lessons-inbox file.

## Repo map and ownership
```
app/(dashboard)/*     18 pages            components/*   mirrors pages, plus ui/
app/api/*             14 cron/job routes  tests/         32 pure-logic test files
lib/discover/   (23 files) sources, dedupe, chain filter, DNC, MX, CSV     depends on research
lib/research/   (14 files) scraper, Claude research, SnapVerify, verify     leaf module
lib/pitches/    (23 files) composer, review, send-gate, guards, follow-ups  THE HUB, one worker at a time
lib/replies/    ( 8 files) classify, bounce parse, draft, send-reply        light coupling
lib/warmup/     (10 files) deliverability, DMARC, IMAP, placement           isolated
lib/{gmail,compliance,anthropic,supabase,audit,sentry}   shared infra, CONDUCTOR ONLY
supabase/migrations/0001..0039                            numbered, CONDUCTOR RESERVES
vercel.json, CLAUDE.md, lib/supabase/types.ts, package.json  CONDUCTOR ONLY
```
Your brief lists the files you may edit. Anything outside it: say so in the PR body, do
not edit. Need a migration? Use the number reserved in your brief, never the next free one.

## Integrations (status, 2026-10-17)
Anthropic ✅ · Google Places ✅ (primary discovery) · Yellow Pages CA ✅ (browser UA; a 403
means headers, not selectors) · Hunter.io ✅ · Anymail ✅ · Gmail OAuth ✅ · Brave ⚠ quota,
user-triggered only · DENUE ⚠ leave off · Yelp ❌ removed.

Pipeline: discovery → scrape → deep research → SnapVerify → score → triage → draft →
gate v2 → review loop (Haiku critic) → approve → send-queue → follow-ups → reply poll.
Paid enrichment fires only at score ≥ 70 inside `enrichContactsForProspect()`.

## Closed, do not re-open
DENUE "Vercel IP block" (false, it was our Accept header) · scraped-email glue (fixed at
the extractor) · duplicate migration 0005 (renumbered) · named clients in pitches
(removed everywhere) · Yellow Pages 403 (bot UA) · discovery restart loop (heartbeat).
Full list: `tasks/project-state.md` "Recently CLOSED".

## Definition of done for a worker task
1. Only files in the brief's allow-list changed (plus new tests).
2. `npm run typecheck && npm run lint && npm test` green locally; count of tests reported.
3. Acceptance checks in the brief demonstrated (command output or SQL result in the PR).
4. PR opened against the branch named in the brief, body uses the PR template section of
   `.claude/skills/worker/SKILL.md`.
5. `tasks/lessons-inbox/<slug>.md` written (even if "nothing new").
6. Conductor messaged with the 20-line report. Then stop; do not keep polishing.
