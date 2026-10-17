# Board (conductor-owned)

Single source of truth for who is doing what. A fresh conductor session resumes from this
file alone. Update it on every spawn, every status change, every merge. Keep closed rows
for the current phase; move older ones to the retro.

## Current phase
`<phase name>` · integration branch `claude/<phase>-integration` · opened from `main` at
`<sha>` · integration → main PR: none yet

## Approvals and checks
| Item | State |
|---|---|
| Batch plan sent to Pedro | not yet / date |
| Batch plan approved | no / yes (date) / waived by standing instruction |
| Questions sent | not yet / date |
| `npm run build` green on integration | no / sha |
| Origin in sync (`git status -sb`) | yes / unpushed: sha |

## Reserved migration numbers
| Number | Reserved for | Status (reserved → used → applied) |
|---|---|---|
| 0042 | — | free |

## Active and queued tasks
| Slug | Module | Model/effort | Branch | Session | PR | Depends on | Status | Blocked on | Turns | Review findings | CI reds | Rework |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| | | | | session id or `agent` | url or branch | slug or — | queued / running / pr-open / in-review / merged / reworked / failed | | | | | |

Column meanings: Turns = assistant turns in the worker session (proxy for tokens).
Review findings = blocking findings the reviewer raised. CI reds = failed CI runs on the
PR. Rework = times the task went back to the worker or was redone by another worker.
These four columns feed the retro and the routing table.

## Questions for Pedro (batched, asked once per batch)
| # | From task | Question | Default if unanswered | Answer |
|---|---|---|---|---|

## Worktrees to clean up (in-session workers only)
| Path | Branch | Remove after |
|---|---|---|

## Shared-file changes pending (conductor does these)
| Requested by | File | Change | Done |
|---|---|---|---|

## Log
- YYYY-MM-DD HH:MM UTC — event
