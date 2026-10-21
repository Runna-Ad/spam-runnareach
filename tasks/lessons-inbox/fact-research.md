[2026-10-21] Web search responses: the only checkable source text is what the model cites
WHAT HAPPENED: lib/benchmarks/research.ts proposes benchmarks from Claude's web_search tool. Result content arrives encrypted, so the sourcing invariant (checkCandidate) can only check the URL against web_search_result urls and the figure against citations[].cited_text from that same URL. The prompt asks the model to state each figure in a cited sentence first, then the JSON; without that step there is no text to verify and every proposal fails closed.
RULE: When a model's claim must be verified against a source you cannot read, make the model produce the evidence in a channel the API fills itself (citations), and check against that channel only, never against the model's own JSON. Match digits by an independent character scan with whole-group boundaries ("70.22" must not match "170.225").
TAGS: benchmarks, anthropic, web-search, fail-closed

[2026-10-21] Stamp a time "after the call" by reading the clock after the call
WHAT HAPPENED: The first draft passed `now: Date` into researchFact before the Claude call, so proposed_at was the run start, 50 s before the answer existed. The exact-payload test with a fake clock caught it.
RULE: Pass a clock function, not a Date, into anything that awaits a slow call and then stamps rows. Exact-payload tests with an advancing fake clock catch this class.
TAGS: testing, time

## Out of scope, noticed
- A client-side timeout (50 s) on the research call leaves no `usage`, so the call is not recorded in cost_tracking although the API may still bill it. Same gap exists for every structuredCall timeout (lib/anthropic/client.ts). Streaming would expose usage; conductor-only file.
- lib/anthropic/client.ts PRICING has no web-search line; research.ts adds $0.01/request itself. If another caller ever uses server tools it must do the same.
