# Brief: handsoff-autopilot

| | |
|---|---|
| Module | `lib/autopilot/governor.ts` + `lib/autopilot/tick.ts` (stage step, breakers, tick report) |
| Model / effort | opus-5.5 / high (routing: `lib/autopilot/` briefed tasks, circuit breakers) |
| Branch | `claude/handsoff-autopilot` from `claude/phase3-batch8-integration` |
| PR target | `claude/phase3-batch8-integration` |
| Reserved migration | none |
| Depends on | none. Parallel with `health-alarms`, which READS the tick-errors audit row you write (contract below) |
| Conductor session | `session_01HtEg7XG4MPQU4omrd2BX69` (send_message ONLY if blocked; the PR body is the report) |
| Size | M |

## Goal
The autopilot recovers from a bad day without Pedro. Today three things either stop it until a person acts or make it blind (readiness check `tasks/audit-2026-10-22-autonomy.md` items 6, 9). Good looks like: a quality problem in the veto stage restarts the veto clock instead of dropping to shadow (where 100 human approvals are needed to climb back); the Gmail-error breaker can actually fire; and every tick that hit errors leaves a row the health check can read.

## Context the worker needs
**Stage demotion.** `nextStage` (`governor.ts:~293-302`): a quality trip or factual error demotes auto→veto and veto→**shadow**. Shadow needs `STAGE_RULES.shadow` (7 days, 100 decided, 90% unedited) to climb back, i.e. a person approving 100 pitches. The tick applies a change at `tick.ts:~892-910` (`autonomy_state.update({ stage, stage_since: now })`, `holdAutoApprovals` pullback when `pullsBackApprovals(next.stage)`, insight, `notify` email). When the stage does not change it only updates metrics (`:~869`) and, if `pullsBackApprovals(s.stage)`, sweeps (`:~877-887`). Veto clock = `stage_since` (`tick.ts:~804`), `STAGE_RULES.veto` 14 days / 100 scheduled.
**Gmail breaker.** `governor.ts:222` trips `gmail_api` at ≥ 3 errors today; `tick.ts:271` passes `apiErrorsToday: 0` always, so it never fires. Gmail send failures return `{ ok:false, error:"Gmail send failed…" }` from `lib/gmail/client.ts:115,120` (conductor-only folder, read-only). Pitch sends call `sendGmailMessage` at `app/api/pitches/send-queue/route.ts:498`, `app/api/pitches/follow-up/route.ts:569` and `lib/pitches/send-action.ts:274` (manual send); check whether anything durable records a failure per inbox today.
**Tick errors.** `report.errors` (`tick.ts:~159-166`, the `step()` helper) are only returned as JSON by `app/api/autopilot/tick/route.ts`; nobody reads them.

**Decisions (conductor):**
1. Demotion from veto: the stage STAYS `veto`, `stage_since` restarts at now (the 14-day / 100-scheduled clock restarts), pending AUTO approvals are pulled back exactly as a demotion does today, and it is logged (insight + notify email) as a change with a reason saying "veto clock restarted". auto→veto is unchanged. Nothing automatic ever moves a tenant to shadow any more; shadow is Pedro's manual choice only. Keep `nextStage` pure: express the restart in its return (e.g. `{ stage: "veto", reason, restart: true }`) and apply it in the tick.
2. Gmail breaker: count today's (UTC day, after the inbox's latest resume, like `inboxBounceStats`) Gmail API send failures per inbox from a durable record. If none exists, put a helper in a new `lib/autopilot/send-failures.ts` (`recordSendFailure(db, { tenantId, inboxId, pitchId, error })` → `audit_log` row, action `gmail.send_failed`, entity_type `sender_inbox`, entity_id the inbox, metadata `{ pitch_id, error ≤ 300 chars }`, never throws) and add ONE call right after each failing `sendGmailMessage` at the three sites above, NOT in `lib/gmail`. `health-alarms` adds one heartbeat line near the END of the same two routes in parallel: keep your route edits to that single call so the merge stays trivial. Only transport/API failures count (not DNC/gate/claim refusals). State which rows you count.
3. Tick errors row — FROZEN CONTRACT for `health-alarms`: when a tick ends with `report.errors.length > 0`, insert one `audit_log` row: `action = "autopilot.tick_errors"`, `entity_type = "tenant"`, `entity_id = tenantId`, `tenant_id = tenantId`, `metadata = { errors: string[] }` (at most 20, each cut to 300 chars). Never throws (log on failure). No row when there are no errors.

## Brain lessons
none matched (second brain not attached). Core-context: a value read by another module → name the reader and quote its check (here: health-alarms reads the row above).

## Files
Allowed to edit: `lib/autopilot/governor.ts`, `lib/autopilot/tick.ts`, `lib/autopilot/send-failures.ts` (new), `lib/pitches/send-action.ts`, `app/api/pitches/send-queue/route.ts` and `app/api/pitches/follow-up/route.ts` (one `recordSendFailure` call each, nothing else), `tests/handsoff-autopilot.test.ts` (new), existing tests that pin veto→shadow or `apiErrorsToday: 0` (name them).
Read only: `lib/gmail/*`, `lib/autopilot/hold.ts`, `lib/autopilot/bounce-breaker.ts`, `lib/reports/*`.
Forbidden: `lib/supabase/*`, `lib/gmail/*`, `lib/compliance/*`, `lib/reports/*` (other worker), `app/api/autopilot/tick/route.ts` and `app/api/replies/poll/route.ts` (other worker adds heartbeats there), migrations, `vercel.json`.

## Must not change (negative set)
- auto→veto demotion and every promotion rule: unchanged.
- Delivery breakers pause sending and never move the stage.
- A pulled-back approval is held exactly as today (reason strings unchanged; `lib/learning/presend.ts` matches them).
- Send-path behaviour: a failed send is handled exactly as today apart from the new record.
- Kill switch / stage off: unchanged.

## Acceptance checks
1. Pure test: veto + quality trip → `{stage:"veto", restart}`; veto + factual error → same; auto + trip → veto; no path returns shadow automatically.
2. Tick test (fake db): a veto restart updates `stage_since`, pulls back AUTO approvals, writes an insight and a notify call.
3. Breaker: 3 recorded Gmail failures today on an inbox → `gmail_api` trip for that inbox; 2 → none; failures before the latest resume don't count; a DNC/gate refusal is not recorded as a failure.
4. Tick errors: a tick with errors writes exactly one row with the contract shape; a clean tick writes none; an insert error does not break the tick.
5. `npm run typecheck && npm run lint && npm test && npm run build` green; count reported.

## External prerequisites
none.

## Prod verification
After deploy: `select action, count(*) from audit_log where action in ('autopilot.tick_errors','gmail.send_failed') and created_at > '<deploy>' group by 1;` (≥ 0; read one row's metadata). Stage stays veto (no automatic shadow).

## Out of scope
Health alerts (other worker), send pacing (next wave), the opt-out spike threshold itself.

## If blocked
Message the conductor with what you tried, what you need, and what you can still do meanwhile.
