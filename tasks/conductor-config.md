# Conductor config: S.P.A.M.

Project-specific settings for the conductor, worker, steward and reviewer. The skills
are generic; everything that is true only of this repo lives here. Keep it under ~150
lines. A fact a WORKER needs goes in `tasks/briefs/_core-context.md` instead (workers do
not read this file).

## Owner and approval
- Owner: Pedro De Velasco. Plain language, no unexplained jargon, numbered options start
  with one plain sentence on what it means for him. Reports end with his verdict block.
- Ship gate: nothing merges to `main` (= production, Vercel auto-deploys) without Pedro's
  explicit "ship it" / "deploy it" in the session. After it, the conductor squash-merges
  the integration PR and runs the ship checklist below.
- Batch plans: one message per batch, "reply 'go' or edit". Pedro may waive the wait.

## Where work comes from
- Phase items: `tasks/audit-2026-10-16.md` §7, `tasks/audit-2026-10-22-autonomy.md`, the
  open items and next-batch notes in `tasks/project-state.md`.

## Commands
- Fresh clone: `npm ci`. Checks: `npm run typecheck && npm run lint && npm test`.
- Build: `npm run build`. Turbopack rejects a symlinked `node_modules`, so in a worktree
  build from a copy: `git archive HEAD | tar -x -C <dir>` then `cp -al node_modules <dir>/`.
- Pre-commit (lefthook) runs tsc + eslint. CI (`.github/workflows/ci.yml`) runs the three
  checks on every PR.

## Protected files (conductor-only)
`lib/supabase/types.ts` (hand-maintained), `vercel.json`, `CLAUDE.md`,
`lib/{anthropic,gmail,compliance,supabase}/`, any migration. A config entry for code that
does not exist yet (a `vercel.json` route) lands in the merge commit that brings the code
(batch 7: the vercel-config test went red for every worker).

## Serialized modules (never two open workers at once)
- `lib/pitches/` (hub). Disjoint files may run in parallel only when the board says so.
- `lib/autopilot/` (briefed tasks), send paths, `lib/compliance/`.

## Merge order on the integration branch
1. Conductor shared-infra commits (types, migrations, vercel.json).
2. Leaf modules (`research`, `warmup`, `learning`, admin UI).
3. `discover`, `replies`.
4. `pitches` last, after re-running the full suite.

## Migrations (Supabase `ybbrpqzbedaxsmotgtkh`, shared with runna-hunter)
- The conductor reserves the number on the board; the worker writes the file at that
  number; the conductor applies it through the Supabase connector at the ship step.
- Check by NAME, never by version: `select version, name from
  supabase_migrations.schema_migrations order by version desc limit 5`. After a connector
  apply, normalise the row: `update supabase_migrations.schema_migrations set
  version='NNNN', name='<file name without number>' where version='<timestamp>'`.
- Each migration header says "apply BEFORE the deploy" or "AFTER", and why.
- Any session, inside the batch flow or not, may take a number: at resume, compare the
  board's reserved table with `ls supabase/migrations` on `origin/main` (2026-10-26:
  PR #63 took 0053 outside the batch flow).

## Ship checklist (after "ship it"; verify each step by query before the next)
A report of "done" is a claim, not a state (0043 was reported applied and was not).
1. Migrations marked BEFORE: apply, verify by name, normalise. Then merge the PR.
2. Deploy READY on Vercel (project `prj_m0QuSi6AVdY6nyZzhhuaV3uFBZYk`, team
   `team_4YnejMsUIFjNQ4Et75VbTabr`): check the deployment, not the merge.
3. Migrations marked AFTER: apply, verify, normalise.
4. External prerequisites from the briefs (OAuth scopes, APIs enabled in the GCP project,
   env vars): ask Pedro for each, then run the brief's prod verification. A new Google
   scope also needs its API enabled in the OAuth client's project.
5. First prod run of every new cron: read `net._http_response` for its path; record the
   counts on the board. The batch is closed only when that row shows no error.
6. Write the ship steps and their verified state into `tasks/project-state.md`.
7. Bring `main` back into the integration branch with a merge commit; never restart it
   with a force push (2026-10-19: a force-with-lease tripped the auto-mode classifier).

## Batch audit model
Fable when the batch touched sending, compliance or migrations; Opus otherwise.

## Cost and volume rules (never raise without asking)
- Near-free: AI API spend is fine; paid platforms/SaaS are not. Scheduler = Supabase
  `pg_cron` + `pg_net`. The Anymail finder is paid: never call it.
- Autopilot researches ≤100 prospects a day; Claude spend ≤$3 per rolling 24h in prod.
- Every pg_cron call is a Vercel cold start (~1s CPU of the free plan's 4h a month):
  a migration that adds or speeds up a job writes calls/week × 1s in its header.

## Environment
- Prod data: Vercel previews share the prod database. Workers never run SQL.
- Second brain: cloud sessions get Pedro's rules and brain catalog from
  `.claude/hooks/cloud-rules.sh` and `cloud-brain.sh`. "Second brain not attached" →
  ask Pedro to attach Moisty-Mango/second-brain and Moisty-Mango/dotclaude read-only
  before planning. `tasks/tools/brain-recall-for.sh "<goal>"` feeds a brief's Brain lessons.
- Real prospect data (emails, names) never goes into a committed file; study notes stay
  in the scratchpad.
