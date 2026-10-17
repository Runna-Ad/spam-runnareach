[2026-10-17] A placeholder or label inside a prompt must not trip the check it is meant to satisfy
WHAT HAPPENED: The exemplar section numbered its examples ("Example 1"), so the "no digit reaches the prompt" test failed on our own label, not on prospect data (lib/pitches/exemplars.ts). In the other direction, the brief's digit placeholder `[n]` is 1 character, and the send gate's placeholder check (lib/pitches/send-gate.ts:377, 3–40 chars, same pattern as `LEFTOVER_PLACEHOLDER_RE` in claude-composer.ts) does not see it: a writer that copies `[n]` out of an exemplar would pass the gate as a draft with a visible blank (the critic is the only net). `[name]`, `[company]`, `[site]` are caught.
RULE: When text is injected into a prompt with placeholders, check both directions: the scaffolding (labels, numbering) carries none of what the scrubber removes, and every placeholder is something the downstream gate recognizes as unfinished if it is copied.
TAGS: pitches, prompts, gate

[2026-10-17] Segment filters cannot run in SQL while industry is free text
WHAT HAPPENED: prospects.industry and decision.segment.industry are free text; segment industry is a regex normalization (lib/learning/segments.ts normalizeIndustry). A "candidates for the segment, limit 20" query cannot be written, so fetchExemplars scans the 200 newest settled sends in the language, filters to the segment in memory, and reads events for at most 20.
RULE: Any learner that needs "pitches in segment X" will hit this. A stored, normalized segment key (e.g. decision.segment_key or a generated column) would make it one indexed query; until then, scan-recent-then-filter with an explicit cap.
TAGS: learning, segments, queries

[2026-10-17] A scrubber is a list of rules; guard it with an invariant that fails closed
WHAT HAPPENED: The first exemplar scrubber replaced a past prospect's full name, company and city with a hand-built case/accent regex. Review found 9 leaks: "Wagner" from "Wagner Legal Group Inc.", lower-case "toronto", "Smith-Jones", "St. Bernard's", "Lic. Núñez", "O’Brien", "Hi Miguel" without a comma, "Dr. Patel", and vowel-only accent classes that missed "CALGARY". The fix matches on one accent-folded, lower-cased shadow of the text mapped back to the original. Then exemplarLeaks re-checks every distinctive word (4+ letters, not generic) of the company, contact, city and domain, and toExemplar DROPS the exemplar if any survives (lib/pitches/exemplars.ts).
RULE: When text from one customer may reach another, don't rely on the replacement rules alone. Add a separate check over the output for the identifying tokens, and drop on any hit. Test it with the reviewer's probes plus a generated property test (30 name × company × city combos), and run those tests against the old code to show they bite (7 of 7 failed there).
TAGS: pitches, privacy, scrubbing, testing

## Out of scope, noticed
- (Fixed by the conductor in 3dfeec4, merged into this branch: the send gate now blocks one-character placeholders like `[n]`.) `LEFTOVER_PLACEHOLDER_RE` in claude-composer.ts (the composer's violation counter) still needs 3+ chars; cosmetic only.
- (Resolved in this PR: the scrubber also replaces the past prospect's city with `[city]`, which the gate's placeholder check does catch.)
