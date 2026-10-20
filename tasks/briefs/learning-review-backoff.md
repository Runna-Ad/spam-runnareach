# Brief: learning-review-backoff

| | |
|---|---|
| Module | `lib/autopilot/learn.ts` (`weeklyReview` only) |
| Model / effort | opus-5.5 / high (`lib/autopilot/` lane; spends Claude money every tick when wrong) |
| Branch | `claude/learning-review-backoff` from `claude/phase3-batch5-integration` |
| PR target | `claude/phase3-batch5-integration` |
| Reserved migration | none |
| Depends on | none. Parallel with the other batch 5 tasks. `followup-path-hardening` edits `lib/autopilot/hold.ts` (the approval lookup); you edit only `learn.ts` |
| Conductor session | `session_017nqBxLFFXKbhDwKiPi6xLf` (send_message here ONLY if blocked; the PR body is the report) |
| Size | S |

## Goal
The weekly AI writing review costs at most one paid attempt a day, whatever goes wrong, and a
failure says why. Today a failed review leaves no trace its guard can see, so it retries on every
15-minute tick: 59 paid calls, $1.47 in 72 h, about 18% of the $3/day Claude budget, which
pushes the daily cap earlier and stops discovery for the rest of the day.

## Context the worker needs
- `weeklyReview` (`lib/autopilot/learn.ts:399+`), called from the tick (`lib/autopilot/tick.ts:224-226`,
  every 15 min, only `if (Date.now() < deadline)`). Its guard (`:400-407`): count
  `learning_insights` rows with `learner = 'review'` created in the last 7 days; if any, return
  "reviewed this week". Then: >= 10 root sends in 14 days, `claudeIsAvailable()`,
  `isUnderDailyCap`. Then a paid `structuredCall({ model: ANTHROPIC_DEFAULT_MODEL, system:
  REVIEW_SYSTEM, user: <evidence JSON>, max_tokens: 1500, timeoutMs: 45_000, schema: reviewSchema })`,
  cost recorded with `metadata: { kind: "learning_review" }` (`:461-468`).
  `if (!call.ok) return { ran: false, reason: "review call failed", guidance: [] };` (`:469`):
  **no insight is written**, so the guard never trips and the next tick pays again. Only a
  success writes `learner: 'review'` insights (observations, discarded proposals, challengers,
  or "no new guidance this week").
- `structuredCall` (`lib/anthropic/client.ts`, conductor-only, do not edit) returns
  `{ ok: false, error, usage, reason: "auth" | "rate_limit" | "timeout" | "parse" | "unknown" }`.
  JSON parse failure (after one mechanical repair) and zod schema failure both give `reason: "parse"`
  with the error text (`"Schema validation failed: <path>:<message>; ..."`).
- **Prod facts (2026-10-20, `cost_tracking`):** first `learning_review` call 2026-10-19 15:15 UTC
  (when 14-day sends reached 10), 59 calls since, ~4 per hour, every one followed by
  "review call failed" in the tick report. Input ~4,624 tokens each (the same evidence),
  output 425-584 tokens, far under `max_tokens` 1500: **not a truncation**; the failure is in
  parsing or the schema (`reviewSchema`, `:373-382`: observations title 5-200 chars, evidence
  5-600, max 6; guidance text 12-400, why 5-400, max 2). The exact error was never logged, and
  Vercel keeps logs only 1 hour; you cannot call Claude from the sandbox.
- **Stop-gap in prod:** the conductor inserted one `learning_insights` row (learner `review`,
  kind `observation`, title "Weekly review paused by hand: the review call failed every tick",
  2026-10-20 15:25 UTC). The guard now skips the review until 2026-10-27. Your fix must work with
  or without that row.
- `learning_insights.kind` has a CHECK: `promote, retire, challenger, observation, breaker, stage, proposal` (0040).
  Readers of `learner = 'review'` rows: the guard above; the /learning page lists insights.

## Brain lessons
- serverless-durable-background-jobs.md: "Bound the retries of any NON-RESUMABLE phase. ... Count
  attempts ... and fail with a real explanation instead of looping." A paid call that fails and
  leaves no mark is that loop.

## The changes
1. **At most one paid attempt per 24 h, at most one successful review per 7 days.** Count the
   attempt BEFORE (or regardless of) the call's result, from data the guard reads (e.g. a
   `learning_insights` row per failed attempt with the reason, or `cost_tracking` rows with
   `kind = learning_review` in the last 24 h). Keep the success cadence weekly.
2. **A failure says why.** The failed attempt records `call.reason` and the first ~300 chars of
   `call.error` where a person can see it (an insight on /learning and the tick report's
   `review.reason`), never the evidence JSON or any prospect data.
3. **Make the likely failure less likely without loosening the rules:** over-long strings from the
   model are trimmed to the schema's limits (or the limits are stated in the prompt), not
   rejected; a wrapper object around the expected JSON is unwrapped if that is cheap to do inside
   `learn.ts`. Say in the PR which failure shapes you made pass and which still fail.

## Files
Allowed to edit:
- `lib/autopilot/learn.ts` (`weeklyReview`, `reviewSchema`, `REVIEW_SYSTEM`, a small helper next to them)
- `tests/*.test.ts`
Read for context, do not edit:
- `lib/autopilot/tick.ts`, `lib/anthropic/client.ts`, `lib/anthropic/cost-tracking.ts`, `supabase/migrations/0040_autopilot_brain.sql`
Forbidden: `lib/supabase/types.ts`, `vercel.json`, `CLAUDE.md`, `lib/{anthropic,gmail,compliance,supabase}/`, migrations, every other `lib/autopilot/` file.

## Must not change (negative set)
- A successful review creates exactly the same insights and challenger arms as today.
- The review still needs >= 10 root sends in 14 days, Claude available and the daily cap free.
- `sanitizeGuidance` and `MAX_GUIDANCE_CHALLENGERS` are untouched; no guidance can bypass them.
- `learnFromOutcomes` and `evolveSearchSpace` are untouched.

## Acceptance checks
1. `npm run typecheck && npm run lint && npm test` pass.
2. Fake-db tests with an injected `structuredCall` (make it injectable if needed, default the real one):
   failing call → 1 paid attempt, then 95 more ticks in the next 24 h → still 1; after 24 h → 2;
   the failure's reason and error text are recorded; a success → no more attempts for 7 days;
   the stop-gap row alone → skipped.
3. Schema tests: an observation with 800-char evidence and a 450-char guidance text → parsed and
   trimmed (guidance still passes `sanitizeGuidance` or is discarded by it, never bypasses it).
4. Mutation table in the PR (remove the attempt guard → test 2 fails).

## External prerequisites
none.

## Prod verification
After deploy the conductor deletes the stop-gap row. Then:
`select count(*) from cost_tracking where metadata->>'kind' = 'learning_review' and incurred_at > now() - interval '24 hours'` <= 1,
and the tick report's `review.reason` names the real failure (or the review succeeds).

## Out of scope
The review's evidence selection, the bandit, other learners, the daily cap value. Lessons go to
`tasks/lessons-inbox/learning-review-backoff.md`.

## Questions already answered
Q: Use a new insight `kind` for failures?  A: No migration in this task: use an allowed kind (e.g. `observation`) and a learner value your guard reads; say which in the PR.
Q: Retry sooner than 24 h after a timeout?  A: No. One paid attempt per 24 h, whatever the reason.

## If blocked
Message the conductor with what you tried, what you need, and what you can still do meanwhile.
