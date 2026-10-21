# Brief: wanted-facts-writer

| | |
|---|---|
| Module | `lib/pitches/` (writer + critic output, pitch-stage recording) |
| Model / effort | opus-5.5 / high (routing: `lib/pitches/` hub) |
| Branch | `claude/wanted-facts-writer` from `claude/phase3-batch7-integration` |
| PR target | `claude/phase3-batch7-integration` |
| Reserved migration | none. 0050 (`supabase/migrations/0050_wanted_facts.sql`) is on the branch: your data contract |
| Depends on | `benchmark-matching` MERGED (same files; it exports `resolvePainCodes` and adds `for_pains` to the writer payload). Conductor confirms before spawning |
| Conductor session | `session_01HtEg7XG4MPQU4omrd2BX69` (send_message ONLY if blocked; the PR body is the report) |
| Size | S-M |

## Goal
When the writer or the critic wants a statistic the library does not have, the system records the wish (what fact, for which pain, from which pitch) instead of losing it, and the email still goes out without a number. Good looks like: a cart-recovery pitch for a boutique with no cart statistic yields one wanted fact like "share of small online stores with no abandoned-cart email" tied to `abandoned_cart_loss`; the same wish from 10 pitches becomes one row asked for 10 times; a pitch never fails, slows, or changes because of this.

## Context the worker needs
**Contract (0050):** call `supabase.rpc("record_wanted_fact", { p_tenant_id, p_fact, p_source: "writer" | "critic", p_pain_code, p_industry, p_market, p_pitch_id })`. It dedupes on a normalized key + pain and bumps `request_count`; it RAISES when the fact is under 8 or over 300 characters. Best-effort: never throws to the caller, never awaited on a path that has a deadline without a timeout; an error is a `console.warn`, nothing else.

**Writer output** (`lib/pitches/claude-composer.ts:40-57` `responseSchema`): add optional `wanted_fact: string | null` (clip, never `.max()` reject; absent → null). Prompt (FACTS block, `:425-433`, as left by `benchmark-matching`): "If a statistic would make this email stronger and none of payload.benchmarks has the pain you lead with in for_pains, write no number in the email and put the fact you wish you had in wanted_fact, in plain words, as a question or a description, never a number." Add the key to the JSON shape the prompt shows (`:494` area).

**Critic output** (`lib/pitches/review.ts:88-95` `criticSchema`, prompt `:118-147`): add optional `wanted_fact: string | null` with the same meaning ("a sourced statistic this email lacks"). It must not change `score`, `issues` or `pass`.

**Recording** (`lib/pitches/pitch-stage.ts`): after the pitch row is inserted (you need its id), record at most ONE writer fact and ONE critic fact per generated pitch, from the FINAL draft's composer/critic outputs only (the review loop calls both up to 3 times; earlier drafts' wishes are dropped). Pain code: map the writer's chosen `pain_id` (UUID or code) with `resolvePainCodes` (exported by `benchmark-matching` from `lib/benchmarks/queries.ts`); null when unknown. Industry and market from the prospect row. Same for the rewrite-with-angle path (`rewritePitchWithAngleWith`, ~`:694`). Template path (no Claude): nothing to record. Store the writer's fact on the decision record too (`lib/pitches/decision.ts`: optional `wanted_fact: string | null`; old rows still parse).

**Discard, do not record,** a fact that: contains a digit (it is the question, not the answer; a model that writes "70% of stores…" is guessing); is shorter than 8 or longer than 300 characters after trim; or names the prospect's company (case-insensitive substring of `company_name` when that is ≥ 4 characters). Your own simple checks, tested.

**Time budget:** generation runs inside a 60 s server action (`app/**` maxDuration 60, review loop deadline startedAt+48 s, see `review.ts` `composeWithReview`). The RPC runs after the insert: give it a 3 s `AbortSignal.timeout` (postgrest-js `.abortSignal()`), and do not await it before anything that follows on the critical path.

**Conductor decision (batch 7 review of #48):** the rewrite-with-angle directive (`claude-composer.ts` ~:583-591, "under the same FACTS rules: no client, no number") contradicts FACTS 2 now that every offered benchmark is tagged with its pain. Change it to "no client; a number only as FACTS 2 allows (a benchmark whose for_pains includes the angle's pain)". Then check `forced_angle.pain_id` (zod at pitch-stage ~:681, sent by the UI) has the same form as `pain_candidates[].pain_id` (UUID); if the UI sends a code, map it with `resolvePainCodes` so the pairing works, and test it. Prompt text changes → bump to `pitch-v3.2-2026-10-22`.

## Brain lessons
none matched (second brain not attached to the conductor session on 2026-10-21). `_core-context.md`: LLM output clipped with `.transform`, never hard `.max`; test an error field for presence, not truthiness.

## Files
Allowed to edit:
- `lib/pitches/claude-composer.ts` (schema, prompt text, `wanted_fact` passthrough on `ComposedPitch` / `ClaudeComposeResult` if needed), `lib/pitches/review.ts` (critic schema + prompt line + passthrough), `lib/pitches/generator.ts` (types only), `lib/pitches/decision.ts`, `lib/pitches/pitch-stage.ts`
- `lib/benchmarks/wanted-facts.ts` (new: `recordWantedFacts(...)` + the discard checks, pure parts exported)
- `tests/wanted-facts-writer.test.ts` (new) and existing tests that pin the schemas (name them in the PR)

Read for context, do not edit: `lib/benchmarks/queries.ts`, `supabase/migrations/0050_wanted_facts.sql`, `lib/supabase/types.ts`.

Forbidden: `lib/supabase/*`, `lib/anthropic/*`, migrations, `vercel.json`, `lib/benchmarks/research.ts`, `lib/benchmarks/actions.ts`, `components/*`.

## Must not change (negative set)
- Subject, body, `pain_id`, critic `score`/`issues`/`pass`, the gate verdict and the lane for a given model output: byte-identical with and without a `wanted_fact` in the output (test with a fake model).
- A pitch whose RPC call errors, times out, or raises the length check is saved exactly as without this feature.
- An old pitch decision without `wanted_fact` still parses.
- `PITCH_PROMPT_VERSION` becomes `pitch-v3.2-2026-10-22` (you change prompt text).

## Acceptance checks
1. Fake composer + critic returning wishes on drafts 1 and 3: exactly one writer and one critic RPC call, both with draft 3's text, the pitch id, the resolved pain code.
2. Discard tests: digit, too short, too long, company name.
3. RPC error and a 5 s hang: pitch saved, action returns normally within the budget (fake timers or an injected clock).
4. Byte-identical check from the negative set.
5. `npm run typecheck && npm run lint && npm test` green; count reported.

## External prerequisites
0050 applied before the deploy (conductor).

## Prod verification
After deploy: `select source, pain_code, industry, fact, request_count from wanted_facts order by last_requested_at desc limit 20;` shows writer/critic rows with no digits; `select count(*) from pitches where decision ? 'wanted_fact' and created_at > <deploy time>;` > 0 after a day of drafting.

## Out of scope
The research step, the /benchmarks UI, which benchmarks are offered (done by `benchmark-matching`).

## Questions already answered
Q: Record when the writer DID cite a benchmark? A: Yes if it still names a wish; the dedupe makes repeats cheap.
Q: Parse critic issue text for missing sources? A: No, use the new structured field only.

## If blocked
Message the conductor with what you tried, what you need, and what you can still do meanwhile.
