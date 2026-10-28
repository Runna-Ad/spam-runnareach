[2026-10-28] A wordlist's subset names describe how it was built, not what the brief needs
WHAT HAPPENED: The brief asked for "given names only, everyday-word names only with a separator". `lib/pitches/wordlists/names.ts` mixes given names and surnames in NAME_LIST, and NAME_WORDS (6,834) is "correct in a Hunspell dictionary", which includes proper nouns: juan, maria, luis, pedro, jorge, laura, diego all count as "everyday words". The literal rule therefore sends juan@, maria@ and pedro@ to the team greeting. Mexican short forms (memo, chema, toño) are in no SSA list at all, and the exemplar scrubber's tests depended on them.
RULE: Before a brief builds a rule on a wordlist subset, the conductor (or the worker, first thing) probes it with 10 real inputs from the target market, on both sides of the line, and puts the results in the brief. A subset's header says how it was made; only probing says whether it means what the rule needs.
TAGS: pitches, greeting, wordlists, briefs

## Out of scope, noticed
- `lib/pitches/wordlists/names.ts` has no given-name-only export. Regenerating it with a GIVEN_NAMES export (scripts/gen-exemplar-wordlists.mjs already reads baby-names.csv separately) would let greetingName refuse surname-only locals (lopez@, which greets "Lopez" today, as before this change) and drop the dictionary-proper-noun noise from NAME_WORDS.
- `GATE_VERSION` in send-gate.ts says "bump on any rule change" but has stayed 2 through several greeting changes; not bumped here either.
