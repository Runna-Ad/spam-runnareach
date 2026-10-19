# Brief: bounce-hotfix

| | |
|---|---|
| Module | `lib/autopilot/`, `lib/research/verify-recipient.ts`, `lib/settings/sending-actions.ts`, `app/api/pitches/send-queue/route.ts` |
| Model / effort | opus-5.5 / high (send-path safety; see tasks/routing.md) |
| Branch | `claude/bounce-hotfix` from `claude/phase3-hotfix-integration` |
| PR target | `claude/phase3-hotfix-integration` |
| Reserved migration | `0048_replies_poll_every_10min.sql` (do not take another number) |
| Depends on | none |
| Conductor session | `session_017nqBxLFFXKbhDwKiPi6xLf` (send_message here ONLY if blocked; the PR body is the report) |
| Size | M |

## Goal
On 2026-10-19 the first AUTO drip hard-bounced twice, the inbox_bounces breaker paused the
ONLY sending inbox (pedro@runnareach.com) and the autopilot dropped veto -> shadow. Pedro
(option 1): "the fix has to let it resume and fix whatever is sending to bounced emails."
After this ships, a person can resume the inbox and it stays resumed; the next bad address
is caught before the rest of a drip goes out; finder-service addresses are never sent
without a person; and a demotion never leaves automatic approvals waiting to send.

## Context the worker needs
Prod facts (2026-10-19, all verified by the conductor with SQL):
- 19 AUTO sends went out 6/6/6/1 at 15:00, 15:10, 15:20, 15:30 UTC (send-queue cron
  `*/10 15-22 * * 1-5`, 6 per run). Gmail bounce notices for 2 of the 15:00 batch landed at
  15:00:31 and 15:00:36. The reply poll (`*/30`) recorded them at 15:30 (pitch_events
  `bounce`); the autopilot tick (`*/15`) tripped `inbox_bounces` at 15:45. 13 sends went
  out after the bounces existed.
- Someone resumed the inbox in Settings between 15:45 and 16:00 (only `updateSenderInbox`
  can set paused=false; it writes no audit row). The 16:00 tick tripped on the SAME 2
  bounces (still in the last 50 sends) and paused it again. A resume cannot stick until
  ~48 more sends, which a paused inbox never makes.
- Bounce sources: henry.jonk@absolute-hydraulics.com, `selected_by = anymail` (1 of 9 Anymail
  sends bounced); contacto@dentistaenguadalajara.com, `scraper` (1 of 39). Both had
  verify_verdict `send` because `provenanceOf` gives anymail/hunter "medium".
- After the demotion, 9 AUTO pitches stayed `approved` + scheduled (6 Anymail). The
  send-queue checks only `inbox.paused`, never the stage. The conductor held all 9 by hand
  (draft, review lane, `held by a person (Pedro, bounce incident 2026-10-19)`).
- Lessons: tasks/lessons.md, the three 2026-10-19 entries on bounces / demotion / resume.

## Brain lessons
- re-verify-a-fix-with-the-same-reviewer-before-closing-it.md: the conductor re-sends any
  blocking fix to the same reviewer. Nothing else matched.

## The four changes
1. **Resume sticks, and is audited.** `updateSenderInbox`: when a paused inbox is saved
   unpaused, insert `audit_log` `{action: "sender_inbox.resumed", entity_type:
   "sender_inbox", entity_id, actor_id: user id, metadata: {previous_reason}}`. The breaker
   (`runBreakers` in `lib/autopilot/tick.ts`) counts an inbox's hard bounces only after its
   latest resume (sends stay "last 50", so the >= 20 sends floor still applies), and
   `bounces_today` counts only after the latest resume of any inbox that day. Keep
   `evaluateBreakers` pure; compute the cut-off in the db layer and test it with a fake db.
2. **The send-queue stops a drip on a fresh bounce.** Before sending from an inbox, the
   send-queue applies the same inbox_bounces rule (shared helper, not a copy) and, if it
   trips, skips that inbox with reason "bounce breaker" (it does not pause; the next tick
   does, with the email). Migration 0048 moves `spam-replies-poll` to `5-59/10 * * * *`
   (every 10 min, offset 5 min from the send runs) via `cron.alter_job` or unschedule +
   schedule, idempotent, no DROP of anything else. Confirm in the PR that a poll run with no
   new mail makes no Claude call (no added AI spend).
3. **Finder addresses need a person.** `verifyEmailPure`: `selected_by` anymail or hunter
   gets a `review` reason ("Address from a finder service (<name>), not published by the
   company"), so the autopilot never auto-sends it. Provenance stays "medium" (the
   bounced-domain rule keeps its meaning). A person can still approve and send it by hand.
4. **A demotion pulls back automatic approvals.** When the stage step moves to `shadow` or
   `off`, in the same step hold every pitch with `status='approved'`,
   `autopilot_lane='auto'`, `sent_at is null`: the same guarded update as `holdPitch`
   (`.eq("status","approved")`). Do not reuse `HELD_BY_PERSON` (no person held it): add a
   new reason that `resolveHeld`/`heldAction` also leaves alone, e.g. `held by the
   autopilot: stage dropped to shadow`, plus one `pitch.held` audit row per pitch
   (metadata source `demotion`). Mention the count in the demotion email body.

## Files
Allowed to edit: `lib/autopilot/tick.ts`, `lib/autopilot/governor.ts`, `lib/autopilot/hold.ts`,
`lib/research/verify-recipient.ts`, `lib/settings/sending-actions.ts`,
`app/api/pitches/send-queue/route.ts`, `supabase/migrations/0048_replies_poll_every_10min.sql`,
new `lib/autopilot/*.ts` helpers, `tests/*.test.ts` (new and existing for these modules).
Read only: `app/api/replies/poll/route.ts`, `lib/pitches/send-action.ts`,
`supabase/migrations/0041_autopilot_scheduler.sql`.
Forbidden: `lib/supabase/types.ts`, `vercel.json`, `CLAUDE.md`, `lib/{anthropic,gmail,compliance,supabase}/`.

## Must not change (negative set)
- A scraped / manual address on the prospect's own domain with MX still gets `send`.
- The breaker thresholds (>= 20 sends, >= 2 bounces, >= 4%; >= 3 bounces today) and every
  other breaker (gmail_api, opt_out_spike, dmarc, blocklist, placement) behave as today.
- An inbox that was never resumed: the breaker counts exactly as today.
- A pitch a person approved by hand (no `approved autopilot=true` event) is never held by a
  demotion and never skipped by the send-queue except by the bounce rule.
- `holdPitch` from the digest link behaves exactly as today.

## Acceptance checks
1. `npm run typecheck && npm run lint && npm test` pass; new tests cover each of the 4 changes
   with fakes, including: trip -> resume -> tick does NOT re-pause; trip -> resume -> 2 new
   bounces in >= 20 sends -> re-pause; send-queue skips on 2 fresh bounces; anymail -> review,
   scraper -> send; veto -> shadow holds only autopilot-approved pitches.
2. A mutation check in the PR: revert each change, the matching test fails.
3. The migration applies cleanly twice in a row (idempotent) on a local/branch DB, or show
   the SQL is idempotent by construction.

## External prerequisites
none (the conductor applies migration 0048 after Pedro's "ship it").

## Prod verification
After deploy + 0048: `select schedule from cron.job where jobname='spam-replies-poll'` =
`5-59/10 * * * *`; Pedro resumes the inbox; the next two ticks leave `paused=false`; an
`audit_log` row `sender_inbox.resumed` exists.

## Out of scope
Spacing sends differently, warmup, paid verifiers (cost rule: none), changing Anymail usage
in research, the stage rules (7 days / 100 decisions). Lessons go to `tasks/lessons-inbox/bounce-hotfix.md`.

## Questions already answered
Q: Pause from the send-queue too?  A: No, skip only; the tick pauses and emails.
Q: Hunter too?  A: Yes, same as Anymail.

## If blocked
Message the conductor with what you tried, what you need, and what you can still do meanwhile.
