# Brief: presend-learning

| | |
|---|---|
| Module | `lib/learning/` + `lib/autopilot/learn.ts` (learners), `/learning` page cleanup |
| Model / effort | opus-5.5 / high (routing: `lib/autopilot/` briefed tasks are high, one at a time) |
| Branch | `claude/presend-learning` from `claude/phase3-batch8-integration` |
| PR target | `claude/phase3-batch8-integration` |
| Reserved migration | none |
| Depends on | none. Reads `click` events written by `tracked-links` (parallel): contract below |
| Conductor session | `session_01HtEg7XG4MPQU4omrd2BX69` (send_message ONLY if blocked; the PR body is the report) |
| Size | M |

## Goal
The writer's experiments learn within days, not months, and a bad AI-written writing instruction removes itself without a person. Pedro decided (2026-10-22, "option 1"): AI-written guidance stays hands-off (goes live as a challenger and can be promoted automatically), protected by a guardrail that retires any guidance that makes drafts fail review more often than the champion. Good looks like: a guidance arm whose drafts get thrown away at a clearly higher rate than the champion's is retired within about a week at today's volume (~20-30 Claude drafts/day); clicks count as a small positive signal; nothing a person cannot use is left on /learning.

## Context the worker needs
**Today.** Learners run in the tick (`lib/autopilot/tick.ts:223-226`). Writer arms (`writer.evidence`, `writer.guidance`) are scored only from SENT root pitches' outcomes (`lib/autopilot/learn.ts:178-193`, `settleLearner(..., armStats(inputs, learner, now), 30)`). An outcome settles on a reply/scan/opt-out/bounce or after 14 days of silence (`lib/learning/reward.ts:84`, `scoreOutcome` `:97-150`); `reviewArms` (`lib/learning/bandit.ts:163-217`) promotes at P(best) ≥ 0.95 and retires at ≤ 0.05 after 30 trials, plus an opt-out guardrail (20+ trials, `:171-180`). Prod 2026-10-22: every writer arm has 0 trials; 43 sends since 10-17, 0 replies, 0 scans.
**The thrown-away drafts already carry their arms.** `decision.arms` is written on every Claude pitch, rejected ones included (`lib/pitches/pitch-stage.ts:~628`). Prod since 10-20 (query run 2026-10-22): guidance `g-2026-10-20-1` 12 drafts / 4 sent / 7 auto_rejected; `g-2026-10-20-2` 7 / 1 / 5; champion `none` 22 / 10 / 11. Rejection reasons live in `pitches.auto_rejected_reason` (e.g. "still held after one rewrite: AI review flagged issues", "a rewrite can't fix: verifier unsure about the address").

**Decisions (conductor):**
1. Pre-send guardrail, `writer.guidance` challengers only (not `writer.evidence`, not the champion): over pitches created in the last 14 days on the Claude path, per arm, count drafts that ended `auto_rejected` with a WRITER-caused reason (AI review / writing gate codes; NOT verifier-unsure, domain/company checks, template, or reasons a person caused) vs all that arm's Claude drafts. Retire a challenger when it has ≥ 12 drafts, the champion has ≥ 12, and P(challenger's held rate > champion's) ≥ 0.9 under Beta(1+held, 1+kept) posteriors (seeded RNG in tests). Log it as an insight (kind `retire`, reason `presend_held_rate`, both rates and counts) exactly like other autonomous changes. Pure function in `lib/learning/`, called from `learn.ts`.
2. Clicks: `click` events (written by `tracked-links` on the ROOT pitch, payload `{code, step, ua}`) count as value 0.25 (below a scan's 0.5), points 1, NOT decisive (silence still settles at 14 days). Add `click` to `OUTCOME_EVENT_TYPES` (`reward.ts:75-82`). Readers of `scoreOutcome` that this changes: exemplar qualification (score ≥ 0.5, `lib/pitches/exemplars.ts:104-115`, a click alone must NOT qualify, test it) and the hunter-signals route (`app/api/public/hunter-signals/route.ts`, check whether it reads `value`; state the effect).
3. Weekly review input (`learn.ts:546`): the held/auto_rejected sample is 20 unordered rows. Order it newest first and pass the grouped `auto_rejected_reason` counts so the review sees the main cause.
4. /learning cleanup (Pedro's decision 12): the prompt-proposals path is a dead end (nothing writes `prompt_change_proposals`; `runWeeklyAnalysis` is a stub, `lib/prompts/actions.ts:108-115`; the writer prompt is code, `PITCH_PROMPT_VERSION`). Remove the proposals UI and the "pending review"/"Sunday analysis proposals" copy (`app/(dashboard)/learning/learning-client.tsx:33-48`, `components/learning/proposal-card.tsx`, the stub). Keep the Learners section (`summarizeArms`). Drop no table. Add one line on /learning saying writing instructions are tested and retired automatically.
5. Add a short header comment in `learn.ts` recording decision 12 (Pedro 2026-10-22: AI guidance hands-off; protected by the pre-send guardrail and the opt-out guardrail; gates, caps, compliance, breakers and DNC are never learnable).

## Brain lessons
none matched (second brain not attached). Core-context: read meaning into an absent input only after excluding every path that empties it on purpose; the no_benchmark arm and template drafts are such paths here.

## Files
Allowed to edit: `lib/learning/*` (new pure file allowed), `lib/autopilot/learn.ts`, `lib/prompts/actions.ts` (stub removal only), `app/(dashboard)/learning/*`, `components/learning/*`, `tests/presend-learning.test.ts` (new), existing tests pinning changed behaviour (name them).
Read only: `lib/autopilot/tick.ts`, `lib/pitches/pitch-stage.ts`, `lib/pitches/exemplars.ts`, `app/api/public/hunter-signals/route.ts`, `lib/autopilot/governor.ts`.
Forbidden: `lib/supabase/*`, `lib/pitches/*` (another worker), `app/api/replies/*` (another worker), `lib/autopilot/tick.ts`, `lib/autopilot/governor.ts`, `lib/reports/*` (next wave), migrations, `vercel.json`.

## Must not change (negative set)
- The champion is never retired by the pre-send guardrail; a learner is never left without a champion.
- `writer.evidence` arms, scout cells and the ICP learner behave exactly as today.
- Drafts rejected for verifier/domain/company/template/person reasons never count against a guidance arm.
- A pitch with only a click is never an exemplar; reply/scan/opportunity values unchanged.
- Gates, caps, compliance, breakers, DNC: untouched.

## Acceptance checks
1. Pure tests for the guardrail at the boundaries (11 vs 12 drafts, P just under/over 0.9), with the prod numbers above as one case (state what it decides).
2. Test that verifier-unsure and template rejections are excluded; one that the no_benchmark arm's drafts still count for guidance (they carry a guidance arm too).
3. `scoreOutcome` with a click: value 0.25, pending until 14 days; with click + scan: 0.5.
4. /learning renders without the proposals section (`npm run build`).
5. `npm run typecheck && npm run lint && npm test && npm run build` green; count reported.

## External prerequisites
none.

## Prod verification
After deploy, next tick: `select learner, kind, title, created_at from learning_insights where created_at > <deploy> order by created_at;` (a `presend_held_rate` retire appears only when the rule fires; with the 10-22 numbers say whether it would). `/learning` shows no proposals block.

## Out of scope
Stall alarms and health alerts (next wave, `lib/reports`); the tick; exemplar switch-on; prompt registry wiring.

## If blocked
Message the conductor with what you tried, what you need, and what you can still do meanwhile.
