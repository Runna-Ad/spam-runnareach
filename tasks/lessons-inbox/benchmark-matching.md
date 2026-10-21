[2026-10-21] A lookup keyed on "any of the prospect's pains" lets a figure about one pain ride along under another
WHAT HAPPENED: `fetchBenchmarksForPitch` (lib/benchmarks/queries.ts) kept rows whose pain_codes overlapped ANY evidenced pain, and the payload did not say which pain a row was for. The writer picks its lead pain itself, so a boutique leading with "no cart recovery" got retention and video figures and presented them as about carts. Fixed by tagging each row with `for_pains` and making writer (FACTS 2) and critic (rule 2) enforce the pairing.
RULE: When a model picks one item (a pain, an angle) from a list and is given supporting evidence for the whole list, every piece of evidence has to name the item it supports, and both the writer and its checker get that tag. An untagged evidence list hands the model the pairing decision without the information it needs to make it.
TAGS: benchmarks, pitches, prompt, matching

[2026-10-21] A brief's worked example can disagree with its own ranking rule
WHAT HAPPENED: acceptance check 2 expected Bain and HBR (universal) for low_customer_retention, but decision 3 ranks a same-family vendor row (Omnisend) above universal rows, so the 3-per-pain cap drops HBR. I followed the rule, pinned the real order in the test, and flagged it in the PR.
RULE: Run the brief's ranking rule over the brief's own example before writing the assertion. When they disagree, implement the rule, pin what it actually produces, and name the gap in the report.
TAGS: process, briefs, tests

## Out of scope, noticed
- lib/pitches/pitch-stage.ts ~:798 (rewrite with angle): passes `rewriteBenchmarks` straight to the writer with no `writerArms` check, while claude-composer's forced-angle directive says "no client, no number". So a forced-angle rewrite gets benchmarks its prompt tells it not to use. One of the two is wrong; not changed here.
- tests/vercel-config.test.ts:18 fails on a clean integration branch (71bd7f4): vercel.json names app/api/benchmarks/research/route.ts, which the research worker creates this wave.
