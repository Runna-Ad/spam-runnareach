# Brief: learning-arms-dashboard

| | |
|---|---|
| Module | `lib/learning/` (one new pure file + one query file), `app/(dashboard)/learning/`, `components/learning/` |
| Model / effort | sonnet-5.5 / medium (Sonnet-lane evaluation: read-only dashboard over an existing table) |
| Branch | `claude/learning-arms-dashboard` from `claude/gallant-gauss-gly093` |
| PR target | `claude/gallant-gauss-gly093` (phase 3 integration branch) |
| Reserved migration | none |
| Depends on | none |
| Conductor session | `session_012bGmp5nHP9Lx5ke69JkaBk` |
| Size | S |

## Goal
The learners (writer evidence, writer guidance, scout cells, ICP terms) are recording
arms in `learning_arms`, but `/learning` only shows prompts and proposals. Pedro cannot
see what the system is learning. Add a "Learners" section: per learner, each arm with
trials, reward rate, status, and an explicit confidence label gated on sample size. A
good solution never shows a rate from n=1 as if it meant something, and says plainly
that the view is observation-only.

## Context the worker needs
- Table (`supabase/migrations/0040_autopilot_brain.sql` lines 24–41): `learner`, `key`,
  `config`, `status` ('champion'|'challenger'|'retired'), `origin`, `parent_key`, `reward`
  (sum), `trials`, `negatives`, `updated_at`, `retired_at`.
- Learner names and what their keys mean: `lib/autopilot/learn.ts` and
  `lib/learning/{bandit,scout,icp}.ts`. Read only what you need to label them.
- Confidence rule (Pedro's lesson, binding): trials < 20 → "too early" (show trials,
  hide the rate); 20–99 → "early" (rate shown with the label); ≥ 100 → "settled".
  Rate = `reward / trials`; negatives shown as a count.
- Page composition: `app/(dashboard)/learning/page.tsx` fetches and passes props to
  `learning-client.tsx`. The table is not in `lib/supabase/types.ts`; use the cast
  pattern from `lib/pitches/events.ts`.
- Design: match the existing dark design language, `components/ui/*`, no charts library,
  no new dependencies. Retired arms collapsed by default.

## Files
Allowed to edit:
- `lib/learning/report.ts` (new, pure: `summarizeArms(rows)` → grouped, labelled rows)
- `lib/learning/queries.ts` (new: `listLearningArms(tenantId)`)
- `components/learning/learner-arms.tsx` (new)
- `app/(dashboard)/learning/page.tsx`
- `app/(dashboard)/learning/learning-client.tsx` (add the section; keep existing props)
- `tests/learning-report.test.ts` (new)

Read, do not edit: `lib/autopilot/learn.ts`, `lib/learning/*.ts`, `components/learning/*`,
`supabase/migrations/0040_*.sql`.

Forbidden: everything in `lib/autopilot/` and `lib/learning/` other than the two new files,
`app/api/*`, migrations.

## Must not change (negative set)
- The prompts and proposals sections of `/learning` render and behave exactly as before.
- No write to `learning_arms` from this UI.

## Acceptance checks
1. `summarizeArms` tests: 5 trials → label "too early" and `rate: null`; 20 trials →
   "early" with the rate; 150 trials → "settled"; retired arms grouped separately;
   arms grouped by learner, champion first.
2. The section header carries the sentence "Observation only: nothing here changes what
   the system does."
3. `npm run typecheck && npm run lint && npm test && npm run build` green.

## Out of scope
Per-segment breakdowns, ICP yield, promoting or retiring arms from the UI, charts.
