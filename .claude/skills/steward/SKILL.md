---
name: steward
description: Repo conventions for driving a S.P.A.M. pull request to green (worker PRs into an integration branch, and the integration PR into main). Read before acting on CI or review events on a PR you opened or are watching.
---

# Stewarding S.P.A.M. PRs

## Branch model
- `main` = production. Merges to `main` happen only on Pedro's explicit "ship it", and only
  from an integration branch PR.
- `claude/<phase>-integration` is cut from `main` at the start of a phase. Worker PRs
  target it. The conductor merges them.
- `claude/<slug>` is one worker's branch. The worker owns it; the conductor merges base
  into it (merge commit, never rebase or force-push) when it conflicts.

## CI
`.github/workflows/ci.yml` runs typecheck + lint + tests on every PR. A red run on a
worker PR is the worker's to fix (send the findings back); a red run on the integration
PR is the conductor's.

## Review threads
- Blocking findings: worker fixes and pushes; conductor re-reviews only the delta.
- Optional findings: one-line reply, resolve, carry into the next push if one happens.
- Never skip, disable or quarantine a test to get green. Never push an empty commit to
  re-run CI.

## Merge order on the integration branch
1. Shared-infra changes the conductor made (types, migrations, vercel.json) first.
2. Leaf modules (`research`, `warmup`) next.
3. `discover`, `replies`.
4. `pitches` last, after re-running the full suite.

After each merge: `npm run typecheck && npm run lint && npm test` on the integration
branch. A failure here blocks further merges until fixed.

## Before the integration → main PR
- Full suite green, `npm run build` green.
- Migrations listed in the PR body in order, with "apply before deploy" called out.
- `tasks/project-state.md` updated with what ships and what stays open.
- Retro written (`tasks/retros/`), routing and core-context updated from it.
- Then: one message to Pedro with the PR link, migrations to apply, and the questions
  table from the board. Wait for "ship it". Do not merge.
