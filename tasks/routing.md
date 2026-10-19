# Model routing (conductor-owned, evidence-driven)

Quality first. Opus 5.5 is the default worker. A lane moves to Sonnet 5.5 only after two
consecutive clean Sonnet runs on that lane (0 rework, ≤1 blocking review finding) and
moves back after one reworked task. Fable 5.1 is reserved for the conductor's own audit
and merge-conflict work and is never a worker. Haiku 5.5 never writes code.

Effort: workers run `medium` by default, `high` when the brief says the module is the hub
(`lib/pitches/`) or touches sending/compliance. The conductor runs `high`. `xhigh`/`max`
only for a retro-level audit, never for routine tasks (tokens).

## Lanes
| Lane | Default model | Effort | Parallel-safe | Evidence (clean runs / reworks) | Last changed |
|---|---|---|---|---|---|
| Conductor: decompose, brief, review, merge, retro | opus-5.5 | high | n/a | — | 2026-10-17 |
| Conductor: phase audit, hard merge conflicts | fable-5.1 | high | n/a | — | 2026-10-17 |
| `lib/pitches/` (hub), `lib/compliance/`, send paths | opus-5.5 | high | NO, serialize (disjoint files may run in parallel when the board says so) | phase3 b1: PR #6 needed 2 review rounds (scrubber leaks); b2: PR #17 3+ rounds (deny-list never complete) → allow-list invariant; b3: send-path-safety clean, -2 one rework (error truthiness), #17 r4 rework (drop rate measured on its own generator: 0.8% vs 80% on real pitches) → privacy filters need a REAL-data acceptance check in the brief | 2026-10-18 |
| Migrations, `pg_cron`, service-role threading, circuit breakers | opus-5.5 | high | NO | — | 2026-10-17 |
| `lib/discover/` | opus-5.5 | medium | yes, if research API frozen | — | 2026-10-17 |
| `lib/research/` (leaf) | opus-5.5 | medium | yes | — | 2026-10-17 |
| `lib/replies/` | opus-5.5 | medium (high for classifier rules and for poll-route changes) | yes, after any pitches task lands | sim 2026-10-17: classifier 3 rounds (no negative set); b2 lead-alerts: 3 rounds on the poll route's 120s kill (brief lacked the time budget) | 2026-10-18 |
| `lib/warmup/` (isolated) | opus-5.5 | medium | yes | — | 2026-10-17 |
| Admin CRUD (`icp`, `benchmarks`, `case-studies`, `notable-clients`, `settings`, `opportunities` UI) | sonnet-5.5 | medium | yes | phase3 b1: PR #1 one blocking caused by a conductor gap, fix round clean → promoted | 2026-10-17 |
| Dashboard pages + components (no data-model change) | opus-5.5 | medium | yes | phase3 b1: 2 clean on Sonnet (PR #2, #3) → promoted; b3: pitches-list-resilience 1 rework on Sonnet (client state across router.refresh) → back to Opus; Sonnet candidate again after 2 clean Opus runs | 2026-10-18 |
| Tests for existing pure logic, docs, scripts, lint/type fixes, bug fix with existing tests | sonnet-5.5 | medium | yes | sim 2026-10-17: 1 clean (0 blocking, cheapest task) | 2026-10-17 |
| `lib/learning/` (pure learners) | opus-5.5 | medium | yes | b2: 1 clean (learning-meeting-outcomes, $1.08) | 2026-10-18 |
| Reports / alerts (`lib/reports`, consumers of `lib/notify`) | opus-5.5 | medium (high when the task claims/marks rows for durability) | yes | b2: platform-reports 1 rework (an emergency rule fired on designed states); b3: booking-alert-durability (high) 1 rework (overlap test never raced the claim; migration→deploy gap) | 2026-10-18 |
| `lib/prospects/` status rule and its writers | opus-5.5 | medium | yes (conductor adopts in shared files) | b2: 1 clean (prospect-status-guard, $1.06) | 2026-10-18 |
| `lib/autopilot/` (briefed tasks) | opus-5.5 | high | NO, one at a time | b2: veto-hold-link 1 rework, both causes conductor brief defects; hotfix: bounce-hotfix 1 clean (0 blocking, in-session worker) | 2026-10-19 |
| Reviewer (reads diff + brief, no edits) | opus-5.5 | high | yes | b1: 6 reviews, 3 real regressions; b2: 9 reviews, every blocking finding reproduced, 0 misses found by the Fable audit; b3: 5 reviews, all blocking real (2 reproduced with a real client / mutation) | 2026-10-18 |
| Log triage, lessons-inbox summarization, fixture generation | haiku-5.5 | low | yes | — | 2026-10-17 |

"→ sonnet candidate" means: run the next task on this lane with Sonnet, record the result
in Evidence, promote or demote per the rule above.

## Mechanism choice (token cost, lowest first)
1. **Remote worker session** (`create_session`): fresh context, reads only brief +
   core-context + its files. Use for anything over ~30 minutes or more than 3 files.
2. **Sub-agent from `.claude/agents/`** (`Agent` tool with `isolation: worktree`): still a
   fresh context, but the conductor pays for the result coming back into its own window.
   Use for small bounded jobs (one test file, one lint sweep) where a session is overkill.
3. **Fork** (`subagent_type: fork`): inherits the conductor's whole context. Almost never
   worth it. Only when the task needs the conversation itself.
4. **Workflow** tool: deterministic fan-out (e.g. review every PR in a batch in parallel,
   then verify). Needs Pedro's opt-in ("use a workflow" or Ultracode on). Use for batch
   review/audit, not for building.
