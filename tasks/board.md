# Board (conductor-owned)

Single source of truth for who is doing what. A fresh conductor session resumes from this
file alone. Update it on every spawn, every status change, every merge. Keep closed rows
for the current phase; move older ones to the retro.

## Current phase
`phase3-batch2` CLOSING: integration ready, integration → main PR open, waiting on Pedro's "ship it". #17 (exemplar allow-list) continues as a follow-up behind the EXEMPLARS_ENABLED kill switch. **Owner: session_018Qvu38cNFVCuWNq41wYfxJ** (batch 2 conductor, Opus 5.5), took over 2026-10-18 06:10 UTC per batch 1's hand-off.
Integration branch: `claude/conductor-skill-board-tasks-cu74t5` (this session's designated branch, cut from main af3c4b0; same pattern as batch 1's gallant-gauss). Workers PR into it.
Previous: `phase3-batch1` CLOSED (shipped a15d1d8, calendar sync live). Its rows, log and hand-off are in `tasks/retros/2026-10-17-phase3-batch1.md` (appendix).

## Approvals and checks
| Item | State |
|---|---|
| Prod = main head READY before cutting integration | yes: af3c4b0 READY (dpl_FK9wsisyQ9D7A8EaYFmqG2gexazX) |
| Batch plan sent to Pedro | 2026-10-18 06:20 UTC (in chat) |
| Integration → main PR | #19 opened, waiting on "ship it" |
| Batch plan approved | yes, 2026-10-18 ~06:25 UTC ("go with all the rest" = every default) + two new asks: notify routing (copies to petedv31 + nila) and NO daily report, weekly + emergency-only |
| Questions sent | with the plan (table below) |
| `npm run build` green on integration | yes, 09b7425 (721 tests) |
| Origin in sync (`git status -sb`) | pushed with this commit |

## Reserved migration numbers
| Number | Reserved for | Status (reserved → used → applied) |
|---|---|---|
| 0045 | platform-reports: `0045_reports_cron.sql` (spam-health-check hourly :25, spam-weekly-report Mon 13:10 UTC) | used (on integration 9da266f); apply AFTER the prod deploy, after `/api/reports/health?dry=1` returns no false problem |
| 0046 | — | free |

## Active and queued tasks
| Slug | Module | Model/effort | Branch | Session | PR | Depends on | Status | Blocked on | Turns | Review findings | CI reds | Rework |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| wave0-conductor | lib/notify (new), tick/poll/warmup notify, vercel.json, lib/gmail, opt-out.ts, reward.ts constant | conductor | integration | this | — | — | merged 4666626 | — | | | | |
| learning-meeting-outcomes | lib/learning/reward.ts | opus/medium | claude/learning-meeting-outcomes | archived | #13 | wave0 | merged b7c1b02 (620 tests) | | ~4 min / $1.08 | 0 (5 optional) | 0 | 0 |
| prospect-status-guard | lib/prospects/status.ts (new) + lib/replies/intent-actions.ts, lib/opportunities/actions.ts | opus/medium | claude/prospect-status-guard | archived | #14 | — | merged 4de357e (635 tests with opt-out adoption 6f9ff16) | | ~4 min / $1.06 | 1 (PR-body adoption lines unpasteable: @/ import in strip-types files + calendar test string order) → conductor handled, no rework; 4 optional | 0 | 0 |
| exemplar-scrubber-gaps | lib/pitches/exemplars.ts (hub) | opus/high | claude/exemplar-scrubber-gaps | session_01AZQoKcXaSPYey6575rZq1z | #17 | — | round 3 (allow-list invariant) running; NOT in this ship, kill switch off | | | r1: 5, r2: 6 (deny-list incomplete) | | 2+ |
| veto-hold-link | lib/autopilot/tick.ts digest + hold.ts/hold-token.ts + app/api/autopilot/hold | opus/high | claude/veto-hold-link | archived | #16 | wave0 | merged 793a2be (659 tests, build green) | | ~8 min + fix round / $2.00+ | 2 (both conductor brief defects) + 1 optional | | 1 |
| lead-alerts | app/api/replies/poll (alert section) + lib/opportunities/calendar-sync.ts + formatters | opus/medium | claude/lead-alerts | archived | #15 | wave0 | merged e8f0b1a (691 tests) | | 3 rounds / $4.76 | 1 + 1 (same class: alert durability) | | 2 |
| platform-reports | lib/reports (new) + app/api/reports/{weekly,health} + 0045 | opus/medium (deviation noted in brief) | claude/platform-reports | archived | #18 | wave0 | merged 9da266f (721 tests); 0045 used, apply after deploy (dry-run health first) | | | 1 + 8 optional | | 1 |
| pitches-list-resilience | lib/pitches/queries.ts + /pitches | sonnet/medium | claude/pitches-list-resilience | | | exemplar-scrubber-gaps merged | DEFERRED to batch 3 (pitches serialized behind #17) | | | | | |
| ~~research-contact-source-url~~ | lib/research/structured-research-stage.ts | — | — | — | — | — | DROPPED 06:30: that path inserted 0 contacts in 10 days (prod query); revisit if it starts inserting | | | | | |

Column meanings: Turns = assistant turns in the worker session (proxy for tokens).
Review findings = blocking findings the reviewer raised. CI reds = failed CI runs on the
PR. Rework = times the task went back to the worker or was redone by another worker.
These four columns feed the retro and the routing table.

Wave plan: wave 0 (conductor, done) → wave 1 = 6 workers in parallel (only exemplar-scrubber-gaps touches lib/pitches) → wave 2 = pitches-list-resilience after exemplar-scrubber-gaps merges.
Batch-audit pairs to check (runtime interactions): learning-meeting-outcomes × exemplar-scrubber-gaps (booked pitches start qualifying as exemplars); prospect-status-guard × opt-out.ts (conductor adopts the predicate there at merge); veto-hold-link × tick veto counter (a hold must count as a veto and never be re-queued); lead-alerts × prospect-status-guard (both touch the poll/calendar files' neighbourhood: lead-alerts must not touch the status writes; the conductor adopts the predicate in poll route bounce + replied, calendar-sync markProspectBooked, opt-out.ts after BOTH merge).

## Questions for Pedro (batched, asked once per batch)
| # | From task | Question | Default if unanswered | Answer |
|---|---|---|---|---|
| 1 | b1 scout credit | Run `scripts/backfill-scout-found-ids.sql` on prod (preview, then update) so the six 10-17 jobs get full scout credit? | not run || default: not run ("go" 06:25) |
| 2 | b1 calendar-sync | Set `CALENDAR_BOOKING_INBOX`? | leave unset (oldest inbox = pedro@runnareach.com, the one that works) || default: unset ("go" 06:25) |
| 3 | b1 calendar-sync | An invite you send counts as booked before the prospect accepts | keep || default: keep ("go" 06:25) |
| 4 | b1 calendar-sync | Cancel-then-rebook = two opportunities | accept || default: accept ("go" 06:25) |
| 5 | veto-hold-link | Hold link opens a confirm page, one more tap holds (mail scanners open links; a one-tap link would hold everything) | two-step || default: two-step ("go" 06:25) |
| 6 | prospect-status-guard | A real outcome (booked/won/lost) wins over a later opt-out or bounce on the prospect's status; sending stays blocked by DNC + paused sequences either way | yes (opt-out already works this way) || default: yes ("go" 06:25) |
| 7 | learning-meeting-outcomes | A meeting that ends "lost" still counts as a success for the email that booked it | yes (the email's job was the meeting) || default: yes ("go" 06:25) |
| b1-2 | b1 contact-source-url | structured-research-stage contact inserts get source_url | yes → this batch | dropped: path unused (0 inserts in 10 days) |
| 8 | Pedro 06:25 | Notify routing | — | everything → pedro@runnareach.com + petedv31@gmail.com; replies + bookings also → nils@runna.com.mx (Pedro corrected "nila" → "nils" 06:45). Wave 0 + lead-alerts |
| 9 | Pedro 06:31 | Reports | — | no daily report; weekly + emergency-only → platform-reports |

## Worktrees to clean up (in-session workers only)
| Path | Branch | Remove after |
|---|---|---|

## Optional findings carried (from batch 1 reviews; ✔ = taken into batch 2)
- ✔ meeting_booked/won/lost do not feed scoreOutcome or the exemplar shortlist → learning-meeting-outcomes.
- ✔ three prospects.status writers with three overwrite rules → prospect-status-guard (also: markProspectBooked overwrites suppressed; prospects update should skip 'suppressed').
- ✔ calendar-sync route has no maxDuration; getAccessToken has no timeout; opt-out.ts own root-pitch query → wave 0.
- ✔ listPitches throws on a pitch_events error → pitches-list-resilience (wave 2).
- ✔ exemplars: 3-letter brands, lowercase honorific names, city abbreviations (CDMX) → exemplar-scrubber-gaps.
- From PR #13 review (batch audit): points sum per event ([sent,booked,booked] = 40; nothing reads .points yet); hunter-signals route also calls scoreOutcome, so bookings now raise runna-hunter findingWeights (intended, note in audit); [sent, hard_no, booked] → value 1 + negative (cautious, fine). Bounced-root-as-exemplar → sent to exemplar-scrubber-gaps worker 06:57.
- From PR #14 review: intent-actions toast + audit say "booked"/"suppressed" even when the guard blocked the write (show what was observed); bounced path skips cooldown_until when guarded (write it unguarded); other status writers outside the rule: discover/pipeline-stage.ts:641 reactivation (suppressed/no_match → researched, breaks I5), deep-research-stage.ts:378, hunter/actions.ts:202; pin DO_NOT_SEND_STATUSES to send-action/send-queue/follow-up copies with a test. Decision: replied guard now also protects no_match (I5 wins over the brief's 'exact string'; nudge would otherwise reach a no_match prospect).
- From PR #15 review: no unique index on replies(tenant_id, gmail_message_id) (0 dups in prod today) → overlapping pg_cron + Vercel poll runs could store one message twice → next-batch migration; booking alerts not durable (Google notifies the organizer anyway); sendGmailMessage had no timeout → conductor added opt-in timeoutMs, notifications only (7941c5b).
- Open: placeholder regex duplicated in send-gate and composer (export one); needsReconnect persists silently (Sentry warning); warn when CALENDAR_BOOKING_INBOX matches no inbox; root-pitch.ts drops its query error; prospect activity feed does not render opportunity.won/lost; reward.ts and hot-lead.ts decide audit_scan stage with different rules (share levelOf); 200-row /pitches window hides old hot leads; "Asked to talk" chip tone; /learning: trials=100 boundary test, honest "arms not loaded" error state, order + truncation notice at 2000, icp learner never writes arms, UI <20 vs bandit 15/30 thresholds; dedupe opportunities per prospect on rebook.

## Shared-file changes pending (conductor does these)
| Requested by | File | Change | Done |
|---|---|---|---|
| pitches-hot-lead-badge (b1) | lib/supabase/types.ts | add pitch_events so the any-cast can go | pending |
| prospect-status-guard | lib/compliance/opt-out.ts | adopt the status predicate | done 6f9ff16 |
| prospect-status-guard | app/api/replies/poll/route.ts (bounce ~353 + replied ~449, `@/lib/prospects/status` ok), lib/opportunities/calendar-sync.ts markProspectBooked (RELATIVE `../prospects/status.ts`; tests/opportunities-calendar-sync.test.ts:362 asserts "(won,lost)" → compare as sets) | adopt after lead-alerts merges | done 82a163e (bounce audit row only when the status changed) |
| platform-reports | vercel.json | daily Vercel cron backstop for /api/reports/health | done (40 12 * * *) |

## Log
- 2026-10-18 06:10 UTC — resumed: session_018Qvu38cNFVCuWNq41wYfxJ took the lock for phase3-batch2 (board commit pushed). Prod af3c4b0 READY. No open PRs. git clean.
- 2026-10-18 06:17 UTC — live check before planning: autonomy_state enabled, stage veto. Nothing sent yet by the autopilot: 23 drafts (REVIEW, from 10-17) + 6 auto_rejected; PR #8's resolve step is rewriting them (first retry 06:15). No discovery job since 10-17 08:30: the 6-jobs/24h cap, then the $3/24h budget ($3.06 spent 05:00–09:00 on 10-17, rolls off from ~07:00 today). Working as designed; batch 1 session's 09:20 check-in verifies the drafts. Batch 1 log + hand-off moved to the batch 1 retro appendix. Batch 2 plan (wave 0 + 6 tasks) sent to Pedro.
- 2026-10-18 06:25 UTC — Pedro: "go with all the rest" (all defaults) + notify routing ask. Found: no *_NOTIFY_EMAIL var set in Vercel → every alert has gone ONLY to petedv31@gmail.com (code default), never to pedro@runnareach.com. 06:31 Pedro: no daily report, weekly + emergency-only.
- 2026-10-18 06:33 UTC — Wave 0 merged on integration 4666626: lib/notify (ops/lead lists), tick/poll/warmup notify through it, calendar-sync maxDuration 120, getAccessToken 10s timeout, opt-out → latestRootSentPitchId, OUTCOME_EVENT_TYPES. 609 tests, typecheck, lint, build green. Dropped research-contact-source-url (0 engine inserts in 10 days). Added lead-alerts + platform-reports (0045 reserved). Noted for later: transitionPitchStatusWith updates status unconditionally (a /pitches "back to draft" can hit a row the send-queue claimed) → veto-hold-link avoids it; candidate for next batch.
- 2026-10-18 06:36 UTC — 7 briefs committed. Spawning wave 1 (6 remote sessions).
- 2026-10-18 06:38 UTC — Wave 1 spawned (6 remote sessions, inherited mode, tag spam-phase3-batch2): ids on the task rows. Safety check-in trig_01Q1Qcv9h7TAe384fsxbf1e9 at 07:28 UTC.
- 2026-10-18 06:45 UTC — Pedro: the lead address is nils@runna.com.mx (not nila). Default fixed in lib/notify/recipients.ts + test + lead-alerts brief. Workers never pass addresses (kind: "lead"), so no worker needs telling.
- 2026-10-18 06:50 UTC — PRs #13 #14 #15 #16 open, CI green, subscribed late (no wake: I had not subscribed before they opened; lesson: subscribe is per-PR, so poll the PR list once ~5 min after spawning small tasks or arm the check-in earlier). 4 reviewers running in parallel. exemplar-scrubber-gaps + platform-reports still working.
- 2026-10-18 06:57 UTC — PR #13 reviewed: merge, 0 blocking, 5 optional (200k random timelines identical on old types; 9 new tests fail on base). Merged into integration b7c1b02, 620 tests green, pushed, session archived. Optional #1 (a bounced root email that later booked could become an exemplar) sent to the exemplar-scrubber-gaps worker as a brief addition (same file, hub).
- 2026-10-18 07:00 UTC — PR #16 review: fix-then-merge, 2 blocking, BOTH my brief's fault: (1) I gave the hold reason "held from the digest link"; governor.heldAction only leaves drafts whose reason startsWith("held by a person"), so the next tick would rewrite the held draft (generatePitchWith deletes it) and the rewrite could send. (2) evaluateStage counts vetoes only in lane auto but every hold (and today's /pitches holds) moves to lane review → vetoes are never counted, so veto→auto promotion ignores holds. PRE-EXISTING PROD BUG for /pitches holds; fixed in this PR. Sent structural fix (one exported HELD_BY_PERSON constant read by governor + written by tick §5 and hold.ts; lane-independent veto count as a tested pure function). Retro: a brief that writes a value another module READS must name the reader (grep the consumer of every string/enum the brief invents).
- 2026-10-18 07:08 UTC — PR #15 review: fix-then-merge, 1 blocking (alerts not durable: lost on Gmail 503/429 or a 120s kill; fix = claim replies.hot_alert_sent_at, existing never-used column, + 48h sweep). Sent to the worker. Conductor added opt-in Gmail send timeout for notifications (7941c5b).
- 2026-10-18 07:10 UTC — PR #14 review: code correct (722 triples, 0 mismatches); the 1 blocking was the PR body's paste lines for MY adoption. Merged 4de357e, adopted in opt-out.ts with the relative import (6f9ff16), 635 tests, typecheck + lint green, pushed, session archived. Poll + calendar-sync adoption waits on lead-alerts.
- 2026-10-18 07:03 UTC — PR #16 fix round (8591797): HELD_BY_PERSON constant read by heldAction and written by tick §5 + hold.ts; countVetoes (lane-independent, by approval event) with tests; try-again page on the send-queue race. Conductor verified the delta directly (the review's repro inputs are now tests; 3rd review skipped per §5). Merged 793a2be: 659 tests, typecheck, lint, build green. Moved heldAction's doc comment back above it.
- 2026-10-18 07:13 UTC — PR #15 delta review: fix-then-merge, 1 blocking, SAME CLASS as round 1 (claimed-then-killed at 120s strands an alert). Sent the structural rule (claim→send only with ≥60s left; sweep at the start of every run; 2-min age gate so overlapping runs don't alert another run's half-processed reply). Conductor verifies the round-3 delta directly. Retro: the brief should have said "the end of the poll route has <20s; anything at the end must be safe to be killed" — route time budget belongs in any brief that adds work to a long route.
- 2026-10-18 07:17 UTC — PR #15 round 3 (6732f86) verified directly by the conductor: start-of-run sweep, end claim only with ≥60s left (deadline = start+60s), 2-min classified_at settle gate for other runs' rows (poll inserts always set classified_at). CI green. Merged e8f0b1a, 691 tests. Then adopted the status rule in the poll (bounce + replied) and calendar-sync (82a163e): 691 tests, typecheck, lint, build green. Session archived. Wave 1: 4/6 merged; exemplar-scrubber-gaps and platform-reports still running.
- 2026-10-18 07:20 UTC — Found #17 and #18 open since 06:52/06:55, unsubscribed (same miss as 06:50: I subscribe only when I learn of a PR). Subscribed, both CI green, 2 reviewers running. RETRO ACTION: conductor skill §3 must say: after spawning, arm a send_later at +10 min whose only job is `list_pull_requests base=<integration>` → subscribe to any new PR; repeat until every spawned task has a PR.
- 2026-10-18 07:27 UTC — PR #18 review: fix-then-merge, 1 blocking (E3 'emails stuck' counts approved pitches the queue holds back by design: paused inbox, daily-cap drip, cooldown, weekend → re-fires every 24h = a daily email). Sent the rule + a silent-state test matrix. Conductor (4a?): notify falls back to the next inbox then Sentry (an E1 'Google disconnected' alert would otherwise be sent through the dead account); audit actions pitch.held + health.alert. Vercel daily backstop for /api/reports/health at merge. Note for ship: run /api/reports/health?dry=1 before applying 0045.
- 2026-10-18 07:32 UTC — PR #17 review (hub): fix-then-merge, 5 blocking, ONE root cause: exemplarLeaks and the property test reuse the scrubber's matchers (HONORIFIC_RE, whole-word replacePhrase, exact city key), so the fail-closed check can never see the scrubber's misses (dotted aliases, lowercase multi-word honorific spans, particle surnames, 1–2-letter initials, glued handles/URLs). Sent invariants I1–I5 + 'leak check must not share matching code with the scrubber'. Same class as batch 1 PR #6 → retro: the batch-1 lesson ('fail-closed invariant') was applied in name only; core-context must say the invariant needs an INDEPENDENT, coarser matcher, and the property test must use a third one.
- 2026-10-18 07:34 UTC — Prod exposure check for the exemplar leaks: 0 of 11 pitches since the batch-1 ship were shown exemplars; 0 pitches have a qualifying positive event (pitch_events began 10-17). Nothing leaked; no kill switch needed. Fix lands before any exemplar qualifies (the first will be a booked meeting or a positive reply).
- 2026-10-18 07:38 UTC — PR #18 round 2 (50209e8) verified by the conductor: E3 judges only the last closed send window (≤24h after close), only sendable inboxes (token ok, unpaused, cap>0) that sent nothing in it, prospects not in cooldown; 'sending' only if it predates the window; 429 transient; observed-wording E2; silent-state matrix + reviewer repro as tests. CI green. Merged 9da266f, 721 tests. Added the Vercel daily backstop cron (40 12 * * *), build green. Session archived. Wave 1: 5/6 merged; exemplar-scrubber-gaps in round 2.
- 2026-10-18 15:34 UTC — Batch audit (Fable, ~189k tokens): ship-after-fixes, 1 blocking (lead-alert optOutFailed used its own 'status !== suppressed' predicate → false 'removal NOT confirmed' for booked/won/lost opt-outs under the status rule). Fixed with DO_NOT_SEND_STATUSES + test (82e1123). #17 round 2 review: 6 more leak classes → round 3 = allow-list invariant; batch ships WITHOUT #17 behind an exemplar kill switch (EXEMPLARS_ENABLED unset = off; 0 exemplars ever shown in prod). pitches-list-resilience deferred. Pre-deploy SQL clean (1 inbox, 0 unalerted replies, enum ok, 19 AUTO pitches scheduled for Mon). Lessons merged (6 inbox + 4 conductor), retro written, routing + project-state updated, poll bounce update gained its tenant filter.
- 2026-10-18 15:35 UTC — Integration → main PR #19 opened and subscribed. Waiting on Pedro's "ship it". #17 round 3 continues (subscribed); merges into a batch 3 integration branch after this ships.
