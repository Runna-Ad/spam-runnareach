# Brief: exemplar-readiness-report

| | |
|---|---|
| Module | `lib/reports/` (weekly report) + one pure export in `lib/pitches/exemplars.ts` |
| Model / effort | opus-5.5 / medium (in-session worker; touches exemplar selection, which feeds pitches) |
| Branch | `claude/exemplar-readiness-report` from `claude/optimistic-tesla-3gceud` (= main 3808b56 + docs) |
| PR target | `claude/optimistic-tesla-3gceud` |
| Reserved migration | none |
| Depends on | none (PR #28 shipped: exemplars on main, switch `EXEMPLARS_ENABLED` unset = off) |
| Conductor session | `session_017nqBxLFFXKbhDwKiPi6xLf` |
| Size | S |

## Goal
Pedro (2026-10-19): the Monday weekly report says how many past pitches would qualify as
style examples ("exemplars") today, so he knows when it is worth turning
`EXEMPLARS_ENABLED` on (advice: from about 5). Good = the count uses EXACTLY the rule
`fetchExemplars` uses (one shared predicate, no second copy that can drift), the report
says "n/a" when a query fails (never 0), and the switch's state is shown.

## Context the worker needs
- Selection today: `lib/pitches/exemplars.ts` `isEligibleCandidate` (target-dependent:
  language, segment tier, current prospect) + `selectExemplars` (outcome: test events,
  bounced address, `scoreOutcome` ≥ `MIN_EXEMPLAR_SCORE`, not negative, the synthetic
  "sent" event for pitches sent before pitch_events existed). `lib/pitches/exemplar-queries.ts`
  `fetchExemplars` adds: prospect status `suppressed` skipped; do-not-contact address or
  domain skipped (`onDnc`); `industry === "other"` never matches.
- Extract the TARGET-INDEPENDENT part into one exported pure predicate (e.g.
  `qualifiesAsExemplar(candidate & { events }, opts) → { score } | null`): root, sent,
  settled ≥ `ATTRIBUTION_WINDOW_DAYS`, critic not failed, no gate override, not a test
  address, no test event, not bounced, score ≥ min and not negative, classifiable segment
  (not "other"). `isEligibleCandidate`/`selectExemplars` call it; their behaviour must not
  change (the existing tests in tests/pitch-exemplars*.test.ts and
  tests/pitch-exemplar-queries.test.ts stay green, unedited).
- The report counts a pitch once; group by language and segment (`segmentOf`, as
  "legal/ca" etc.), top few segments.
- Data (`lib/reports/snapshot.ts` `gatherWeeklyRaw`): settled root sent pitches of the
  tenant (`sent_at` ≤ now − 14 d; with prospect industry/market/language/status, contact
  email, critic pass, gate_override), their outcome events (`OUTCOME_EVENT_TYPES`, chunk
  the `.in` lists), and the do-not-contact entries for those emails/domains. Use the file's
  `all()` paging helper. Any failed query → the whole field is null → "n/a".
  Prod today: 178 settled root sends, all before pitch_events existed, 0 with an outcome
  event → the line must read 0 (not n/a) on the next report.
- Format (`lib/reports/weekly.ts`, LEARNING section, plain text, no AI):
  `Exemplars: off (EXEMPLARS_ENABLED unset). Past pitches that qualify: 0` and, when > 0,
  `(EN 3, ES 1; top: legal/ca 2, dental/mx 1)`; when ≥ 5 and off, add
  `: worth turning on`. On = `Exemplars: on.` + the same count. The switch state comes
  from `process.env.EXEMPLARS_ENABLED === "1"`, read in snapshot (keep weekly.ts pure).

## Files
Allowed to edit:
- `lib/pitches/exemplars.ts` (the shared predicate + its callers only)
- `lib/pitches/exemplar-queries.ts` (only if the predicate move needs it)
- `lib/reports/weekly.ts`, `lib/reports/snapshot.ts`
- `tests/reports-weekly.test.ts`, new `tests/exemplar-readiness.test.ts`

Read, do not edit: `lib/learning/reward.ts`, `lib/learning/segments.ts`,
`app/api/reports/weekly/route.ts`, `lib/discover/dnc-check.ts`.

Forbidden: `lib/supabase/types.ts`, `vercel.json`, migrations, the scrubber/leak check
(`scrubExemplar`, `exemplarLeaks`, `toExemplar`, wordlists).

## Must not change (negative set)
- Which exemplars `fetchExemplars` picks for any input (existing tests unedited and green).
- Every other line of the weekly report (existing reports-weekly tests unedited and green).
- No AI call, no write, no email beyond the existing one.

## Acceptance checks
1. A test: candidates covering each rule (follow-up, unsettled, critic failed, gate
   override, test address, test event, bounced, low score, negative reply, "other"
   segment, suppressed prospect, DNC address, DNC domain, a pre-events pitch with only
   sent_at, two qualifying in different languages) → the count and grouping are exact.
2. A test that the report prints "n/a" when the field is null, 0 when empty, the
   "worth turning on" hint at ≥ 5 with the switch off and not when on.
3. A test proving there is one predicate: `selectExemplars` for a matching target picks
   only pitches the readiness predicate also counts (property over the fixture).
4. `npm run typecheck && npm run lint && npm test && npm run build` green.

## External prerequisites
none

## Prod verification
After the deploy: `GET /api/reports/weekly?dry=1` (CRON_SECRET) shows the Exemplars line
with "off" and "qualify: 0".

## Out of scope
The switch itself; exemplar selection changes; other report sections. Notes → lessons
inbox (`tasks/lessons-inbox/exemplar-readiness-report.md`).
