# Retro 2026-10-17: workflow simulation on a fictional project (ORBIT)

Before using the multi-agent workflow on S.P.A.M., it was run end to end on a made-up
project with the same shape (hub module, leaf and isolated modules, shared types,
numbered migrations, a 400-line lessons file, a CLAUDE.md that says "read history first").
One conductor, 4 worker runs (3 Opus, 1 Sonnet), 4 per-task reviews (one went 3 rounds),
1 batch audit, 1 resume test from the board alone. Result: 15 → 88 tests, 0 CI reds,
0 scope violations, 1 real regression caught in review, 1 cross-task design flaw caught
by the batch audit, 1 lost commit caught by the resume test. The gaps below were applied
to the skills, agents, board and brief template in the same commit.

## Per task
| Slug | Model/effort | Turns | Blocking findings | Rework | Tokens worker / reviewer |
|---|---|---|---|---|---|
| vet-public-suffix (bug fix, leaf) | sonnet/medium | 6 | 0 | 0 | ~20k / ~23k |
| health-pause-rule (isolated) | opus/medium | 8 | 0 | 0 | ~28k / ~24k |
| replies-not-now (classifier + migration) | opus/medium | 27 | 3 rounds | 3 | ~61k / ~45k |
| rfq-skip-paused (hub, depends on health) | opus/high | 8 | 0 | 0 | ~29k / ~29k |
| batch audit (whole diff) | opus/high | — | 0 (6 optional, 1 design) | — | ~47k |
| resume test (board + skill only) | opus | — | 10 resume gaps | — | ~71k |

## Gaps found and fixed
Gaps found while running the workflow end to end. G = gap, N = note.

- G1 (decompose): CLAUDE.md multi-agent section lists `migrations/*` as conductor-only,
  but TEMPLATE.md and `_core-context.md` tell the worker to write the migration at the
  reserved number. Contradiction. Resolution used in sim: worker writes the file at the
  reserved number; conductor applies it. CLAUDE.md wording must change.
- G2 (spawn): `.claude/agents/*-worker.md` bodies use repo-relative paths
  (`.claude/skills/worker/SKILL.md`). In a remote session that is fine; for an `Agent`
  sub-agent the cwd is wherever the conductor is, which may not be the worktree. The
  prompt must pass absolute paths. Sim prompts do; real skill should say so.
- G3 (worker §2): skill says `npm ci --prefer-offline || npm install`; a worker session
  on a fresh clone pays an install on every task. Fine in cloud sessions, but the brief
  should say whether node_modules is already present (it is in the cloud env setup).
- G4 (brief writing): the conductor skill says "commit the brief to the integration branch
  so the worker's fresh clone has it" but does not say the core-context must ALSO be
  written by the conductor before the first brief. For a new project (or a new phase after
  a big refactor) that is a real step with real tokens. Add it to conductor §1.
- G5 (board): the board template has no column for "wave" or "depends on". The rfq task
  depends on health landing; I had to abuse the "Blocked on" column. Add a Depends-on
  column.
- G6 (sim mechanics, also real): `send_message`/`create_session` have no sub-agent
  equivalent, so in-session workers return a report instead. The worker skill §7 should
  say "if you are a sub-agent, return the report as your final output".
- N1: writing 4 briefs + core-context took the conductor ~8k output tokens. That is the
  conductor's main token cost per batch; acceptable.
- G7 (instrumentation, sim-only): access-time markers are defeated by git re-hashing
  files whose ctime changed. Fixed with `git update-index --assume-unchanged` on the
  marked files. Wave-1 results on "did the worker open forbidden files" are therefore
  inconclusive; wave 2 (rfq) is measured properly. Self-reported read lists are the
  fallback evidence.
- G8 (quality): reviewer caught that a worker-written regression test also passes on the
  base branch. The worker skill should require: "for a bug fix, run the new test against
  the base commit and show it fails" (git stash or `git show base:file` into a temp). Cheap
  and it makes every regression test real.
- N2: Sonnet worker (vet, S task): ~20k tokens, 8 tool uses, 36s; reviewer verdict merge.
  Opus worker (health, S task): ~28k tokens, 11 tool uses, 108s.
- G9 (worker skill): "never include model names in commits" made the worker drop the
  harness's required Co-Authored-By trailer. Reword: "the harness attribution trailer is
  required; no model names anywhere else (PR titles, bodies, code, comments)".
- G10 (worker skill): a worker amended and force-pushed its own branch. Harmless on a
  branch nobody else has, but the skill should say "no amend/force-push after the PR is
  open; add commits" so the reviewer's delta-review stays valid.
- N3: the replies worker deviated from the brief's rule order with a correct reason and
  documented it under Decisions. The brief was wrong (hard opt-outs must beat not_now).
  Brief-quality finding for the retro: when a brief dictates ordering, state the
  invariant ("an opt-out is never scheduled for follow-up") so the worker can check it.
- N4: the worker flagged a real Postgres hazard (enum ADD VALUE cannot be used in the same
  transaction). That is relevant to S.P.A.M. migrations too. Lessons-inbox worked.
- G11 (sim artifact with a real lesson): per-branch PR.md at the repo root collides on
  every merge. Real PRs live on GitHub so this does not apply, but the same shape WOULD
  apply to any per-task file at a fixed path. lessons-inbox is per-slug, so it is safe.
- G12 (conductor discipline): I chained "merge && checks && board edit && commit && push
  && worktree" in one command; the merge failed and everything after it ran on the wrong
  state (worktree cut from the pre-merge commit, so wave 2 would have lacked the API it
  depends on). Conductor skill §5 must say: one step per command on a merge; verify
  `git status` clean and the dependency present before spawning a dependent task.
- N5 (quality loop works): the Opus reviewer found a real regression the Opus worker
  introduced while improving on the brief, traced it to the cron write path, and gave a
  reproducible failing input list. That is exactly the gate a single session lacks. Cost:
  ~25k tokens for the review.
- N6 (brief quality): the regression traces back to my brief listing phrasings for
  not_now but not for opt-outs, and stating an order instead of the invariant. Briefs
  for classifiers must list the negative set too.
- N7 (proof, wave 2): with assume-unchanged markers, the hub worker never opened
  tasks/lessons.md, session-log.md, audit.md or project-state.md (access times still
  2000-01-01 after the run). The "load only brief + core-context" rule holds under Opus
  at high effort on an M task. Source-file markers are meaningless (tsc and the test
  runner read every .ts), so "did it read outside its allow-list" can only be judged
  from the self-reported list, which for all 4 workers matched the brief's read list.
- N8: hub worker (Opus, high, M task): ~29k tokens, 11 tool uses, 98s. The high-effort
  hub run cost about the same as the medium-effort S tasks; effort did not blow up tokens.
- G8b (refines G8): "prove the new test fails" must target the commit that introduced
  the risk (for a regression caught in review, the worker's own first commit), not
  always the base branch. Worker skill wording: "show the test failing on the code it
  guards against: the base for a bug fix, your own earlier commit for a review fix".
- N9 (rework cost): the review round trip for replies cost ~40k worker tokens (resume)
  + ~25k reviewer tokens + the re-review. A rework roughly doubles a task's cost. The
  brief gap (N6) is where that money went.
- G13 (conductor skill): no rule for "same class of finding twice". Added in practice:
  round 2 on the same class → conductor rewrites the fix as a structural instruction
  (invariant in code), not a longer list. Add to conductor §5.
- G14 (brief / conductor judgment): the worker flagged in round 1 that the classifier's
  fallback drops unknown replies ("needs-human intent would be safer") and I scoped it
  out. Both review rounds were symptoms of that. Lesson for the conductor: when a worker's
  "out of scope, noticed" names the root cause of the task's own risk, pull it into the
  brief or the next wave immediately, not the retro.
- N10 (worker pushback is a feature): the worker refused a conductor instruction with
  measured evidence (my regex would suppress 6/7 valid replies) and offered the one-line
  switch to comply. The conductor skill should state explicitly that a worker may reject
  an instruction that breaks the brief's goal, with evidence, and that the conductor
  decides. The worker skill §3 already allows deviation with a documented reason; make it
  symmetric for conductor review instructions.
- N11 (cost of the replies task so far): worker ~28k + 40k + 56k = ~124k tokens over 3
  rounds; reviewer ~25k + 35k + round 3 pending. An S task became the most expensive one
  in the batch because the brief missed the negative set and the structural fix was
  deferred. Rework, not model choice, is the token sink.
- G15 (conductor skill, token rule): when a re-review delta is tiny and mechanical (a
  list of patterns + their tests), the conductor verifies it directly (run the suite,
  reproduce the reviewer's inputs) instead of spending another ~30k-token review. Add:
  "delta under ~20 lines with reproducible inputs → conductor spot-check, not reviewer".
- G16 (design, next batch): regex classifiers cannot enumerate language. The structural
  fix is a `needs_review` intent for replies carrying both signals, which is a shared
  types + migration change = conductor task. Same applies to S.P.A.M.'s reply classifier.
- G17 (caught by the resume test): the lessons-inbox merge commit held only the
  deletions; lessons.md itself was never committed (my assume-unchanged marker made git
  skip it). Sim-caused, but the class is real: any step that moves content between files
  must be verified by `git show --stat` of the commit, not by looking at the working
  tree. Add to conductor §6.4: "verify the merge commit touches lessons.md".
- G18 (resume §0): the skill says read the latest retro; on a first batch none exists.
  Say "if none, skip". §1.2 hard-codes the audit filename; fine for S.P.A.M., note it.
- G19 (resume §0.4 / board): the skill assumes remote sessions and real PRs. For
  in-session Agent workers there are no session ids, PR links or CI runs, so the board
  columns "Session" and "PR" and the step "subscribe to PRs" do not apply. Add an
  "in-session worker" variant: Session = agent, PR = branch, CI = local checks, and
  "worktrees to clean up" as a board section.
- G20 (board): no record of whether the owner approved the batch plan, whether the
  questions were sent, whether `npm run build` passed, or which commits are unpushed.
  Add an "Approvals and checks" block to the board template (plan approved: Y/N/waived,
  questions sent: date, build: sha, origin in sync: Y/N).
- G21 (board log): I wrote approximate clock times into the log while commits carry
  real ones; the resume agent flagged the mismatch. Rule: log lines use `date -u`.
- G22 (board): migration 0013 still read "reserved" after the branch using it was
  merged. Conductor §5.4 must flip reserved → used at merge.
- G23 (leftover): tasks/prs/rfq-skip-paused.md remained on integration while the other
  PR bodies were dropped. Sim artifact, but the general rule holds: per-task artifacts
  must have one defined fate at merge.
- N12 (resume test verdict): a fresh Opus agent reconstructed phase, task states, owed
  work, next action, open questions and migration state from the board + skill alone,
  without touching any history file, and found a lost commit. The board works as the
  resume point; the gaps above are template fixes, not design flaws.
