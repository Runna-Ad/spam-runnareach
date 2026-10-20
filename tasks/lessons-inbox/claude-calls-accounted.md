[2026-10-20] A "usage on failure" return value is only half the fix: the caller must stop gating the record on success
WHAT HAPPENED: `structuredCall` already returned usage on parse/schema failures, but four call sites still dropped it: the scorer replaced it with ZERO_USAGE (`lib/research/scoring/claude-scorer.ts`), score-stage only recorded when `method === "claude"`, and the reply-draft/nudge/no-meeting paths recorded inside `if (r.ok)`. SnapVerify and both ICP calls never recorded at all because the paid call sat inside a helper with no tenant in scope.
RULE: Record cost on `usage != null`, never on `ok`. A helper that makes a paid call but has no tenant must return the call (model + usage + fallback reason) to its caller, and when there are several callers, give them one shared recorder (`recordSnapVerifyCall`) so the row shape cannot drift.
TAGS: anthropic, cost-tracking, daily-cap

[2026-10-20] One loader-hook harness can drive real server actions with the real Claude client
WHAT HAPPENED: `tests/claude-calls-accounted.test.ts` stubs every value import of each target by parsing its import lines, keeps `lib/anthropic/client.ts` real and swaps only the SDK via `__test__.setClient`. Stubs are Proxies over `globalThis.__stub(name)`, so constants with methods (`NextResponse.json`) and functions both work, and a missing stub throws by name.
RULE: To test that a call site records cost, keep structuredCall real (so schema failures and pricing are real) and stub the recorder; assert the row count per path, including the zero-row paths (no key, over the cap, API error).
TAGS: tests, anthropic

[2026-10-20] structuredCall could state the keys itself
WHAT HAPPENED: Zod 3.24 has no JSON-schema export, so every prompt names its own keys by hand (snap-contact, ICP refine fixed here; the pitch composer's `pain_id:Required` failures are the same class).
RULE: Worth a conductor decision: a small `describeShape(schema)` in `lib/anthropic/` that walks a ZodObject (keys, required/nullable, `.max` limits) and appends it to the trailing uncached JSON instruction would make "a key the prompt never names" impossible for every caller. Not done here (`structuredCall` is out of scope).
TAGS: anthropic, prompts

[2026-10-20] A paid call in a "use server" export with no auth is open to anyone, not just a cap gap
WHAT HAPPENED: I filed `suggestIcpFieldsAction` (direct `messages.create`, no `requireUser`) as a cap gap to route later. Review pointed out that a server action is reachable by a POST to any path, so it was an unauthenticated paid Haiku call; the AI Search source (`lib/discover/sources/claude-search.ts`) also never recorded its multi-turn Sonnet loop. Both fixed in the review push.
RULE: When auditing cost recording, grep for `messages.create` as well as `structuredCall`, and for each `"use server"` export that spends money, check auth before cost. An unauthenticated paid call is a security finding: fix it in the same PR, don't file it.
TAGS: anthropic, security, server-actions

## Out of scope, noticed
- `lib/replies/draft-composer.ts`: the failure results of `composeReplyDraftWithClaude` / `composeNudgeWithClaude` carry no `model`, so callers hard-code `ANTHROPIC_DEFAULT_MODEL` to record a failure. Returning `model` on failure too would remove that coupling.
