# Retro 2026-10-19 phase3/hotfix (bounce incident)

## Per task (from tasks/board.md)
| Slug | Model/effort | Turns | Review findings | CI reds | Rework | Verdict |
|---|---|---|---|---|---|---|
| bounce-hotfix | opus-5.5 / high (in-session opus-worker, worktree) | ~70 (26 min) | 0 blocking, 13 optional | 0 | 0 | clean |

Incident to ship: first bounce 15:00 UTC, pause 15:45, brief 17:00, worker done 17:30, reviewed 18:15, shipped 19:05, inbox resumed and holding 19:23, back to veto 19:57.

## What cost the most (tokens or time) and why
- Three container/worker restarts during the incident (reviewer result had to be recovered; one turn ended "no response" with a pending action). Cause: long single conductor session; mitigation already in place: send_later safety check-ins re-armed at each step.
- A finder-address decision (drop vs wait for a person) surfaced only in the worker's report, after Pedro had been told "they wait for you". The brief said "a person can still approve" without checking `heldAction`'s "nothing waits on a person" rule.

## Routing changes
| Lane | From | To | Evidence |
|---|---|---|---|
| `lib/autopilot/` (briefed tasks) | opus high | unchanged | b-hotfix: 1 clean (0 blocking); first clean run after b2's rework |
| Reviewer | opus high | unchanged | b-hotfix: 0 blocking, 13 optional; 11/12 mutations caught, the survivor flagged by the reviewer itself |
(applied to tasks/routing.md in this commit)

## Brief quality
- Missing sentence: "what does the autopilot do with a draft whose verdict is review?" A brief that changes a verdict must quote the consumer of that verdict (`heldAction`) and state the outcome. Added to TEMPLATE ("Context" hint) in this commit.
- Missing sentence: the conductor's own numbers in the brief ("one burst") were wrong; the board had the per-run counts. Rule: incident facts in a brief come from a query run for the brief, quoted with its output.

## Reviewer misses
None found later (Pedro's demotion question was a design gap, not a review miss). Three checklist items added from the worker's lessons: race test for a repeated WHERE guard (already present), cached verdicts after a rule tightens, resets need a recorded reset.

## Conductor misses
- Told Pedro "all 19 went out together" before checking the board's 6/6/6/1; corrected 30 min later. Rule: state send timing from `pitches.sent_at`, never from memory.
- After a worker restart, answered "No response requested" while a requested action (set veto after the resume check) was pending; the scheduled check caught it. Rule added to the conductor skill: after a restart, re-read the last user message and finish what it asked.
- Told Pedro finder addresses "wait for you", then shipped "dropped". Rule: a promise about behaviour to Pedro is checked against the code path before it is made.

## Lessons merged
1 inbox file (bounce-hotfix: 3 lessons) merged into tasks/lessons.md; 1 PEDRO_OVERRIDE (deliverability trips must not demote) logged; 0 promoted to _core-context.md (the override becomes code in batch 4).
