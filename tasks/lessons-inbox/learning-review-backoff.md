[2026-10-20] A structuredCall prompt must state the JSON field names; "matching the requested schema" sends no schema
WHAT HAPPENED: `REVIEW_SYSTEM` in `lib/autopilot/learn.ts` described observations and guidance in prose but never named the keys (`title`/`evidence`, `text`/`why`). `structuredCall` (`lib/anthropic/client.ts`) only appends "Respond ONLY with valid JSON matching the requested schema"; the zod schema itself never reaches the model. The weekly review then failed every tick with output far under max_tokens (59 paid calls in 72 h). The prompt now states the exact shape and limits, and the schema accepts the common alias keys.
RULE: Every prompt passed to structuredCall spells out the exact JSON shape (key names, list sizes, string limits) in its own text, taken from the same constants the zod schema uses. A test asserts the prompt contains the shape. Never rely on "the requested schema": the model never sees it.
TAGS: anthropic, prompts, zod, learning

[2026-10-20] A paid retry loop needs a mark written before the call, read by its own guard
WHAT HAPPENED: `weeklyReview` guarded on "a `review` insight in 7 days", but only a success wrote one, so a failed call left no trace and the 15-minute tick paid again (about 18% of the $3/day cap). Fix: a `review.attempt` row is inserted BEFORE the call (no row, no call), updated with the reason after, and a 24 h guard reads it. A run killed mid-call still counts.
RULE: For any paid or non-resumable call on a schedule, write the attempt mark before the call and fail closed if the mark cannot be written or read; record the outcome on the same row. A guard that only counts successes is an unbounded retry loop.
TAGS: autopilot, cost, retries

## Out of scope, noticed
- `lib/anthropic/client.ts` `structuredCall`: the JSON parse error embeds `Raw: <first 200 chars of model output>`, which for prompts built from replies can carry prospect text into any caller that logs or stores `call.error`. I did not check whether other callers store it; worth a scrub at the source (conductor-only file). Twelve files call structuredCall.
- Other structuredCall prompts may share the missing-shape problem; a grep for callers whose system text never names their schema keys would find them.
