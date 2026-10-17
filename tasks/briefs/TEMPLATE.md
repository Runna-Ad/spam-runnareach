# Brief: <slug>

<!-- Conductor fills this. Target: under 150 lines. A worker reads ONLY this file,
     tasks/briefs/_core-context.md, and the files listed under "Files". -->

| | |
|---|---|
| Module | `lib/<module>/` |
| Model / effort | opus-5.5 / medium  (see tasks/routing.md) |
| Branch | `claude/<slug>` from `claude/<phase>-integration` |
| PR target | `claude/<phase>-integration` |
| Reserved migration | none  (or `0040_<name>.sql`, do not take another number) |
| Conductor session | `session_...` (send_message here when done or blocked) |
| Size | S / M / L |

## Goal (2–4 sentences)
What outcome this task produces and why it matters to the product. Written so the worker
can tell a good solution from a merely passing one.

## Context the worker needs
Only what the worker cannot infer from the code. Decisions already made, the public API
that must stay stable, the data shape in prod, the lesson that applies. Link a section of
`tasks/audit-2026-10-16.md` only if it is required reading.

## Files
Allowed to edit:
- `lib/<module>/<file>.ts`
- `tests/<module>-<thing>.test.ts` (new tests always allowed)

Read for context, do not edit:
- `lib/<other>/<file>.ts`

Forbidden (conductor-only, say so in the PR if you need a change there):
- `lib/supabase/types.ts`, `vercel.json`, `CLAUDE.md`, any migration not reserved above.

## Acceptance checks
Concrete, runnable. The reviewer re-runs these.
1. `npm test` passes and includes a new test for <behaviour>.
2. <SQL or command> returns <expected>.
3. <Edge case> is handled: <how to demonstrate>.

## Out of scope
What a diligent worker might be tempted to fix and must not. Write it to the lessons inbox
instead.

## Questions already answered
Q: ...  A: ... (so the worker doesn't ask again)

## If blocked
Message the conductor with: what you tried, what you need, what you can still do
meanwhile. Do not wait idle if any part of the brief is still doable.
