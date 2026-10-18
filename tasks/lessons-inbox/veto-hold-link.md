[2026-10-18] A veto that moves the row out of the set the counter reads is never counted
WHAT HAPPENED: `scheduleAuto` (lib/autopilot/tick.ts §5) moves a held pitch to `autopilot_lane = 'review'`, and `evaluateStage` (§6) counts vetoes only among rows with `autopilot_lane = 'auto'`. §5 runs before §6 in the same tick, so a person's veto (and now a digest hold) leaves the counted set before it is counted: `autoVetoed` stays ~0 and the veto-rate rule can promote veto → auto on vetoes it never saw.
RULE: When a state change both "handles" a row and is the signal a later metric counts, the metric must select on something the handling doesn't rewrite (here: the autopilot-approved event set, not the lane). Test the metric on the row as it looks AFTER the handler ran.
TAGS: autopilot, metrics, veto

[2026-10-18] Public capability links: key per purpose, GET reads only, guarded update
WHAT HAPPENED: The digest hold link (app/api/autopilot/hold) reuses the unsubscribe pattern: HMAC token with its own derived key (`autopilot-hold-v1:` label) plus a `k: "hold"` field, a GET confirm page that only reads, and a POST that is one `.eq("status","approved")` update returning rows. A fake query builder that applies `.eq()` filters (tests/autopilot-hold.test.ts) tests the guard itself instead of a mock that returns what it was told.
RULE: Every public token gets its own purpose-labelled key; the action is one conditional write whose row count decides the answer; the read path is tested with a fake that throws on any write.
TAGS: security, routes, tokens

## Out of scope, noticed
- `lib/autopilot/tick.ts` `evaluateStage`: `vetoed` filters `rows` (lane = 'auto'), but held rows are moved to lane 'review' by §5 first, so vetoes are effectively never counted. Fix: query autopilot-approved pitch ids (already in `autopilotApproved`) for status in ('draft','reviewer_rejected') without the lane filter.
- `lib/pitches/pitch-stage.ts` `transitionPitchStatusWith`: the update has no current-status guard, so a /pitches "move to draft" can flip a row the send-queue just claimed (`sending`) or sent. Same gap the brief names.
- `lib/audit/log.ts` `AuditAction` has no `"pitch.held"`; hold.ts inserts into `audit_log` directly (via the injected client) instead of `writeAuditLog`. Add the union member and switch over when convenient.
