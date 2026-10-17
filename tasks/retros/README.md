# Retros

One file per batch: `YYYY-MM-DD-<phase>-<batch>.md`. The conductor writes it after the
integration branch is green and before the integration → main PR goes to Pedro. A retro
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
Which briefs produced questions or rework, and the sentence that was missing.
(applied to tasks/briefs/TEMPLATE.md or _core-context.md in this commit)

## Reviewer misses
Findings CI or Pedro caught that the reviewer did not.
(applied to .claude/agents/reviewer.md checklist in this commit)

## Conductor misses
Where the conductor wasted tokens: re-read a transcript, re-ran a check, wrote a brief
twice, asked Pedro something the docs answered.
(applied to .claude/skills/conductor/SKILL.md in this commit)

## Lessons merged
N inbox files merged into tasks/lessons.md; M promoted to _core-context.md.
```
