# Board (conductor-owned)

Single source of truth for who is doing what. A fresh conductor session resumes from this
file alone. Update it on every spawn, every status change, every merge. Keep closed rows
for the current phase; move older ones to the retro.

## Current phase
`phase3-batch2` ACTIVE (planning: plan sent to Pedro, waiting on "go"). **Owner: session_018Qvu38cNFVCuWNq41wYfxJ** (batch 2 conductor, Opus 5.5), took over 2026-10-18 06:10 UTC per batch 1's hand-off.
Integration branch: `claude/conductor-skill-board-tasks-cu74t5` (this session's designated branch, cut from main af3c4b0; same pattern as batch 1's gallant-gauss). Workers PR into it.
Previous: `phase3-batch1` CLOSED (shipped a15d1d8, calendar sync live). Its rows, log and hand-off are in `tasks/retros/2026-10-17-phase3-batch1.md` (appendix).

## Approvals and checks
| Item | State |
|---|---|
| Prod = main head READY before cutting integration | yes: af3c4b0 READY (dpl_FK9wsisyQ9D7A8EaYFmqG2gexazX) |
| Batch plan sent to Pedro | 2026-10-18 06:20 UTC (in chat) |
| Batch plan approved | not answered |
| Questions sent | with the plan (table below) |
| `npm run build` green on integration | not yet |
| Origin in sync (`git status -sb`) | pushed with this commit |

## Reserved migration numbers
| Number | Reserved for | Status (reserved → used → applied) |
|---|---|---|
| 0045 | — (batch 1 reserved it for exemplar memory; not used) | free |
No batch 2 task needs a migration (pitch_event_type already has meeting_booked/won/lost since 0043).

## Active and queued tasks
| Slug | Module | Model/effort | Branch | Session | PR | Depends on | Status | Blocked on | Turns | Review findings | CI reds | Rework |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| wave0-conductor | vercel.json, lib/gmail, lib/compliance/opt-out.ts, lib/learning/reward.ts (constant only), lib/pitches/exemplar-queries.ts (import only) | conductor | integration | this | — | — | planned | go | | | | |
| learning-meeting-outcomes | lib/learning/reward.ts | opus/medium | claude/learning-meeting-outcomes | | | wave0 | planned | go | | | | |
| prospect-status-guard | lib/prospects/status.ts (new) + writers in lib/replies/intent-actions.ts, lib/opportunities/{actions,calendar-sync}.ts | opus/medium | claude/prospect-status-guard | | | wave0 | planned | go | | | | |
| research-contact-source-url | lib/research/structured-research-stage.ts | opus/medium | claude/research-contact-source-url | | | — | planned | go | | | | |
| exemplar-scrubber-gaps | lib/pitches/exemplars.ts (hub) | opus/high | claude/exemplar-scrubber-gaps | | | — | planned | go | | | | |
| veto-hold-link | lib/autopilot/tick.ts (digest) + app/api/autopilot/hold (new) + lib/autopilot/hold-token.ts (new) | opus/high | claude/veto-hold-link | | | — | planned | go | | | | |
| pitches-list-resilience | lib/pitches/queries.ts + /pitches page | sonnet/medium | claude/pitches-list-resilience | | | exemplar-scrubber-gaps merged (pitches serialize) | planned (wave 2) | go | | | | |

Column meanings: Turns = assistant turns in the worker session (proxy for tokens).
Review findings = blocking findings the reviewer raised. CI reds = failed CI runs on the
PR. Rework = times the task went back to the worker or was redone by another worker.
These four columns feed the retro and the routing table.

Wave plan: wave 0 (conductor) → wave 1 = 5 workers in parallel (only one touches lib/pitches) → wave 2 = pitches-list-resilience after exemplar-scrubber-gaps merges.
Batch-audit pairs to check (runtime interactions): learning-meeting-outcomes × exemplar-scrubber-gaps (booked pitches start qualifying as exemplars); prospect-status-guard × opt-out.ts (conductor adopts the predicate there at merge); veto-hold-link × tick veto counter (a hold must count as a veto and never be re-queued).

## Questions for Pedro (batched, asked once per batch)
| # | From task | Question | Default if unanswered | Answer |
|---|---|---|---|---|
| 1 | b1 scout credit | Run `scripts/backfill-scout-found-ids.sql` on prod (preview, then update) so the six 10-17 jobs get full scout credit? | not run | |
| 2 | b1 calendar-sync | Set `CALENDAR_BOOKING_INBOX`? | leave unset (oldest inbox = pedro@runnareach.com, the one that works) | |
| 3 | b1 calendar-sync | An invite you send counts as booked before the prospect accepts | keep | |
| 4 | b1 calendar-sync | Cancel-then-rebook = two opportunities | accept | |
| 5 | veto-hold-link | Hold link opens a confirm page, one more tap holds (mail scanners open links; a one-tap link would hold everything) | two-step | |
| 6 | prospect-status-guard | A real outcome (booked/won/lost) wins over a later opt-out or bounce on the prospect's status; sending stays blocked by DNC + paused sequences either way | yes (opt-out already works this way) | |
| 7 | learning-meeting-outcomes | A meeting that ends "lost" still counts as a success for the email that booked it | yes (the email's job was the meeting) | |
| b1-2 | b1 contact-source-url | structured-research-stage contact inserts get source_url | yes → this batch (research-contact-source-url) | taken |

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
| prospect-status-guard | lib/compliance/opt-out.ts | adopt the status predicate (after the worker's PR merges) | pending |

## Log
- 2026-10-18 06:10 UTC — resumed: session_018Qvu38cNFVCuWNq41wYfxJ took the lock for phase3-batch2 (board commit pushed). Prod af3c4b0 READY. No open PRs. git clean.
- 2026-10-18 06:17 UTC — live check before planning: autonomy_state enabled, stage veto. Nothing sent yet by the autopilot: 23 drafts (REVIEW, from 10-17) + 6 auto_rejected; PR #8's resolve step is rewriting them (first retry 06:15). No discovery job since 10-17 08:30: the 6-jobs/24h cap, then the $3/24h budget ($3.06 spent 05:00–09:00 on 10-17, rolls off from ~07:00 today). Working as designed; batch 1 session's 09:20 check-in verifies the drafts. Batch 1 log + hand-off moved to the batch 1 retro appendix. Batch 2 plan (wave 0 + 6 tasks) sent to Pedro.
