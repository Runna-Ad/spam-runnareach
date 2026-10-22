# Brief: redraft-pool

| | |
|---|---|
| Module | `lib/autopilot/tick.ts` (resolve held + a new re-draft step), `lib/autopilot/governor.ts` (held action), `lib/pitches/contacts.ts` (recipient choice) |
| Model / effort | opus-5.5 / high (routing: `lib/autopilot/` briefed tasks; recipient choice is a send-path input) |
| Branch | `claude/redraft-pool` from `claude/phase3-batch8-integration` |
| PR target | `claude/phase3-batch8-integration` |
| Reserved migration | none (if you find you need one, stop and message the conductor) |
| Depends on | wave 2 merged (tick.ts as on the integration branch). Parallel with `send-pacing` (send routes only, disjoint) |
| Conductor session | `session_01HtEg7XG4MPQU4omrd2BX69` (send_message ONLY if blocked; the PR body is the report) |
| Size | M |

## Goal
A prospect we researched (and paid for) is not thrown away for good because one draft failed. Readiness check `tasks/audit-2026-10-22-autonomy.md` items 8 and 11. Prod 2026-10-22 (query run by the conductor): in the last 14 days 68 first-email drafts were auto_rejected, one per prospect, and none of those 68 prospects ever got an email; 16 were dropped because the verifier was unsure about the address, and 5 of those 16 prospects have a second contact with an email. Good looks like: an unsure address makes the autopilot try the prospect's next contact instead of dropping it, and a prospect whose draft failed for its WRITING gets one fresh draft later, inside the existing caps.

## Context the worker needs (conductor-verified facts, file:line)
- Recipient: `lib/pitches/contacts.ts` `fetchTopUsableContact` (order `priority_rank` asc, limit 12, first `hasUsableEmail`); the pitch's `contact_id` is set at `lib/pitches/pitch-stage.ts:~503-510`. `generatePitchWith(actor, prospectId, { retryOf })` re-reads contacts and re-picks with `fetchTopUsableContact` every time (`pitch-stage.ts:~179-206, ~503`); `retryOf` only reads the held draft for revision (`~418-427`); the recipient is never excluded.
- Verification runs only in the tick's labelling step (`tick.ts labelDrafts ~582-625`, `storedVerdictUsable` / `verifyRecipient`), and is stored on the contact: `prospect_contacts.verify_verdict` / `verify_reasons` / `verify_checked_at` (TTL `VERDICT_TTL_MS` 7 days, `lib/research/verify-recipient.ts:130`). `laneFor` (`governor.ts:44-63`) gets `verify` + `recipientSelectedBy`; "verifier unsure about the address" is a review reason (`:56`) and `UNFIXABLE_REASON` (`:69`) makes `heldAction` drop it; `resolveHeld` (`tick.ts ~637-695`) calls `dropDraft` (`~698`, status `auto_rejected`, prospect stays `pitched`).
- A prospect can have many contacts (`priority_rank`); there is no "next best" logic and no bad flag on a contact. The Anymail finder is PAID (`lib/discover/enrich-contacts.ts:78`, no cost record, no cap): never call it here (cost rule, CLAUDE.md).
- Drafting happens in the discovery pipeline, not the tick: `lib/discover/pipeline-stage.ts processSingleProspect` takes only `raw` prospects (`getRawProspectIdsWith :113`, limit 50) and writes `pitched` (`:636-638`). So an auto_rejected prospect is never drafted again. `pitch-stage.ts` blocks a new draft only for `isSentOrParked`.
- Limits: `MAX_PROSPECTS_PER_DAY = 100` (`lib/learning/scout.ts:186`, research volume, Pedro's rule), AI cap via `isUnderDailyCap` ($3/24h in prod), `REWRITES_PER_TICK = 2`, `LABEL_BATCH = 40` (`tick.ts:106-111`).
- Pre-send guardrail (batch 8 wave 1, `lib/learning/presend.ts`) classifies `auto_rejected_reason` strings from `laneFor` / `heldAction`; any new reason string you write must keep its classification right (a re-draft's rejection is a normal writer/verifier reason; add a test).

**Decisions (conductor):**
1. Recipient choice: `fetchTopUsableContact` skips a contact whose stored verdict (within TTL) is `drop`, and skips one whose verdict is `review` WHEN another usable contact without a bad verdict exists. With no alternative it returns the same contact as today (a person can still decide in the review lane). Manual generation gets the same rule (it is better for it too); say so in the PR.
2. Verifier unsure in `resolveHeld`: when the held reasons include "verifier unsure about the address" (or "verifier says the address will not deliver" via the drop lane) AND the prospect has another usable contact without a bad verdict, regenerate the draft (`generatePitchWith(actor, prospectId, { retryOf })`), which now picks that contact; it counts against `REWRITES_PER_TICK` and the AI budget check exactly like a rewrite. Otherwise drop as today. Express the choice in `heldAction` (pure) with an input flag such as `hasAlternativeContact`, so `governor.ts` stays pure and testable.
3. Re-draft pool, a new tick step `redraft` (after resolveHeld, before scheduling; inside the tick budget): pick prospects whose ONLY root pitches are `auto_rejected` with a WRITER-caused reason (the same classification `presend.ts` uses: AI review / writer-fixable gate codes, "rewrite failed" counts as writer), the newest of them created ≥ 14 days ago, prospect not suppressed / DNC / in cooldown / parked, and at most ONE earlier re-draft (so a prospect gets at most 2 auto_rejected drafts ever). Generate a fresh draft (no `retryOf`) with `generatePitchWith`; it is labelled next tick like any draft. At most 3 re-drafts per tick and 10 per UTC day, only while `isUnderDailyCap` leaves at least the rewrite minimum; record each in the tick report. Mark it in `decision` (e.g. `redraft_of: <old pitch id>`) so it can be counted.
4. Never re-draft for address, probation, template, person or unknown reasons.

## Brain lessons
none matched (second brain not attached). Core-context: read meaning into an absent input only after excluding every path that empties it on purpose (no contacts read ≠ no alternative contact: a read error means "drop as today").

## Files
Allowed to edit: `lib/autopilot/tick.ts`, `lib/autopilot/governor.ts`, `lib/pitches/contacts.ts`, `tests/redraft-pool.test.ts` (new), existing tests that pin the drop of verifier-unsure drafts or `fetchTopUsableContact` order (name them).
Read only: `lib/pitches/pitch-stage.ts`, `lib/research/*`, `lib/learning/*`, `lib/discover/*`.
Forbidden: `lib/supabase/*`, `lib/gmail/*`, `lib/compliance/*`, `app/api/pitches/*` (send-pacing worker), `lib/reports/*`, migrations, `vercel.json`, any paid finder call.

## Must not change (negative set)
- A draft held by or edited by a person is never touched; HELD_BY_PERSON / HELD_BY_AUTOPILOT handling unchanged.
- The lane rules themselves (`laneFor`) unchanged: an unsure address is still never sent automatically.
- No prospect is emailed twice: a re-draft only for prospects with NO sent/approved/sending pitch; DNC, suppression, cooldown and opt-out checks all still apply through the normal path.
- Research volume (100/day) and the $3 cap untouched; re-drafts stay inside the AI cap.
- The pre-send guardrail's classification of existing reasons unchanged.

## Acceptance checks
1. `fetchTopUsableContact`: drop-verdict contact skipped; review-verdict skipped only with an alternative; stale verdict (past TTL) ignored; no alternative → same as today.
2. `heldAction` pure tests: unsure + alternative → rewrite; unsure, no alternative → drop (as today); person hold wins over everything.
3. Tick test (fake db): a verifier-unsure draft on a prospect with 2 contacts is regenerated to the second contact; with 1 contact it is dropped.
4. Re-draft step: eligible prospect (writer reason, 15 days old) → one fresh draft with `redraft_of`; 13 days old → none; verifier/person/template reason → none; already re-drafted once → none; a prospect with any sent pitch → none; caps 3/tick and 10/day respected; AI cap below minimum → none.
5. `npm run typecheck && npm run lint && npm test && npm run build` green; count reported.

## External prerequisites
none.

## Prod verification
After deploy (first re-drafts can appear on 2026-10-31, 14 days after the 10-17 drafts): `select count(*) from pitches where decision ? 'redraft_of' and created_at > '<deploy>';` and `select auto_rejected_reason, count(*) from pitches where status='auto_rejected' and created_at > '<deploy>' group by 1;` → fewer "verifier unsure" drops when a second contact exists.

## Out of scope
Finding new contacts (paid finder), the pipeline's raw-only selection, send pacing.

## If blocked
Message the conductor with what you tried, what you need, and what you can still do meanwhile.
