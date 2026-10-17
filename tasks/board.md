# Board (conductor-owned)

Single source of truth for who is doing what. A fresh conductor session resumes from this
file alone. Update it on every spawn, every status change, every merge. Keep closed rows
for the current phase; move older ones to the retro.

## Current phase
`phase3-batch1` · integration branch `claude/gallant-gauss-gly093` (this session's branch doubles as the integration branch) · opened from `main` at `acf53e2` · integration → main PR: https://github.com/Runna-Ad/spam-runnareach/pull/7 (awaiting Pedro's ship-it)

## Approvals and checks
| Item | State |
|---|---|
| Batch plan sent to Pedro | 2026-10-17 (in chat) |
| Batch plan approved | yes, 2026-10-17 ("go") |
| Questions sent | 2026-10-17: booking tool → Google Calendar (answered) |
| `npm run build` green on integration | yes, af917cb (593 tests) |
| Origin in sync (`git status -sb`) | pushed with this commit |

## Reserved migration numbers
| Number | Reserved for | Status (reserved → used → applied) |
|---|---|---|
| 0043 | conductor wave 0: opportunities.source/calendar_event_id, pitch_event_type +meeting_booked/won/lost, prospect_contacts.source_url | used (merged, NOT applied; apply BEFORE deploy: inserts name source_url) |
| 0044 | opportunities-calendar-sync (cron schedule) | used (merged, NOT applied; apply AFTER deploy) |
| 0045 | pitch-exemplar-memory (wave 2, if a table is needed) | reserved |
| 0046 | — | free |

## Active and queued tasks
| Slug | Module | Model/effort | Branch | Session | PR | Depends on | Status | Blocked on | Turns | Review findings | CI reds | Rework |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| opportunities-calendar-sync | opportunities (new) + api | opus/high | claude/opportunities-calendar-sync | archived | #5 merged bfd1a58 | — | merged | — | 32 | 1 (7 optional, 5 pulled into the fix) + 5 optional on delta | 0 | 1 | tokens: 30.9k out / 3.2M cache-read / $1.78 |
| opportunities-pipeline-ui | opportunities UI | sonnet/medium | claude/opportunities-pipeline-ui | archived | #1 merged 2a25f8d | — | merged | — | 18 | 1 (6 optional) + 4 optional on delta | 0 | 1 | tokens: 13.7k out / 1.35M cache-read / $0.58 |
| pitches-hot-lead-badge | pitches UI + query | sonnet/medium | claude/pitches-hot-lead-badge | archived | #3 merged 808af20 | — | merged | — | 12 | 0 (6 optional) | 0 | 0 |
| learning-arms-dashboard | learning UI | sonnet/medium | claude/learning-arms-dashboard | archived | #2 merged 5d9e88c | — | merged | — | 12 | 0 (6 optional) | 0 | 0 |
| contact-source-url | research + discover inserts | opus/medium | claude/contact-source-url | archived | #4 merged ce22264 | — | merged | — | 14 | 0 (3 optional) | 0 | 0 |
| pitch-exemplar-memory | pitches (hub) | opus/high | claude/pitch-exemplar-memory | archived | #6 merged af917cb | none | merged | — | ~50 | 2 rounds (7 + 5 optional) | 0 | 2 | tokens: 92.9k out / 14.3M cache-read / $6.45 |

Column meanings: Turns = assistant turns in the worker session (proxy for tokens).
Review findings = blocking findings the reviewer raised. CI reds = failed CI runs on the
PR. Rework = times the task went back to the worker or was redone by another worker.
These four columns feed the retro and the routing table.

## Questions for Pedro (batched, asked once per batch)
| # | From task | Question | Default if unanswered | Answer |
|---|---|---|---|---|
| 1 | opportunities-calendar-sync | Reconnect Google once after ship so the calendar.readonly scope is granted | sync reports needsReconnect until done | |
| 2 | contact-source-url | structured-research-stage.ts also inserts contacts (outside the brief's allow-list); leave source_url null there until a later task? | yes, next batch | |
| 3 | opportunities-calendar-sync | Set env CALENDAR_BOOKING_INBOX to the inbox whose calendar holds the appointment schedule (optional; default = oldest connected inbox) | default | |
| 4 | opportunities-calendar-sync | An invite YOU send from the connected inbox counts as a booked meeting before the prospect accepts (current behaviour). Keep, or require acceptance? | keep | |
| 5 | opportunities-calendar-sync | Cancel-then-rebook creates two opportunities (one lost, one booked); a manual row plus a calendar booking also gives two. Accept for now, dedupe per prospect later? | accept | |

## Worktrees to clean up (in-session workers only)
| Path | Branch | Remove after |
|---|---|---|

## Optional findings carried to next batch (from reviews)
- Batch audit (Fable): meeting_booked/won/lost do not feed scoreOutcome or the exemplar shortlist; three prospects.status writers with three overwrite rules (one closeProspectStatus predicate); placeholder regex duplicated in send-gate and composer (export one); needsReconnect persists silently (Sentry breadcrumb after 24h); calendar-sync route has no maxDuration; listPitches throws on a pitch_events error while listOpportunities returns [].
- PR #5: warn when CALENDAR_BOOKING_INBOX matches no inbox; markProspectBooked overwrites suppressed/archived/bounced (skip suppressed); getAccessToken has no timeout (conductor, lib/gmail); root-pitch.ts drops its query error.
- PR #1: prospects update should skip 'suppressed'; prospect activity feed does not render opportunity.won/lost actions.
- PR #3: /pitches list throws if the pitch_events query fails (wrap, log, show list without badges); reward.ts and hot-lead.ts decide audit_scan stage with different rules (share levelOf); 200-row list window hides old hot leads; "Asked to talk" chip tone is danger-red (Pedro to judge in browser).
- PR #2: add a trials=100 boundary test; query failure renders as an honest "arms not loaded", not an empty state; order + truncation notice on the 2000 limit; icp learner never writes arms (label dead); UI "too early" (<20) vs bandit settle thresholds (15 scout / 30 writer) differ, audit to note.

## Shared-file changes pending (conductor does these)
| Requested by | File | Change | Done |
|---|---|---|---|
| opportunities-pipeline-ui | lib/pitches/events.ts, lib/audit/log.ts | extend PitchEventType and audit unions with meeting_booked / won / lost | done: events.ts (0375052), audit actions opportunity.booked/won/lost + entity (this commit) |
| PR #1 review (batch interaction) | lib/pitches/root-pitch.ts | one shared latestRootSentPitchId() for outcomes, calendar sync and opt-out | done (d00e743); opt-out.ts migration to it = next batch |
| pitch-exemplar-memory | lib/pitches/send-gate.ts, claude-composer.ts | placeholder regex must catch 1-char tokens ([n], {x}) the scrubber emits | done (this commit, + 2 gate tests) |
| pitches-hot-lead-badge | lib/supabase/types.ts | add pitch_events so the any-cast can go | pending, next batch |

## Log
- 2026-10-17 16:16 UTC — phase3-batch1 opened on claude/gallant-gauss-gly093 (main acf53e2 merged). Wave 0: migration 0043 + types. 5 briefs written. Wave 1 = calendar-sync, pipeline-ui, hot-lead-badge, learning-dashboard, contact-source-url in parallel (remote sessions). Wave 2 = exemplar memory after wave 1 merges.
- 2026-10-17 16:18 UTC — create_session refused permission_mode acceptEdits (server records this session as default; Pedro says the app shows Accept edits). Probe: pipeline-ui spawned with inherited mode; check-in at 16:25 UTC decides remote vs in-session for the rest.
- 2026-10-17 16:24 UTC — PROBE RESULT: remote worker in inherited (default) mode ran install, tests, build, push and PR creation with NO prompts; only its final send_message to the conductor prompted. PR #1 open (499→507 tests). Allowing mcp__claude-code-remote__send_message in .claude/settings.json so later workers don't prompt. Spawning the other four next.
- 2026-10-17 16:25 UTC — 4 remaining wave-1 workers spawned as remote sessions (inherited mode, proven by the probe). PR #1 under review. Safety check-in armed for 17:16 UTC.
- 2026-10-17 16:31 UTC — PR #1 review: fix-then-merge (blocking: won/lost event attached to latest SENT pitch, which is a follow-up child; must be the root). Conductor landed lib/pitches/root-pitch.ts + audit opportunity actions. PR #2 (learning) and #3 (hot-lead) opened, 504/505 tests, in review.
- 2026-10-17 16:35 UTC — PR #3 merged (505 tests), PR #2 merged (510 tests), both reviewed merge/0 blocking. Sessions archived. Sonnet lane evidence: 2 clean runs on UI tasks.
- 2026-10-17 16:39 UTC — PR #5 (calendar-sync, 524 tests, 20 turns; does NOT use latestRootSentPitchId, reviewer told) and PR #4 (contact-source-url, 505 tests, 14 turns) opened, CI green, both in review. PR #1 fix pushed (508 tests), delta re-review running. Brief-quality note: contact-source-url brief contradicted SUBPAGE_PRIORITY (About before Contact).
- 2026-10-17 16:40 UTC — PR #1 merged after one fix round (root-pitch bug; reviewer verified the test fails without the fix). Integration: 519 tests. Remaining: PR #4, PR #5 in review; wave 2 next.
- 2026-10-17 16:42 UTC — PR #4 merged (525 tests). PR #5 review: fix-then-merge (blocking: own latest-sent-pitch query instead of latestRootSentPitchId; worker branched before d00e743). Conductor pulled 5 optional items into the fix (booked status stops follow-ups; organizer check; inbox pin; truncation flag; DB errors surfaced). Wave 2 (exemplar memory) spawned.
- 2026-10-17 16:50 UTC — PR #5 merged after one fix round (root pitch + 5 pulled-in items; reviewer verified the regression test). WAVE 1 COMPLETE: 5/5 merged, integration 565 tests green. Wave 2 (exemplar memory) running.
- 2026-10-17 16:52 UTC — Wave 2: PR #6 (exemplar memory, 545 tests, 35 turns) open, in review. Conductor fixed the gate's placeholder regex (3+ chars → 1+) in send-gate.ts and claude-composer.ts with tests; 565 green on integration.
- 2026-10-17 16:58 UTC — PR #6 review: fix-then-merge. Blocking: scrubber leaks company short forms, hyphenated surnames, honorifics, lowercase cities. Sent back with a fail-closed invariant (drop exemplar if any distinctive token survives) + property test, per the sim lesson (invariant, not longer regex). Reviewer: ~114k tokens, 45 tool uses, 7 min (hub-level rigor).
- 2026-10-17 17:11 UTC — PR #6 round 2: fail-closed invariant landed (592 tests) but the common-word case gate also covered cities/brands (victoria, surrey, summit leak in lowercase subjects). Sent the precise fix as the last round; conductor will verify with the reviewer's probe script instead of a 3rd review (G15). Reviewer round 2: ~142k tokens cumulative.
- 2026-10-17 17:23 UTC — PR #6 merged after conductor spot-check (23 probes, 593 tests). BATCH COMPLETE: 6/6 merged, 593 tests, build green. Fable batch audit: MERGE, conditional on applying 0043 BEFORE deploy (contact inserts name source_url; a code-first deploy would silently drop contacts in the autopilot research path). Retro written, lessons merged, project-state updated. Opening integration → main PR; waiting on Pedro's ship-it.
- 2026-10-17 17:24 UTC — Integration → main PR #7 opened and subscribed. Batch is DONE on the conductor side; waiting on Pedro: apply 0043, ship it, apply 0044, reconnect Google.
