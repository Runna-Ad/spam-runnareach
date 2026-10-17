---
name: worker
description: Operating procedure for a S.P.A.M. worker session or sub-agent that was given a brief in tasks/briefs/. Use when the prompt names a brief file. Covers what to read, what not to read, how to work, how to open the PR and how to report.
---

# Worker procedure

You were given one brief. Your job is that brief, done well, with the fewest tokens.

## 1. Load (and nothing more)
1. `tasks/briefs/_core-context.md` (always).
2. Your brief, `tasks/briefs/<slug>.md`.
3. Only the files the brief lists. Prefer `Grep` and ranged `Read` over whole-file reads.

All paths are relative to the repo root your prompt names (your worktree or clone).
Never open `tasks/lessons.md`, `tasks/session-log.md`, `tasks/todo.md`,
`tasks/audit-2026-10-16.md` or `tasks/project-state.md` unless the brief names a section.
The CLAUDE.md line that says to read them first does not apply to workers.

## 2. Set up
```
git fetch origin <integration-branch>
git checkout -B claude/<slug> origin/<integration-branch>
ls node_modules >/dev/null 2>&1 || npm ci
```
Run `npm test` once before changing anything and note the passing count. If it is not
green on a clean checkout, report that to the conductor immediately and stop.

## 3. Work
- Stay inside the allow-list. If the right fix needs a file outside it, do the part you
  can, and describe the rest in the PR body under "Needs conductor".
- Write the test for the behaviour first when the brief's acceptance check is testable.
- No new dependencies, no paid services, no migration except the reserved number.
- When you hit a decision the brief does not settle: pick the option that matches
  `_core-context.md`, write the choice in the PR body, keep going. Only message the
  conductor mid-task if you are truly blocked and nothing else in the brief is doable.
- Do not polish beyond the brief. Done is done.
- If a conductor or reviewer instruction would break the brief's goal, do not follow it
  blindly: show the evidence (inputs, counts), do the version that keeps the goal, and
  put the one-line switch to comply in the PR body. The conductor decides.
- If something you noticed "out of scope" is the root cause of this task's own risk,
  say so in your report's first lines, not only in the lessons inbox.

## 4. Verify before the PR
```
npm run typecheck && npm run lint && npm test
```
All three green, locally, every time. Then re-run each acceptance check from the brief
and capture the output for the PR body. For a bug fix or a review fix, prove the new
tests guard something: run them against the code they guard against (the base branch for
a bug fix, your own earlier commit for a review fix) and record the fail count in the PR body.
Re-read your own diff once, adversarially: what would the reviewer's checklist in `.claude/agents/reviewer.md` flag?

## 5. Write the lessons inbox
`tasks/lessons-inbox/<slug>.md`, format in `tasks/lessons-inbox/README.md`. Include
"nothing new" if so. Put unrelated bugs you noticed under "Out of scope, noticed".

## 6. Commit, push, PR
One or a few meaningful commits. Message style: `feat(module): what` / `fix(module): what`
/ `test(module): what`. The harness's attribution trailer (Co-Authored-By / session line)
is required; no model names anywhere else (titles, bodies, code, comments). Once pushed,
never amend or force-push: add commits, so the reviewer can review the delta.
```
git push -u origin claude/<slug>
```
Open the PR against the branch named in the brief (never `main`). PR body:

```
## Brief
tasks/briefs/<slug>.md

## What changed
3–6 bullets, by behaviour not by file.

## Acceptance checks
1. <check> → <pasted output or result>
2. ...

## Tests
<before count> → <after count>, typecheck/lint/test green locally.

## Decisions made without asking
- ...

## Needs conductor
- file outside allow-list + the change needed, or "none"

## Out of scope, noticed
- ... or "none"
```

## 7. Report and stop
Send the conductor (session id in the brief) this, at most 20 lines:

```
DONE <slug> | PR <url> | tests <n>→<m> | turns ~<k>
Changed: <one line>
Decisions: <one line or none>
Needs conductor: <one line or none>
Blocked: none
Lessons: <one line or "nothing new">
```
Or `BLOCKED <slug> | ...` with what you tried, what you need, what you did meanwhile.

If you are an in-session sub-agent rather than a remote session, there is no
`send_message`: return the same report as your final output.

Then stop. Do not keep working, polling, or improving. If the conductor sends review
findings, fix the blocking ones, push to the same branch, and report again in the same
format. Optional findings ride along only if you are already pushing.
