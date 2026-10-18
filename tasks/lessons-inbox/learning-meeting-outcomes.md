nothing new

The wave-0 `OUTCOME_EVENT_TYPES` export made this a one-file change as intended: adding
the three opportunity types there is all the exemplar loader needed, and `learn.ts`
loads every event type, so armStats/funnel inherit the new scoring with no edit.

## Out of scope, noticed
- `lib/learning/reward.ts` sums points per event (scans already did this), so two
  distinct `meeting_booked` events on one root pitch (rebooked after a cancel) count
  20 each. Calendar sync writes one per opportunity, so this is per-meeting, which
  seems right; flagging in case dashboards want one-per-pitch.
