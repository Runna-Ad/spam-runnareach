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
   **The board is the lock.** "Current phase" names the conductor session that owns it.
   If that session is not you and `list_sessions` shows it running or idle (not
   archived), stop and ask Pedro which session conducts; two conductors on one repo is
   how 2026-10-18 got a red prod build. Take over only when Pedro says so, and then
   write your session id into "Current phase" before anything else.
2. Read `tasks/routing.md`, `tasks/project-state.md` (first 60 lines), and the latest
   file in `tasks/retros/` (if only the README exists, skip).
3. Do NOT read `tasks/lessons.md` or `tasks/session-log.md` in full. Grep them when a
   brief needs a specific lesson.
4. Check open PRs on the integration branch and their CI state. Subscribe to each open
   worker PR with `subscribe_pr_activity` if not already subscribed. For in-session
   workers (board Session = agent) there are no PRs: check the branch instead and list
   worktrees to clean up (`git worktree list`).
5. Check `git status -sb`: anything unpushed goes on the board before you do more.
6. Check the brain is here. A "PEDRO'S GLOBAL RULES" block at session start and a
   "SECOND BRAIN" catalog on the first prompt mean yes (`.claude/hooks/cloud-rules.sh`,
   `cloud-brain.sh`). A "Second brain not attached" note means no: ask Pedro to attach
   Moisty-Mango/second-brain and Moisty-Mango/dotclaude read-only before planning
   anything. Those global rules (wrap-up, PEDRO_OVERRIDE, writing check) apply to the
   conductor in full (PEDRO_OVERRIDE 2026-10-19).
7. Write a one-line "resumed" entry in the board log, timestamped with `date -u`.

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
- A value the brief invents that another module READS (a reason string, an enum value, a
  column, a status) names that reader and quotes the check it must pass. Grep for the
  consumer before writing the value (batch 2: a hold reason the governor's
  `startsWith("held by a person")` did not match would have re-sent held emails).
- Work added to a long route (poll, tick, send-queue) states the route's time budget and
  what runs after it: anything at the end must be safe to be killed at maxDuration
  (batch 2 lead alerts: 3 rounds on "claimed, then killed, never sent").
- An alert, report or emergency rule lists the designed-normal states that must stay
  silent (paused inbox, cap drip, cooldown, weekend, outside the send window, AI cap,
  nothing sent yet) and states the rule as "due activity did not happen in a closed
  window", never "something is waiting" (a 24h dedupe turns a false positive into a
  daily email).
- A scrubber, filter or gate guarded by a fail-closed check: the brief says the check
  and the property test must use their OWN matching, never the guarded code's (batch 1
  and batch 2 both lost a round to a leak check that reused the scrubber's regexes).
- A privacy filter, scrubber or classifier: acceptance check 1 runs on REAL prod data
  (the conductor exports a fixture to the worker or measures before review). A metric on
  a generator built from the same vocabulary the worker then tunes measures nothing
  (batch 3: 0.8% generated vs 80% real drop rate).
- A list built from external data (gazetteer, names, dictionary): the brief names the
  everyday spellings to probe that the data writes differently ("Mexico City" vs "Ciudad
  de México", "León de los Aldama" vs "León") and asks the generator to print what it
  added and what it intersects with our allow lists (#17 r6b: 1 blocking from each).
- A migration the old prod code will run against (applied before the deploy): the brief
  says what rows the old code writes in the gap and what the new code then does to them;
  never key a window on `updated_at` (the trigger bumps it on every write).
- Model/effort copied from `tasks/routing.md`, and the brief says why if it deviates.
- The Files list is derived by grep: every caller that gates the path, every producer of
  data the change reads, every writer of a field it protects (batch 4: 3 of 5 blocking
  findings were files the brief left out: a route filter, a report producer, a 4th writer).
- A claim about how the code behaves today quotes the line that does it, checked against its
  file:line before spawning (batch 4: a false premise about the >=70 pitching phase cost a
  rework round; batch 5: "the /learning page lists insights" was false).
- A brief that names a race lists EVERY write the run makes to the contested row (claim,
  release, final update) and starts from the widest read→write window (batch 5: the brief
  named the 1-3 s release window; the real one was the 20-95 s before the claim).
- A brief with a time budget names the largest load the code is designed for (schedules,
  ramp constants) and asks for a test at that load, plus a reserve for every step between
  two deadlines (batch 5: warm-up took 3 review rounds on budget math at 40-50/day).
- A brief for a repair/backfill that calls a shared routine lists what that routine writes
  and who counts those rows by time (batch 5: phantom opt-out events would have tripped a
  breaker on the deploy week).
- A brief that feeds stored output back into a model (a rewrite, a revision, an exemplar)
  lists every step the code applied AFTER the model answered (filled links and codes,
  appended lines) and asks for each to be reversed, tested with a fake model that copies
  its input (batch 6: the held body carried the old pitch's attribution code into the rewrite).
- A number that drove Pedro's decision is grouped by the field that RECORDS the cause
  (e.g. `auto_rejected_reason`), not by labels on the content, and re-checked before the
  brief; if it changed, tell Pedro before spawning (batch 6: "9 polish-only drops" was 0).
- Every SQL in a brief's Prod verification is run once against prod (or column-checked
  against the migrations) before spawning; a query that errors is not a check (batch 6:
  `cost_tracking.created_at`, the column is `incurred_at`).
- "Brain lessons": run `tasks/tools/brain-recall-for.sh "<the brief's goal in a sentence>"`
  and paste the RULE of each article that really applies (skip weak matches). Worker
  sessions do not get the brain; the brief is how its lessons reach them.
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
and PR creation without prompts. Workers do NOT `send_message` when done (that was the
one call that prompted Pedro, six times in batch 1): the PR body's Report block is the
report. A worker messages you only when BLOCKED. Record session id, branch, model, start
time on the board. Spawn every parallel-safe task of the current wave in the same turn.
**A PR that opens does NOT wake you**: a subscription needs a PR number, so nothing is
subscribed until you subscribe (batch 2 found 6 PRs late, 4 by ~8 min, 2 by ~20 min).
So arm a `send_later` at +8 min whose only job is `list_pull_requests` with
`base=<integration>` → `subscribe_pr_activity` each new PR → re-arm at +8 min until every
spawned task has a PR. Arm it in the SAME turn as every spawn AND every `send_message`
that starts a new PR (a follow-up task to a warm worker, a later wave): batch 3 armed it
for wave 1 only and found both wave-2 PRs ~20 min late. After that, PR events (CI, merge) wake you. Never poll with sleep.
Keep one 50-minute safety check-in for a worker that dies silently (no PR, no message).

Small bounded jobs (one test file, a lint sweep, a doc) may use `Agent` with the
`opus-worker` / `sonnet-worker` definitions and `isolation: worktree` instead. Never
`fork` for worker tasks: it copies your whole context.

## 4. While workers run
- A worker PR opens → read its Report block, update the board (status, turns, PR),
  subscribe. Do not read the worker's transcript. If the report is unclear, ask the
  worker one question by `send_message`; that is cheaper than reading events.
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
4. After merge: delete nothing. Close the worker in two steps, every time (PEDRO_OVERRIDE
   2026-10-19): (a) wrap up: `send_message` it the WRAP UP message from
   `worker/SKILL.md` section 8, then read its reply with `list_events` (kinds
   assistant/result) and carry late lessons and loose ends to your pending-lessons list
   and the board; (b) only then `archive_session` (an in-session sub-agent: its final
   output is the wrap-up; remove the worktree). A worker rejected or stuck gets the same
   two steps. Board row: "wrapped + archived". Then move the board row to merged, flip
   its migration from reserved to used,
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
7. After "ship it": run the ship checklist in `steward/SKILL.md` (verify each manual step
   by query, migrations by name, external prerequisites, first prod run of every new
   cron). The batch is closed when every brief's "Prod verification" returns clean, not
   when the PR merges.

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
- Run the conductor on Opus 5.5 at `high`. Fable only for the batch audit (spawn it as
  a reviewer agent or a separate session), never for routine conducting: batch 1's
  conductor ran on Fable with a long context and was the batch's largest token sink.
- Hand off before you are compacted: when the batch is merged and the retro written, or
  when your context passes ~250k tokens, write the board's "Hand-off" section and stop.
  The next conductor session resumes from §0 at a fraction of the cost of continuing.
  Pedro starts it with: "Read .claude/skills/conductor/SKILL.md, resume from
  tasks/board.md".

## After a restart or a late notification
- Re-read the last message from Pedro and finish what it asked before replying "no action":
  a scheduled check-in is a backstop, not the plan (hotfix retro: veto was set 25 min late).
- Facts you tell Pedro about prod (send times, counts, who did what) come from a query run
  now, never from memory or an earlier summary (hotfix retro: "one burst" was 6/6/6/1).
- A promise about how the system will behave ("they wait for you") is checked against the
  code path that decides it before it is made.

## Never
- Merge to `main`. Pedro does, after "ship it".
- Spawn a worker on `lib/pitches/` while another `pitches` worker is open.
- Let two tasks share a migration number or a shared-infra file.
- Skip the retro. A batch without a retro makes the next batch no better.
