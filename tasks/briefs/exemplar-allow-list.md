# Brief: exemplar-allow-list (round 4 of PR #17, exemplar-scrubber-gaps)

| | |
|---|---|
| Module | `lib/pitches/` (hub): `exemplars.ts` + `wordlists/` only |
| Model / effort | opus-5.5 / high (hub; a miss sends one prospect's details to another) |
| Branch | EXISTING `claude/exemplar-scrubber-gaps` (PR #17, now based on `claude/optimistic-tesla-3gceud`) |
| PR target | `claude/optimistic-tesla-3gceud` (PR #17; keep pushing to it, do not open a new PR) |
| Reserved migration | none |
| Depends on | none. Parallel track: other batch-3 workers are in `send-action.ts` / `pitch-stage.ts` and later `queries.ts`; none touch your files |
| Conductor session | `session_017nqBxLFFXKbhDwKiPi6xLf` (send_message ONLY if blocked; the PR body is the report) |
| Size | M |

## Goal
Past winning emails are shown to the writer as examples after `scrubExemplar` blanks the
old prospect's details, and `exemplarLeaks` drops any exemplar that still carries one
(fail closed). Round 3 made the leak check an allow-list invariant (every word a common
EN/ES word, our vocabulary, or a blank). Review found two problems, and they pull in
opposite directions: the allow-list has holes (some tokens are never checked), and it
drops 53.5% of clean house-style pitches, so the feature would effectively be off. Good =
zero leaks on the adversarial set AND a drop rate on clean pitches low enough that most
winning emails can be shown. Ships behind `EXEMPLARS_ENABLED` (off in prod today; 0
exemplars ever shown); Pedro turns it on after this merges.

## First: bring the branch up to date (conductor verified this recipe: 749 tests green)
```
git fetch origin claude/optimistic-tesla-3gceud claude/exemplar-scrubber-gaps
git checkout -B claude/exemplar-scrubber-gaps origin/claude/exemplar-scrubber-gaps
git merge --no-edit origin/claude/optimistic-tesla-3gceud
# conflicts are all outside your files: take the integration side
git diff --name-only --diff-filter=U | xargs git checkout --theirs -- && git add -A
git rm tasks/lessons-inbox/{lead-alerts,learning-meeting-outcomes,platform-reports,prospect-status-guard,veto-hold-link}.md
git commit --no-edit
git diff --stat origin/claude/optimistic-tesla-3gceud   # only exemplar files + your inbox file
```

## Context the worker needs
Read `lib/pitches/exemplars.ts` (the leak check is ~700–925), `wordlists/vocab.ts`,
both test files, and your own `tasks/lessons-inbox/exemplar-scrubber-gaps.md` (rounds 1–3).

Round-3 review findings (both blocking):
1. **Tokens the allow-list never sees.** The final loop does
   `leakFold(text).split(/[^a-z]+/)`, so every letter outside a–z is a separator: 金龍,
   Иванов, Παπαδόπουλος, محمد vanish; a Cyrillic look-alike splits a name into harmless
   pieces ("Pаtel" with U+0430 → "p", "tel"); "Weiß" → "wei"; a zero-width space or soft
   hyphen inside a name ("Pa​tel", "Pa­tel") splits it.
2. **Drop rate 53.5%** on 200 house-style pitches. Causes seen: words that are also names
   are removed from the list (`NAMES`), so "vale la pena", "rosa", "mark", "grant" drop;
   benchmark publishers our pitches cite (from `supabase/migrations/0037_seed_benchmarks_sourced_outcomes.sql`)
   and trade words missing from `OWN_VOCABULARY`.

Design to build (the reviewer's; state it as the invariant in the header comment):
- I1 Tokens: remove `\p{Cf}` (format chars: zero-width, soft hyphen, bidi marks) first,
  fold, then a token is a maximal run of `\p{L}`. Digits and punctuation separate tokens.
  A token with any letter outside a–z after folding is never allow-listed (it leaks).
- I2 Strict tier = frequency lists minus `NAMES`, plus `OWN_VOCABULARY`. It applies to:
  every token of the subject; every token that starts with a capital and does not open a
  sentence; every token in a whitespace chunk containing `@`, `#`, `://`, `www` or a dot
  between letters (handles, emails, URLs, domains).
- I3 Generous tier = strict ∪ the frequency-list words that are also names ∪ trade words
  ∪ every publisher/source name in 0037. You may extend both EN and ES to the 50k list of
  the same source (hermitdave/FrequencyWords, CC BY-SA 4.0, same header attribution, same
  folding; regenerate, never hand-edit). It applies to every other token.
- I4 The field checks, honorific and greeting span rules from round 3 stay as they are
  (they catch the CURRENT prospect's name even when it is a common word). Only the
  allow-list loop and the word sets change. The leak check still shares no matching code
  with the scrubber; the property test keeps its own third matcher.
- The scrubber should also strip `\p{Cf}` before matching, so "Pa​tel" as the
  contact is scrubbed rather than dropped.

## Files
Allowed to edit:
- `lib/pitches/exemplars.ts`
- `lib/pitches/wordlists/{en,es,vocab}.ts` (and a new generator script under `scripts/` if you regenerate)
- `tests/pitch-exemplars.test.ts`, `tests/pitch-exemplars-property.test.ts`, new `tests/pitch-exemplars-allowlist.test.ts`
- `tasks/lessons-inbox/exemplar-scrubber-gaps.md` (append)

Read for context, do not edit: `lib/pitches/exemplar-queries.ts`, `lib/pitches/claude-composer.ts`,
`lib/pitches/industry-templates.ts`, `lib/pitches/followup-templates.ts`, `0037_*.sql`.

Forbidden: every other file in `lib/pitches/`, `lib/supabase/types.ts`, `vercel.json`, migrations.

## Must not change (negative set)
- Every existing test in both exemplar test files passes unchanged (round 1–3 leak classes).
- Placeholders stay exactly `[name] [company] [site] [city] [n]` and `{hunter_url}`.
- `toExemplar`'s shape, `selectExemplars`, the prompt sections, the kill switch
  (`EXEMPLARS_ENABLED` in exemplar-queries.ts), `EXEMPLAR_PROMPT_VERSION` (v3 never shipped).

## Acceptance checks
1. Adversarial test: with the contact, company and city set to something else, a body or
   subject containing each of 金龍, Иванов, Παπαδόπουλος, محمد, "Pаtel" (Cyrillic а),
   "Gоmez" (Cyrillic о), Weiß, Straße, "Pa​tel", "Pa­tel", "Ｐａｔｅｌ",
   "@drpatelclinic", "patelclinic.com/contact", "Rosa" mid-sentence → `toExemplar` is
   null. Shown failing on the round-3 code (paste the count).
2. With the contact named "Pa​tel" / "Ｐａｔｅｌ", the scrubbed text has `[name]`, no leak.
3. Drop rate: a seeded generator of ≥ 200 clean house-style pitches built from the repo's
   own templates (industry + follow-up templates, EN and ES) with generated prospect
   fields and benchmark sentences from 0037 → report the share `toExemplar` drops; target
   ≤ 10%. List the 10 most frequent dropping tokens in the PR body. "vale la pena" and a
   lowercase "rosa"/"mark" in the body survive (explicit test).
4. The property tests from round 3 still hold (≥ 200 cases each) and use their own matcher.
5. `npm run typecheck && npm run lint && npm test` green; report the test count.
The conductor re-measures the drop rate and leaks on real prod pitch bodies (not
committed) before merging; same targets.

## External prerequisites
Pedro sets `EXEMPLARS_ENABLED=1` in Vercel after the ship (conductor asks him).

## Prod verification
After `EXEMPLARS_ENABLED=1`: `select decision->>'exemplar_prompt_version' v, count(*) from
pitches where created_at > '<flip time>' group by 1` (null = no exemplar qualified; normal
until outcomes settle); 0 exemplar rows whose exemplar text contains another prospect's
company (conductor spot-checks the first 5).

## Out of scope
One shared placeholder regex for send-gate/composer/exemplars; the "[company]." trailing
dot; how exemplars are chosen or how many. Lessons inbox.

## Questions already answered
Q: CC BY-SA word lists in the repo?  A: Acceptable (server-side, not distributed;
attribution in the file headers). Conductor, batch 2.
Q: Capitalized sentence openers: strict or generous?  A: Generous (I3). The field checks
and span rules still cover the current prospect; mid-sentence capitals are strict.
