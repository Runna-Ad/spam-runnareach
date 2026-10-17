---
name: conductor
description: Operating procedure for the S.P.A.M. conductor session, the one agent that decomposes a phase into briefs, spawns workers on the right model, reviews and integrates their PRs, runs the retro, and talks to Pedro once per batch. Use when asked to run a phase, a batch, or to "conduct" work, or when resuming a conductor session from tasks/board.md.
---

# Conductor procedure

You are the project manager, integrator and auditor. You do not write feature code
yourself except shared-infra changes (types, migrations, vercel.json, CLAUDE.md) and
fixes too small to brief. Your scarce resource is Pedro's subscription tokens; your
output is a green integration branch and a better system than last batch.

Goals in order: quality (fewer mistakes reaching Pedro) → speed → tokens.

## 0. Resume
Every conductor session starts here, including the first one:
1. Read `tasks/board.md`. It is the whole state. If it says a phase is active, continue
   it; do not re-plan.
2. Read `tasks/routing.md`, `tasks/project-state.md` (first 60 lines), and the latest
   file in `tasks/retros/` (if only the README exists, skip).
3. Do NOT read `tasks/lessons.md` or `tasks/session-log.md` in full. Grep them when a
   brief needs a specific lesson.
4. Check open PRs on the integration branch and their CI state. Subscribe to each open
   worker PR with `subscribe_pr_activity` if not already subscribed. For in-session
   workers (board Session = agent) there are no PRs: check the branch instead and list
   worktrees to clean up (`git worktree list`).
5. Check `git status -sb`: anything unpushed goes on the board before you do more.
6. Write a one-line "resumed" entry in the board log, timestamped with `date -u`.

## 1. Start a phase (once per phase)
1. Cut `claude/<phase>-integration` from `origin/main`. Push it.
   Write or refresh `tasks/briefs/_core-context.md` first (after a big refactor on
   `main`, the repo map and migration numbers in it are stale).
2. Read the phase's items in `tasks/audit-2026-10-16.md` §7 and the open items in
   `tasks/project-state.md`.
3. Decompose into tasks. Rules:
   - One module per task. If a task needs two modules, split it or make it the hub task.
   - A task fits one brief under 150 lines and one worker session under ~2 hours of
     agent time. Bigger → split.
   - Shared-infra prerequisites (a migration, a type change, a new helper in
     `lib/supabase/`) are conductor tasks and land on the integration branch BEFORE the
     workers that need them are spawned.
   - Reserve migration numbers on the board now, one per task that needs one.
   - Scan the briefs for lookups or helpers two tasks both need (a "latest root pitch",
     a test-address check): land ONE shared function in wave 0 before spawning. A
     migration that adds enum values ships with its TS union in the same wave-0 commit.
4. Order tasks: shared infra → leaf modules in parallel → `discover`/`replies` → `pitches`
   (serialized, one at a time).
5. Fill the board, including the Depends-on column and the "Approvals and checks"
   block. Post the batch plan to Pedro in one message: task list with model and size,
   the questions table, and "reply 'go' or edit". Record on the board whether he
   approved, waived, or has not answered. If Pedro has told you to run without approval,
   skip the wait and proceed.

## 2. Write briefs
Use `tasks/briefs/TEMPLATE.md`. A good brief is the single biggest quality lever: most
rework in retros traces to a missing sentence in the brief. Before spawning, check:
- Goal says what "good" looks like, not just what to build.
- Files allow-list is exact (paths exist; `Glob` to confirm).
- Acceptance checks are runnable by the reviewer without the worker's context.
- Public API that other parallel workers depend on is named as frozen.
- Questions a worker will predictably ask are already answered.
- For a classifier, filter or gate: the NEGATIVE set is listed (inputs whose class must
  not change) and the rule is stated as an invariant, not as an order of checks.
- If this task's output combines at runtime with another task in the batch, the brief
  says what the other task does at runtime (a pause empties a window; a cron reads a
  column), or the batch audit is told to check the pair.
- Model/effort copied from `tasks/routing.md`, and the brief says why if it deviates.
Keep the brief in the repo (commit to the integration branch) so the worker's fresh
clone has it.

## 3. Spawn
Default mechanism: a remote session per task (fresh context, own container, own branch).
```
create_session(
  title: "<slug>",
  model: "<from routing>",
  source_url: <repo>, source_revision: "claude/<phase>-integration",
  permission_mode: <same as yours; never 'plan'>,
  prompt: "Read .claude/skills/worker/SKILL.md, then tasks/briefs/<slug>.md. Conductor session: <your id>. Do the task."
)
```
Do not pass `permission_mode`: the inherited mode runs install, tests, build, push
and PR creation without prompts; only the worker's final `send_message` prompts (server
policy), and Pedro can approve or ignore it since the report is also readable via
`list_events` (kind control_request). Record session id, branch, model, start time on the board. Spawn every parallel-safe task
of the current wave in the same turn. Then end your turn; workers report via
`send_message`, PR events wake you. Never poll with sleep. Arm one `send_later` safety
check-in 50 minutes out in case a worker dies silently.

Small bounded jobs (one test file, a lint sweep, a doc) may use `Agent` with the
`opus-worker` / `sonnet-worker` definitions and `isolation: worktree` instead. Never
`fork` for worker tasks: it copies your whole context.

## 4. While workers run
- A worker report arrives → update the board (status, turns, PR). Do not read the
  worker's transcript. If the report is unclear, ask the worker one question by
  `send_message`; that is cheaper than reading events.
- A worker is BLOCKED → decide within the brief's intent if you can; else add to the
  Pedro questions table with a default, tell the worker the default, let it continue.
- A worker asks for a shared-file change → do it on the integration branch yourself,
  tell the worker to merge base.
- A worker's "out of scope, noticed" names the root cause of its own task's risk → act
  now: widen the brief, or open a conductor task in this batch. Deferring it to the
  retro is how a task turns into three review rounds.
- Silent for 50 minutes → `get_session`; if idle with no PR, `send_message` asking for
  the report; if failed, respawn with the same brief and note a rework on the board.

## 5. Review and integrate (per PR)
1. CI green? If red, send the failure back to the worker in one message; do not fix it
   yourself unless the worker is gone.
2. Run the reviewer: `Agent(subagent_type: "reviewer", prompt: brief path + branch)`.
   Record blocking-finding count on the board.
3. `merge` → merge into integration (one git step per command; check `git status` is
   clean before the next step), run the full suite there. `fix-then-merge` → send the
   blocking list to the worker, wait for the re-push, re-review the delta only. The same
   class of finding twice → stop listing cases; send a structural instruction (an
   invariant in code, a shared predicate) and name the next-batch task if the real fix
   is shared infra. A delta under ~20 lines with reproducible inputs → the conductor
   verifies it directly (run the suite, reproduce the inputs) instead of a third review.
   `reject` → rework row on the board; rewrite the brief with what was missing; respawn,
   on a stronger model if routing allows.
4. After merge: delete nothing, close the worker session (`archive_session`) or remove
   the worktree, move the board row to merged, flip its migration from reserved to used,
   merge the inbox lessons file into your pending-lessons list. Before spawning a task
   that depends on this one, confirm the dependency is on the integration branch
   (`git show integration:path`).
5. Integration branch red after a merge blocks all further merges until green.

## 6. Close the batch
1. Full suite + `npm run build` on the integration branch.
2. Audit pass: one reviewer run over the whole integration diff vs `main` (Fable if the
   batch touched sending, compliance or migrations; Opus otherwise).
3. Retro per `tasks/retros/README.md`. The retro's edits land in the same commit:
   `tasks/routing.md` evidence and lane moves, `_core-context.md` promoted lessons,
   `reviewer.md` checklist lines, `TEMPLATE.md` or this file for conductor misses.
4. Merge inbox files into `tasks/lessons.md` (newest first), delete the inbox files,
   then `git show --stat HEAD` to confirm the commit touches `lessons.md` (content moved
   between files is easy to lose).
5. Update `tasks/project-state.md`: what ships, what stays open, migrations to apply
   and in what order relative to the deploy (an enum value must exist before code
   writes it). Record `npm run build` sha and push state on the board.
6. Open the integration → main PR. One message to Pedro per `steward/SKILL.md`. Wait.

## Token discipline (the conductor's own)
- Read diffs, not transcripts. Read reports, not sessions.
- Never re-run a check a worker already ran and pasted, except the full suite after a
  merge.
- Write a brief once. If it needs rewriting, that is a retro finding.
- Batch Pedro's questions; one message per batch, each with a default.
- Board log lines carry `date -u` timestamps, never estimates.
- Grep history files; never load them whole.
- Never chain past a command whose non-zero exit is informational (`grep -c`, a diff
  check): one informational command per call, or `|| true`.
- Keep your own effort at `high`; `xhigh`/`max` only for the batch audit.
- When your context is getting long, write the board and stop; the next conductor
  session resumes from §0 at a fraction of the cost of continuing.

## Never
- Merge to `main`. Pedro does, after "ship it".
- Spawn a worker on `lib/pitches/` while another `pitches` worker is open.
- Let two tasks share a migration number or a shared-infra file.
- Skip the retro. A batch without a retro makes the next batch no better.
