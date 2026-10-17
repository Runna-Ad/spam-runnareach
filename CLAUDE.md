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

## Multi-agent mode (since 2026-10-17)
Phases are run by one **conductor** session that briefs, spawns, reviews and integrates **workers** (one module, one brief, one fresh session each, model per `tasks/routing.md`).
- Conductor procedure: `.claude/skills/conductor/SKILL.md`. State lives in `tasks/board.md`; a new conductor session resumes from it.
- Worker procedure: `.claude/skills/worker/SKILL.md`. Briefs in `tasks/briefs/`, lessons go to `tasks/lessons-inbox/<slug>.md`, never straight into `lessons.md`.
- PR conventions: `.claude/skills/steward/SKILL.md`. Workers PR into `claude/<phase>-integration`; only the conductor opens the integration → `main` PR, and only Pedro merges it ("ship it").
- Conductor-only files: `lib/supabase/types.ts`, `vercel.json`, `CLAUDE.md`, `lib/{anthropic,gmail,compliance,supabase}/`. Migrations: the conductor reserves the number on the board; the worker writes the file at that number; the conductor applies it.
- After every batch the conductor writes `tasks/retros/<date>.md` and applies its edits to routing, core-context, the reviewer checklist and the skills. That loop is how the system gets better; skipping it is not allowed.
