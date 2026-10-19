[2026-10-19] A stage with "@/" imports can still get a fake-client test: stub its deps with a loader hook
WHAT HAPPENED: processSingleProspectWith (lib/discover/pipeline-stage.ts) imports "@/" aliases and next/cache, so node's test runner cannot load it and every earlier test of it was a source grep. tests/pipeline-status-rule.test.ts registers a module.register() resolve/load hook that maps each of the target's value imports to a generated stub module (names parsed from the target's own import lines, so a new import needs no test edit), keeps lib/prospects/status.ts and zod real, and drives the real function against a ~60-line fake Supabase query builder. The same hook loaded bulkScoreProspects (a "use server" action) unchanged.
RULE: Before settling for a source-grep test on a stage file, use the loader-hook pattern in tests/pipeline-status-rule.test.ts: stub the imports, keep the rule under test real, and assert on the fake table's rows. A source test only proves a string exists; the fake-client test proved the outcome counting (needs_review vs suppressed) that the grep could not see.
TAGS: tests, pipeline, status-rule

[2026-10-19] Guarding an UPDATE is half the job: the caller must learn the guard refused it
WHAT HAPPENED: Adding `.not("status","in",…)` to the pipeline's "pitched" / "b_list" writes stopped the un-park, but the stage still returned outcome "pitched"/"needs_review", so job stats would have counted a parked prospect as active. The writes now `.select("id")` and the outcome is "suppressed" when zero rows moved (an error keeps today's outcome).
RULE: A guarded status write returns whether it moved the row (`.select("id")`, count > 0), and every count, audit row or outcome derived from the write uses that, not the intent. bulkScoreProspects now audits only the ids the UPDATE returned.
TAGS: prospects, status-rule, supabase

## Out of scope, noticed
- lib/discover/pipeline-stage.ts: a prospect parked mid-run (timing gap) can still get a draft pitch row from generatePitchWith / generateWebsitePitchWith before the guarded status write refuses; status stays parked and send paths block it via DO_NOT_SEND_STATUSES, but the orphan draft shows in /pitches. generatePitchWith could check the prospect status before the Claude call.
- lib/research/deep-research-stage.ts: standalone deep research (the UI button) still runs Claude on a do-not-send prospect; only its suppress write is guarded now.
- lib/replies/send-reply-action.ts:421 (archived_no_meeting over booked/won/lost) and NON_PITCHABLE in app/api/discover/run/route.ts (~49): as listed in the brief, not touched.
