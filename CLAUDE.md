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
- Read `tasks/project-state.md` + `tasks/lessons.md` first — API integration status lives there.
- Supabase project is SHARED with runna-hunter (`hunter_scans`) — never assume a table is SPAM-only.
- Background jobs self-chain via `after()` + fetch (Vercel daily-cron tier), not queues; long routes have custom `maxDuration` in `vercel.json`.
- AI calls are cost-tracked + daily-capped — keep new calls inside that wrapper.
