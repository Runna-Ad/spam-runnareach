# Brief: benchmark-review-ui

| | |
|---|---|
| Module | `/benchmarks` page: `app/(dashboard)/benchmarks/`, `components/benchmarks/`, `lib/benchmarks/actions.ts`, `lib/benchmarks/proposals.ts` (new) |
| Model / effort | sonnet-5.5 / medium (routing: Admin CRUD lane, `benchmarks` is listed there) |
| Branch | `claude/benchmark-review-ui` from `claude/phase3-batch7-integration` |
| PR target | `claude/phase3-batch7-integration` |
| Reserved migration | none. 0050 (`supabase/migrations/0050_wanted_facts.sql`) is on the branch: your data contract |
| Depends on | 0050 + types (on the branch). Parallel with `benchmark-matching` and `fact-research` |
| Conductor session | `session_01HtEg7XG4MPQU4omrd2BX69` (send_message ONLY if blocked; the PR body is the report) |
| Size | M |

## Goal
Pedro reviews, on /benchmarks, the statistics the weekly research step proposes, and nothing goes live without his click. He also sees which facts the writer keeps wishing it had, can add one himself, and can say "don't look for this". Good looks like: a proposal shows everything he needs to decide in one card (figure, the sentence it would be quoted as, publisher, link, vendor flag, caveat, why research thinks it is solid, which wanted fact and how often it was asked for); approve, edit-then-approve and reject each take one click; rejected proposals never come back.

## Context the worker needs
**Data (0050, read the file):** proposals are `benchmarks` rows with `wanted_fact_id is not null and verified_at is null and rejected_at is null` (always `is_active=false`). Rejected = `rejected_at` set (kept so research never re-proposes it; DB CHECK forbids a rejected row being active). `wanted_facts` rows: `fact, pain_code, industry, market, source, request_count, last_requested_at, status (open|proposed|no_source|dismissed), research_note`. New rows ONLY through the RPC `record_wanted_fact(p_tenant_id, p_fact, p_source, p_pain_code, p_industry, p_market, p_pitch_id)` (it dedupes; it raises on a fact under 8 or over 300 characters: show that as a form error). Types are in `lib/supabase/types.ts` (`wanted_facts`, `record_wanted_fact`).

**Approval today:** `setBenchmarkActive` (`lib/benchmarks/actions.ts:30-68`) refuses viewers (`:34`), and activating stamps `verified_by`/`verified_at` (`:51-57`). Reuse it for "Approve". Every new action follows the same shape: `requireUser()`, viewer refused, zod input, request-scoped `createClient()` (RLS), `.eq("tenant_id", user.tenantId)`, `revalidatePath("/benchmarks")`.

**New actions in `lib/benchmarks/actions.ts`:**
- `updateBenchmarkProposal({ benchmark_id, statistic, figure, caveat, industry_scope, market, is_vendor_sourced })`: only when the row is still an unverified, unrejected proposal (put those conditions in the UPDATE's WHERE and treat 0 rows updated as "already reviewed"). Editing `figure` is allowed (Pedro may shorten it) but must stay non-empty.
- `rejectBenchmarkProposal({ benchmark_id })`: sets `rejected_at=now()`, same WHERE conditions.
- `addWantedFact({ fact, pain_code? })`: RPC with `p_source='manual'`, tenant from the session. Pain picker from `pain_taxonomy` (`code`, `display_name_en`, `is_active`).
- `setWantedFactStatus({ wanted_fact_id, status: "dismissed" | "open" })`: dismiss, or reopen a dismissed / no_source fact.
- `setBenchmarkActive` must refuse to activate a rejected row with a clear message (today the DB CHECK would error with a raw message).

**Queries:** new `lib/benchmarks/proposals.ts` (`listBenchmarkProposals(tenantId)` joining the wanted fact; `listWantedFacts(tenantId)` ordered `status` (open, proposed, no_source, dismissed), then `request_count desc`). Do NOT edit `lib/benchmarks/queries.ts` (another worker changes it this wave): the existing main list (`listAllBenchmarks`) keeps showing everything, so the page passes it the set of proposal and rejected ids to leave out (pending proposals appear only in the review section; rejected rows appear nowhere except a collapsed "Rejected (n)" list).

**Page layout (`app/(dashboard)/benchmarks/page.tsx`, today 27 lines):** 1) "Waiting for your review (n)" cards, only when n > 0, at the top; 2) the existing library list; 3) "Facts the writer asked for" table with an add form. Follow `components/benchmarks/benchmarks-list.tsx` for style (caveat visible, not behind a disclosure; `Chip`, `Button` from `components/ui`). Vendor-published rows carry the same vendor marker the list uses. Copy is plain English: "Approve", "Edit before approving", "Reject", "Don't look for this", "Look again".

## Brain lessons
none matched (second brain not attached to the conductor session on 2026-10-21). `_core-context.md` rule that applies: client state survives `router.refresh()`; derive a card's state from server props, not only from local state.

## Files
Allowed to edit:
- `app/(dashboard)/benchmarks/page.tsx`
- `components/benchmarks/*` (new files allowed)
- `lib/benchmarks/actions.ts`, `lib/benchmarks/proposals.ts` (new)
- `tests/benchmark-review-ui.test.ts` (new)

Read for context, do not edit:
- `supabase/migrations/0050_wanted_facts.sql`, `supabase/migrations/0029_benchmarks.sql`, `lib/supabase/types.ts`, `lib/benchmarks/queries.ts`, `lib/auth.ts`, `components/ui/*`

Forbidden: `lib/benchmarks/queries.ts`, `lib/benchmarks/research.ts`, `app/api/*`, `lib/pitches/*`, `lib/supabase/*`, migrations, `vercel.json`.

## Must not change (negative set)
- A viewer can do none of the new actions (each returns the viewer error, no DB call).
- Approving still stamps `verified_by`/`verified_at` exactly as today; deactivating still leaves them.
- No action ever sets `is_active=true` except `setBenchmarkActive`.
- A proposal already approved or rejected (by another tab) is not edited or rejected: the action reports "already reviewed".
- Existing active and inactive library rows (the 48 + the inactive Rival IQ row) render as today.

## Acceptance checks
1. Action tests with a fake client: each action's WHERE conditions (tenant, unverified, unrejected) are asserted; viewer refused before any DB call; RPC error from a 5-character fact surfaces as a readable form error; activating a rejected row is refused.
2. `npm run build` green; screenshot-free description in the PR of the three sections with a seeded fake (the conductor checks the UI on the preview).
3. `npm run typecheck && npm run lint && npm test` green; count reported.

## External prerequisites
none (0050 is applied by the conductor before the deploy).

## Prod verification
After deploy and the first research run: /benchmarks shows "Waiting for your review" with the proposals (`select count(*) from benchmarks where wanted_fact_id is not null and verified_at is null and rejected_at is null;` matches n). Pedro approves one: `verified_by` is his user id, `is_active` true.

## Out of scope
The research step itself, the writer recording wanted facts, which benchmarks the writer gets, a "research now" button, editing active library rows.

## Questions already answered
Q: Delete a rejected proposal? A: No, keep it (`rejected_at`) so research never proposes it again.
Q: Show `fact_key`? A: No, internal.
Q: Who may add a wanted fact? A: Any non-viewer.

## If blocked
Message the conductor with what you tried, what you need, and what you can still do meanwhile.
