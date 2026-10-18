# Board (conductor-owned)

Single source of truth for who is doing what. A fresh conductor session resumes from this
file alone. Update it on every spawn, every status change, every merge. Keep closed rows
for the current phase; move older ones to the retro.

## Current phase
`phase3-batch3` ACTIVE. **Owner: session_017nqBxLFFXKbhDwKiPi6xLf** (Opus 5.5), took the lock 2026-10-18 17:09 UTC (lock was released by session_018Qvu38cNFVCuWNq41wYfxJ; Pedro: "Run phase3-batch3 ... Go").
Integration branch: `claude/optimistic-tesla-3gceud` (this session's designated branch, cut from main e10a326). Workers PR into it.
Scope (Pedro read it 2026-10-18: "all seem good"), in order:
1. Send-path safety: DO_NOT_SEND_STATUSES in `lib/pitches/send-action.ts` and the send-queue route, plus a status guard on `transitionPitchStatusWith`. First: 19 AUTO pitches start sending Mon 15:00 UTC.
2. Unique index on replies(tenant_id, gmail_message_id). Needs a reserved migration number.
3. Booking-alert durability in `lib/opportunities/calendar-sync.ts`, same claim/sweep pattern as the reply alerts.
4. /pitches resilience (`tasks/briefs/pitches-list-resilience.md`, sonnet/medium).
5. #17 exemplar allow-list to the reviewer's strict/generous design (batch 2 log 16:24). Opus/high, parallel track; flip EXEMPLARS_ENABLED once merged.
Not code: pipeline-stage reactivation vs the status rule is a product question for Pedro.
Previous: `phase3-batch2` CLOSED (main e10a326). Its rows, log and hand-off are in `tasks/retros/2026-10-18-phase3-batch2.md` (appendix).

Open prod checks:
- The 01:00 and 13:00 UTC digests list the 19 AUTO pitches.
- First weekly report, Mon 13:10 UTC.
- First AUTO sends, Mon 15:00 UTC.
- First real lead alert shows alerts{sent:3,failed:[]}.
- First use of a hold link.

## Approvals and checks
| Item | State |
|---|---|
| Prod = main head READY before cutting integration | e10a326 READY per batch 2 log 16:53 (re-check at ship) |
| Batch plan sent to Pedro | scope approved in advance ("all seem good", 2026-10-18); Pedro "Go" 17:07 UTC |
| Integration → main PR | — |
| Questions sent | — |
| `npm run build` green on integration | wave 0: yes (726 tests) |
| Origin in sync (`git status -sb`) | — |

## Reserved migration numbers
| Number | Reserved for | Status (reserved → used → applied) |
|---|---|---|
| 0045 | platform-reports: `0045_reports_cron.sql` (spam-health-check hourly :25, spam-weekly-report Mon 13:10 UTC) | APPLIED 2026-10-18 16:23 UTC via connector after dry runs were clean; version normalised to `0045` |
| 0046 | conductor wave 0: `0046_replies_gmail_message_unique.sql` (unique (tenant_id, gmail_message_id) where not null; poll skips 23505) | used (wave 0); apply before deploy (prod had 0 dups at 17:20 UTC) |
| 0047 | booking-alert-durability: `0047_opportunities_alert_markers.sql` (booked/cancelled alert markers + meeting_start/time zone; backfill existing calendar rows as alerted). Written by the conductor in wave 0 | used (wave 0); apply before deploy (additive) |
| 0048 | — | free |

## Active and queued tasks
| Slug | Module | Model/effort | Branch | Session | PR | Depends on | Status | Blocked on | Turns | Review findings | CI reds | Rework |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| wave0-conductor | migrations 0046 + 0047, poll insert 23505 handling, core-context refresh, 4 briefs | conductor | integration | this | — | — | merged (726 tests, lint, build green) | — | | | | |
| send-path-safety | send-action.ts, send-queue + follow-up + nudge routes, transitionPitchStatusWith (+ new pure status-transitions.ts) | opus/high | claude/send-path-safety | | | wave0 | queued (wave 1) | | | | | |
| booking-alert-durability | lib/opportunities/calendar-sync.ts + booking-alert.ts + route | opus/high (deviation: alerts lane is medium; same durability class reworked twice in b2) | claude/booking-alert-durability | | | wave0 (0047 file) | queued (wave 1) | | | | | |
| exemplar-allow-list | lib/pitches/exemplars.ts + wordlists (hub), PR #17 round 4 | opus/high | claude/exemplar-scrubber-gaps (existing) | | #17 | — | queued (wave 1, parallel track, Pedro-sanctioned; files disjoint from send-path-safety) | | | b2: r1 5, r2 6, r3 2 | | 3 (b2) |
| pitches-list-resilience | lib/pitches/queries.ts (listPitches) + /pitches | sonnet/medium | claude/pitches-list-resilience | | | send-path-safety merged | queued (wave 2: pitches serialized) | | | | | |

Column meanings: Turns = assistant turns in the worker session (proxy for tokens).
Review findings = blocking findings the reviewer raised. CI reds = failed CI runs on the
PR. Rework = times the task went back to the worker or was redone by another worker.
These four columns feed the retro and the routing table.

Wave plan: wave 0 (conductor: 0046 + poll insert, 0047, briefs) → wave 1 = send-path-safety, booking-alert-durability, exemplar-allow-list in parallel (3 remote sessions) → wave 2 = pitches-list-resilience after send-path-safety merges → batch audit (Fable) → integration → main PR. Target: ready for Pedro's "ship it" well before Mon 15:00 UTC (first AUTO sends). #17 ships in the same PR only if merged in time; otherwise a follow-up PR (kill switch stays off either way).
Pitches serialization: exemplar-allow-list (exemplars.ts + wordlists) runs alongside send-path-safety (send-action.ts, pitch-stage.ts transition only): disjoint files, Pedro's board line 5 calls it a parallel track. pitches-list-resilience (queries.ts) waits.
Batch-audit pairs to check (runtime interactions): send-path-safety × autopilot tick (tick writes "approval refused: <error>" + lane review on a refused approve; error must not start with HELD_BY_PERSON); send-path-safety × hold.ts (a hold racing the queue claim); send-path-safety × recoverStuckSends (released claims vs stuck-row recovery); booking-alert-durability × 0047 backfill (existing rows never alert) × markCancelled updated_at; 0046 × poll (23505 skip means the first run owns opt-out, draft and alert; a run killed between insert and opt-out leaves the opt-out to the lead alert's optOutFailed flag); exemplar-allow-list × learning-meeting-outcomes (booked pitches qualify as exemplars).

## Questions for Pedro (batched, asked once per batch)
| # | From task | Question | Default if unanswered | Answer |
|---|---|---|---|---|

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
- 2026-10-18 17:09 UTC — resumed: session_017nqBxLFFXKbhDwKiPi6xLf took the released lock for phase3-batch3 (Pedro: "Run phase3-batch3 ... Go"). Board brought over from the batch 2 branch (9c810d0); batch 2 rows + log moved to the batch 2 retro appendix. main e10a326. Open PRs: #17 only (parked). git clean apart from this board commit.
- 2026-10-18 18:34 UTC — Wave 0 on integration: 0046 (replies unique index; prod 0 dups / 32 rows) + poll insert skips 23505 and reports other insert errors; 0047 (opportunity alert markers + meeting start/zone, backfill); core-context refreshed; briefs send-path-safety, booking-alert-durability, exemplar-allow-list (round 4 of #17; merge recipe verified locally: 749 green), pitches-list-resilience retargeted. 726 tests, lint, build green. Prod check: replies 0 dups; opportunities 0 calendar rows.
