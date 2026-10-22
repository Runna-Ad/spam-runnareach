[2026-10-22] Changing "who gets the email" in one picker silently splits the email from its greeting
WHAT HAPPENED: The brief moved the recipient choice into `fetchTopUsableContact` (lib/pitches/contacts.ts). That only sets the pitch's `contact_id`. The greeting comes from `pickAddressContact` over pitch-stage's own contacts query (generator.ts, industry-templates.ts, review.ts), and the generation-time gate's recipient from `loadGateContext` (gate.ts:173), each "first usable by priority". Skipping contact A would have produced "Hi <A>" drafts linked to contact B, gated against A (so labelled AUTO), caught only by the send-queue gate's greeting_mismatch.
RULE: Before changing a "which X" rule, grep every reader that answers the same question by its own copy (here: `pickAddressContact`, `pickTopUsableContact`, `loadGateContext`, the /pitches display) and change them together, or change none. A rule that sets an FK is not the rule the text was written for unless the composer reads the same FK.
Found mid-task; the conductor extended the scope to pitch-stage.ts, gate.ts and queries.ts the same hour.
TAGS: pitches, recipient, one-predicate

[2026-10-22] A "one try per X" cap needs a mark that survives the rewrite that replaces X
WHAT HAPPENED: The re-draft's `decision.redraft_of` mark would have been lost when the tick's rewrite replaced the re-draft (generatePitchWith deletes drafts and writes a fresh decision), so a twice-failed prospect could be re-drafted again 14 days later. resolveHeld now copies the mark onto the rewrite, and a failed generation marks the old pitch (`redraft_failed`) so a repeating failure is not retried every tick.
RULE: When a marker lives on a row some other step deletes and recreates, carry it across that step and test the full chain (mark → rewrite → drop → next window), not only the first write.
TAGS: autopilot, tick, caps

[2026-10-22] A revision carries its recipient: change the recipient, compose fresh
WHAT HAPPENED: The autopilot's rewrite revises the held draft's text (`retryOf`, pitch-stage.ts heldDraftRevision). A rewrite to a different contact would have handed the reviser "Hi Ana" while the pitch now went to Bo. generatePitchWith now composes fresh when the held draft's contact_id is not the new recipient.
RULE: Stored text handed back to a model carries every fact it was written for (recipient, link, language); when one of them changes, do not revise, write fresh.
TAGS: pitches, rewrite, recipient

[2026-10-22] A column with a write-once trigger cannot carry a later mark, and the fake db must say so
WHAT HAPPENED: The re-draft step marked pitches.decision after generatePitchWith had written it. Migration 0038 makes decision write-once (trigger raises), so in prod every mark would fail silently: the 10/day cap would never bind, a failing re-draft would retry every tick. All tests passed because the fake db accepted the update. Fix: the mark goes in at the first write (`generatePitchWith(…, { redraftOf })`), a failed try is an audit_log row, and the test fake now refuses a second decision write.
RULE: Before writing to an existing column, grep the migrations for triggers on that table (`create trigger … on public.<table>`); a fake db must enforce every such trigger the code path can hit, the same way it must reject a column the table lacks.
TAGS: autopilot, migrations, fake-db, decision

## Out of scope, noticed
- none
