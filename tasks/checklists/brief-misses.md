# Brief misses (S.P.A.M. examples, grouped by principle)

Each line is a real rework round a brief caused, filed under the principle in the
conductor skill (§2) that would have prevented it. When a retro finds a new brief miss,
add it under its principle. If it fits none, that is a new principle: add it to the skill
too (rare; the list should stay near 8).

## P1 Readers: who reads what this task writes
- A value the brief invents that another module READS (a reason string, an enum value, a
  column, a status) names that reader and quotes the check it must pass. Grep for the
  consumer before writing the value (batch 2: a hold reason the governor's
  `startsWith("held by a person")` did not match would have re-sent held emails).
- A field the task writes that another module later TRUSTS as text (a gate's allowed sources,
  exemplars, prompts): the brief names that reader, quotes its acceptance rule, and asks for
  the guard to include it (batch 7: fact-research took 2 rework rounds because the brief never
  said gate.ts:126 turns an approved `statistic` into a send-gate source).
- A brief that changes "which X" (which recipient, which link, which arm): list every reader
  that answers the same question with its own copy and put them all in Files (batch 8: the
  greeting, the gate and /pitches each picked the recipient separately from `contact_id`).
- A brief that changes a writer or reviewer PROMPT: say what the change does to every learner
  that compares arms over a window (presend guardrail, bandit) and require the sample to be
  keyed on the prompt version (batch 9 audit).
- A brief that tells a reviewer model "this line is ours, not a claim": name the slots the
  writer fills in that line and say they are still judged (batch 9: CTA pain, proof line).
- If this task's output combines at runtime with another task in the batch, the brief
  says what the other task does at runtime (a pause empties a window; a cron reads a
  column), or the batch audit is told to check the pair.

## P2 Writers and constraints: who else writes it, and what the database enforces
- The Files list is derived by grep: every caller that gates the path, every producer of
  data the change reads, every writer of a field it protects (batch 4: 3 of 5 blocking
  findings were files the brief left out: a route filter, a report producer, a 4th writer).
- A brief that tells a worker to WRITE an existing column: grep the migrations for triggers
  and constraints on that table first and quote them (batch 8: "mark it in `decision`", but
  0038 makes `pitches.decision` write-once → every mark failed silently in prod shape).
- A brief for a repair/backfill that calls a shared routine lists what that routine writes
  and who counts those rows by time (batch 5: phantom opt-out events would have tripped a
  breaker on the deploy week).

## P3 Claims verified before spawning
- A claim about how the code behaves today quotes the line that does it, checked against its
  file:line before spawning (batch 4: a false premise about the >=70 pitching phase cost a
  rework round; batch 5: "the /learning page lists insights" was false; batch 1: a fetch
  order the code does not have).
- A number that drove Pedro's decision is grouped by the field that RECORDS the cause
  (e.g. `auto_rejected_reason`), not by labels on the content, and re-checked before the
  brief; if it changed, tell Pedro before spawning (batch 6: "9 polish-only drops" was 0).
- Every SQL in a brief's Prod verification is run once against prod (or column-checked
  against the migrations) before spawning; a query that errors is not a check (batch 6:
  `cost_tracking.created_at`, the column is `incurred_at`).

## P4 Quiet states: what must not change or fire
- For a classifier, filter or gate: the NEGATIVE set is listed (inputs whose class must
  not change) and the rule is stated as an invariant, not as an order of checks
  (simulation: the reply classifier took 3 rounds without one).
- An alert, report or emergency rule lists the designed-normal states that must stay
  silent (paused inbox, cap drip, cooldown, weekend, outside the send window, AI cap,
  nothing sent yet) and states the rule as "due activity did not happen in a closed
  window", never "something is waiting" (a 24h dedupe turns a false positive into a
  daily email).
- A brief that silences or re-alerts a state: list every way a PERSON can enter that state
  on purpose and say which stay silent (batch 8: a deliberate inbox pause would have alerted
  Pedro daily).

## P5 Load and time: the largest designed load and every deadline
- Work added to a long route (poll, tick, send-queue) states the route's time budget and
  what runs after it: anything at the end must be safe to be killed at maxDuration
  (batch 2 lead alerts: 3 rounds on "claimed, then killed, never sent").
- A brief with a time budget names the largest load the code is designed for (schedules,
  ramp constants) and asks for a test at that load, plus a reserve for every step between
  two deadlines (batch 5: warm-up took 3 review rounds on budget math at 40-50/day).
- A brief that runs a job more often: list every exit that leaves the item due after paid
  work and ask for a back-off (batch 8 #57: 48 recomposes/day).
- A brief that runs a job LESS often: list every reader that windows by calendar day or
  by clock hours and every dedupe keyed on the old gap (quiet hours #63: a midnight-reset
  breaker and a 24h dedupe).

## P6 Real data and independent checks
- A privacy filter, scrubber or classifier: acceptance check 1 runs on REAL prod data
  (the conductor exports a fixture to the worker or measures before review). A metric on
  a generator built from the same vocabulary the worker then tunes measures nothing
  (batch 3: 0.8% generated vs 80% real drop rate).
- A scrubber, filter or gate guarded by a fail-closed check: the brief says the check
  and the property test must use their OWN matching, never the guarded code's (batch 1
  and batch 2 both lost a round to a leak check that reused the scrubber's regexes).
- A list built from external data (gazetteer, names, dictionary): the brief names the
  everyday spellings to probe that the data writes differently ("Mexico City" vs "Ciudad
  de México", "León de los Aldama" vs "León") and asks the generator to print what it
  added and what it intersects with our allow lists (#17 r6b: 1 blocking from each).
- Before briefing a quality fix, measure which side is wrong on real rows (batch 9: a
  30-draft study showed the critic over-strict 31 times vs the writer 16; "fix the
  writer" alone would have moved ~3 of 30).

## P7 Empty inputs and stored output fed back
- A feature that infers something from an input the model did NOT get (no benchmark, no
  exemplar): the brief lists every path that empties that input on purpose (A/B arms, caps,
  fallbacks) and says what happens there (batch 7: the no_benchmark arm).
- A brief that feeds stored output back into a model (a rewrite, a revision, an exemplar)
  lists every step the code applied AFTER the model answered (filled links and codes,
  appended lines) and asks for each to be reversed, tested with a fake model that copies
  its input (batch 6: the held body carried the old pitch's attribution code into the rewrite).

## P8 Order and timing: ship order, gaps, races
- A migration the old prod code will run against (applied before the deploy): the brief
  says what rows the old code writes in the gap and what the new code then does to them;
  never key a window on `updated_at` (the trigger bumps it on every write).
- A brief that changes a schedule or config another module quotes back (heartbeat.ts, health
  rules, vercel.json tests): state the ship order (migration before/after deploy) in the
  brief and the migration header (batch 8 #57).
- A brief that names a race lists EVERY write the run makes to the contested row (claim,
  release, final update) and starts from the widest read→write window (batch 5: the brief
  named the 1-3 s release window; the real one was the 20-95 s before the claim).
- A migration that adds enum values ships with its TS union in the same wave-0 commit
  (batch 1).
