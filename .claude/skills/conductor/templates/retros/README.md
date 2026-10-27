# Retros

One file per batch: `YYYY-MM-DD-<phase>-<batch>.md`. The conductor writes it after the
integration branch is green and before the integration → main PR goes to the owner. A retro
is not a diary. It ends in edits to the files that shape the next batch, or it was
pointless.

## Template

```
# Retro <date> <phase>/<batch>

## Per task (from tasks/board.md)
| Slug | Model/effort | Turns | Review findings | CI reds | Rework | Verdict |
|---|---|---|---|---|---|---|
Verdict: clean / acceptable / rework / wrong-model

## What cost the most (tokens or time) and why
Three bullets max. Name the cause, not the symptom.

## Routing changes
| Lane | From | To | Evidence |
(applied to tasks/routing.md in this commit)

## Brief quality
Which briefs produced questions or rework, the sentence that was missing, and the
principle (P1-P8 in the conductor skill §4) it falls under.
(applied to tasks/checklists/brief-misses.md under that principle in this commit; a class
missed twice in a row → rewrite the principle's sentence in the skill)

## Reviewer misses
Findings CI, the batch audit or the owner caught that the reviewer did not.
(applied to tasks/checklists/review-misses.md, under its principle, in this commit)

## Conductor misses
Where the conductor wasted tokens: re-read a transcript, re-ran a check, wrote a brief
twice, asked the owner something the docs answered.
(applied to the conductor skill, or to tasks/conductor-config.md when project-specific, in this commit)

## Rung chosen
Which rung of the size ladder the batch ran on, and whether a lower one would have done.

## Lessons merged
N inbox files merged into tasks/lessons.md; M promoted to _core-context.md.

## Memory hygiene
Board sections archived (to tasks/archive/), lessons.md line count before → after,
_core-context.md line count.
```
