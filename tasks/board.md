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
| opportunities-calendar-sync | opportunities (new) + api | opus/high | claude/opportunities-calendar-sync | — | — | — | queued | — | | | | |
| opportunities-pipeline-ui | opportunities UI | sonnet/medium | claude/opportunities-pipeline-ui | session_01EPMCtSCVAJ4Pzs49KhxxcZ | #1 | — | pr-open | — | 12 | | | |
| pitches-hot-lead-badge | pitches UI + query | sonnet/medium | claude/pitches-hot-lead-badge | — | — | — | queued | — | | | | |
| learning-arms-dashboard | learning UI | sonnet/medium | claude/learning-arms-dashboard | — | — | — | queued | — | | | | |
| contact-source-url | research + discover inserts | opus/medium | claude/contact-source-url | — | — | — | queued | — | | | | |
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

## Shared-file changes pending (conductor does these)
| Requested by | File | Change | Done |
|---|---|---|---|
| opportunities-pipeline-ui | lib/pitches/events.ts, lib/audit/log.ts | extend PitchEventType and audit unions with meeting_booked / won / lost | |

## Log
- 2026-10-17 16:16 UTC — phase3-batch1 opened on claude/gallant-gauss-gly093 (main acf53e2 merged). Wave 0: migration 0043 + types. 5 briefs written. Wave 1 = calendar-sync, pipeline-ui, hot-lead-badge, learning-dashboard, contact-source-url in parallel (remote sessions). Wave 2 = exemplar memory after wave 1 merges.
- 2026-10-17 16:18 UTC — create_session refused permission_mode acceptEdits (server records this session as default; Pedro says the app shows Accept edits). Probe: pipeline-ui spawned with inherited mode; check-in at 16:25 UTC decides remote vs in-session for the rest.
- 2026-10-17 16:24 UTC — PROBE RESULT: remote worker in inherited (default) mode ran install, tests, build, push and PR creation with NO prompts; only its final send_message to the conductor prompted. PR #1 open (499→507 tests). Allowing mcp__claude-code-remote__send_message in .claude/settings.json so later workers don't prompt. Spawning the other four next.
