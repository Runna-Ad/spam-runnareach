---
name: steward
description: Conventions for driving a conductor-flow pull request to green (worker PRs into an integration branch, and the integration PR into main). Read before acting on CI or review events on a PR you opened or are watching.
---

# Stewarding conductor PRs

Project specifics (approval phrase, check commands, merge order, ship checklist) are in
`tasks/conductor-config.md`.

## Branch model
- `main` = production. It changes only after the owner's approval phrase, and only from an
  integration branch PR (or a one-file hotfix, below).
- `claude/<phase>-integration` is cut from `main` at the start of a phase. Worker PRs
  target it. The conductor merges them.
- `claude/<slug>` is one worker's branch. The worker owns it; the conductor merges base
  into it (merge commit, never rebase or force-push) when it conflicts.

## CI
A red run on a worker PR is the worker's to fix (send the findings back); a red run on the
integration PR is the conductor's. Never skip, disable or quarantine a test to get green.
Never push an empty commit to re-run CI.

## Review threads
- Blocking findings: the worker fixes and pushes; the conductor re-reviews only the delta.
- Optional findings: one-line reply, resolve, carry into the next push if one happens.

## Never merge two branches straight into `main` back to back
Two PRs, each CI-green alone, can break `main` together: CI tests a PR against the base as
it was at its last push, not against what landed since (2026-10-18, S.P.A.M.: PR #8 and
#9 merged four minutes apart, both added the same import, prod build red until PR #10).
Every PR goes through the integration branch, where the full suite runs on the COMBINED
head before the one PR to `main`. A direct `main` PR is for a one-file hotfix only, and
then nothing else merges until its deploy is ready.

## Merging into the integration branch
Follow the config's merge order. After each merge run the full checks on the integration
branch; a failure blocks further merges until fixed.

## Before the integration → main PR
- Full checks and build green.
- Migrations and other ordered steps listed in the PR body, "before" or "after" the deploy.
- `tasks/project-state.md` says what ships and what stays open.
- Retro written, its edits applied.
- Then one message to the owner: the PR link, the ordered steps, the questions table.
  Wait for the approval phrase. Do not merge before it.

## After approval
Run the ship checklist in `tasks/conductor-config.md`, verifying each step by query or
by the deploy's state before the next. A report of "done" is a claim, not a state. Then
bring `main` back into the integration branch with a merge commit; never restart it with a
force push.
