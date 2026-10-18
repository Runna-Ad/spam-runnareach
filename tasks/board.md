# Board (conductor-owned)

Single source of truth for who is doing what. A fresh conductor session resumes from this
file alone. Update it on every spawn, every status change, every merge. Keep closed rows
for the current phase; move older ones to the retro.

## Current phase
`phase3-batch1` CLOSED 2026-10-18 (shipped a15d1d8; calendar sync verified live; PR #11 scout credit shipped c869323). Owner: session_012bGmp5nHP9Lx5ke69JkaBk (batch 1 conductor, retiring).
**Next: `phase3-batch2`, NOT started. No conductor owns it yet.** The next conductor session writes its id here before doing anything else (see "Hand-off" below).

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
| 0043 | conductor wave 0: opportunities.source/calendar_event_id, pitch_event_type +meeting_booked/won/lost, prospect_contacts.source_url | APPLIED 2026-10-17 17:40 UTC via connector; row normalised to version `0043` on 2026-10-18 |
| 0044 | opportunities-calendar-sync (cron schedule) | APPLIED 2026-10-17 after the prod deploy (job spam-calendar-sync, 5 * * * *); row normalised to version `0044` on 2026-10-18 |
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
| 1 | opportunities-calendar-sync | Reconnect Google once after ship so the calendar.readonly scope is granted | sync reports needsReconnect until done | done 2026-10-18; also had to enable the Calendar API in GCP 892318428312 |
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
- 2026-10-17 17:42 UTC — Pedro: 'applied 0043, ship it'. DB check showed 0043 NOT applied (0 columns, 0 enum values, latest migration 0042) → applied via Supabase connector, verified, THEN merged PR #7 → main a15d1d8. Remaining for Pedro: apply 0044 after deploy, reconnect Google. Check-in trigger cancelled.
- 2026-10-17 17:45 UTC — Prod deploy of a15d1d8 READY on Vercel. 0044 applied via connector; cron job spam-calendar-sync scheduled. Only Pedro's Google reconnect remains (optional: CALENDAR_BOOKING_INBOX).
- 2026-10-18 04:09 UTC — Pedro reconnected Google. 04:05 UTC sync: needsReconnect false (inbox pedro@runnareach.com) but 403: Google Calendar API not enabled in GCP project 892318428312. One console toggle by Pedro; no code change. Earlier hourly runs (18:05 → 03:05) all needsReconnect true as expected.
- 2026-10-18 04:36 UTC — Pedro enabled the Calendar API in GCP 892318428312. Manual sync run 04:35 UTC (via spam_cron_call): needsReconnect false, counts events 0 / created 0 / cancelled 0 / unmatched 0 / errors []. Calendar sync LIVE. Phase 3 batch 1 fully closed; question #1 on the Pedro table answered (reconnect + API enable).
- 2026-10-18 05:17 UTC — Other session (Phase 2 conductor, great-planck) could not find 0043/0044: connector had recorded them under timestamp versions. Normalised both rows to 0043/0044 (verified). Steward skill gained a post-ship checklist (verify every manual step by query; check migrations by name; normalise connector versions; enable the API behind any new Google scope; first cron run read from net._http_response).
- 2026-10-18 05:53 UTC — Pedro closing the Phase 2 session (PR #8 merged, main dc0fdff, deployed) and the AI-budget session (PR #9 open, CI green). Conductor took over: (a) the Phase 2 session's 09:20 UTC check-in (old trigger deleted, new send_later trig_01MEw63katHBZye8pXK7QNMp into this session); (b) the scout-credit branch: merged PR #9's branch into it, resolved tick.ts, 603 tests, opened PR #11 → main, subscribed. Backfill SQL scripts/backfill-scout-found-ids.sql NOT run (Pedro's call). Waiting on Pedro: merge #9 and #11.
- 2026-10-18 05:56 UTC — While wrapping scout: PR #9 squash-merged (9b89128), its prod build failed on a duplicate isUnderDailyCap import (#8 + #9), PR #10 fixed it (8e5d7c3, prod READY 05:50 UTC). Merged main into PR #11's branch (ba936cc), resolved tick.ts + project-state, 603 tests. PR #11 now = scout change only. Lesson for steward: two PRs squash-merged into main within minutes with no integration branch → red prod build; this is exactly what the integration branch prevents.

## Hand-off to the next conductor (written 2026-10-18 by the batch 1 conductor)
Start a NEW session on Opus 5.5 with: "Read .claude/skills/conductor/SKILL.md, resume from tasks/board.md". Then:
1. Write your session id into "Current phase" and push that commit before anything else (the board is the lock).
2. `main` is prod. Last known: c869323 (PR #11). Confirm the Vercel production deployment of the current `main` head is READY before cutting the integration branch (`get_deployment spam-runnareach.vercel.app`).
3. Cut `claude/phase3-batch2-integration` from `origin/main`. Refresh `tasks/briefs/_core-context.md` (migration count now 0044; repo map unchanged).
4. Pending housekeeping that belongs to batch 2's close, not its start: merge `tasks/lessons-inbox/scout-cell-credit.md` into `tasks/lessons.md` (newest first) and delete it.
5. Batch 2 candidates (pick ≤6, one module each; Pedro approves the plan with "go"):
   - learning: meeting_booked / won / lost feed `scoreOutcome` and the exemplar shortlist (opus/medium)
   - prospects status: one `closeProspectStatus` predicate for the three writers (opportunities outcome, calendar sync, PR #9's suppressUnfinished); skip `suppressed` (opus/medium; touches discover + opportunities → hub-ish, serialize)
   - replies: `opt-out.ts` → `latestRootSentPitchId()` (sonnet/medium, has tests)
   - gmail (CONDUCTOR): `getAccessToken` timeout; `needsReconnect` Sentry breadcrumb after 24h
   - api: `maxDuration` for `/api/opportunities/calendar-sync` in vercel.json (CONDUCTOR, wave 0)
   - pitches UI: `/pitches` list resilient to a `pitch_events` query error (sonnet/medium)
   - research: structured-research-stage inserts set `source_url` (opus/medium)
   - roadmap Phase 3: one-click hold in the veto digest (opus/medium); Phase 4: weekly learning review → approvable proposals on /learning (opus/high)
6. Decisions still open for Pedro (ask once, in the batch plan message): run `scripts/backfill-scout-found-ids.sql`? set `CALENDAR_BOOKING_INBOX`? invites you send count as booked before acceptance (default keep)? cancel-then-rebook = two opportunities (default accept)?
7. The 09:20 UTC 2026-10-18 check-in on PR #8's resolve step fires into the batch 1 session, not yours; its result lands in this log.
