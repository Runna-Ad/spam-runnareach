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
| Prod = main head READY before cutting integration | e10a326 READY (dpl_8udavQRnDUycKVocmcXakCav9pEm, verified 19:45) |
| Batch plan sent to Pedro | scope approved in advance ("all seem good", 2026-10-18); Pedro "Go" 17:07 UTC |
| Integration → main PR | — |
| Questions sent | — |
| `npm run build` green on integration | yes after #24 (845 tests) |
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
| send-path-safety | send-action.ts, send-queue + follow-up + nudge routes, transitionPitchStatusWith (+ new pure status-transitions.ts) | opus/high | claude/send-path-safety | session_01GQrLz2TkuQdQRLfXA2Hco4 | #21 | wave0 | merged 0128b6b (790 tests) | | ~30 | 0 (8 optional) | 0 | 0 | | | | | |
| booking-alert-durability | lib/opportunities/calendar-sync.ts + booking-alert.ts + route | opus/high (deviation: alerts lane is medium; same durability class reworked twice in b2) | claude/booking-alert-durability | session_01V52B5CStFDH8bHRXbbggve | #22 | wave0 (0047 file) | merged (820 tests on integration) | | ~30 | 2 (race test never races the claim; deploy-gap duplicate) + 7 optional | 0 | 1 | | | | | |
| exemplar-allow-list | lib/pitches/exemplars.ts + wordlists (hub), PR #17 round 4 | opus/high | claude/exemplar-scrubber-gaps (existing) | session_01UKwyaiiw7nmqT9GEFR6ixb | #17 (base retargeted to integration, subscribed) | — | round 5 sent (r4 6adf251: fix-then-merge, 3 blocking + real-data drop 80%) | | | b2: r1 5, r2 6, r3 2; b3: r4 3 | | 4 |
| send-path-safety-2 | follow-up route last-moment recheck, DNC error → fail closed at recheck, stronger source-order test, one message | opus/high | claude/send-path-safety-2 | session_01GQrLz2TkuQdQRLfXA2Hco4 (same worker, warm context) | #24 | send-path-safety merged | merged (845 tests, build green) | | ~20 | 1 (DNC error with an empty message reads as 'not listed' → sends) + 9 optional | 0 | 1 | | | | | |
| pitches-list-resilience | lib/pitches/queries.ts (listPitches) + /pitches | sonnet/medium | claude/pitches-list-resilience | session_019XtZMnCmBLJ2hxdMSgtJAe | #23 | send-path-safety merged | merged (824 tests); new file hot-lead-events.ts accepted (testability) | | ~20 | 1 (a Hot leads filter left on when badges become unavailable empties the list and can't be cleared) | 0 | 1 | | | | | |

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

## Optional findings carried (✔ = taken into a batch)
- ✔ meeting_booked/won/lost do not feed scoreOutcome or the exemplar shortlist → learning-meeting-outcomes.
- ✔ three prospects.status writers with three overwrite rules → prospect-status-guard (also: markProspectBooked overwrites suppressed; prospects update should skip 'suppressed').
- ✔ calendar-sync route has no maxDuration; getAccessToken has no timeout; opt-out.ts own root-pitch query → wave 0.
- ✔ listPitches throws on a pitch_events error → pitches-list-resilience (wave 2).
- ✔ exemplars: 3-letter brands, lowercase honorific names, city abbreviations (CDMX) → exemplar-scrubber-gaps.
- From PR #13 review (batch audit): points sum per event ([sent,booked,booked] = 40; nothing reads .points yet); hunter-signals route also calls scoreOutcome, so bookings now raise runna-hunter findingWeights (intended, note in audit); [sent, hard_no, booked] → value 1 + negative (cautious, fine). Bounced-root-as-exemplar → sent to exemplar-scrubber-gaps worker 06:57.
- From PR #14 review: intent-actions toast + audit say "booked"/"suppressed" even when the guard blocked the write (show what was observed); bounced path skips cooldown_until when guarded (write it unguarded); other status writers outside the rule: discover/pipeline-stage.ts:641 reactivation (suppressed/no_match → researched, breaks I5), deep-research-stage.ts:378, hunter/actions.ts:202; pin DO_NOT_SEND_STATUSES to send-action/send-queue/follow-up copies with a test. Decision: replied guard now also protects no_match (I5 wins over the brief's 'exact string'; nudge would otherwise reach a no_match prospect).
- From PR #15 review: no unique index on replies(tenant_id, gmail_message_id) (0 dups in prod today) → overlapping pg_cron + Vercel poll runs could store one message twice → next-batch migration; booking alerts not durable (Google notifies the organizer anyway); sendGmailMessage had no timeout → conductor added opt-in timeoutMs, notifications only (7941c5b).
- Open: placeholder regex duplicated in send-gate and composer (export one); needsReconnect persists silently (Sentry warning); warn when CALENDAR_BOOKING_INBOX matches no inbox; root-pitch.ts drops its query error; prospect activity feed does not render opportunity.won/lost; reward.ts and hot-lead.ts decide audit_scan stage with different rules (share levelOf); 200-row /pitches window hides old hot leads; "Asked to talk" chip tone; /learning: trials=100 boundary test, honest "arms not loaded" error state, order + truncation notice at 2000, icp learner never writes arms, UI <20 vs bandit 15/30 thresholds; dedupe opportunities per prospect on rebook.

- From batch 3 reviews (carried, not done): reply poll — a run killed between the reply insert and its opt-out leaves the opt-out to the lead alert's optOutFailed flag (0046 makes the next run skip the row); calendar-sync — kill between createOpportunity and recordEvent/audit loses those writes (pre-existing); booking alert "Who" reads "unknown attendee" when the contact row is gone; one shared deadline across tenants in the calendar sync; follow-up DNC/suppression pauses write no audit row; follow-up release restores next_followup_at and can undo a concurrent OOO postponement (inherited); the recheck's two GETs run on a client with no fetch timeout (service-role, conductor-only); poll DEAD_STATUSES lacks no_match; nudge route accepts only CRON_SECRET; first-read DNC checks fail open by design; 200-row /pitches window; share levelOf with reward.ts.

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
- 2026-10-18 18:35 UTC — Wave 1 spawned (3 remote Opus sessions, inherited mode, tag spam-phase3-batch3): ids on the rows. (17:25–18:30 gap: this session's worker process restarted mid-research.) PR #17 base → integration, subscribed. Check-ins: PR discovery trig_01CoHL36LeijjLYXgBFTRVXe (18:44), worker safety trig_01LuFCcKksucbPcva74tHmtH (19:26), prod checks trig_011Wp2W1Yx3pG963DG74uf3y (Mon 01:15 digest), trig_01FHw5RDpobtr4S2hoffX3e1 (Mon 13:25 digest + weekly), trig_015vvHvyjC3AJAEJPijpkCcu (Mon 15:25 first sends).
- 2026-10-18 18:40 UTC — Live check: 19 AUTO pitches approved, prospects all 'pitched', scheduled_send_at Mon 00:30–04:00 UTC; send-queue runs pg_cron */10 15-22 Mon–Fri + Vercel daily 15:00 → first sends Mon ~15:00 UTC (board line correct). All pg_cron jobs succeeding (tick, poll, health, calendar-sync).
- 2026-10-18 18:45 UTC — PR #21 (send-path-safety) found by the +8 min check (opened 18:42), subscribed, reviewer running. Needs conductor: stale comments hold.ts:8 + status.ts:29 (after merge); poll DEAD_STATUSES lacks no_match (gates reply drafting, not a send → optional, not changed). DNC lookup fails open on a query error by design (dnc-check.ts comment); last-moment fail-closed for DNC errors = candidate follow-up (needs an error field on DncHit).
- 2026-10-18 18:54 UTC — PR #21 review: merge, 0 blocking, 8 optional (9 new tests fail on base as claimed; jitter-after-recheck mutation caught). Merged 0128b6b, 790 tests, typecheck + lint green. Conductor fixed the stale comments (hold.ts:8, status.ts:29). Optional findings → send-path-safety-2 (same worker): follow-up route has no last-moment recheck (~20s compose between its prospect read and Gmail; first follow-ups due ~Thu), DNC fail-open at the recheck, source-order test only bans 2 calls, one unobserved-diagnosis message. Kept as optional, not changed: poll DEAD_STATUSES (drafting gate, not a send); first-read prospect query has no tenant filter (consistent by construction); bounced/replied/ghosted/b_list pass the set (frozen contents; bounces also DNC). Wave 2 starts: send-path-safety-2 + pitches-list-resilience (disjoint files: follow-up route/status-transitions/dnc-check vs queries.ts + /pitches).
- 2026-10-18 18:54 UTC — PR #22 (booking-alert-durability, opened 18:46) and #17 round 4 (6adf251) found; both subscribed; 2 reviewers running. Worker flagged: cancellation window keyed on updated_at never closes (0001 trigger) → conductor added opportunities.cancelled_at to 0047 (12ed4de; 0047 not applied anywhere).
- 2026-10-18 19:07 UTC — PR #22 review: fix-then-merge, 2 blocking: (1) overlapping-runs test snapshots after its yield, so the claim is never raced (removing the claim check stays green); (2) "0047 before deploy" lets a booking made in the gap alert twice (old code from memory, new sweep from the row). Sent: snapshot before the yield + mutation proof; cancellation due only with cancelled_at set (also stops a person's free-text "booking cancelled" Lost from emailing the lead list, and old-code cancellations); ship step = after deploy READY, mark rows with meeting_start null as alerted (conductor). Optional taken: guarded release, reserve from recipient count, maxDuration pin test.
- 2026-10-18 19:10 UTC — Conductor re-measure of #17 r4 (6adf251) on 30 real prod pitches (19 AUTO + 11 latest drafts/auto-rejected; scratchpad only, not committed): KEPT 6/30 = 80% drop (worker's generator: 0.8% → fitted to its own vocabulary, as its report warned). Drops are mostly ordinary words outside the 20k lists (corresponda, asesoría, availability, spec, trabas, storefront, outage, monitoreo, compiten…); 50k lists cover most of them. Remaining: Spanish verb forms (agendaron, armaríamos, asesorando, calificarlas), trade words (skus, mro, jobsite, handrail, woodworking, bandsaw, tutorials, oftalmología). True leaks caught correctly: benessere (business name not in the company field), mec, irt, bulkley, fjällräven, monterrey (city, strict position). Round 5 = 50k for LOWERCASE tokens only (strict/capitalized tiers unchanged), Spanish morphology, trade words; target on the same 30: every remaining drop a real leak. Waiting on the r4 review to send one list.
- 2026-10-18 19:14 UTC — PR #22 fix round (4b0e15e) verified by the conductor (no third review): removing the claim check now fails (d) and (d'); cancellation due keyed on cancelled_at (markCancelled writes it; dueAlerts filters/orders on it); release guarded by the claim timestamp; reserve derived from the lead recipient count; vercel.json maxDuration pin test. CI green. Merged into integration: 820 tests, typecheck, lint green. Session archived. SHIP STEP (conductor): after deploy READY, before the next :05 sync: `update opportunities set booked_alert_sent_at = created_at where source='calendar' and booked_alert_sent_at is null and meeting_start is null`.
- 2026-10-18 19:21 UTC — Wave 2 PRs found by the check-in: #23 pitches-list-resilience (18:57), #24 send-path-safety-2 (19:00); subscribed (late by ~20 min: no check-in was armed between 18:53 and 19:11 — the 18:53 one re-armed only for #22), 2 reviewers running. #17 r4 review: fix-then-merge, 3 blocking (abbreviation dots/colons open sentences → names judged generous, incl. a "M. Peña" regression; non-word WORD_NAMES in generous; strict tier is no name net + recipient_email never scrubbed). Combined with the 80% real drop rate → round 5 = structure (S1 positions, S2 50k lowercase / strict = 20k − generated public-domain NAMES, S3 apostrophe join, S4 email local part, S5 enclosed letters/separators), acceptance on held-out names + the conductor's 30 real pitches; #17 off the critical path. Retro note: same class (scrubber tuned on its own vocabulary) as b1/b2 → measure on real data BEFORE review next time; the brief should have shipped the real-data check as acceptance 1, not a conductor step after.
- 2026-10-18 19:27 UTC — PR #23 review: fix-then-merge, 1 blocking (stale hotOnly state filters an all-null list after a refresh with the events query down; checkbox disabled so it can't be cleared). Sent the one-line fix + 2 optional (end-to-end flag test by moving the combine step into hot-lead-events.ts; cursor). Routing evidence: Sonnet on the dashboard/query lane NOT clean this time (1 blocking; brief said "disable rather than show empty" but did not name the leftover-state case). Removed a stray self-referencing node_modules/node_modules symlink in the conductor checkout (18:58; breaks Turbopack in hard-linked worktrees).
- 2026-10-18 19:32 UTC — PR #24 review: fix-then-merge, 1 blocking (`if (dnc.error)` truthiness: postgrest-js maps an empty-body 502/503/504 to message "" → recheck passes → Gmail; reproduced with a real client). Sent: presence check + dnc-check never returns an empty error + tests; optional taken: pause-wiring assertion, one canNeverSend predicate, log a failed follow-up release. Prod: 0 pitches whose tenant differs from their prospect's (reviewer's unsure tenant-filter case is not reachable today); 0 follow-ups pending.
- 2026-10-18 19:33 UTC — PR #23 fix (11c971a) verified by the conductor: hotFilterOn = hotOnly && !unavailable drives the memo + checkbox; combine step moved into hot-lead-events.ts with an end-to-end flag test; mapping unchanged (absent → null as before). CI green. Merged: 824 tests, typecheck, lint green. Session archived.
- 2026-10-18 19:36 UTC — PR #24 fix (ed96d1d) verified by the conductor: presence check + dnc-check never returns an empty error; empty-message and thrown-Error tests pass (42/42 in the send-path file); canNeverSend shared; failed follow-up release logged. CI green. Merged; conductor moved one stacked doc comment back above queueReleaseFor. Integration: 845 tests, typecheck, lint, build green. Send-path worker archived. All 5 non-#17 tasks merged → batch audit (Fable) next; #17 round 5 still running (off the critical path).
- 2026-10-18 20:07 UTC — Batch audit (Fable, f5176a5): SHIP, 0 blocking; 5 optional carried (no-op approve skips the autopilot event in a race; Vercel 15:00 + pg_cron send-queue overlap under-counts sends_today — pre-existing, Monday bounded 19 < cap 30; send-queue loop has no time budget; follow-up first-read skip doesn't pause; person-Lost row before its booking alert). Auditor deploy steps folded into project-state. Pre-ship prod: inbox pedro@ cap 30, unpaused; 19 AUTO approved; replies 32, 0 duplicate pairs. (Container restarted ~19:50; nothing lost, branch in sync.) Opening the integration → main PR.
