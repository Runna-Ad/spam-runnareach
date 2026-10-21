# Brief: benchmark-matching

| | |
|---|---|
| Module | `lib/benchmarks/` + the pitch writer's benchmark input (`lib/pitches/`) |
| Model / effort | opus-5.5 / high (routing: `lib/pitches/` hub is high) |
| Branch | `claude/benchmark-matching` from `claude/phase3-batch7-integration` |
| PR target | `claude/phase3-batch7-integration` |
| Reserved migration | none |
| Depends on | none. `wanted-facts-writer` (wave 2) builds on your frozen API below |
| Conductor session | `session_01HtEg7XG4MPQU4omrd2BX69` (send_message ONLY if blocked; the PR body is the report) |
| Size | M |

## Goal
A pitch that leads with a pain gets the sourced statistics that are about THAT pain, for a business like this one, and the writer and critic both know which pain each statistic is about. Good looks like: a boutique leading with "no cart recovery" is offered the Baymard abandonment figures, never a retention or video statistic dressed up as being about carts; a construction firm is never offered an online-store figure. Fewer pitches with no number at all, and zero pitches whose number is about a different problem than the one they describe.

## Context the worker needs
**Today** (`lib/benchmarks/queries.ts:109-144`, `fetchBenchmarksForPitch`): rows are kept when `pain_codes` overlaps ANY of the prospect's pains (`:124`, `.overlaps("pain_codes", codes)`), then `industryOverlaps(r.industry_scope, opts.industry)` (`:130`, whole-word containment, `:58-67`), then market (`:132`). Both callers pass every evidenced pain: `lib/pitches/pitch-stage.ts:331-335` (first generation, `pains.map((p) => p.pain_id)`) and `:798-802` (rewrite with angle). The payload sent to the writer (`lib/pitches/claude-composer.ts:563-570`) and to the critic (`lib/pitches/review.ts:171`) carries statistic/figure/publisher/caveat but NOT which pain a row is for. The writer picks its own lead pain (`claude-composer.ts:451`, returns `pain_id`, `:494`).

**Prod case (query run 2026-10-21):** pitch `9f2d7427…` (boutique, CA, rewrite 10:15 UTC) led with pain `…452` "No cart or browse abandonment recovery" and was offered three rows: Bain "25% to 95%" and HBR "5 to 25 times" (both `low_customer_retention`, universal scope) and Wyzowl "85%" (`no_content_velocity`, universal). All 5 active `abandoned_cart_loss` rows are scoped `["online store","retail"]`, and "boutique" contains neither word, so none passed. The prospect also had retention and content pains, which is why off-topic universal rows got in. (Pitch `04e5dbde…`, same day, got 0 because the A/B arm was `no_benchmark`, `pitch-stage.ts:362`; that path stays as is.)

**Measured on the prod fixture** (`tests/fixtures/prod-prospect-pains-2026-10-21.txt`, 259 prospects; `tests/fixtures/prod-benchmarks-2026-10-21.json`, the 48 active rows): with today's rule, 215 prospects get ≥1 row for their FIRST evidenced pain; 42 get rows only for OTHER pains (the failure above); 2 get none. Prospects whose first pain gets nothing, by industry: industrial supplier 10, logistics 6, fisioterapia 4, asesoría fiscal 3, boutique 3, fitness studio 3, restaurant group 3, consultorio dental 2, wholesale 2, wholesale distributor 2, others 1 each. (Conductor script, same matching as `industryOverlaps`.)

**Decisions already made (conductor, within Pedro's approval "fix how statistics are matched to a pitch's pain"):**
1. **Pain first.** Every offered row says which of this prospect's pains it is for: add `for_pains: Array<{ code: string; label: string | null }>` to `GeneratorInputBenchmark` (`lib/pitches/generator.ts:124-132`), only codes that are both in the row's `pain_codes` and among the prospect's evidenced pains. Payload to writer and critic includes it.
2. **Industry families.** A new pure module `lib/benchmarks/industry-families.ts`. A row also matches when one of its `industry_scope` terms is in the SAME family as the prospect's industry. Families (lookup on the WHOLE industry string, trimmed, lower-cased, accents kept as stored; never word containment, so "boutique hotel" is NOT retail):
   - retail: online store, retail, boutique, direct to consumer, tienda, ecommerce, e-commerce
   - b2b_industrial: manufacturer, manufacturing, industrial supplier, distribution, distributor, wholesale, wholesale distributor, supply chain, logistics
   - professional: accounting firm, chartered accountant, despacho contable, asesoría fiscal, law firm, despacho de abogados, consultoría, consulting firm, agencia de seguros
   - clinic: hospital, clínica, consultorio dental, fisioterapia
   - wellness: spa, salón de belleza, estética, fitness studio, gimnasio
   - food: restaurant, restaurante, restaurant group, bar, panadería
   - lodging: hotel, hotel chain, boutique hotel
   "outdoor" stays in no family (open question for Pedro; default: unmatched). Today's direct `industryOverlaps` match stays as is; families only ADD matches.
3. **Order and cap.** Rows for the same pain: direct industry match first, then family match, then universal (empty scope); within a tier, non-vendor before vendor. At most 3 rows per pain, at most 8 in total. Deterministic order (tests pin it).
4. **Prompt rules.** Writer (`claude-composer.ts` FACTS block ~`:430-433` and payload note `:620`): cite a benchmark only if one of its `for_pains` is the pain you lead with; otherwise no number. Critic (`review.ts:126`, rule 2): a statistic whose `for_pains` does not include the pain the email is about is BLOCKING ("about a different problem"). Bump `PITCH_PROMPT_VERSION` (`claude-composer.ts:276`) to `pitch-v3.1-2026-10-22`; the conductor adjusts the batch 6 comparison that filters on the old string.
5. **Decision record** (`lib/pitches/decision.ts:45`): `benchmarks_offered` entries gain an optional `pain_codes: string[]` (the `for_pains` codes). Optional so old rows still parse.

**Frozen public API** (wave 2 `wanted-facts-writer` imports it, do not rename):
- `fetchBenchmarksForPitch(supabase, tenantId, { painIds, industry, market })` keeps its signature and never-throws contract.
- Export `resolvePainCodes(supabase, tenantId, painIds): Promise<Array<{ id: string; code: string }>>` from `lib/benchmarks/queries.ts` (today private at `:77`, returns codes only; widen it to pairs so a caller can map the writer's chosen `pain_id` UUID to its code). Same error behaviour: never throws, unknown ids dropped.
- Export `industryFamily(industry: string | null): string | null` from `industry-families.ts`.

## Brain lessons
none matched (second brain not attached to the conductor session on 2026-10-21; engineering rules in `_core-context.md` apply).

## Files
Allowed to edit:
- `lib/benchmarks/queries.ts`, `lib/benchmarks/industry-families.ts` (new)
- `lib/pitches/generator.ts` (the benchmark type only), `lib/pitches/claude-composer.ts` (benchmark payload, FACTS/payload rule text, prompt version), `lib/pitches/review.ts` (critic payload + rule 2 text only), `lib/pitches/decision.ts` (benchmarks_offered type + its validation if any), `lib/pitches/pitch-stage.ts` (the two `fetchBenchmarksForPitch` call sites and the `benchmarks_offered` line `:596` only)
- `tests/benchmarks.test.ts`, `tests/benchmark-matching.test.ts` (new), and any existing test that pins the old payload or prompt version (say which in the PR)

Read for context, do not edit:
- `lib/pitches/send-gate.ts` (rule 5 reads active figures; unchanged), `lib/pitches/gate.ts:105-130`, `lib/autopilot/learn.ts` (the `no_benchmark` arm), `tests/fixtures/prod-*.{txt,json}`

Forbidden: `lib/supabase/types.ts`, `vercel.json`, `CLAUDE.md`, any migration, `lib/benchmarks/actions.ts` and `components/benchmarks/*` (another worker owns them this wave), `lib/benchmarks/research.ts` (another worker).

## Must not change (negative set)
- A row with `is_active=false` or `verified_at` null, or `rejected_at` set (column added by 0050, may be absent from your fake), is never offered.
- Market rule: a row scoped to CA never reaches an MX prospect (`:132`).
- Construction, law firm, hospital, spa with `abandoned_cart_loss` get NO online-store row. "boutique hotel" gets no retail row. Industry null gets universal rows only.
- `writerArms.evidence === "no_benchmark"` still sends an empty list (`pitch-stage.ts:362`).
- Send gate figures (`fetchActiveBenchmarkFigures`, `gate.ts` `loadGateShared`) unchanged.
- `detectCitedBenchmark` behaviour unchanged.

## Acceptance checks
1. Real data: a test reads both fixtures and, for every prospect line and every one of its pains, asserts no offered row lacks that pain in `for_pains`, and prints the coverage table "first evidenced pain gets ≥1 row: before 215/259, after N/259" plus the per-industry misses after. Paste the table in the PR.
2. The prod case: boutique / CA / pains `[no_content_velocity, abandoned_cart_loss, low_customer_retention, poor_social_engagement]` → the cart rows (Baymard 70.22%, Baymard 40%, McKinsey >90%) come first for `abandoned_cart_loss`, each tagged with that pain; Bain/HBR are tagged `low_customer_retention` only.
3. Every negative-set line above is a test. Show the "boutique hotel" and construction tests FAIL if the family lookup is changed to word containment (paste the failure), then restore.
4. Writer and critic payload snapshots show `for_pains`; the FACTS and rule-2 text say what decision 4 says.
5. `npm run typecheck && npm run lint && npm test` green; count reported.

## External prerequisites
none.

## Prod verification
After deploy, first v3.1 Claude pitches with a benchmark offered:
`select id, decision->'pain'->>'id' pain, decision->'benchmarks_offered' offered, decision->'benchmark_cited' cited from pitches where decision->>'prompt_version'='pitch-v3.1-2026-10-22' and jsonb_array_length(decision->'benchmarks_offered')>0 order by created_at desc limit 20;`
Expected: every `cited` row's `pain_codes` contains the code of `pain.id`.

## Out of scope
New benchmark rows, the wanted-facts table (0050) and anything that writes to it, the /benchmarks page, the A/B arm logic, the industry values discovery writes.

## Questions already answered
Q: Should industry stop mattering when the pain matches? A: No. Pain first, then the same industry or the same family; universal rows last.
Q: Add "outdoor"? A: Not without Pedro (asked; default unmatched). Leave a one-line comment where it would go.
Q: Is the writer's lead pain known before the call? A: No, the writer picks (`claude-composer.ts:451`), so tag rows by pain and let writer and critic enforce the pairing.

## If blocked
Message the conductor with what you tried, what you need, and what you can still do meanwhile.
