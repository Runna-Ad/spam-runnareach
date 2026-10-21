# Brief: fact-research

| | |
|---|---|
| Module | `lib/benchmarks/research.ts` (new) + `app/api/benchmarks/research/route.ts` (new) |
| Model / effort | opus-5.5 / high (deviation from the medium leaf default: it decides what reaches Pedro as "sourced", a fail-closed sourcing check like the privacy filters) |
| Branch | `claude/fact-research` from `claude/phase3-batch7-integration` |
| PR target | `claude/phase3-batch7-integration` |
| Reserved migration | none. 0050 (`supabase/migrations/0050_wanted_facts.sql`) is already on the branch: read it first, it is your data contract |
| Depends on | 0050 + types (on the branch). Runs in parallel with `benchmark-matching` and `benchmark-review-ui` |
| Conductor session | `session_01HtEg7XG4MPQU4omrd2BX69` (send_message ONLY if blocked; the PR body is the report) |
| Size | M |

## Goal
Once a week, take the most-requested open "wanted facts" and look on the web for a solid, citable statistic for each, then store what was found as INACTIVE benchmark proposals for Pedro to approve. Good looks like: every proposal carries a real URL the search actually returned and a figure the source actually states; vendor-published figures are flagged; nothing is ever active without Pedro; when nothing solid exists the fact says so and we spend nothing more on it for 30 days. Pedro's example of a wanted fact: "how many stores have no cart recovery, and how much money that leaves on the table on average" (the conductor found no checked source for the first half; figures like that are usually vendor-published).

## Context the worker needs
**Data contract (0050):** `wanted_facts` rows (status `open | proposed | no_source | dismissed`, `request_count`, `pain_code`, `industry`, `market`). Rows are created via `record_wanted_fact()`; you only UPDATE `status`, `researched_at`, `research_note`. Benchmarks gain `wanted_fact_id`, `proposed_at`, `proposal_note`, `rejected_at`. The 0029 CHECK (`is_active = false or verified_at is not null`) and the 0050 CHECK (`rejected_at is null or is_active = false`) hold at the DB. Insert proposals with `is_active=false`, `verified_at=null`, `verified_by=null`, `wanted_fact_id`, `proposed_at=now()`, `pain_codes=[fact.pain_code]` (empty array if null), `industry_scope` and `market` as the model reports them, `source_url`, `publisher`, `published_date` (nullable), `is_vendor_sourced`, `caveat` (required: sample, geography, year, who published), `statistic` (one diagnostic sentence, the way it would be quoted), `figure` (bare figure, e.g. "70.22%"), `proposal_note` (the cited sentence + why the source is solid).

**Selection:** per tenant, up to 2 facts per run: `status='open'`, or `status='no_source' and researched_at < now()-30 days`; order `request_count desc, last_requested_at desc`. Tenants: reuse `reportTenantIds` (`lib/reports/snapshot.ts`, as `app/api/reports/weekly/route.ts` does).

**Route budget:** `vercel.json` gives `app/api/benchmarks/research/route.ts` maxDuration 120 (conductor added it). pg_cron calls it Wed 14:20 UTC (0050) with the scheduler token: auth exactly like `app/api/reports/weekly/route.ts` (`isSchedulerAuthorized`, Sentry `withCronMonitor` slug `spam-fact-research`, crontab `20 14 * * 3`). One Claude call per fact, client timeout 50 s. Start a fact only if ≥ 55 s remain before a 105 s deadline (so at most 2 per run). Anything after the last call (DB writes, the notification) must be safe to be killed: write the proposal rows and the fact's status in one step per fact, right after its call; the next run must not double-insert (dedupe below). `?dry=1` (still authorized) runs ONE fact and returns the proposals as JSON without writing anything; the conductor uses it on the preview, so it must work end to end.

**Claude call:** `getClient(50_000)` from `lib/anthropic/client.ts`, model `ANTHROPIC_DEFAULT_MODEL` (`claude-sonnet-4-5-20250929`), server tool `{ type: "web_search_20250305", name: "web_search", max_uses: 5 }` (the newer `_20260209` variant needs a 4.6+ model; we stay on our model). SDK is `@anthropic-ai/sdk ^0.40.0`: if its types lack the tool, cast at that one line; do not bump the package (conductor-only). Server-tool errors arrive as HTTP 200 with an error object in `web_search_tool_result.content` (a list on success, an object on error): branch on it. Handle `stop_reason: "pause_turn"` by treating the turn as unfinished (no proposals, note it). Web search must be enabled for the org in the Claude Console; a "web search not enabled" error records a note on the fact, leaves it `open`, and stops the run (one Sentry warning, no email).

**Cost (inside the $3 cap, Pedro's volume rule):** check `isUnderDailyCap(tenantId)` before EACH call; stop the run when not under. Record every call whose `usage` is non-null (parse failures are paid) with `recordClaudeCall({ entity_type: "fact_research", entity_id: fact.id, ... })`. `cost_usd` = `computeCostUsd(...)` for tokens PLUS `usage.server_tool_use.web_search_requests × $0.01` (web search is $10 per 1,000; computeCostUsd does not know it). Put `web_search_requests` in metadata. Test this sum.

**The sourcing invariant (fail closed, own matching):** search result content is encrypted, so the only text you can check is what the model cites. Ask the model to state each candidate figure in a sentence that cites its source (citations come back on `text` blocks as `citations[]` with `url`, `title`, `cited_text`), then return the structured proposals as JSON in its final text block. Keep a proposal only if ALL hold, checked by code that does not reuse the prompt's wording or the parser's regexes:
1. `source_url` equals (after trimming a trailing slash and `#fragment`) a `url` from a `web_search_result` in this response;
2. some citation with that same url has a `cited_text` containing every digit group of `figure` (digits-only comparison: "70.22%" needs "70.22"; "5 to 25 times" needs 5 and 25; a figure with no digit is rejected);
3. no existing benchmark row (any state, rejected included) has the same `source_url` + `figure`.
Drop anything else and say why in `research_note`. If the model's JSON does not parse, record the cost, note it, keep the fact `open`. Never retry in the same run.

**After a run:** if ≥ 1 proposal was written for a tenant, send ONE ops email through `lib/notify/send.ts` (`kind: "ops"`, `fromName: "S.P.A.M. research"`): how many statistics wait on /benchmarks, each with its figure, publisher and the wanted fact. No email when nothing was proposed (Pedro wants no routine mail).

## Brain lessons
none matched (second brain not attached to the conductor session on 2026-10-21; `_core-context.md` rules apply, especially: fail-closed check uses its own matching; record cost on usage, never on ok; a route's last step must survive being killed).

## Files
Allowed to edit:
- `lib/benchmarks/research.ts` (new: selection, prompt, call, invariant, writes; pure parts exported for tests)
- `app/api/benchmarks/research/route.ts` (new)
- `tests/fact-research.test.ts` (new), fixtures under `tests/fixtures/` (new)

Read for context, do not edit:
- `supabase/migrations/0050_wanted_facts.sql`, `lib/supabase/types.ts` (`wanted_facts`, `benchmarks`, `record_wanted_fact`), `lib/anthropic/client.ts`, `lib/anthropic/cost-tracking.ts`, `lib/cron-auth.ts`, `lib/sentry/cron.ts`, `lib/notify/send.ts`, `app/api/reports/weekly/route.ts`, `lib/reports/snapshot.ts`, `lib/benchmarks/queries.ts`

Forbidden: `lib/anthropic/*`, `lib/supabase/*`, `vercel.json`, migrations, `lib/benchmarks/queries.ts` and `lib/benchmarks/actions.ts` (other workers), `lib/pitches/*`.

## Must not change (negative set)
- No benchmark row is ever written with `is_active=true` or `verified_at` set by this code (test the insert payload).
- A fact with `status='dismissed'` or `proposed` is never selected; a `no_source` fact researched < 30 days ago is not selected.
- Over the cap → zero calls, zero writes, no email.
- A proposal whose url was not in the search results, or whose figure is not in a citation from that url, is never written, even if everything else is perfect.

## Acceptance checks
1. Fake-client tests (record a realistic response shape: `server_tool_use`, `web_search_tool_result` with results, `text` blocks with `citations`, final JSON text): one passing proposal written with the exact insert payload; one with an invented URL dropped; one with a figure not in any citation dropped; one with a figure cited from a DIFFERENT url dropped; duplicate source+figure dropped.
2. Show the invariant test failing when check 2 is removed (paste), then restore.
3. Error paths: search error object, `pause_turn`, unparseable JSON (cost still recorded), "web search not enabled", cap reached before the first and before the second call.
4. Budget: with a fake call taking 50 s, a run starts at most 2 calls and the second only when ≥ 55 s remain; the route returns before 120 s.
5. Cost: tokens + 3 searches → `cost_usd` = tokens cost + 0.03.
6. `?dry=1` writes nothing (fake db records zero inserts/updates) and returns the proposals.
7. `npm run typecheck && npm run lint && npm test` green; `npm run build` green (new route).

## External prerequisites
- Web search enabled for the Anthropic org in the Claude Console (Pedro; the conductor asks). Without it the run notes "web search not enabled" and stops.
- `ANTHROPIC_API_KEY` in Vercel Production and Preview (exists).

## Prod verification
1. Preview: `GET /api/benchmarks/research?dry=1` with `Authorization: Bearer $CRON_SECRET` (conductor) after inserting one manual wanted fact → JSON with proposals or a clear "no source" note; `cost_tracking` gains one `entity_type='fact_research'` row with `metadata->>'web_search_requests'`.
2. After the first Wednesday: `select status, count(*) from wanted_facts group by 1;` and `select figure, publisher, is_vendor_sourced, is_active, verified_at from benchmarks where wanted_fact_id is not null;` → proposals inactive, unverified; `select status_code from net._http_response where ... '/api/benchmarks/research'` 200.

## Out of scope
Recording wanted facts (wave 2 worker), the /benchmarks review UI (parallel worker), changing which benchmarks the writer gets, a "research now" button.

## Questions already answered
Q: Use web_fetch to read the page? A: No (more tokens, and the citation check is enough for a human-approved proposal). Note it as a follow-up if you think it is needed.
Q: Several proposals for one fact? A: Up to 3, best first.
Q: Which tenant for `reportTenantIds`? A: All it returns; per-tenant cap check.

## If blocked
Message the conductor with what you tried, what you need, and what you can still do meanwhile.
