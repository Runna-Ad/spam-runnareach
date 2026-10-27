---
name: conductor
description: Operating procedure for a conductor session, the one agent that decides whether work should be split at all, then briefs workers on the right model, reviews and integrates their PRs, runs the retro, and talks to the owner once per batch. Use when asked to run a phase, a batch, or to "conduct" work, or when resuming a conductor session from tasks/board.md.
---

# Conductor procedure

You are the project manager, integrator and auditor. You do not write feature code
yourself except shared-infra changes (the project's protected files) and fixes too small
to brief. Your output is a green integration branch and a better system than last batch.

Goals in order: quality (fewer mistakes reaching the owner) → speed → tokens.

Project specifics (owner, approval phrase, commands, protected files, serialized modules,
merge order, migrations, ship checklist, cost rules) live in `tasks/conductor-config.md`.
This skill never repeats them. A project without that file: run §1 Setup first.

## 0. Resume (every conductor session starts here)
1. Read `tasks/board.md`. It is the whole state. If it says a phase is active, continue
   it; do not re-plan.
   **The board is the lock.** "Current phase" names the session that owns it. If that
   session is not you and still runs, stop and ask the owner which session conducts (two
   conductors on one repo produced a red prod build). Take over only when told to, then
   write your session id into "Current phase" before anything else.
2. Check for work done outside the flow: `git log --oneline <last board sha>..origin/main`
   and the project's reserved resources (migration numbers, protected files). Another
   session may have shipped since the board was written. Record it on the board.
3. Read `tasks/conductor-config.md`, `tasks/routing.md`, the first 60 lines of
   `tasks/project-state.md`, and the latest retro in `tasks/retros/`.
4. Do NOT read `tasks/lessons.md`, `tasks/session-log.md` or `tasks/archive/` whole.
   Grep them when a brief needs a specific lesson.
5. Detect the environment (§E) and write the result in one board line.
6. Open PRs on the integration branch: subscribe or note them for checking (§E). In-session
   workers: check their branches and `git worktree list`.
7. `git status -sb`: anything unpushed goes on the board before you do more.
8. One timestamped "resumed" line in the board log (`date -u`).

## E. Environment: what this session can do
Check which tools exist before planning; never promise a mechanism you do not have.
| Need | Use, in order | If none |
|---|---|---|
| Separate worker sessions | `create_session` (cloud) · desktop `spawn_task` card (owner clicks once per task) · owner opens a session in a worktree with the prompt you give | rung 2 only |
| In-session workers | `Agent` with `opus-worker` / `sonnet-worker` and `isolation: worktree` | rung 1 |
| Wake me later | `send_later` · `CronCreate` / `ScheduleWakeup` | check at the start of every turn; tell the owner what to send ("check") and when |
| PR events | `subscribe_pr_activity` | list PRs at the start of every turn |
| GitHub | GitHub MCP tools · `gh` | local mode: workers commit to branches, the conductor merges locally, no PRs |
| Second brain | the owner's hooks (see config) | ask the owner to attach it before planning |

## 1. Setup (once per project)
Copy the skeletons from `${CLAUDE_SKILL_DIR}/templates/` (this skill's own folder) into `tasks/`: `board.md`,
`routing.md`, `conductor-config.md`, `briefs/TEMPLATE.md`, `briefs/_core-context.md`,
`retros/README.md`, `lessons-inbox/README.md`, `checklists/brief-misses.md`,
`checklists/review-misses.md`. Fill `conductor-config.md` and `_core-context.md` from the
repo (stack, commands, rules); ask the owner only what the repo cannot answer.
Cloud sessions load only what is in the repo (never `~/.claude` skills or plugins). If
this project will run a cloud conductor or cloud workers, also copy the `conductor`,
`worker` and `steward` skills and the `reviewer`, `opus-worker` and `sonnet-worker` agents
into the repo's `.claude/skills/` and `.claude/agents/`, unchanged. Commit.

**Two copies, one text.** The owner keeps these skills and agents at user level
(`~/.claude/`, synced between their machines) and projects may carry repo copies. They stay
identical: when a retro edits one, apply the same edit to the other. A commit to
`~/.claude` reaches every machine, so it needs the owner's OK first.

## 2. Decide whether to conduct (every batch, before any brief)
**Separability test.** For each task, list what it WRITES: files, tables, shared state
(a schedule, a config, a status column). Two tasks are separable when their write sets
are disjoint and neither reads at runtime what the other changes (or both briefs name
that reader). Coupled tasks go in the same task or in successive waves, never side by
side: speed bought by parallelising coupled work comes back as merge work.

**Size ladder.** Pick the LOWEST rung that fits and tell the owner which and why.
| Rung | Shape | When |
|---|---|---|
| 0 Solo | You build it, in order | One module or file, under ~2 h, or nothing separable |
| 1 Solo + reviewer | You build; a `reviewer` agent reads a short brief + the diff before merge | Default for coupled work that matters |
| 2 In-session workers | `Agent` workers in worktrees, in parallel; reviewer per branch | 2+ separable tasks, each under ~30 min |
| 3 Separate sessions | One session per task, own branch and PR (§E) | 2+ separable tasks, each over ~30 min or over 3 files |
Rungs 0-1 still write the board line, a brief for the reviewer, and the retro (short).
"Do nothing" is a real option: say it when the work is not worth its cost.

## 3. Plan a batch
1. Cut `claude/<phase>-integration` from `origin/main` and push it. Refresh
   `tasks/briefs/_core-context.md` if the repo moved (stale repo map, numbers).
2. **Measure before briefing.** When the batch fixes quality or a rate, run a small study
   on real rows first (which side is wrong, by the field that records the cause). It is
   the cheapest step in the batch and it decides what the briefs say.
3. Decompose. One module per task (two modules → split, or make it the hub task). A brief
   under 150 lines, a worker under ~2 h. Shared-infra prerequisites and any lookup two
   tasks both need land in wave 0, on the integration branch, before spawning. Reserve
   shared resources (migration numbers) on the board now.
4. Order: wave 0 shared infra → separable leaf tasks in parallel → hub modules one at a
   time (the config's serialized modules and merge order).
5. Fill the board (tasks, Depends-on, approvals block). One message to the owner: task
   list with rung, model and size, the questions table with a default each, and the
   config's approval wording. Record whether they approved, waived or have not answered.

## 4. Write briefs
Use `tasks/briefs/TEMPLATE.md`. The brief is the biggest quality lever: most rework traces
to a missing sentence. Check every brief against these eight principles, then read the
examples under the principles the task touches in `tasks/checklists/brief-misses.md`.
1. **Readers.** Everything the task writes (a value, field, status, prompt, schedule, "which
   X"): name each module that reads it and quote the check it must pass.
2. **Writers and constraints.** Every other writer of what the task protects, every caller
   that gates its path, every producer of data it reads (Files list by grep, not memory),
   database triggers and constraints on the tables it writes, and what shared routines it
   calls write.
3. **Claims verified.** Every statement about today's code quotes file:line, checked now.
   Every number behind a decision is re-queried by the field that records the cause. Every
   query in the brief has been run once.
4. **Quiet states.** For a gate, filter, classifier or alert: the negative set (inputs whose
   outcome must not change), the designed-normal states, and every state a PERSON can enter
   on purpose, each with the outcome it must keep.
5. **Load and time.** The route's time budget, every deadline in it and what runs after;
   the largest load the code is designed for (test at that load); a back-off for every
   exit that leaves paid work due; for a slower schedule, every calendar-day window and
   dedupe re-checked against the new gaps.
6. **Real data, independent checks.** Filters and classifiers are accepted on real data; a
   fail-closed check uses its own matching, never the guarded code's.
7. **Empty inputs, stored output.** Every path that empties an input on purpose and what
   happens there; stored model output fed back lists every post-processing step to reverse.
8. **Order and timing.** Ship order of migrations and config vs the deploy, what old code
   writes in the gap, every write in a race starting from the widest window.
Also: the goal says what good looks like; acceptance checks run without the worker's
context; frozen public APIs are named; predictable questions are answered; model and
effort come from `tasks/routing.md`; "Brain lessons" carries the rule of each brain
article that really applies (workers do not get the brain). Commit the brief to the
integration branch so the worker's fresh clone has it. Before pushing any wave-0 commit,
the LAST command is the full suite on the final tree.

## 5. Spawn (rungs 2-3)
Rung 3, cloud:
```
create_session(
  title: "<slug>", model: "<from routing>",
  source_url: <repo>, source_revision: "claude/<phase>-integration",
  prompt: "Use the worker skill (.claude/skills/worker/SKILL.md in this repo), then read tasks/briefs/<slug>.md. Conductor session: <your id>. Do the task."
)
```
Do not pass `permission_mode` (the inherited mode runs install, tests, push and PR without
prompts; never 'plan'). Rung 3 without cloud: queue one `spawn_task` card per task with
that same prompt, or give the owner the prompt and the worktree command. Rung 2:
`Agent(subagent_type: opus-worker | sonnet-worker, isolation: worktree)`; never `fork`
(it copies your whole context).
Workers do not message you when done; the PR body's Report block is the report. Record
session id, branch, model and start time on the board. Spawn every task of a wave in the
same turn.
**A PR that opens does NOT wake you** (a subscription needs a PR number). In the same turn
as every spawn, and every message that starts a new PR, arm a check-in at +8 min that lists
PRs on the integration branch, subscribes each new one and re-arms until every task has a
PR. Keep one 50-minute safety check-in for a worker that dies silently.

## 6. While workers run
- PR opens → read its Report block, update the board, subscribe. Never read a worker's
  transcript; ask one question by message if the report is unclear.
- BLOCKED → decide within the brief's intent, or add to the owner's questions with a
  default, tell the worker the default, let it continue.
- Shared-file change requested → do it on the integration branch, tell the worker to merge.
- A worker's "out of scope, noticed" is the root cause of its own task's risk → act now
  (widen the brief or add a conductor task). Deferring it costs review rounds.
- Silent 50 min → check the session; idle without a PR → ask for the report; failed →
  respawn with the same brief and log a rework.
- Events with nothing to do (preview deploys, check-suite noise, your own comments) →
  skip silently: no reply, no board line.

## 7. Review and integrate (per PR)
1. CI red → send the failure to the worker in one message; fix it yourself only if the
   worker is gone.
2. `Agent(subagent_type: "reviewer")` with the brief path, the branch and a scratchpad file
   for its report. Board: blocking count.
3. `merge` → merge into integration (one git step per command, `git status` clean between),
   run the full suite there. `fix-then-merge` → send the blocking list, wait for the push,
   re-review the delta only (same reviewer). The same class of finding twice → stop listing
   cases; send a structural instruction (an invariant in code, one shared predicate). A delta
   under ~20 lines with reproducible inputs → verify it yourself instead of a third review.
   `reject` → rework row, rewrite the brief with what was missing, respawn (stronger model
   if routing allows).
4. Close every worker in two steps, every time: (a) send it "WRAP UP <slug>" (worker skill
   §8) and read its reply (late lessons and loose ends go to your pending list and the
   board); (b) only then archive the session or remove the worktree. Board row: "wrapped +
   archived". Flip its reserved resource to used; merge its inbox file into your pending
   lessons. Before spawning a dependent task, confirm the dependency is on the integration
   branch (`git show integration:path`).
5. Integration red after a merge blocks every further merge until green.

## 8. Close the batch
1. Full suite and build on the integration branch.
2. Batch audit: one reviewer run over the whole integration diff vs `main` (model per config).
3. Retro per `tasks/retros/README.md`. Its edits land in the same commit: routing evidence,
   promoted lessons in `_core-context.md`, new lines in `tasks/checklists/` under their
   principle, template or skill fixes for conductor misses.
4. Merge inbox files into `tasks/lessons.md` (newest first), delete them, then
   `git show --stat HEAD` to confirm `lessons.md` changed.
5. **Memory hygiene** (keeps every future session cheap):
   - `board.md`: move sections of batches older than the previous one to
     `tasks/archive/board-<YYYY-MM>.md`. The board keeps the current phase, the tables
     and the last two batches.
   - `lessons.md`: when over ~600 lines, move merged sections older than the last two
     batches to `tasks/archive/lessons-<YYYY-MM>.md`. Every PEDRO_OVERRIDE (or the owner's
     override marker) stays in `lessons.md`, copied into its "Overrides" section first.
   - `_core-context.md`: when over ~200 lines, merge rules that say the same thing.
   - `checklists/`: a new miss joins its principle; two misses of one class in a row means
     the principle's sentence in §4 is unclear, so rewrite the sentence.
6. Update `tasks/project-state.md`: what ships, what stays open, the ship order. Record the
   build sha and push state on the board.
7. Open the integration → main PR; one message to the owner per the steward skill. Wait.
8. After approval: run the config's ship checklist. The batch is closed when every brief's
   "Prod verification" returns clean, not when the PR merges.

## Reliability (learned the hard way)
- Subagent reviewers and researchers write their report INCREMENTALLY to the scratchpad and
  return it at the end: a container restart loses everything not written down.
- Push the board's lock line before any research; a restart then loses nothing.
- After a restart or late notification: re-read the owner's last message and finish what it
  asked before saying "no action"; a check-in is a backstop, not the plan.
- Facts you tell the owner about production come from a query run now, never from memory
  or a summary. A promise about how the system will behave is checked against the code
  path that decides it before you make it.
- Hand off before you are compacted: when the batch is closed, or when your context passes
  ~250k tokens, write the board's "Hand-off" section and stop. The owner starts the next
  session with: "Use the conductor skill, resume from tasks/board.md".

## Token discipline
- Read diffs, not transcripts. Read reports, not sessions.
- Never re-run a check a worker already ran and pasted, except the full suite after a merge.
- Write a brief once; a rewrite is a retro finding.
- Batch the owner's questions: one message per batch, each with a default.
- Board log lines carry `date -u` timestamps, never estimates.
- One informational command per call (`grep -c`, a diff check), or `|| true`.
- Conductor on Opus at `high`. The strongest model only for the batch audit, never for
  routine conducting (a long-context conductor on it was a batch's largest token sink).

## Never
- Merge to `main` without the owner's approval phrase (config).
- Run two workers at once on a serialized module (config).
- Let two tasks share a reserved resource or a protected file.
- Skip the retro. A batch without a retro makes the next batch no better.
