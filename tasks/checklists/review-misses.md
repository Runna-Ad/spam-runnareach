# Review checklist (S.P.A.M. examples, grouped by principle)

The reviewer agent reads this whole file after the brief. Each line is something a
reviewer, the batch audit, CI or Pedro caught. When a retro records a reviewer miss, add
the line under its principle (same P1-P8 as the conductor skill).

## Always
- Did every acceptance check in the brief actually run, with the output in the PR?
- Does the PR silently widen scope (files outside the allow-list)? Report under SCOPE.
- Would Pedro's standing rules in `_core-context.md` be violated by any line of this diff?
- The PR claims its tests fail on the old code: check it once (base for a bug fix, the
  worker's earlier commit for a review fix).
- Tests: do they exercise the failure mode that matters (false positives for filters,
  round-trips for encoders), or only the happy path?
- Task adds an integration, a cron, an OAuth scope or an env var: does the PR body list
  the external prerequisites (API enabled in the Google Cloud project, not just the
  scope) and a prod verification query? Missing → BLOCKING; the batch cannot be closed
  without them (phase 3 batch 1: calendar sync sat 11 h on an unlisted console toggle).
- Every SQL in the PR body: check its columns against the migrations (batch 6:
  `cost_tracking.created_at` does not exist).

## P1 Readers
- Does the change introduce a second predicate for a question one function already answers?
- A value written in one module and read in another (a reason string, a status, a
  column): grep the reader and test the written value against the reader's check.
- A value one module writes and another module FILTERS on (market, pain codes, scope,
  status): run the reader's filter over every value the writer can produce, including the
  empty one (batch 7 audit: market "US" and pain_codes {} made approved rows unofferable).
- A field written for human review that another module later trusts (a gate's allowed
  sources, an exemplar, a prompt): run the READER's acceptance rule on the field's worst
  case, not only the writer's guard (batch 7: an approved statistic sentence would have
  made "three times more" and "$18 billion" sendable).
- Any write to `prospects.status`: list every reader (send-queue, follow-up, nudge, reply
  poll, discovery, governor) and say which transitions each one honours.
- A rule that tightens a verdict, label or lane: grep every place that STORES or caches that
  verdict or a decision derived from it (labels, lanes, approvals, a reused stored value) and
  say what happens to rows decided under the old rule. Unhandled → BLOCKING (hotfix: a cached
  `send` would have auto-sent finder addresses for 7 days).
- A new import in a cron route: grep tests/ for the route path; every stub loader needs an
  answer for the new name.
- Does this task's output combine at runtime with another task in the batch (a rule one
  module writes, a cron another reads)? Say so under OPTIONAL so the batch audit looks.
- A reviewer/critic prompt that exempts "house text": does any exempted line contain a part the
  writer fills in (a [pain], a result, a subject)? That part must still be judged (batch 9).

## P2 Writers and constraints
- Column rename or enum value: every query and TS union updated? Migration numbered as
  reserved in the brief?
- A column the diff UPDATEs on an existing row: grep the migrations for triggers on that
  table (write-once, immutability) and check the fake db enforces them (batch 8 #58: a
  write-once `decision` mark passed every test and failed every write in prod).
- A test fake for a table the diff queries: does it reject unknown columns / honour the
  select list? If not, check every column the new query uses against the migration's
  `create table` yourself (batch 4: a wrong column passed every test).
- A repair, sweep or backfill: what does each routine it calls write, with which timestamp,
  and which breaker, learner or report counts those rows? (batch 5: a DNC repair would have
  written two July opt-outs dated today and tripped opt_out_spike.)
- Does any new code path reachable from a cron use the cookie client? (must be service-role)
- A new `"use server"` export or a new `messages.create`: auth before the paid call, cost
  recorded on usage.

## P3 Claims about the prospect and the code
- Does any new outbound-mail text make an unverified claim about the prospect?
- A prompt that newly ALLOWS a pattern: read it as the cheapest model would. Does a fixed
  cue phrase let a forbidden claim through, and will the phrase become a template?

## P4 Quiet states
- A detector that writes found:false: list every HTML way the feature appears (links, form actions + submit text, button onclick/data-href, scripts, iframes) and check each resolves or yields null; probe one real page of each shape (batch 10 #70).
- Classifier, filter or gate change: probe inputs that contain the trigger words but belong
  to another class (an interested reply that says "stop by our booth"); list them.
- New alert, digest or emergency rule: run it against the designed-normal states
  (paused inbox, cap drip, cooldown, weekend, outside the send window, AI cap reached,
  nothing sent yet). A rule that fires there becomes a daily email under a 24h dedupe →
  BLOCKING.
- An alert rule: run it against each state a PERSON can enter on purpose (a manual pause, a
  kill switch, a holiday), not only the automatic ones.
- An automatic pause or block a person can lift: does it count evidence only after the latest
  lift, and is the lift a row only the lift writes (never `updated_at`)? (hotfix: a resume was
  re-paused by the same 2 bounces every 15 min.)

## P5 Load and time
- New `fetch`: `AbortSignal.timeout` present? Worst-case time × retries under the route's
  `maxDuration`?
- New Claude call: inside the cost wrapper? `max_tokens` sized to worst case? zod `.transform`
  clipping? JSON parsed with a parser?
- New work at the END of a long route: what if Vercel kills the function right after
  the first write? Anything claimed/marked before a send must survive that.
- A deadline, budget or cap: recompute it at the largest load the code is designed for, not
  today's prod load, and check every step between two deadlines still gets time (batch 5:
  warm-up budget fit 5/day, broke at the designed 40-50/day, then starved the reply step).
- A cadence change: every exit that leaves an item due after paid work (Claude, quota) needs
  a back-off. Slower cadence: every calendar-day window and every dedupe re-checked against
  the new gaps (quiet hours #63).

## P6 Independent checks
- "Newest row" logic: does the test fake honour order() and limit()? If not, newest is untested (batch 10 #71).
- A fail-closed check (leak check, invariant, guard): does it call the code it guards?
  If it reuses the guarded code's matchers it can never fire on that code's misses →
  BLOCKING. Same for the property test's own matcher.
- A scrubber that masks paired delimiters (quotes, brackets) is not fail-closed: feed it
  unbalanced input from the real source (batch 5: model text leaked past quote pairing).
- An error field or flag checked with `if (x.error)` / `if (msg)`: what does an empty
  string do? (postgrest-js: empty-body 5xx → `message: ""`). Presence, not truthiness.
  A postgrest `head: true` count error ALWAYS has `message: ""` (HEAD has no body): batch 5 #42.

## P7 Empty inputs and stored output fed back
- A feature that reads meaning into a missing input (no benchmark offered, no exemplar,
  no contact): list every path that empties that input on purpose (A/B arms, caps,
  fallbacks) and check each is excluded (batch 7: the no_benchmark arm).
- Stored text handed back to a model: list what the code added after the model answered
  (filled links with attribution codes, appended lines) and check each is reversed; run a
  fake model that copies its input to the end of the path (batch 6: attribution lost).

## P8 Order, timing, races
- A reader of a stored observation keyed on an id whose underlying value can change (site, domain, email): does it re-match the row to the current value, and does a newer failed row stop an older good one? (batch 10 #71)
- A migration applied before the deploy: what do the OLD prod code's writes look like in
  the new schema during the gap, and does the NEW code re-act on them (duplicate alert,
  re-send)? Missing ship step → BLOCKING.
- A race/overlap test: delete the guard it claims to test (the claim check, the WHERE
  guard) and run it. Still green → BLOCKING (the test does not exercise the race).
- A "since" timestamp that decides what was already handled (stage_since, resumed_at): is it
  taken AFTER the newest row the same run wrote? Drive it with the evidence written inside
  run 1 and three runs in a row (batch 8 #55: the veto clock restarted twice).
- UI: a control disabled by a server prop while its client state stays on (useState
  survives router.refresh): does the stale state still filter or act?
