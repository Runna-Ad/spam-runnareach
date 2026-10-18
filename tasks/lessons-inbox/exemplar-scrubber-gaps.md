[2026-10-18] A leak check is only as wide as its token filter: test the net on raw input, not only on scrubbed output
WHAT HAPPENED: `exemplarLeaks` (lib/pitches/exemplars.ts) shared the scrubber's `distinctive()` filter (4+ letters, not generic), so 3-letter company/domain words, 2-letter surnames, city short forms (CDMX, YYZ) and a stranger's name after "dr." were invisible to both. The batch-1 property test only checked scrubbed output, and the scrubber happened to blank known short surnames, so the net's surname blind spot never showed. A second property ("every raw field in a one-line text is seen by the leak check") caught all four classes on the old code (720 unseen surname inserts, 1305 short-token, 1010 alias, 2967 honorific).
RULE: For a fail-closed invariant, write two properties: (1) a kept output never contains a forbidden token, and (2) the invariant flags every forbidden token when it is fed unscrubbed. (2) proves the net is complete on its own; (1) alone only proves the scrubber and net together were good enough on the generated templates.
TAGS: pitches, exemplars, scrubber, property-test

[2026-10-18] Field-word replacement must never match inside a placeholder
WHAT HAPPENED: A contact surnamed "Hunter" (or a company word "url") was replaced inside `{hunter_url}`, producing `{[name]_url}`, because `_` is not a word character in the whole-word pattern. `replacePhrase` now skips matches overlapping `[name] [company] [site] [city] [n] {hunter_url}`.
RULE: Any scrubber that runs several replacement passes must protect the tokens earlier passes inserted.
TAGS: pitches, exemplars, scrubber

## Out of scope, noticed
- lib/pitches/exemplars.ts: a company ending in "Inc."/"Ltd." leaves the trailing dot after `[company]` ("[company]. answers"); cosmetic, pre-existing.
- One placeholder regex for send-gate, composer and exemplars is still separate (brief's out-of-scope item; `PLACEHOLDER_RE` in exemplars.ts is a third copy).

[2026-10-18] A fail-closed net that reuses the scrubber's matchers is not a second check
WHAT HAPPENED: Round 1 of exemplar-scrubber-gaps widened `exemplarLeaks` (lib/pitches/exemplars.ts) but kept it on the scrubber's own `replacePhrase`, honorific regex and exact city key, and the property test's `has()` used the same whole-word matcher. So every form the scrubber's matchers could not see ("sra. [name] ruiz", "Qro.", "the Wagners", "Thanks, Le.") the net and the test could not see either. Review round 2 rewrote the leak check with its own fold, tokenizer (dots inside initials removed), letters-only chunk substrings and honorific/greeting span rules, and the property test got a third, independent matcher.
RULE: The invariant behind a scrubber, and the property test behind both, must each use matching code the scrubber does not share: different tokenizer, coarser rules (substring over whole-word, spans over single tokens). Sharing word lists is fine; sharing matchers means one blind spot, three times.
TAGS: pitches, exemplars, scrubber, property-test, review

[2026-10-18] Deny-lists for "what must not appear" never converge; switch the invariant to an allow-list
WHAT HAPPENED: Two review rounds on lib/pitches/exemplars.ts each found new spellings of the same leak (honorific forms, demonyms, hashtags, handles, plurals). Round 3 made the invariant an allow-list: every word of a kept exemplar must be one of the 20k most frequent EN/ES words (lib/pitches/wordlists/, from hermitdave/FrequencyWords, CC BY-SA 4.0), our own short vocabulary, or a blank, minus a list of common names. The deny-list rules remain as the scrubber and a second net. Subtitle-derived frequency lists contain thousands of names (garcia, patel, smith), so a "common names" subtraction list is needed, and words that are both names and words (Park, Lee, Flores, Cruz, Young) stay with the field check.
RULE: When a filter guards against "anything of X leaking", prefer an allow-list invariant (only known-safe tokens) over enumerating X's spellings; measure its drop rate on real templates (not just generated ones) and grow the allow-list from what those drops show.
TAGS: pitches, exemplars, scrubber, allow-list, review
