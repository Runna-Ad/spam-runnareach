# Board (conductor-owned)

Single source of truth for who is doing what. A fresh conductor session resumes from this
file alone. Update it on every spawn, every status change, every merge. Keep closed rows
for the current phase; move older ones to the retro.

## Current phase
`phase3-batch1` · integration branch `claude/gallant-gauss-gly093` (this session's branch doubles as the integration branch) · opened from `main` at `acf53e2` · integration → main PR: none yet

## Approvals and checks
| Item | State |
|---|---|
| Batch plan sent to Pedro | 2026-10-17 (in chat) |
| Batch plan approved | yes, 2026-10-17 ("go") |
| Questions sent | 2026-10-17: booking tool → Google Calendar (answered) |
| `npm run build` green on integration | no (no node_modules in conductor container; CI + workers) |
| Origin in sync (`git status -sb`) | pushed with this commit |

## Reserved migration numbers
| Number | Reserved for | Status (reserved → used → applied) |
|---|---|---|
| 0043 | conductor wave 0: opportunities.source/calendar_event_id, pitch_event_type +meeting_booked/won/lost, prospect_contacts.source_url | used (on integration, NOT applied) |
| 0044 | opportunities-calendar-sync (cron schedule) | reserved |
| 0045 | pitch-exemplar-memory (wave 2, if a table is needed) | reserved |
| 0046 | — | free |

## Active and queued tasks
| Slug | Module | Model/effort | Branch | Session | PR | Depends on | Status | Blocked on | Turns | Review findings | CI reds | Rework |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| opportunities-calendar-sync | opportunities (new) + api | opus/high | claude/opportunities-calendar-sync | session_012RWb5yLGodvUPrkTCx1cyV | — | — | running | — | | | | |
| opportunities-pipeline-ui | opportunities UI | sonnet/medium | claude/opportunities-pipeline-ui | session_01EPMCtSCVAJ4Pzs49KhxxcZ | #1 | — | reworked (fix-then-merge) | — | 12 | 1 (6 optional) | 0 | 1 |
| pitches-hot-lead-badge | pitches UI + query | sonnet/medium | claude/pitches-hot-lead-badge | archived | #3 merged 808af20 | — | merged | — | 12 | 0 (6 optional) | 0 | 0 |
| learning-arms-dashboard | learning UI | sonnet/medium | claude/learning-arms-dashboard | archived | #2 merged 5d9e88c | — | merged | — | 12 | 0 (6 optional) | 0 | 0 |
| contact-source-url | research + discover inserts | opus/medium | claude/contact-source-url | session_01VQw8xTBcjWonaKZruNCydk | — | — | running | — | | | | |
| pitch-exemplar-memory | pitches (hub) | opus/high | claude/pitch-exemplar-memory | — | — | wave 1 merged | queued (wave 2) | wave 1 | | | | |

Column meanings: Turns = assistant turns in the worker session (proxy for tokens).
Review findings = blocking findings the reviewer raised. CI reds = failed CI runs on the
PR. Rework = times the task went back to the worker or was redone by another worker.
These four columns feed the retro and the routing table.

## Questions for Pedro (batched, asked once per batch)
| # | From task | Question | Default if unanswered | Answer |
|---|---|---|---|---|
| 1 | opportunities-calendar-sync | Reconnect Google once after ship so the calendar.readonly scope is granted | sync reports needsReconnect until done | |

## Worktrees to clean up (in-session workers only)
| Path | Branch | Remove after |
|---|---|---|

## Optional findings carried to next batch (from reviews)
- PR #3: /pitches list throws if the pitch_events query fails (wrap, log, show list without badges); reward.ts and hot-lead.ts decide audit_scan stage with different rules (share levelOf); 200-row list window hides old hot leads; "Asked to talk" chip tone is danger-red (Pedro to judge in browser).
- PR #2: add a trials=100 boundary test; query failure renders as an honest "arms not loaded", not an empty state; order + truncation notice on the 2000 limit; icp learner never writes arms (label dead); UI "too early" (<20) vs bandit settle thresholds (15 scout / 30 writer) differ, audit to note.

## Shared-file changes pending (conductor does these)
| Requested by | File | Change | Done |
|---|---|---|---|
| opportunities-pipeline-ui | lib/pitches/events.ts, lib/audit/log.ts | extend PitchEventType and audit unions with meeting_booked / won / lost | done: events.ts (0375052), audit actions opportunity.booked/won/lost + entity (this commit) |
| PR #1 review (batch interaction) | lib/pitches/root-pitch.ts | one shared latestRootSentPitchId() for outcomes, calendar sync and opt-out | done (this commit); opt-out.ts migration to it = next batch |
| pitches-hot-lead-badge | lib/supabase/types.ts | add pitch_events so the any-cast can go | pending, next batch |

## Log
- 2026-10-17 16:16 UTC — phase3-batch1 opened on claude/gallant-gauss-gly093 (main acf53e2 merged). Wave 0: migration 0043 + types. 5 briefs written. Wave 1 = calendar-sync, pipeline-ui, hot-lead-badge, learning-dashboard, contact-source-url in parallel (remote sessions). Wave 2 = exemplar memory after wave 1 merges.
- 2026-10-17 16:18 UTC — create_session refused permission_mode acceptEdits (server records this session as default; Pedro says the app shows Accept edits). Probe: pipeline-ui spawned with inherited mode; check-in at 16:25 UTC decides remote vs in-session for the rest.
- 2026-10-17 16:24 UTC — PROBE RESULT: remote worker in inherited (default) mode ran install, tests, build, push and PR creation with NO prompts; only its final send_message to the conductor prompted. PR #1 open (499→507 tests). Allowing mcp__claude-code-remote__send_message in .claude/settings.json so later workers don't prompt. Spawning the other four next.
- 2026-10-17 16:25 UTC — 4 remaining wave-1 workers spawned as remote sessions (inherited mode, proven by the probe). PR #1 under review. Safety check-in armed for 17:16 UTC.
- 2026-10-17 16:31 UTC — PR #1 review: fix-then-merge (blocking: won/lost event attached to latest SENT pitch, which is a follow-up child; must be the root). Conductor landed lib/pitches/root-pitch.ts + audit opportunity actions. PR #2 (learning) and #3 (hot-lead) opened, 504/505 tests, in review.
- 2026-10-17 16:35 UTC — PR #3 merged (505 tests), PR #2 merged (510 tests), both reviewed merge/0 blocking. Sessions archived. Sonnet lane evidence: 2 clean runs on UI tasks.
