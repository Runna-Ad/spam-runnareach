[2026-10-22] A schema comment and the code disagreed on the shape of parent_pitch_id
WHAT HAPPENED: supabase/migrations/0001_initial_schema.sql:610 says "follow-up step N points to step N-1", while app/api/pitches/follow-up/route.ts only sends from rows with no parent, so every follow-up points straight at the root. Git history starts on 2026-10-17, so older rows could not be proven chain-free. The poll now prefers the thread's own parentless row, and the backfill walks parent_pitch_id up to the top ancestor, so both shapes resolve.
RULE: When a stored relation's meaning comes from a comment and the code that writes it, and they disagree, make readers and repairs correct for both shapes (resolve to the top ancestor) unless the data can be checked. A backfill must not trust the comment.
TAGS: replies, pitches, backfill, data-shape

[2026-10-22] Next.js route files cannot export helpers, so route logic is tested through the loader hook
WHAT HAPPENED: The root resolution lives in app/api/replies/poll/route.ts, and the brief's allow-list had no lib file. A route.ts may only export route fields, so the test drives GET through the stub loader from tests/optout-repair.test.ts, with lib/pitches/events.ts loaded for real against a fake db that stores rows.
RULE: To test logic inside a route without a lib file, load the route with the loader hook, stub every import except the module whose writes you assert, and check the stored rows rather than spy arguments.
TAGS: tests, routes

## Out of scope, noticed
- supabase/migrations/0001_initial_schema.sql:610: the parent_pitch_id comment ("points to step N-1") no longer matches the follow-up cron, which points at the root. A comment-only fix belongs in a future migration or a doc note.
- scripts/backfill-reply-events-to-root.sql only moves reply/bounce. If any other event type (unsubscribe) was ever written on a follow-up row, it has the same blind spot. Not checked in prod.
