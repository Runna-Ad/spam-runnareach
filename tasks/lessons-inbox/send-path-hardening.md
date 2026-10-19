[2026-10-19] A counter guarded by a cap is one SQL statement: check and write in the same UPDATE
WHAT HAPPENED: sends_today was bumped by read → add one in TypeScript → write back in three send paths (send-queue, lib/pitches/send-action.ts, follow-up). Two send-queue runs overlap at 15:00 UTC and their write-backs clobbered each other. Migration 0049 replaces all three with spam_reserve_send_slot (UPDATE … WHERE effective < daily_cap RETURNING) taken before Gmail, and spam_release_send_slot when Gmail refuses. 20 parallel psql sessions against cap 5 on a local Postgres: 5 taken, 15 refused, counter 5.
RULE: When a value both limits work and counts it, reserve before the external call with one conditional UPDATE and release on a definite refusal. Never release on an ambiguous failure (a throw from the send call): the over-count is the safe side. A security definer RPC that authenticated users can call needs its own tenant guard in the WHERE (`auth.uid() is null or tenant_id = current_tenant_id()`), since it bypasses RLS.
TAGS: send-path, migrations, concurrency

[2026-10-19] Keep the existing source-shape guards passing instead of rewriting them
WHAT HAPPENED: A `giveBack()` helper that released both the slot and the claim broke four tests in tests/send-path-safety.test.ts, which look for `releaseClaim(` with `to: "approved"` / `queueReleaseFor(` inside the blocked branch. Inlining the two calls kept those guards untouched; the new test then checks that each claim release after the reservation sits next to a slot release.
RULE: When a refactor trips a source-shape guard, change the code shape back before touching the guard. The guard encodes a reviewer's check; weakening it to fit the refactor removes that check silently.
TAGS: tests, send-path

## Out of scope, noticed
- `app/api/replies/nudge/route.ts:174/332` is a fourth sends_today writer, still read-then-write (`bumpSendsTodayPayload`). It can still under-count when it overlaps a send run. Same fix: `reserveSendSlot` before Gmail, `releaseSendSlot` on refusal.
- `countVetoes` (lib/autopilot/governor.ts) counts any autopilot-approved pitch back in draft as a veto, including `HELD_BY_AUTOPILOT` pullbacks (holdAutoApprovals and now the send-time doubtful-address hold). Vetoes only gate promotion, so this errs toward caution, but the veto rate stops meaning "a person said no".
- Follow-up route: the loop-top `TIME_BUDGET_MS` (90 s) check comes before a compose of up to ~20 s, then the claim and Gmail. A pitch started at 89 s can run past 110 s. A claim-side budget check like the send-queue's would close it.
- `recoverStuckSends` puts a never-sent stuck pitch back to approved without giving its slot back. That over-counts by one (the safe side). Releasing it there would be wrong if the slot was taken on an earlier UTC day.
