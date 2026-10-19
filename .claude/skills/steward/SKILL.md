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

## Never merge two branches straight into `main` back to back
2026-10-18: PR #8 and PR #9, each CI-green alone, were squash-merged into `main` four
minutes apart. Both had added the same import on different lines; the merge was clean,
the prod build was red, and prod kept serving the previous commit until PR #10. CI on a
PR tests the PR against the base as it was when the PR was last pushed, not against what
landed since. Every PR goes through the integration branch, where the full suite runs on
the COMBINED head before the one PR to `main`. A direct `main` PR is for a one-file
hotfix only, and then nothing else merges until its deploy is READY.

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

## After "ship it": the ship checklist (conductor runs it, Pedro only does what needs him)
Every manual step is verified with a query before the next step; a report of "done" is a
claim, not a state (0043 was reported applied and was not; the Calendar API was
reported enabled before it was).
1. Migrations marked "before deploy": confirm applied, then merge the PR.
   Check by NAME, never by version: `select version, name from
   supabase_migrations.schema_migrations order by version desc limit 5`. Pedro's
   SQL-editor runs record version `NNNN`; the connector records a timestamp. After a
   connector apply, normalise the row to the repo convention so every session sees the
   same table: `update supabase_migrations.schema_migrations set version='NNNN',
   name='<file name without number>' where version='<timestamp>'`.
2. Deploy READY on Vercel (check the deployment, not the PR merge).
3. Migrations marked "after deploy": apply, verify, normalise as above.
4. External prerequisites from the briefs (OAuth scopes, APIs enabled in the Google
   Cloud project, env vars): ask Pedro for each one, then run the brief's prod
   verification query. A new Google scope also needs its API enabled in the OAuth
   client's GCP project; the scope grant alone returns 403.
5. First prod run of every new cron: read `net._http_response` for its path and record
   the counts on the board. The batch is closed only when that row shows no error.
6. Write the ship steps and their verified state into `tasks/project-state.md` so any
   other session that fetches `main` reads the same facts the conductor has.
7. Bring `main` back into the integration branch with a merge commit (`git merge
   origin/main`, same tree after a squash ship); never restart it with a force push. 2026-10-19:
   a force-with-lease restart after PR #27 tripped the auto-mode classifier, which then blocked
   even read-only calls until the container restarted.