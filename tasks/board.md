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
| Prod = main head READY before cutting integration | checking |
| Batch plan sent to Pedro | scope approved in advance ("all seem good", 2026-10-18); Pedro "Go" 17:07 UTC |
| Integration → main PR | — |
| Questions sent | — |
| `npm run build` green on integration | — |
| Origin in sync (`git status -sb`) | — |

## Reserved migration numbers
| Number | Reserved for | Status (reserved → used → applied) |
|---|---|---|
| 0045 | platform-reports: `0045_reports_cron.sql` (spam-health-check hourly :25, spam-weekly-report Mon 13:10 UTC) | APPLIED 2026-10-18 16:23 UTC via connector after dry runs were clean; version normalised to `0045` |
| 0046 | — | free |

## Active and queued tasks
| Slug | Module | Model/effort | Branch | Session | PR | Depends on | Status | Blocked on | Turns | Review findings | CI reds | Rework |
|---|---|---|---|---|---|---|---|---|---|---|---|---|

Column meanings: Turns = assistant turns in the worker session (proxy for tokens).
Review findings = blocking findings the reviewer raised. CI reds = failed CI runs on the
PR. Rework = times the task went back to the worker or was redone by another worker.
These four columns feed the retro and the routing table.

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
