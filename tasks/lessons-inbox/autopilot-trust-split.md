[2026-10-19] A step that "runs when the feature is off" needs every caller to reach it, not just the function
WHAT HAPPENED: The brief said runTick returned before runBreakers with the kill switch off, so the fix was to move the off gate below the breakers (lib/autopilot/tick.ts). But app/api/autopilot/tick/route.ts only calls runTick for autonomy_state rows with enabled = true, so with the kill switch off runTick never runs at all. The tick's own digest comment ("runs even when the autopilot is switched off") had the same blind spot.
RULE: Before claiming "X now runs when the feature is off", trace the caller chain up to the scheduler (cron → route → per-tenant filter → function) and check each filter. A gate can sit in the route's query as well as in the function. Pin the whole path with one test or source check, not just the function body.
TAGS: autopilot, tick, kill-switch, cron

[2026-10-19] Logic in a file the test runner can't import gets pinned by regex; move the db step into an importable, db-injected module instead
WHAT HAPPENED: tick.ts imports "server-only" and "@/" aliases, so node --test can't load it, and the finder relabel loop was pinned only by a source regex (deleting the loop passed every test). Moving it to lib/autopilot/hold.ts relabelFinderDrafts(db, …) let it run against the fake db; the tick keeps a one-line call pinned by regex, and the behaviour is tested for real (mutation table in the PR).
RULE: When a guard lives in an unimportable orchestrator, extract the db step into a db-injected function in an importable module (relative .ts imports, no server-only) and test it with the fake. Keep only the call site pinned by a source check.
TAGS: testing, autopilot, fake-db

## Out of scope, noticed
- lib/autopilot/governor.ts countVetoes (and tick.ts evaluateStage autoVetoed): an automatic approval pulled back by the autopilot itself (HELD_BY_AUTOPILOT, now also on the kill switch) counts as a person's veto in the current stage. After kill switch off → on in veto, those pull-backs raise the veto rate and block promotion: delivery/ops events leaking into the quality metric. Fix: countVetoes takes reasons and skips HELD_BY_AUTOPILOT. Not changed (promotion metrics are in the brief's negative set).
- lib/reports/snapshot.ts (~l.167): the autoScheduled query must also select pitches.autopilot_reasons and map it to `reasons`, or the weekly report's new pull-back exclusion has no data in prod.
- app/api/autopilot/tick/route.ts header + query: `.eq("enabled", true)` skips kill-switched tenants (see first lesson).
