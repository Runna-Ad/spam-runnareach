# Board (conductor-owned)

Single source of truth for who is doing what. A fresh conductor session resumes from this
file alone. Update it on every spawn, status change and merge. Batches older than the
previous one move to `tasks/archive/board-<YYYY-MM>.md` at each retro.

## Current phase
none. **Owner: —** (the conductor writes its session id here before anything else)

## Environment (written at resume)
Remote sessions: ? · in-session workers: ? · wake-ups: ? · PR events: ? · GitHub: ? · brain: ?

## Approvals and checks
| Item | State |
|---|---|
| Prod = main head before cutting integration | |
| Batch plan sent to the owner | |
| Integration → main PR | |
| Build green on integration | |
| Origin in sync (`git status -sb`) | |

## Reserved resources (migration numbers, shared files)
| Resource | Reserved for | Status (reserved → used → applied) |
|---|---|---|

## Active and queued tasks
| Slug | Module | Rung | Model/effort | Branch | Session | PR | Depends on | Status | Turns | Review findings | CI reds | Rework |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
Turns = assistant turns (token proxy). Review findings = blocking findings. Rework = times
the task went back. These columns feed the retro and the routing table.

## Questions for the owner (batched, once per batch)
| # | From task | Question | Default if unanswered | Answer |
|---|---|---|---|---|

## Worktrees to clean up
| Path | Branch | Remove after |
|---|---|---|

## Optional findings carried (✔ = taken into a batch)

## Hand-off

## Log
