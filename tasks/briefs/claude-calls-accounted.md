# Brief: claude-calls-accounted

| | |
|---|---|
| Module | `lib/research/`, `lib/discover/` (call sites), `lib/replies/` (call sites), `lib/icp/` |
| Model / effort | opus-5.5 / medium  (see tasks/routing.md) |
| Branch | `claude/claude-calls-accounted` from `claude/phase3-batch6-integration` |
| PR target | `claude/phase3-batch6-integration` |
| Reserved migration | none |
| Depends on | none. `lib/anthropic/client.ts` parse-error scrub is already on the integration branch (c7e4fde) |
| Conductor session | `session_017nqBxLFFXKbhDwKiPi6xLf` (send_message here ONLY if blocked; the PR body is the report) |
| Size | M |

## Goal
Three small repairs to how S.P.A.M. calls Claude outside `lib/pitches/`:
1. **Pre-check bar from 10 to 20.** Companies whose cheap first score is 10-19 are no longer deep-researched. Prod data shows they almost never reach a pitch.
2. **Every paid call records its cost, including failed calls.** Today some calls never reach `cost_tracking`, so the $3/24 h cap (`isUnderDailyCap` sums those rows) undercounts real spend.
3. **Every prompt names its JSON keys and the hard limits its schema enforces.** Text only shown to people is clipped instead of failing the whole call.

A good solution: the cap sees every dollar, a long sentence of "reasoning" never throws a classification away, and nothing else about scoring, research or replies changes.

## Context the worker needs
**Part 1, pre-check (data from a prod query run for this brief).** The structural score is the superseded `scores` row; the final score is the active one (`superseded_at is null`). Pairs with a final score in the last 7 days:

| structural | companies | final ≥ 70 | research+scoring $ |
|---|---|---|---|
| 10-19 | 25 | 0 | 0.46 |
| 20-29 | 21 | 2 | 0.34 |
| 30-39 | 47 | 3 | 0.53 |
| 40-49 | 51 | 9 | 0.97 |
| 50+ | 153 | 90 | 3.61 |

All time: 1 of 26 in 10-19 reached 70, out of 258 that reached 70. Decision (conductor, on Pedro's "raise the bar only if we rarely lose a 70+"): **bar = 20**. A bar of 30 would lose 2 of 104 good companies a week to save another $0.34; not taken.
- The check is `lib/discover/pipeline-stage.ts:439` `if (initialScore < 10) {`. The comment above it (`:435-438`) says "threshold is 10".
- These stale comments must match the code after your change:
  - `:8` says "only if structural score ≥ 20";
  - `:14-17` says final triage "< 40 suppressed, 40–69 needs_review". The code is `:540` `if (score < 50)` and `:552` `if (score < 70)`;
  - `:391` says "Gate threshold is 20 (not 35)".
- A prospect suppressed here still counts in `processed` against the daily budget (`lib/learning/scout.ts`, `lib/autopilot/tick.ts:413-433`). Do NOT change that: Pedro's volume rule caps it.

**Part 2, cost recording.** `recordClaudeCall` (`lib/anthropic/cost-tracking.ts:36`, conductor-only, do not edit) is best-effort and never throws. Allowed `entity_type` values (`:16`): research, scoring, pitch, reply_classify, reply_draft, icp_suggest. `entity_id` may be null. `structuredCall` returns `usage` non-null on parse and schema failures, null on API errors (`client.ts:139-141`). Record whenever usage is non-null. The gaps:
- **Scorer.** `lib/research/scoring/claude-scorer.ts:78-88`: on failure it returns `usage: ZERO_USAGE` even though the call was paid. `lib/research/score-stage.ts:181` `if (method === "claude") claudeUsage = claudeResult.usage;` so a failed call is never recorded (prod: 622 scoring rows in 14 days, 0 failures recorded).
- **SnapVerify.** `lib/research/snap-contact.ts:107-123`: the Haiku `extractPeople` call. `:125` `if (!result.ok) return [];` and on success the usage is dropped too. It is never recorded, by either caller:
  - `lib/discover/pipeline-stage.ts:484`;
  - `lib/discover/enrich-contacts.ts:45`.
  
  Return the usage through `SnapVerifyResult` (`snap-contact.ts:27`) and record it in both callers: entity_type `research`, entity_id the prospect, `metadata.kind: "snap_verify"`. Exactly one row per call, never two.
- **Reply drafts.** `lib/replies/send-reply-action.ts:350` (regenerate) and `:495` (no-meeting reason) record only on ok.
- **Nudge.** `app/api/replies/nudge/route.ts:223` records only on ok.
- **ICP.** `lib/icp/suggest-action.ts:376` and `lib/icp/gary-action.ts:124` never record, ok or not. Use `icp_suggest`. Gary is Sonnet (`ANTHROPIC_DEFAULT_MODEL`); pass the model actually called.

**Part 3, answer formats.** `structuredCall` adds only "Respond ONLY with valid JSON matching the requested schema" (`client.ts:180-181`). The schema itself is never shown to the model, and Zod 3.24 has no JSON-schema export. A key the prompt never names fails as `<key>:Required` (prod: 5 pitch composes last week failed with `pain_id:Required`; that composer is another worker's).
- **`snap-contact.ts`.** The prompt never names `people`, `full_name` or `role_title`. `role_title` is required but nullable. The schema allows `people.max(5)` and the prompt says "max 3".
- **`suggest-action.ts:374`.** It says "JSON matching the schema". It never names `employee_size_min`, `employee_size_max`, `field_rationales` or `summary`, all required (`refineSchema :311-327`). Unstated limits: arrays 12, items 60, rationales 240, summary 800.
- **`claude-classifier.ts:43-48`.** `reasoning` `.max(400)` fails the whole classification on a long sentence; the prompt says "1 sentence". Reasoning is display-only, so clip it instead.
  - Do not touch `intent`, `urgency` or `sentiment`.
- **`claude-research.ts`.**
  - `reasoning` `.max(800)` (`:73`) is display-only: clip it.
  - `pain_label .max(200)` (`:62`): state that limit in the prompt.
  - `pain_id` stays a strict uuid: it acts.
- **`send-reply-action.ts:481`.** `reason .min(10).max(300)`: state 300 in the prompt, or clip. It is shown to people.

Rule (core-context): clip only text shown to people. Never clip or loosen a field that acts (ids, enums, scores, emails).

## Brain lessons
- `a-cap-is-fake-if-a-call-site-bypasses-the-wrapper.md`: every paid call goes through the recorder, failures included, or the daily cap is fiction.
- `anthropic-prompt-caching-mechanics.md`: key names are static text; add them to the static part of the prompt and never put per-call text in a block marked `cache_control` (claude-research's system block is cached).

## Files
Allowed to edit:
- `lib/discover/pipeline-stage.ts` (only the pre-check block `:427-447`, its header comments, and the snapVerify call site `:476-510`)
- `lib/discover/enrich-contacts.ts`
- `lib/research/snap-contact.ts`, `lib/research/scoring/claude-scorer.ts`, `lib/research/score-stage.ts`, `lib/research/claude-research.ts`
- `lib/replies/claude-classifier.ts`, `lib/replies/send-reply-action.ts`, `app/api/replies/nudge/route.ts`
- `lib/icp/suggest-action.ts`, `lib/icp/gary-action.ts`
- `tests/*.test.ts` (new tests always allowed; existing tests only where your change requires it, say which in the PR)

Read for context, do not edit:
- `lib/anthropic/client.ts`, `lib/anthropic/cost-tracking.ts` (conductor-only)
- `lib/research/structured-research-stage.ts:192` (already records failures: copy its pattern)
- `app/api/replies/poll/route.ts:577, :666` (already records failures; do NOT edit, lane rule)
- `lib/discover/bulk-actions.ts`, `app/api/discover/run/route.ts` (callers of `processSingleProspectWith` / `enrichContactsForProspect`)

Forbidden: everything under `lib/pitches/` (the pitches worker owns it this batch), `lib/autopilot/`, `lib/anthropic/`, `lib/supabase/types.ts`, `vercel.json`, `CLAUDE.md`, migrations.

## Must not change (negative set)
- Final score thresholds 50 and 70; the order of paid steps for structural ≥ 20 (deep research → snapVerify → structured research → final score).
- Successful scoring, research and classification record exactly the rows they record today (same entity_type, entity_id, metadata keys). No double rows.
- A structural score of 0-9 is suppressed as today. Exactly 20 is researched.
- Reply intent, urgency and sentiment parsing: the same input gives the same output (`tests/claude-reply-classifier.test.ts` untouched and green).
- A call that never reached Claude (`usage: null`, or `claudeIsAvailable()` false, or heuristic-only) records nothing.

## Acceptance checks
1. `npm test` passes, with new tests that show:
   - **Pre-check.** A fake scorer returning 19 suppresses with no deep research call. 20 proceeds.
   - **Scorer failure.** A scorer schema failure with usage records one `scoring` row carrying its real cost. A heuristic run records none.
   - **SnapVerify.** One `research` row with `metadata.kind = "snap_verify"`, on success and on schema failure, from each caller.
   - **Replies, nudge and ICP.** Each failure path records once.
   - **Prompts.** The captured prompts of snap-contact and suggest-action contain every top-level schema key.
   - **Classifier.** A 600-character reasoning classifies (clipped) instead of failing.
2. `npm run typecheck` and `npm run lint` clean.
3. Mutation: revert the bar to 10 and revert the scorer usage line, and your tests fail (say which in the PR).

## External prerequisites
none

## Prod verification
After the deploy, once one discovery run has finished:
- `select count(*) from cost_tracking where metadata->>'kind'='snap_verify' and incurred_at > '<deploy time>'` > 0.
- New `suppressed_reason` rows read "structural score 1x".

## Out of scope
Anything in `lib/pitches/` (composer `pain_id`, angle-advisor cost: other worker). Raising or lowering any daily limit. Retrying failed calls. Changing `structuredCall`. If you think `structuredCall` itself should state the keys, write it in the lessons inbox.

## Questions already answered
- **Q: Why not bar 30 or 40?** A: 30 loses 2 of 104 good companies a week, and 40 loses 5. Each saves under $1.40 a week.
- **Q: Should skipped prospects stop counting toward the daily 100?** A: No. That raises volume; Pedro decides that, not this batch.
- **Q: A new entity_type for snapVerify?** A: No. Use `research` plus `metadata.kind`. The type list lives in a conductor-only file.

## If blocked
Message the conductor with: what you tried, what you need, what you can still do meanwhile. Do not wait idle if any part of the brief is still doable.
