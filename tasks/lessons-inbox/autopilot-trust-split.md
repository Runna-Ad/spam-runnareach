[2026-10-19] A step that "runs when the feature is off" needs every caller to reach it, not just the function
WHAT HAPPENED: The brief said runTick returned before runBreakers with the kill switch off, so the fix was to move the off gate below the breakers (lib/autopilot/tick.ts). But app/api/autopilot/tick/route.ts only calls runTick for autonomy_state rows with enabled = true, so with the kill switch off runTick never runs at all. The tick's own digest comment ("runs even when the autopilot is switched off") had the same blind spot.
RULE: Before claiming "X now runs when the feature is off", trace the caller chain up to the scheduler (cron → route → per-tenant filter → function) and check each filter. A gate can sit in the route's query as well as in the function. Pin the whole path with one test or source check, not just the function body.
TAGS: autopilot, tick, kill-switch, cron

[2026-10-19] Logic in a file the test runner can't import gets pinned by regex; move the db step into an importable, db-injected module instead
WHAT HAPPENED: tick.ts imports "server-only" and "@/" aliases, so node --test can't load it, and the finder relabel loop was pinned only by a source regex (deleting the loop passed every test). Moving it to lib/autopilot/hold.ts relabelFinderDrafts(db, …) let it run against the fake db; the tick keeps a one-line call pinned by regex, and the behaviour is tested for real (mutation table in the PR).
RULE: When a guard lives in an unimportable orchestrator, extract the db step into a db-injected function in an importable module (relative .ts imports, no server-only) and test it with the fake. Keep only the call site pinned by a source check.
TAGS: testing, autopilot, fake-db

[2026-10-19] A fake db that ignores the select list can't catch a column missing from the select
WHAT HAPPENED: The follow-up added autopilot_reasons to the weekly producer's select (lib/reports/snapshot.ts). Removing it again passed every test, because the fake returned whole rows whatever was selected. Once the fake projected the selected columns, embeds included (tests/autopilot-trust-split.test.ts parseSelect/project), the mutation failed as it should.
RULE: When a test proves "the producer now reads column X", the fake must return only the selected columns, embeds included, the way PostgREST does. Otherwise run the mutation (drop X from the select) and watch it fail before calling the column covered.
TAGS: testing, fake-db, reports

## Out of scope, noticed
- none left: the route filter, the snapshot select and countVetoes were folded into this PR on the conductor's review (follow-up push).
