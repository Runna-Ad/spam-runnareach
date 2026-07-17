# S.P.A.M. — Project State

> Rünna CA Opportunity Engine: discovers Canadian/Mexican SMB prospects, researches +
> scores them, auto-composes bilingual cold pitches, sends via warmed Gmail inboxes,
> and runs a reply/follow-up/nudge funnel. Created this file 2026-07-17 (wrap-up).

## Stack
- **Next.js 16** (App Router, server actions, `after()`), React, TypeScript (no `any`)
- **Supabase** — Postgres + RLS + pgvector + edge functions (`verify-email` SMTP probe). Project ref `ybbrpqzbedaxsmotgtkh` (S.P.A.M — East US). Auth: cookie-based `requireUser()`.
- **Anthropic SDK** — Sonnet (pitch/research/search), Haiku (SnapVerify people-extract, website pitch). Cost-tracked + daily-capped.
- **Vercel** — prod `spam-runnareach.vercel.app` (project `pedros-projects-c43384db/spam-runnareach`). Daily-cron tier → background jobs self-chain via `after()`+fetch, not queues.
- Tailwind 4, Radix, cmdk, zod, cheerio, p-retry, Sentry.
- **Sibling repo:** `runna-hunter` (separate Vercel project) — the self-serve Inefficiency Hunter the pitch CTA deep-links to.

## What's deployed
- Prod = commit **`38e04e4`** (2026-07-17). `origin/main` in sync.
- Warmup engine live (pedro@runnareach.com, ramped to 50/day across 7 buddy inboxes).
- Full pipeline live: discovery → scrape → deep research → SnapVerify → pain extraction → score → triage (<50 suppress / 50-69 B-list / ≥70 enrich+pitch) → drip send → reply funnel.

## API integrations
| Service | Status |
|---|---|
| Anthropic (Claude) | ✅ working |
| Google Places | ✅ working (primary discovery source) |
| Brave Search | ⚠️ **HTTP 402 — quota/subscription exhausted.** Needs billing at api-dashboard.search.brave.com. Powers deep research + AI Search + no-website discovery. |
| DENUE (INEGI, MX) | ⚠️ **HTTP 406 — INEGI WAF blocking Vercel's US datacenter IP.** New token set 2026-07-17 (`10fa44b8…`); browser-UA fix deployed. If still 406 after an MX run, needs a MX proxy or leave off. |
| Hunter.io | ✅ working (contact tier 3) |
| Anymail Finder | ✅ working (contact tier 2) |
| Gmail API (OAuth) | ✅ working (send + reply poll + DMARC ingest) |
| Yelp | ❌ **REMOVED 2026-07-17** (expired trial; code deleted). `YELP_API_KEY` still in Vercel but inert — safe to delete. |

## Key DB tables
`prospects` · `prospect_research` (pain_points, what_they_do, tech_stack) · `prospect_contacts` (priority_rank: 0 manual > 1 verified > 2 scraped > 3-5 role/guess) · `pitches` · `scores` · `discovery_runs` · `discovery_jobs` (self-chaining worker) · `replies` · `icps` · `case_studies` · `pain_taxonomy` · `sender_inboxes` · `cost_tracking` · `audit_log` · `hunter_scans` · `do_not_contact_list` · `blackout_dates`.

## Known issues / tech debt (open, deliberate — need Pedro's call)
- Catch-all *guessed* addresses (`snapverify_catchall_guess`) still auto-send when they're the only contact.
- Hunter confidence 50-69 addresses still inserted (rank 3).
- Discovery "discovering" phase is still one slice — can exceed 120s on 5-keyword ICPs (janitor now auto-closes the stuck run; per-source slicing deferred).
- LATAM market mapping is contradictory (run-all → CA, crawl insert → MX).
- Suppression is per-prospect, not per-email-address (a bounced address on a duplicate prospect could be re-emailed).
- Website-pitch fallback template is English-only (the Claude path localizes).
- 55 legacy junk contacts still in DB (unsendable; cleanup DELETE ready in `scripts/audit-2026-07-17-review.sql`).

## Recent sessions
- **2026-07-17** — Critical-fail audit: fixed the Acadian fake-website pitch, email-bounce root causes, Yelp/Brave/DENUE, + ~20 more via a 3-agent full-system audit. Shipped `38e04e4`. (this session)
- **2026-07-09** — Cost reduction: prompt caching, closed a cap hole, cut redundant scoring (~20-35% cheaper/run).
- **2026-06-25** — Pitch↔Hunter handoff (P1-P4), reply nudge, bounce→suppress, triage tiers, discovery time-budgeting.
