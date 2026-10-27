# Lessons inbox

Workers write here, never to `tasks/lessons.md` (parallel edits to a 1,300-line file
collide, and workers must not load it). One file per task: `<slug>.md`.

Format, same as lessons.md so the merge is a copy:

```
[YYYY-MM-DD] <one-line title>
WHAT HAPPENED: two or three sentences, with file paths.
RULE: the generalizable rule, one paragraph max.
TAGS: module, topic
```

Also allowed in the same file, under `## Out of scope, noticed`: bugs or debt you saw and
did not touch (path + one line). The conductor turns these into board rows or todo items.

If nothing was learned, write the file anyway with `nothing new` so the conductor knows
you considered it.

The conductor merges these into `tasks/lessons.md` at retro time, promotes the ones that
should bind every worker into `tasks/briefs/_core-context.md`, and deletes the inbox file.
