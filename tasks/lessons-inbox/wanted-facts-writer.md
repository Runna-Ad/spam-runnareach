[2026-10-21] An optional LLM field must not be able to fail the parse it rides on
WHAT HAPPENED: wanted_fact was added to the writer and critic schemas (lib/pitches/claude-composer.ts, lib/pitches/review.ts). A `z.string().nullable().optional()` would have thrown the whole pitch to the template the first time the model returned a number or an object there. The field is `z.unknown()` + `.transform` to string|null, cast to `ZodType<string|null, …, string|null>` because `structuredCall`'s `z.ZodType<T>` infers T from input AND output, so an `unknown` input widens `call.data` to unknown.
RULE: A nice-to-have field added to an LLM output schema accepts any value and maps it to a typed default; it never decides whether the output parses. Test it with a fake model returning absent, null, "", a number, an object and an oversized string.
TAGS: pitches, llm-output, zod

[2026-10-21] A test-harness stub that throws on unknown names reaches into best-effort code
WHAT HAPPENED: tests/pitch-rewrite-notes-stage.test.ts stubs every import of pitch-stage.ts and throws "no stub for X" synchronously on a new import. The new best-effort recorder was called outside any try, so two existing tests failed. Wrapping the call site in an async try/catch fixed it without touching the harness, and is right anyway: "never throws to the caller" has to hold at the call site, not only inside the helper.
RULE: A best-effort side call is wrapped where it is called, not only inside its own module; a synchronous throw from its wiring must not reach the main path either.
TAGS: pitches, tests, best-effort

## Out of scope, noticed
- lib/pitches/website-pitch-stage.ts also runs Claude composes but does not go through composeWithReview's wanted-fact plumbing; its pitches record no wishes (not in this brief).
