# Model routing (conductor-owned, evidence-driven)

Quality first. Opus is the default worker. A lane moves to Sonnet only after two
consecutive clean Sonnet runs on that lane (0 rework, ≤1 blocking review finding) and
moves back after one reworked task. The strongest model is for the conductor's batch
audit and hard merge conflicts, never a worker. Haiku never writes code.

Effort: workers `medium` by default, `high` for the project's hub module and anything that
touches sending, money, auth or user data. Conductor `high`.

## Lanes
| Lane | Default model | Effort | Parallel-safe | Evidence (clean runs / reworks) | Last changed |
|---|---|---|---|---|---|
| Conductor: decompose, brief, review, merge, retro | opus | high | n/a | — | |
| Conductor: batch audit, hard merge conflicts | strongest | high | n/a | — | |
| Reviewer (reads diff + brief, no edits) | opus | high | yes | — | |
| Tests for existing pure logic, docs, scripts, lint/type fixes | sonnet | medium | yes | — | |
