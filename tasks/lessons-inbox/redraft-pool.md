[2026-10-22] Changing "who gets the email" in one picker silently splits the email from its greeting
WHAT HAPPENED: The brief moved the recipient choice into `fetchTopUsableContact` (lib/pitches/contacts.ts). That only sets the pitch's `contact_id`. The greeting comes from `pickAddressContact` over pitch-stage's own contacts query (generator.ts, industry-templates.ts, review.ts), and the generation-time gate's recipient from `loadGateContext` (gate.ts:173), each "first usable by priority". Skipping contact A would have produced "Hi <A>" drafts linked to contact B, gated against A (so labelled AUTO), caught only by the send-queue gate's greeting_mismatch.
RULE: Before changing a "which X" rule, grep every reader that answers the same question by its own copy (here: `pickAddressContact`, `pickTopUsableContact`, `loadGateContext`, the /pitches display) and change them together, or change none. A rule that sets an FK is not the rule the text was written for unless the composer reads the same FK.
TAGS: pitches, recipient, one-predicate

[2026-10-22] A "one try per X" cap needs a mark that survives the rewrite that replaces X
WHAT HAPPENED: The re-draft's `decision.redraft_of` mark would have been lost when the tick's rewrite replaced the re-draft (generatePitchWith deletes drafts and writes a fresh decision), so a twice-failed prospect could be re-drafted again 14 days later. resolveHeld now copies the mark onto the rewrite, and a failed generation marks the old pitch (`redraft_failed`) so a repeating failure is not retried every tick.
RULE: When a marker lives on a row some other step deletes and recreates, carry it across that step and test the full chain (mark → rewrite → drop → next window), not only the first write.
TAGS: autopilot, tick, caps

## Out of scope, noticed
- lib/pitches/queries.ts:134, :241: /pitches shows `pickTopUsableContact` (priority-top, no verdicts) as the recipient, not the pitch's `contact_id`. After this PR plus the pitch-stage patch, a draft sent to contact B still shows contact A on /pitches.
- lib/pitches/pitch-stage.ts revision path: a rewrite that changes the recipient still revises the held text (`retryOf`) when the held draft had critic notes, so the revision is handed the old greeting. The gate then catches it as greeting_mismatch and the rewrite is dropped. Composing fresh when the recipient changed would keep it.
