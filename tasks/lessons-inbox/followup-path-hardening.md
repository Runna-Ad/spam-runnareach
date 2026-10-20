[2026-10-20] A rollback that restores a value it read earlier must be guarded on the value it wrote
WHAT HAPPENED: releaseFollowupClaim (lib/pitches/status-transitions.ts) put back the next_followup_at read at the start of the run, guarded only on sequence_step. The reply poll's OOO postpone and the manual snooze write next_followup_at on a claimed row (their filters still match it), so the release pulled the due date back over the OOO week and the next run would send during it. Fixed by restoring the old date only while the row still holds the date the claim wrote (`eq("next_followup_at", claimedFollowupAt)`), else releasing the step alone.
RULE: Every column a release writes back needs its own "still what I wrote" guard in the WHERE, not just the claim column. If another writer can change that column while the row is claimed, release in two steps: a guarded full restore, then a fallback that restores only the claim column. Test it with the other writer's exact filters running between the claim and the release, and with a fake that runs the concurrent write right before the release's own UPDATE.
TAGS: send-path, follow-up, race, claims

[2026-10-20] A per-item budget check belongs right before the expensive step, not only at the loop top
WHAT HAPPENED: The follow-up route checked a 90s budget only at the loop top, then did pre-work (token, thread read), a paid 20s compose, the gate, the claim and Gmail. A follow-up started at 89s could finish past 110s. Now hasTimeToCompose (cutoff 70s = 120 - (25 compose + 25 claim reserve)) runs right before the compose, hasTimeToClaim (95s) right before the claim, and out of time breaks the loop.
RULE: Put a budget check in front of each step that spends money or takes a claim, sized for everything after it (show the sum in a comment). When a check fails, break the loop instead of continuing, because every later item is in the same position.
TAGS: send-path, time-budget, serverless

## Out of scope, noticed
- lib/replies/intent-actions.ts:189-196: the manual auto_reply snooze sets `sequence_paused_at: null`, so it also un-pauses a sequence the recheck paused for do-not-send/DNC. The follow-up cron re-checks status and DNC before sending, so nothing goes out, but the pause and its new audit row stop meaning "stopped for good".
- app/api/pitches/follow-up/route.ts gate-fail pause (7b'): `update({ sequence_paused_at })` has no tenant or step guard. It runs before the claim, so nothing breaks today. Noting it for whoever next reshapes that block.
