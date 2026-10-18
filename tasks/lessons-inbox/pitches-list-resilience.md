[2026-10-18] Query modules that import the Next server client can't be unit-tested
WHAT HAPPENED: `lib/pitches/queries.ts` imports `@/lib/supabase/server`, and the node test runner can't resolve the `@/` alias, so the failure path of `listPitches` couldn't be tested in place. The side-query logic moved to `lib/pitches/hot-lead-events.ts` (relative imports, injected client) and is tested with a fake client.
RULE: Put any branch that needs a failure-path test in a small file with relative imports and an injected client; keep the `createClient()` wrapper thin.
TAGS: pitches, testing

## Out of scope, noticed
- 200-row window in `listPitches` hides hot leads on older pitches.
- `levelOf` could be shared with `reward.ts`.
