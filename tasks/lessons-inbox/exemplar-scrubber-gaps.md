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

[2026-10-18] An allow-list's tokenizer is part of the allow-list: define a token by what it IS, not by what splits it
WHAT HAPPENED: Round 3's allow-list loop in lib/pitches/exemplars.ts split on `[^a-z]+`, so every non-Latin letter was a separator: 金龍, Иванов, محمد vanished, "Pаtel" (Cyrillic а) became "p" + "tel", a zero-width space or soft hyphen split "Patel" into allowed pieces, "Weiß" became "wei". 25 of 40 adversarial strings survived. Round 4 strips \p{Cf}, NFKD-folds, takes maximal \p{L} runs and rejects any token with a letter outside a-z after folding.
RULE: In an allow-list check, tokens are maximal runs of the widest class (\p{L}), and anything the allow-list cannot represent is a leak by itself. Strip invisible format characters (\p{Cf}) before tokenizing, in the scrubber too.
TAGS: pitches, exemplars, allow-list, unicode

[2026-10-18] Fail-closed vs. usable: split the allow-list into tiers by where the token sits
WHAT HAPPENED: One flat allow-list either let names through (if names that are words were allowed) or dropped 30% of clean pitches ("vale la pena", publishers, "platicar"). Two tiers fixed both: strict (no word-names) for the subject, mid-sentence capitals and handle/URL chunks; generous (word-names allowed) for lower case and sentence openers. Drop rate 30.4% → 0.8% on 240 generated house pitches, adversarial set 25 kept → 0. Extending to the 50k frequency lists was measured and rejected: it adds surnames like velasco, nguyen, tremblay, banerjee for no needed gain.
RULE: When a word list must both block names and pass prose, decide by position and case (where a name would stand), not by one bigger list; measure each list extension for the names it brings in, not only the drops it removes.
TAGS: pitches, exemplars, allow-list, drop-rate

[2026-10-18] A drop-rate generator built from your own vocabulary measures your vocabulary, not the drop rate
WHAT HAPPENED: Round 4 of exemplar-scrubber-gaps reported 0.8% dropped on 240 generated pitches; the conductor's run on 30 real prod pitches dropped 24 (80%), mostly on ordinary words (availability, fabrication, agendaron) outside the 20k lists. The generator's text came from the same templates and prompt examples whose words had just been added to OWN_VOCABULARY.
RULE: Measure a fail-closed filter's drop rate on held-out real data (or text from a source the lists were not grown from) before reporting it; a generator is a regression guard, not a measurement. Do the same for the leak side: a held-out names test from a source the names net was not built from (round 5: 142/228 caught → 226/228).
TAGS: pitches, exemplars, allow-list, measurement

[2026-10-18] Names data is full of words: classify each name by a dictionary, and decide by position and strength
WHAT HAPPENED: SSA and Census name lists contain Price, Will, Canada, La, More, Re, Legend, Brand. Using them raw as a deny list broke subjects ("Re:") and prose. What held: a name is "also a word" when a Hunspell dictionary has it in lower case (directly or by inflection); such a name is refused only capitalized mid-sentence, and only when it is strong (a given name or a top-10,000 surname) and not among the 300 most frequent words; long-tail given names that are frequent words count only capitalized.
RULE: When a deny list comes from real-world data, split it by a second independent source (a dictionary) and by position before using it; never deny a common word everywhere because someone is named after it.
TAGS: pitches, exemplars, names, allow-list

[2026-10-19] An allow-list over our vocabulary must refuse names first, then allow; "ours" is not a free pass
WHAT HAPPENED: Round 5 of exemplar-scrubber-gaps checked OWN_VOCABULARY and CAPITALIZED_WORDS before the name deny, so "mencionan a Julio", "Abril contesta", "Quintana y Asociados" and title-case "Seo"/"Ota" passed because those strings were on our lists (months, states, acronyms). Round 6 refuses the name first; only the senders, months that are no name, and whole phrases ("Quintana Roo") beat it, and acronyms pass only in all capitals or all lower case.
RULE: In an allow-list with a deny list on top, order matters: deny first, then allow, with a short, reviewed list of exceptions that are allowed to beat the deny. Store multi-word places and publishers as phrases, never as their words.
TAGS: pitches, exemplars, allow-list, review

[2026-10-19] Stem-only dictionary checks call real words names; use an affix-aware checker at build time
WHAT HAPPENED: The round-5 generator read Hunspell .dic stems, so forth, math, fallen (missing or irregular) and haga, vea, vida, debo, cierra (inflected Spanish) were classed as name-only and refused even in lower case. nspell (dev-time only) over en_US/en_GB/en_CA/es_MX/es_ES fixed it, and the generator now prints every top-20k word that ends name-only so a gap shows at build time.
RULE: When a build step classifies words with a dictionary, check inflected forms with the dictionary's own affix rules, and print the frequent words the step ends up refusing.
TAGS: pitches, exemplars, generator, dictionaries

[2026-10-19] Official place names hide the everyday one; a place net needs the short forms
WHAT HAPPENED: GeoNames lists "Santiago de Querétaro", "Heroica Nogales", "Victoria de Durango", so a place deny built from cities15000 as-is missed "en Querétaro" (round 6b of exemplar-scrubber-gaps). Stripping official prefixes (Santiago de, Victoria de, Heroica, Ciudad de) added the names people write; regions that are municipalities (Los Cabos) and CDMX colonias needed a hand list. State names that are also cities (Puebla, Querétaro, Oaxaca, Quebec) had to leave the "always allowed" list, found by intersecting it with the place list in the generator, not by eye.
RULE: When a deny list comes from a gazetteer, add the everyday short forms and intersect every allow list with it at build time; anything on both is a decision, not a default.
TAGS: pitches, exemplars, places, generator

[2026-10-19] When two lists feed one positional rule, compute the position over the list the rule is about
WHAT HAPPENED: Round 6b of exemplar-scrubber-gaps appended the e-mail local part to the contact's name pieces, and the "last piece is always checked" rule (for particle surnames: "Minh Le") read `i === name.length - 1`, so with minhle@ the local part became "last" and "Le and her team answer every call" was kept. Round 6c computes the index over the contact name only.
RULE: When you extend an array that a positional rule (first, last, index) reads, check what the position now means; keep the rule's index on the original list.
TAGS: pitches, exemplars, regression, review
