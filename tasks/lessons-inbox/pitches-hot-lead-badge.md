[2026-10-17] Widening PitchListRow breaks PitchDetail
WHAT HAPPENED: `PitchDetail` is `PitchListRow & {...}` and `getPitch` builds it by hand, so adding required fields to the list row would have forced edits to `getPitch` (briefed as untouched). I changed the PitchDetail type to `Omit<PitchListRow, "hot_lead" | "hot_lead_at"> & {...}` in lib/pitches/queries.ts. Also `pitch_events` is not in `lib/supabase/types.ts`, so the typed client rejects it; the query uses the same `any` cast as lib/pitches/events.ts. Tests import with a relative path plus `.ts` (the `@/` alias is not resolved by the node test runner).
RULE: When adding a field to a row type that another type extends, check the extender's builder; list-only fields go through `Omit` on the detail type. Add `pitch_events` to the Database types when the conductor next touches types.ts.
TAGS: pitches, types

## Out of scope, noticed
- lib/supabase/types.ts: `pitch_events` missing from the hand-written Database type (forces `any` casts in events.ts and queries.ts).
- getPitch fills created_at/updated_at with `new Date()` instead of the row values (lib/pitches/queries.ts).
