---
name: worker
description: Operating procedure for a worker session or sub-agent that was given a brief in tasks/briefs/ by a conductor. Use when the prompt names a brief file. Covers what to read, what not to read, how to work, how to open the PR and how to report.
---

# Worker procedure

You were given one brief. Your job is that brief, done well, with the fewest tokens.

## 1. Load (and nothing more)
1. `tasks/briefs/_core-context.md` (always).
   A "Second brain not attached" note at your first prompt is expected for workers:
   the brief's "Brain lessons" section carries what applies. Do not ask anyone to attach it.
2. Your brief, `tasks/briefs/<slug>.md`.
3. Only the files the brief lists. Prefer `Grep` and ranged `Read` over whole-file reads.

All paths are relative to the repo root your prompt names (your worktree or clone).
Never open project history (`tasks/lessons.md`, `tasks/session-log.md`, `tasks/todo.md`,
`tasks/project-state.md`, `tasks/archive/`, audit docs, `tasks/conductor-config.md`) unless
the brief names a section. A CLAUDE.md line that says to read them first does not apply
to workers.

## 2. Set up
```
git fetch origin <integration-branch>
git checkout -B claude/<slug> origin/<integration-branch>
```
Install dependencies and run the checks exactly as `_core-context.md` "Stack and commands"
says (for example `npm ci`, then typecheck, lint, test). Run the
tests once before changing anything and note the passing count. If it is not
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
Run the project's checks (from `_core-context.md`). All green, locally, every time. Then re-run each acceptance check from the brief
and capture the output for the PR body. For a bug fix or a review fix, prove the new
tests guard something: run them against the code they guard against (the base branch for
a bug fix, your own earlier commit for a review fix) and record the fail count in the PR body.
Re-read your own diff once, adversarially: what would the reviewer's principles (`.claude/agents/reviewer.md`) and the project lines in `tasks/checklists/review-misses.md` flag?

## 5. Write the lessons inbox
`tasks/lessons-inbox/<slug>.md`, format in `tasks/lessons-inbox/README.md`. Include
"nothing new" if so. Put unrelated bugs you noticed under "Out of scope, noticed".

## 6. Commit, push, PR
One or a few meaningful commits. Message style: `feat(module): what` / `fix(module): what`
/ `test(module): what`. The harness's attribution trailer (Co-Authored-By / session line)
is required; no model names anywhere else (titles, bodies, code, comments). Once pushed,
never amend or force-push: add commits, so the reviewer can review the delta.
Right before the push, bring the integration branch in (a merge, never a rebase) and
re-run the three checks on the result. A worker that branched before a wave-0 helper
landed reinvents it otherwise (phase 3 batch 1: two PRs each wrote their own
"latest root pitch" query):
```
git fetch origin <integration-branch>
git merge --no-edit origin/<integration-branch>
<the project's checks>
git push -u origin claude/<slug>
```
No GitHub in this session (the brief or the conductor says "local mode"): commit to
`claude/<slug>`, skip the push and the PR, and return the PR body below as your output.
Open the PR against the branch named in the brief (never `main`). The PR body IS your
report: the conductor is woken by the PR-opened event and reads the top block first.
PR body:

```
## Report
DONE <slug> | tests <n>→<m> | turns ~<k>
Changed: <one line>
Decisions: <one line or none>
Needs conductor: <one line or none>
Lessons: <one line or "nothing new">

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

## External prerequisites (anything outside this repo that must be true in prod)
- OAuth scope / API enabled in the Google Cloud project / env var / credential / DNS,
  or "none". Say who does it and how to tell it is done.

## Prod verification (the conductor runs this after the deploy)
- one SQL query, URL or log line that shows the feature working, and the expected result

## Out of scope, noticed
- ... or "none"
```

## 7. Stop
Do NOT `send_message` the conductor when you are done: the PR-opened event already wakes
it, and the message is the only step that prompts the owner for permission. Message the
conductor only when you are BLOCKED (`BLOCKED <slug> | tried … | need … | meanwhile …`).

If you are an in-session sub-agent rather than a remote session, return the PR body's
Report block as your final output.

Then stop. Do not keep working, polling, or improving. If the conductor sends review
findings, fix the blocking ones, push to the same branch (new commits, never amend), and
update the Report block at the top of the PR body. Optional findings ride along only if
you are already pushing.

## 8. Wrap up (when the conductor sends "WRAP UP <slug>")
Your PR is merged (or the task is closed). The conductor reads your reply from your
transcript and then archives this session. Do this, then stop:
1. `git status --short` and `git log --oneline origin/<branch>..HEAD`: list uncommitted
   or unpushed work. Commit and push nothing new (the branch is merged; a new commit is
   orphaned). Describe anything real that is left.
2. Lessons learned after you wrote `tasks/lessons-inbox/<slug>.md` (e.g. during review
   fixes): put them in the reply as WHAT HAPPENED / RULE / TAGS. Do not edit the file.
3. Noticed but not done: one line each, or "none".
4. End with this block, filled in:
   ```
   Fully done?               Yes / No / Not checked
   Anything needed from you? No / one specific action
   New unfinished work?      No / how many + where it's written down
   Safe to close?            Yes / No: reason in five words
   ```
Do not `send_message` the conductor. Under 25 lines.
