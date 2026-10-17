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
| `lib/pitches/` (hub), `lib/compliance/`, send paths | opus-5.5 | high | NO, serialize | — | 2026-10-17 |
| Migrations, `pg_cron`, service-role threading, circuit breakers | opus-5.5 | high | NO | — | 2026-10-17 |
| `lib/discover/` | opus-5.5 | medium | yes, if research API frozen | — | 2026-10-17 |
| `lib/research/` (leaf) | opus-5.5 | medium | yes | — | 2026-10-17 |
| `lib/replies/` | opus-5.5 | medium (high for classifier rules) | yes, after any pitches task lands | sim 2026-10-17: classifier task took 3 review rounds; brief lacked the negative set | 2026-10-17 |
| `lib/warmup/` (isolated) | opus-5.5 | medium | yes | — | 2026-10-17 |
| Admin CRUD (`icp`, `benchmarks`, `case-studies`, `notable-clients`, `settings`) | opus-5.5 → sonnet candidate | medium | yes | — | 2026-10-17 |
| Dashboard pages + components (no data-model change) | opus-5.5 → sonnet candidate | medium | yes | — | 2026-10-17 |
| Tests for existing pure logic, docs, scripts, lint/type fixes, bug fix with existing tests | sonnet-5.5 | medium | yes | sim 2026-10-17: 1 clean (0 blocking, cheapest task) | 2026-10-17 |
| Reviewer (reads diff + brief, no edits) | opus-5.5 | high | yes | — | 2026-10-17 |
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
