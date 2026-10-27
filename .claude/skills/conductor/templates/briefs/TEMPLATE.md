# Brief: <slug>

<!-- Conductor fills this. Target: under 150 lines. A worker reads ONLY this file,
     tasks/briefs/_core-context.md, and the files listed under "Files". -->

| | |
|---|---|
| Module | `<module path>` |
| Model / effort | opus / medium  (see tasks/routing.md) |
| Branch | `claude/<slug>` from `claude/<phase>-integration` |
| PR target | `claude/<phase>-integration` |
| Reserved resource | none  (or a migration number from the board; do not take another) |
| Depends on | none  (or `<slug>` merged first; what it provides at runtime) |
| Conductor session | `session_...` (send_message here ONLY if blocked; the PR body is the report) |
| Size | S / M / L |

## Goal (2–4 sentences)
What outcome this task produces and why it matters to the product. Written so the worker
can tell a good solution from a merely passing one.

## Context the worker needs
Only what the worker cannot infer from the code. A change to a verdict,
label or lane quotes its consumer (e.g. `governor.heldAction`) and states the outcome. Incident
facts are quoted from a query run for this brief. Decisions already made, the public API
that must stay stable, the data shape in prod, the lesson that applies. A route with a time
budget: its maxDuration, every deadline inside it, every step between them, and the largest
load the schedules allow (test at that load). Stored text handed back to a model: every
post-processing step to reverse (links, codes, appended lines).

## Brain lessons
From the owner's second brain (how to search it: `tasks/conductor-config.md`): one line
per article that applies, its file name and its rule. "none matched" is an answer.

## Files
<!-- Derive this list, don't guess it (batch 4: 3 of 5 blocking findings were files missing
     here): grep for every CALLER that gates the code path (a route that filters before the
     call), every PRODUCER of data the change reads, and every WRITER of a field the change
     protects. Each goes below or the brief says why not. -->
Allowed to edit:
- `<module>/<file>`
- `<tests>/<new test file>` (new tests always allowed)

Read for context, do not edit:
- `<other module>/<file>`

Forbidden (conductor-only, say so in the PR if you need a change there):
- the protected files from `tasks/conductor-config.md`, any resource not reserved above.

## Must not change (negative set)
Inputs or behaviours whose outcome stays exactly as today. Mandatory for classifiers,
filters and gates; the reviewer probes these first.

## Acceptance checks
Concrete, runnable. The reviewer re-runs these. A filter/scrubber/classifier: check 1 runs
on real prod data (fixture from the conductor), never only on a generator the worker wrote.
1. The project's checks pass and include a new test for <behaviour>.
2. <SQL or command> returns <expected>.
3. <Edge case> is handled: <how to demonstrate>.

## External prerequisites
Everything outside this repo that must be true before the feature works in prod, with who
does it: an OAuth scope (and the API enabled in the OAuth client's Google Cloud project,
which the scope alone does not do), an env var in Vercel, a credential, a DNS record, a
console toggle. "none" is an answer; "unknown, worker to list in the PR" is not.

## Prod verification
<!-- Run each query once against prod (or check its columns against the migrations)
     before spawning. -->
One query, URL or log line the conductor runs after the deploy to show the feature is
live, and what it should return (e.g. the first `net._http_response` row for a new cron
path showing counts and no error). The batch is not closed until this returns clean.

## Out of scope
What a diligent worker might be tempted to fix and must not. Write it to the lessons inbox
instead.

## Questions already answered
Q: ...  A: ... (so the worker doesn't ask again)

## If blocked
Message the conductor with: what you tried, what you need, what you can still do
meanwhile. Do not wait idle if any part of the brief is still doable.
