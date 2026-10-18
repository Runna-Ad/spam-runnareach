# Board (conductor-owned)

Single source of truth for who is doing what. A fresh conductor session resumes from this
file alone. Update it on every spawn, every status change, every merge. Keep closed rows
for the current phase; move older ones to the retro.

## Current phase
`phase3-batch2` ACTIVE (wave 1 running). **Owner: session_018Qvu38cNFVCuWNq41wYfxJ** (batch 2 conductor, Opus 5.5), took over 2026-10-18 06:10 UTC per batch 1's hand-off.
Integration branch: `claude/conductor-skill-board-tasks-cu74t5` (this session's designated branch, cut from main af3c4b0; same pattern as batch 1's gallant-gauss). Workers PR into it.
Previous: `phase3-batch1` CLOSED (shipped a15d1d8, calendar sync live). Its rows, log and hand-off are in `tasks/retros/2026-10-17-phase3-batch1.md` (appendix).

## Approvals and checks
| Item | State |
|---|---|
| Prod = main head READY before cutting integration | yes: af3c4b0 READY (dpl_FK9wsisyQ9D7A8EaYFmqG2gexazX) |
| Batch plan sent to Pedro | 2026-10-18 06:20 UTC (in chat) |
| Batch plan approved | yes, 2026-10-18 ~06:25 UTC ("go with all the rest" = every default) + two new asks: notify routing (copies to petedv31 + nila) and NO daily report, weekly + emergency-only |
| Questions sent | with the plan (table below) |
| `npm run build` green on integration | yes, 4666626 (wave 0, 609 tests) |
| Origin in sync (`git status -sb`) | pushed with this commit |

## Reserved migration numbers
| Number | Reserved for | Status (reserved → used → applied) |
|---|---|---|
| 0045 | platform-reports: `0045_reports_cron.sql` (spam-health-check hourly :25, spam-weekly-report Mon 13:10 UTC) | reserved |
| 0046 | — | free |

## Active and queued tasks
| Slug | Module | Model/effort | Branch | Session | PR | Depends on | Status | Blocked on | Turns | Review findings | CI reds | Rework |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| wave0-conductor | lib/notify (new), tick/poll/warmup notify, vercel.json, lib/gmail, opt-out.ts, reward.ts constant | conductor | integration | this | — | — | merged 4666626 | — | | | | |
| learning-meeting-outcomes | lib/learning/reward.ts | opus/medium | claude/learning-meeting-outcomes | session_01427GvammP8EiJJ7CBQA5ek | | wave0 | running (06:37) | | | | | |
| prospect-status-guard | lib/prospects/status.ts (new) + lib/replies/intent-actions.ts, lib/opportunities/actions.ts | opus/medium | claude/prospect-status-guard | session_01Ki2uVNN7712JsosdvSUJuD | | — | running (06:37) | | | | | |
| exemplar-scrubber-gaps | lib/pitches/exemplars.ts (hub) | opus/high | claude/exemplar-scrubber-gaps | session_01AZQoKcXaSPYey6575rZq1z | | — | running (06:37) | | | | | |
| veto-hold-link | lib/autopilot/tick.ts digest + hold.ts/hold-token.ts + app/api/autopilot/hold | opus/high | claude/veto-hold-link | session_01A9P95NW1yKUbsTcb7ZGpeH | | wave0 | running (06:37) | | | | | |
| lead-alerts | app/api/replies/poll (alert section) + lib/opportunities/calendar-sync.ts + formatters | opus/medium | claude/lead-alerts | session_01Vs4NpsnoVRr7DtPLeULzPd | | wave0 | running (06:37) | | | | | |
| platform-reports | lib/reports (new) + app/api/reports/{weekly,health} + 0045 | opus/medium (deviation noted in brief) | claude/platform-reports | session_01EzWfTFzFKDFwMP8cHjsJti | | wave0 | running (06:37) | | | | | |
| pitches-list-resilience | lib/pitches/queries.ts + /pitches | sonnet/medium | claude/pitches-list-resilience | | | exemplar-scrubber-gaps merged | wave 2 (brief written) | | | | | |
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
- Open: placeholder regex duplicated in send-gate and composer (export one); needsReconnect persists silently (Sentry warning); warn when CALENDAR_BOOKING_INBOX matches no inbox; root-pitch.ts drops its query error; prospect activity feed does not render opportunity.won/lost; reward.ts and hot-lead.ts decide audit_scan stage with different rules (share levelOf); 200-row /pitches window hides old hot leads; "Asked to talk" chip tone; /learning: trials=100 boundary test, honest "arms not loaded" error state, order + truncation notice at 2000, icp learner never writes arms, UI <20 vs bandit 15/30 thresholds; dedupe opportunities per prospect on rebook.

## Shared-file changes pending (conductor does these)
| Requested by | File | Change | Done |
|---|---|---|---|
| pitches-hot-lead-badge (b1) | lib/supabase/types.ts | add pitch_events so the any-cast can go | pending |
| prospect-status-guard | lib/compliance/opt-out.ts, app/api/replies/poll/route.ts (bounce + replied), lib/opportunities/calendar-sync.ts (markProspectBooked) | adopt the status predicate (after status-guard AND lead-alerts merge) | pending |
| platform-reports | vercel.json | daily Vercel cron backstop for /api/reports/health (if the worker asks) | pending |

## Log
- 2026-10-18 06:10 UTC — resumed: session_018Qvu38cNFVCuWNq41wYfxJ took the lock for phase3-batch2 (board commit pushed). Prod af3c4b0 READY. No open PRs. git clean.
- 2026-10-18 06:17 UTC — live check before planning: autonomy_state enabled, stage veto. Nothing sent yet by the autopilot: 23 drafts (REVIEW, from 10-17) + 6 auto_rejected; PR #8's resolve step is rewriting them (first retry 06:15). No discovery job since 10-17 08:30: the 6-jobs/24h cap, then the $3/24h budget ($3.06 spent 05:00–09:00 on 10-17, rolls off from ~07:00 today). Working as designed; batch 1 session's 09:20 check-in verifies the drafts. Batch 1 log + hand-off moved to the batch 1 retro appendix. Batch 2 plan (wave 0 + 6 tasks) sent to Pedro.
- 2026-10-18 06:25 UTC — Pedro: "go with all the rest" (all defaults) + notify routing ask. Found: no *_NOTIFY_EMAIL var set in Vercel → every alert has gone ONLY to petedv31@gmail.com (code default), never to pedro@runnareach.com. 06:31 Pedro: no daily report, weekly + emergency-only.
- 2026-10-18 06:33 UTC — Wave 0 merged on integration 4666626: lib/notify (ops/lead lists), tick/poll/warmup notify through it, calendar-sync maxDuration 120, getAccessToken 10s timeout, opt-out → latestRootSentPitchId, OUTCOME_EVENT_TYPES. 609 tests, typecheck, lint, build green. Dropped research-contact-source-url (0 engine inserts in 10 days). Added lead-alerts + platform-reports (0045 reserved). Noted for later: transitionPitchStatusWith updates status unconditionally (a /pitches "back to draft" can hit a row the send-queue claimed) → veto-hold-link avoids it; candidate for next batch.
- 2026-10-18 06:36 UTC — 7 briefs committed. Spawning wave 1 (6 remote sessions).
- 2026-10-18 06:38 UTC — Wave 1 spawned (6 remote sessions, inherited mode, tag spam-phase3-batch2): ids on the task rows. Safety check-in trig_01Q1Qcv9h7TAe384fsxbf1e9 at 07:28 UTC.
- 2026-10-18 06:45 UTC — Pedro: the lead address is nils@runna.com.mx (not nila). Default fixed in lib/notify/recipients.ts + test + lead-alerts brief. Workers never pass addresses (kind: "lead"), so no worker needs telling.
