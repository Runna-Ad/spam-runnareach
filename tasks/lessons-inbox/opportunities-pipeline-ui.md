[2026-10-17] Read-only helper unions lag new enum values
WHAT HAPPENED: 0043 added `won`/`lost` to pitch_event_type, but `PitchEventType` in lib/pitches/events.ts and the AuditAction/entityType unions in lib/audit/log.ts were not extended, and both are read-only for workers. actions.ts inserts the pitch_events row directly and reuses the `prospect.status_changed` audit code with the opportunity id in metadata.
RULE: when a migration adds an enum value, the conductor extends every TS union that mirrors it in the same wave, so workers can use the shared helpers.
TAGS: opportunities, enums, pitch-events, audit

## Out of scope, noticed
- package.json has zod v3 (`required_error`), so zod v4 `{ error }` params fail typecheck; worth a line in core-context.
