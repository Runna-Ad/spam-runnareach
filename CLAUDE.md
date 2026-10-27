# S.P.A.M. (Runna CA Opportunity Engine)

## What this is
Human-in-the-loop AI sales engine for Rünna CA: discovers Canadian/Mexican SMB prospects, researches + scores them, writes bilingual cold pitches, sends from warmed Gmail inboxes, and runs the reply/follow-up funnel.

## Stack
Next.js 16 (App Router, Turbopack, React 19) · TypeScript strict · Tailwind 4 · Supabase (Postgres + RLS + pgvector, ref `ybbrpqzbedaxsmotgtkh`) · Anthropic SDK (Sonnet + Haiku) · Gmail API · Google Places · Sentry · Vercel.

## Commands
- Dev: `npm run dev`
- Build: `npm run build` (also `npm run typecheck`, `npm run lint`)
- Test: `npm test` (node test runner, `tests/**/*.test.ts`)
- DB types: `npm run db:types`

## Deploy
Vercel project `spam-runnareach` → https://spam-runnareach.vercel.app. Repo `Runna-Ad/spam-runnareach`. Prod deploy needs Pedro's explicit "ship it".

## Key conventions
- Read `tasks/project-state.md` + `tasks/lessons.md` first — API integration status lives there. **Exception: a worker session started from a brief** (`tasks/briefs/<slug>.md`) reads `tasks/briefs/_core-context.md` instead and nothing else from `tasks/`; see `.claude/skills/worker/SKILL.md`.
- Supabase project is SHARED with runna-hunter (`hunter_scans`) — never assume a table is SPAM-only.
- Background jobs self-chain via `after()` + fetch (Vercel daily-cron tier), not queues; long routes have custom `maxDuration` in `vercel.json`.
- AI calls are cost-tracked + daily-capped — keep new calls inside that wrapper.
- **Cost rule (Pedro, 2026-10-16):** until S.P.A.M. is proven to make money, stay as close to free as possible. AI API spend is fine; paid external platforms/SaaS are not. Build or solve it internally (our own data, DNS, Postgres, Supabase `pg_cron`, Gmail API) unless there is truly no other way, and ask before adding any paid service. Scheduler = Supabase `pg_cron` + `pg_net`, not Vercel Pro.
- **Volume rule (Pedro, 2026-10-17):** while the platform learns, the autopilot researches at most 100 prospects a day (`MAX_PROSPECTS_PER_DAY`, `lib/learning/scout.ts`) and Claude spend is capped at $3 per rolling 24h (`ANTHROPIC_DAILY_USD_CAP` in Vercel; code default $6). Don't raise either without asking.

## Multi-agent mode (since 2026-10-17; generic core since 2026-10-27)
Phases are run by one **conductor** session that first decides whether to split the work at all (separability test + size ladder: solo, solo + reviewer, in-session workers, separate sessions), then briefs, spawns, reviews and integrates **workers** (one module, one brief, one fresh context each, model per `tasks/routing.md`).
- Skills: `.claude/skills/{conductor,worker,steward}` and agents `.claude/agents/{reviewer,opus-worker,sonnet-worker}.md` are project-neutral (ready to become a plugin). Everything S.P.A.M.-specific (ship gate, commands, protected files, serialized modules, migrations, ship checklist, cost rules) is in `tasks/conductor-config.md`.
- State lives in `tasks/board.md`; a new conductor session resumes from it. Briefs in `tasks/briefs/`; worker lessons go to `tasks/lessons-inbox/<slug>.md`, never straight into `lessons.md`. Past brief and review misses, sorted by principle: `tasks/checklists/`. Older board and lessons sections: `tasks/archive/`.
- Workers PR into `claude/<phase>-integration`; only the conductor opens the integration → `main` PR, and nothing merges to `main` without Pedro's "ship it".
- After every batch the conductor writes `tasks/retros/<date>.md`, applies its edits (routing, core-context, checklists, skills or config) and archives old board/lessons sections. That loop is how the system gets better; skipping it is not allowed.
