[2026-10-20] A zod field made optional must stay the same type in and out when the schema goes through structuredCall
WHAT HAPPENED: `structuredCall` takes `schema: z.ZodType<T>`, i.e. input type = output type. Adding `.optional().transform(v => v ?? null)` to `pain_id` in lib/pitches/claude-composer.ts made T infer as the union of input and output (`string | null | undefined`) and broke three call sites. `.optional()` plus `?? null` where the field is read keeps the types honest with no cast.
RULE: Through a helper typed `z.ZodType<T>`, a transform that changes the type does not narrow `call.data`. Keep the schema's input and output the same type and normalize at the read site, or give the helper `ZodType<O, Def, I>`.
TAGS: anthropic, zod, pitches

[2026-10-20] The loader-stub harness proxies constants too; a stubbed string is never === a string
WHAT HAPPENED: tests/pipeline-guards.test.ts stubs every value import with a callable Proxy. In tests/pitch-rewrite-notes-stage.test.ts the stage compares a critic issue against `NOT_REVIEWED_ISSUE`, and the comparison against the Proxy never matched, so the fallback test failed for the wrong reason. Fixed by having the stub module export real values for a short CONSTS list.
RULE: When a module under the stub harness compares against or iterates an imported constant (string, Set), export the real value from the stub (a CONSTS list) instead of a Proxy, and check the test fails for the reason you meant.
TAGS: tests, harness

## Out of scope, noticed
- lib/pitches/decision.ts (read-only for this task): `DecisionRecord` has no field saying a rewrite revised the held draft or was written fresh (template or unreadable). Prod verification can only tell rewrites apart by `retry_of`. A `retry_mode: "revised" | "fresh"` field would let the conductor split the after-deploy numbers.
- tests/pitch-exemplars-allowlist.test.ts:110-123 still builds its house-voice pitches from the v2 prompt lines ("yours wait until morning", "the leak, stated as fact" subject). That is fine for the leak check (old pitches exist in the DB), but its comment says it mirrors the composer's prompt, which is no longer true.
- Exemplars (lib/pitches/exemplars.ts) can still hand the writer past pitches that state guesses as fact, which works against the v3 prompt. Re-scrubbing them was out of scope.
