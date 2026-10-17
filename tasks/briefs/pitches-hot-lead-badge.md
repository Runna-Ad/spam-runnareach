# Brief: pitches-hot-lead-badge

| | |
|---|---|
| Module | `lib/pitches/` (queries + one new pure file), `components/pitches/` |
| Model / effort | sonnet-5.5 / medium (Sonnet-lane evaluation: UI + one query, no data-model change) |
| Branch | `claude/pitches-hot-lead-badge` from `claude/gallant-gauss-gly093` |
| PR target | `claude/gallant-gauss-gly093` (phase 3 integration branch) |
| Reserved migration | none |
| Depends on | none |
| Conductor session | `session_012bGmp5nHP9Lx5ke69JkaBk` |
| Size | S |

## Goal
Attribution is live end to end: when a prospect runs the free audit tool from a pitch's
link, a `pitch_events` row of type `audit_scan` is written (payload `stage: "scan"`), and
when they submit the contact form, another with `stage: "contact_request"`. Nothing shows
this on `/pitches`, so the hottest leads look like every other sent pitch. Add a badge
and a filter. A good solution derives the level in one pure function, fetches the events
in one query (no N+1), and changes nothing else about the list.

## Context the worker needs
- Event rows: `supabase/migrations/0039_hunter_scan_attribution.sql` writes them; column
  names and the payload shape are there (`event_type`, `payload`, `event_at`, `pitch_id`).
- `listPitches(tenantId)` in `lib/pitches/queries.ts` returns `PitchListRow[]`. Add
  `hot_lead: "contact_request" | "scan" | null` and `hot_lead_at: string | null`.
  Fetch the `audit_scan` events for the returned pitch ids in ONE query (`in('pitch_id',
  ids)`), then fold with the pure function.
- Level rule: `contact_request` beats `scan`; latest `event_at` wins for `hot_lead_at`.
- UI: `components/pitches/pitches-page.tsx` renders rows with `Chip` (see existing
  `<Chip tone=…>` uses). Add a chip "Asked to talk" (contact_request) or "Ran the check"
  (scan) next to the status chip, and a filter toggle "Hot leads" that keeps only rows
  with `hot_lead`. Keep the existing filters working.

## Files
Allowed to edit:
- `lib/pitches/hot-lead.ts` (new, pure: `hotLeadLevel(events)`)
- `lib/pitches/queries.ts` (extend `PitchListRow` and `listPitches` only)
- `components/pitches/pitches-page.tsx`
- `tests/pitches-hot-lead.test.ts` (new)

Read, do not edit: `lib/pitches/events.ts`, `supabase/migrations/0039_*.sql`,
`components/ui/chip.tsx`.

Forbidden: every other file in `lib/pitches/` (the hub; another task will touch the
composer later), `app/api/*`, migrations.

## Must not change (negative set)
- The order, count and existing fields of `listPitches` output.
- Existing filters and the pitch detail drawer behaviour.
- `getPitch` and `getPitchCounts` are untouched.

## Acceptance checks
1. `hotLeadLevel` tests: no events → null; one scan → scan; scan then contact_request
   → contact_request with the contact_request timestamp; events of other types ignored.
2. `listPitches` issues exactly one additional query for events (show the code path in
   the PR body; tests cannot hit the DB).
3. Badge renders for both levels; "Hot leads" filter hides rows without a level.
4. `npm run typecheck && npm run lint && npm test && npm run build` green.

## Out of scope
Notifications for hot leads, changes to the governor, the /funnel page.
