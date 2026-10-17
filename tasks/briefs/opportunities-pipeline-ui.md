# Brief: opportunities-pipeline-ui

| | |
|---|---|
| Module | `components/opportunities/`, `app/(dashboard)/opportunities/`, `lib/opportunities/{queries,actions}.ts` |
| Model / effort | sonnet-5.5 / medium (Sonnet-lane evaluation: UI + CRUD over an existing table) |
| Branch | `claude/opportunities-pipeline-ui` from `claude/gallant-gauss-gly093` |
| PR target | `claude/gallant-gauss-gly093` (phase 3 integration branch) |
| Reserved migration | none |
| Depends on | none (schema from 0043 is on the integration branch) |
| Conductor session | `session_012bGmp5nHP9Lx5ke69JkaBk` |
| Size | S |

## Goal
`/opportunities` today shows only runna-hunter scans. Real opportunities (booked
meetings, soon created automatically by a calendar sync) have no screen and no way to
be marked won or lost, so the funnel can never report revenue. Add a "Pipeline" section
listing `opportunities` rows with mark-won and mark-lost actions that also append the
outcome to `pitch_events`. A good solution is small, validated, and records why a deal
was lost and how much a won one was worth.

## Context the worker needs
- Table `opportunities` (see `supabase/migrations/0001_initial_schema.sql` lines 717–736
  and 0043): `stage` enum `meeting_booked | discovery_done | proposal_sent | negotiation |
  won | lost`, `deal_value_cad numeric`, `loss_reason text`, `notes`, `prospect_id`,
  `contact_id`, `source`, `calendar_event_id`, `actual_close_date`.
- The table is not in `lib/supabase/types.ts`; follow the cast pattern used in
  `lib/pitches/events.ts` for untyped tables.
- Server action pattern: `lib/prospects/detail-actions.ts` (`"use server"`, `requireUser`,
  zod input, audit log via `lib/audit`).
- `pitch_events` insert helper and types: `lib/pitches/events.ts`. New event types
  `won` and `lost` exist in the enum (0043). Attach to the prospect's most recent sent
  pitch if any; otherwise skip the event and still update the opportunity.
- Page composition: `app/(dashboard)/opportunities/page.tsx` fetches and passes props to
  `components/opportunities/opportunities-page.tsx`. Add the pipeline above the hunter
  sections. Reuse `components/ui/*` (Chip, Button, Card, EmptyState); match the existing
  dark design language, no new dependencies.

## Files
Allowed to edit:
- `lib/opportunities/queries.ts` (new: `listOpportunities(tenantId)` joined with prospect
  name and contact email, newest first, limit 200)
- `lib/opportunities/actions.ts` (new: `markOpportunityWon`, `markOpportunityLost`)
- `lib/opportunities/outcome.ts` (new, pure: zod schemas and a `describeOutcome()` helper
  so the validation is testable without a DB)
- `components/opportunities/pipeline-list.tsx` (new)
- `components/opportunities/opportunities-page.tsx` (add the section)
- `app/(dashboard)/opportunities/page.tsx` (fetch the list)
- `tests/opportunities-outcome.test.ts` (new)

Read, do not edit: `lib/prospects/detail-actions.ts`, `lib/pitches/events.ts`,
`lib/audit/*`, `components/ui/*`, `components/opportunities/hunter-*.tsx`.

Forbidden: `lib/opportunities/calendar-sync.ts`, `lib/opportunities/google-calendar.ts`,
any `app/api/*`, migrations, `lib/supabase/types.ts`.

## Must not change (negative set)
- The hunter scans and analytics sections render exactly as before.
- No opportunity row is ever deleted from this UI.

## Acceptance checks
1. `markOpportunityWon` rejects a value ≤ 0 or missing; `markOpportunityLost` rejects an
   empty reason (tests on the pure schemas).
2. Won sets `stage = 'won'`, `deal_value_cad`, `actual_close_date = today`; lost sets
   `stage = 'lost'`, `loss_reason`, `actual_close_date`. Both append a `pitch_events` row
   when a sent pitch exists (describe how you verified; a DB is not available in tests).
3. Empty state when there are no opportunities, with one honest line and no CTA that
   creates rows.
4. `npm run typecheck && npm run lint && npm test && npm run build` green.

## Out of scope
Creating opportunities by hand, editing deal stages other than won/lost, charts.
