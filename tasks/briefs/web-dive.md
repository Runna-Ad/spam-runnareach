# Brief: web-dive

| | |
|---|---|
| Module | `lib/research/web-dive/` (new), the draft step of `lib/discover/pipeline-stage.ts`, one new step in `lib/autopilot/tick.ts` |
| Model / effort | opus-5.5 / high |
| Branch | worktree from `main` (local mode) |
| PR target | none: local mode. Do NOT commit, push or open a PR. Leave every change uncommitted in your worktree; your final message is the PR body (worker/SKILL.md section 6 format) |
| Reserved migration | `0055_web_research.sql` |
| Depends on | none. A second change (conductor, same batch) reads your `webFactsFor` and `WebFact` exactly as written below |
| Size | L |

## Goal
Before a prospect's first email is written, look at it twice: its own website (the existing crawler, `/api/research/observe`) and the rest of the web (new: one Claude call with the web_search tool). Keep a web fact only when code can show where it came from: the page URL and the exact text on it, about THIS business. Today the first email is drafted right after research, before either look; after this change it is drafted only once both looks are finished.

## Context the worker needs
- Incident (prod, 2026-11-09): CrushCamp, a Calgary fitness studio, got "I didn't see the viewport setting… we'd build you a site that works on any screen" and replied a hard no. The claim came from a crawler bug plus a research sentence our AI wrote. Pedro's rule now: "whatever we claim we are 100% sure its correct", and "do a deep dive on the web and if we cant find anything other than the website fine but look 1st".
- Pedro chose (2026-11-09): Claude web search (AI spend is allowed; no paid services), and the daily AI cap goes from $3 to $5 at ship. Measured: a web-search call in weekly fact research (Sonnet, 4 searches, ~50k input tokens) costs $0.20-0.22. First drafts: 10-24 a day. Busy-day AI spend today: $2.77-2.93.
- Reuse `lib/benchmarks/research.ts`: the `web_search_20250305` request as plain JSON, `readEvidence` (search result URLs + citations), `normalizeUrl`, `numbersCovered`, `researchCost` (adds $0.01 per search), the `isSearchDisabled` case, and "record cost on usage, never only on ok". Export what you need from there without changing its behaviour (`tests/fact-research*.test.ts` stay green and unchanged). `checkCandidate` itself is not reusable: it requires a figure.
- `isUnderDailyCap` (lib/anthropic/cost-tracking.ts:69) is a rolling 24h window and FAILS OPEN on a read error. For dives, treat an error as "do not dive".
- The crawler is the model to copy: `supabase/migrations/0054_site_observations.sql` (table, RLS, `claim_site_observations` with pending rows, abandon after 15 min, skip-locked, pg_cron via `spam_cron_call`), `lib/research/site-crawl/store.ts`, `app/api/research/observe/route.ts` (heartbeat, scheduler auth).
- The tick's re-draft step (lib/autopilot/tick.ts ~749-880: REDRAFTS_PER_TICK, a budget floor, audit rows on failure) is the model for the new "draft ready prospects" step. `REWRITE_MIN_BUDGET_USD = 0.25` (tick.ts:133).
- Prospect status `match` exists in the enum and is unused (lib/prospects/status.ts:26). It becomes "a good fit, waiting for both looks before its first email".

## The contract (the other change codes against this exactly)
`lib/research/web-dive/facts.ts` (pure, no server imports):
```ts
export type WebFactKind = "problem" | "opening" | "context";
export type WebFact = { fact: string; quote: string; url: string; title: string | null; kind: WebFactKind };
export const WEB_FACTS_MAX_AGE_DAYS = 60;
```
`lib/research/web-dive/store.ts`:
```ts
export async function webFactsFor(db: WebResearchDb, tenantId: string, prospectId: string, now?: Date): Promise<WebFact[]>;
// newest finished row (ok or empty) younger than 60 days; ok → its facts re-validated to the WebFact shape (bad entries dropped); anything else → []. Never throws: an error returns [].
export type LookState = "done" | "waiting" | "gave_up";
export async function webLookState(db, tenantId, prospectId, now?): Promise<LookState>;
// done = an ok/empty row in 60 days; gave_up = 2+ failed/abandoned rows in 60 days and no ok/empty; else waiting.
```
`kind`: problem = something the business or its customers say is not working (a review saying nobody answers, a post about a booking outage); opening = a change that makes them likely to need help (new location, hiring front-desk or marketing staff, a launch, an award); context = anything else true and useful (what they offer, where, since when).

## The keep-check (`keepWebFact`, pure, exported, fail closed, one reason per drop)
A candidate `{ fact, quote, url, kind }` is kept only when ALL hold:
1. `normalizeUrl(url)` is one of the URLs the search returned.
2. A citation whose URL normalizes the same has `cited_text` containing `quote` (both: lowercase, accents kept, whitespace collapsed, curly quotes straightened); `quote` is 20+ characters.
3. Every digit group in `fact` appears in `quote` (`numbersCovered`).
4. The URL host is not the prospect's own domain or a subdomain of it (the crawler covers their site).
5. It is about this business: the business name, normalized (lowercase, accents stripped, punctuation removed, legal suffixes dropped: inc, ltd, ltee, corp, corporation, llc, professional corporation, sa de cv, s de rl, sc, sa), 4+ characters, appears in `quote` or `title`; AND at least one of: the URL host is a page on their domain label (e.g. instagram.com/crushcamp has "crushcamp" in the path), the prospect's city appears in `quote` or `title`, or the prospect's domain appears in `quote`. A name that is one common word (use the existing word lists under lib/pitches/wordlists if one fits) needs the domain tie, the city is not enough.
6. `kind` is one of the three.
At most 6 kept facts per prospect.

## Flow
- Migration 0055 (copy 0054's shape): `web_research` (id, tenant_id, prospect_id, status text check in ('pending','ok','empty','failed','abandoned'), facts jsonb default '[]', searches int default 0, cost_usd numeric, model text, error text, dropped jsonb (candidate + reason, for debugging), started_at default now(), finished_at); index on (tenant_id, prospect_id, started_at desc); RLS like 0054 (tenant users read own; service role writes). `claim_web_research(p_limit int)`: abandon pending older than 10 min; due = prospects with status 'match', pitch_gate_passed true, not in DO_NOT_SEND_STATUSES, no ok/empty row in 60 days, fewer than 2 failed/abandoned rows in 60 days, no pitch row yet; oldest-updated first; insert pending; skip locked. pg_cron `spam-web-dive` every 15 minutes in the weekday window 15-22 UTC (offset from the other jobs' minutes). Header comment: ship order (code first, then the migration, as 0054 did) and the rollback (`cron.unschedule`).
- `app/api/research/web-dive/route.ts`: scheduler auth + `withHeartbeat("web-dive", …)`. Before each dive: cap − spent ≥ $0.50 and fewer than 25 rows started in the last 24h, else stop the run (rows stay unclaimed). At most 2 dives per run, the second only with ≥55 s left before a 105 s deadline; one Claude call each, 50 s client timeout, `max_uses: 4`, model `process.env.WEB_DIVE_MODEL ?? ANTHROPIC_DEFAULT_MODEL`. Outcomes: ok (1+ kept), empty (search ran, 0 kept), failed (error, timeout, pause_turn, unparseable, search disabled). Cost recorded whenever usage came back (entity_type "web_research"). Add the route to vercel.json with maxDuration 120.
- The prompt: name, city, region, country, domain, industry. Ask for facts about this business from pages other than its own website (reviews, local news, job posts, directories, social profiles, awards, new locations), each with the page URL, a verbatim quote and a kind; JSON only; "no facts" is a fine answer; never guess.
- Pipeline (pipeline-stage.ts:634-660): where it now calls `generatePitchWith` for a new prospect, write status `match` + `pitch_gate_passed: true` (via the same `writeStatus`) and an audit row `{ kind: "waiting_for_looks" }`, and settle as `match`. Check every reader of the settle outcome and of job stats ("pitched" counts, `scoutCredits` in lib/learning/scout.ts, the job's pitching catch-up) and keep them right: a prospect in `match` must not be lost to the learners or counted as a failure.
- Tick: new step "draft ready prospects" (after labels, before learners; mirror the re-draft step): status `match`, no pitch row, site look finished (a non-pending `site_observations` row in 30 days, or no website/domain, or 2 abandoned crawls) and `webLookState` done or gave_up; OR waiting more than 24 h since it entered `match` (then draft anyway, audit reason "looks timed out"). At most 2 per tick, only with ≥ `REWRITE_MIN_BUDGET_USD` left. Calls `generatePitchWith(actor, prospectId)`; on ok writes `pitched` exactly like the pipeline does; on failure an audit row like `REDRAFT_FAILED_ACTION`.

## Files
Allowed to edit: `lib/research/web-dive/*` (new), `app/api/research/web-dive/route.ts` (new), `supabase/migrations/0055_web_research.sql` (new), `lib/benchmarks/research.ts` (exports only), `lib/discover/pipeline-stage.ts` (the draft step), `lib/autopilot/tick.ts` (the new step only), `lib/learning/scout.ts` (only if `match` needs counting), `lib/reports/health.ts` (register the heartbeat like "site-observe"), `vercel.json` (the one route), `tests/web-dive*.test.ts` (new) and existing tests that the pipeline change legitimately changes (say which in the report).
Read, do not edit: `lib/pitches/*` (another change is editing them now), `lib/research/site-crawl/*`, `lib/anthropic/*`, `lib/prospects/status.ts`.
Forbidden: `lib/supabase/types.ts` (cast like observe/route.ts does), `CLAUDE.md`, `tasks/*` except `tasks/lessons-inbox/web-dive.md`.

## Must not change
- The manual "Generate pitch" button and `generatePitchWith` itself (rewrites tick.ts:716 and re-drafts tick.ts:867 draft as today).
- Weekly fact research: same calls, same rows, its tests unchanged.
- Prospects already `pitched`/`sent`: untouched. No backfill of existing prospects into `match`.

## Acceptance checks
1. `npm test` green; new tests for: every keep-check rule (a kept fact, and one drop per rule, including a same-name business in another city and a quote not in any citation); outcome mapping (ok / empty / failed for timeout, pause_turn, unparseable, disabled); budget stop (< $0.50 left, cap read error, 25 in 24h); `webFactsFor` (60-day limit, failed row ignored, bad entries dropped); `webLookState`; the tick step (ready → drafts; waiting → skips; 24 h → drafts with the reason; budget floor); the pipeline writes `match` and no longer drafts.
2. `npm run typecheck`, `npm run lint`, `npm run build` clean.
3. `scripts/web-dive-samples.ts`: real Claude on prospect ids given as arguments, prints each candidate, kept or dropped with the reason, and the cost; saves nothing, sends nothing. Header says it needs `node --env-file=.env.local` and is run by Pedro (you never run anything that reads `.env*`).

## External prerequisites
Migration 0055 applied by the conductor after the code ships (Pedro's "ship it"). `WEB_DIVE_MODEL` optional. Web search is already enabled for the Anthropic org (weekly fact research ran 2026-11-04).

## Prod verification
`select status, count(*), round(avg(cost_usd),3) from web_research where started_at > now() - interval '1 day' group by 1;` shows ok/empty rows and an average near the sample's cost; `select count(*) from prospects where status='match' and updated_at < now() - interval '1 day';` stays near 0.

## Out of scope
What the email writers do with web facts (the other change). Health alarm for prospects stuck in `match` (note it). Model choice beyond the env var.

## Questions already answered
Q: Retry a failed dive? A: once more on a later run (2 failures → gave_up, the draft goes on without web facts).
Q: Empty result? A: cache it 60 days; that is "we looked and found nothing", which is fine.
Q: Own-site facts? A: never from the dive; the crawler covers their site.
