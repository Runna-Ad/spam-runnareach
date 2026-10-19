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

## Round 5 (conductor, 2026-10-18 after the round-4 review + a real-data re-measure)
Two measurements disagree with round 4's numbers, and both point at the tiers, not at
missing cases. Fix the STRUCTURE; do not tune to either sample.
1. **Real drop rate.** The conductor ran `toExemplar` (6adf251) on 30 real prod pitches
   (the 19 AUTO pitches due Monday + the 11 latest drafts): **24/30 dropped (80%)**.
   Your generator measured 0.8% because it was built from the same vocabulary.
   - Dropping on ordinary words (must pass after round 5): corresponda, asesoria,
     trabas, traba, availability, spec, monitoreo, compiten, agendaron, armariamos,
     asesorando, calificarlas, califica, resolviste, confiaron, desktop, usable, multi,
     storefront, outage, enthusiasts, rigging, fabrication, skus, mro, jobsite, handrail,
     woodworking, bandsaw, tutorials, oftalmologia. Most are in the 50k lists; the rest
     are Spanish verb forms (-aron, -aríamos, -ando + enclitics) and trade words.
   - Dropping on real leaks (must STILL drop): a business name not in the company
     field ("Zona Benessere" → benessere), third-party brands and places (MEC,
     Fjällräven, Bulkley Valley), a company acronym (IRT), a city written mid-sentence
     when the city field is null (Monterrey).
2. **Name leaks the strict tier lets through** (round-4 review, blocking):
   - B1 Dots after an initial or a short title, and colons, end a "sentence", so the
     name after them is judged generous: "M. Peña" (regression vs round 3), "C.D.
     Torres", "J. Torres", "A.J. Cruz", "M.V.Z. Flores", "Front desk: Grant".
   - B2 WORD_NAMES entries that are not frequency-list words reach the generous tier:
     guadalupe, amparo, jazmin, ernest → COMMON_NAMES (or filter WORD_NAMES by the lists).
   - B3 The strict tier is not a name net: 58/98 common Mexican and 67/99 Canadian
     given names and many surnames (Graham, Kennedy, Sinclair, Chan, Huang, Sharma,
     Méndez, Bautista, Escobar…) pass capitalized mid-sentence; O’Brien / O’Connor pass
     everywhere (lists split on apostrophes). And when `recipient_name` is null, the
     composer greets from the email local part (`firstNameGuess`, claude-composer.ts
     ~475–501) but `recipient_email` is never used by the scrubber or the leak check, so
     "Si quieres, Monica, lo vemos" survives.

Structure to build:
- S1 Positions. Sentence opener = first letter-token after the start, a newline, or
  `. ! ? ¿ ¡ …` that is not an abbreviation dot (one letter, a capitalized run ≤ 4
  letters, or an honorific). A colon never opens a sentence. All-caps tokens of ≥ 2
  letters are strict everywhere. (The reviewer's prototype of the dot rule + apostrophe
  join is in the conductor's message; take it.)
- S2 Tiers. Lowercase non-subject tokens: GENEROUS = 50k EN + 50k ES (folded, same
  source and licence, generator script) ∪ strict ∪ WORD_NAMES that are list words.
  Capitalized tokens anywhere, subject tokens, address chunks: STRICT = 20k lists −
  NAMES + OWN_VOCABULARY, where NAMES = COMMON_NAMES ∪ a GENERATED public-domain names
  list (US SSA given names and US Census 2010 surnames are public domain; add the
  Mexican/Canadian names you can source the same way) built by the generator script.
  Sentence openers may use strict ∪ WORD_NAMES-that-are-list-words (keeps "Mark the
  date", "Rosa mexicano") — state the residual ("Grant Hill…" at a sentence start) in
  the header. Spanish morphology: add -aron/-ieron, conditional -aríamos/-eríamos/
  -iríamos, gerund + enclitic stacks (calificarlas, asesorándote).
- S3 Join a letter + apostrophe + capital into one token (O’Brien → obrien).
- S4 recipient_email: when recipient_name is null and the local part reads as a given
  name, treat it as a name field in BOTH the scrubber and the leak check, each with its
  own matcher (independence rule).
- S5 Letters with no NFKD form inside letter-like symbols (enclosed alphanumerics
  U+2460–24FF and U+1F100–1F1FF, regional indicators) and visible in-word separators
  (· ŀ ‧ ᠆ U+2800) make the token leak.

Acceptance (round 5):
1. The reviewer's probes all drop or scrub clean (they are in the conductor's message).
2. A held-out names test: 200+ given names and surnames (EN, ES, Chinese/South Asian
   Canadian) from a source NOT used to build NAMES, each inserted capitalized
   mid-sentence into a clean pitch → dropped or scrubbed, ≥ 98%. Report the misses.
3. Your own drop-rate generator stays reported, but the number that decides is the
   conductor's re-run on the 30 real pitches: target ≤ 30%, every remaining drop a
   real leak of the kinds listed under (1).
4. Existing exemplar tests unchanged and green; typecheck, lint, test green.
If the targets conflict (a name net that drops most real pitches), stop and report the
numbers: the conductor decides, and #17 stays out of this ship either way.

## Round 6 (conductor, 2026-10-19, after the round-5 review) — LAST round on this design
Round 5 measured: 20/30 real pitches kept (r4: 6/30), no identifying token in the kept 20,
held-out names 226/228. The review (fix-then-merge) found these, each traced through
`toExemplar`; fix them as stated (the reviewer's fixes are the spec):
1. **Address chunks regressed** (exemplars.ts ~1090): handles/domains with name-like words
   pass ("@torres o @vega", "instagram.com/peña.dental", "vega-dental.com", "@chan.dental",
   "luna.dental"). Every name is denied in an address chunk (S2 said strict = 20k − ALL
   names). Better: the scrubber blanks every bare domain and handle as [site], and the leak
   check flags any address chunk left. Treat "_" as an address-chunk marker.
2. **OWN / CAPITALIZED_WORDS beat the name deny** (~274, ~318): "mencionan a Julio",
   "Abril contesta", "Abril y Domingo", "Quintana y Asociados", Title-case "Seo"/"Ota".
   Apply the deny after OWN for names (except the senders henry, nils); drop Spanish month /
   day words that are names (julio, abril, domingo, agosto, mayo) from CAPITALIZED_WORDS;
   "Quintana Roo" as a phrase, not "quintana"; OWN acronyms only all-caps or lowercase.
3. **S4 shares one gate** between scrubber and leak check (~642, ~948): memo@, chema@,
   nacho@, toño@ → "Si quieres, Memo, lo vemos" kept. Scrubber: use the composer's own
   local-part predicate (move `firstNameGuess`'s rule from claude-composer.ts ~478 into a
   pure shared module both import: one predicate for "what name does the greeting use";
   claude-composer.ts is in your allow-list for that move only). Leak check: its own
   coarser rule: any leading letter run of 3+ letters that is not a role inbox, no
   names-list gate.
4. **Titles before a dot** (~1052): "la Profa. Torres", "Fisio.", "Notar.", "Contad." end a
   sentence. Add profa, profr, profra, licdo, lcdo, ingra, enf, psic (and similar) to
   HONORIFICS, AND make the rule structural: a capitalized token directly before "." never
   opens a sentence for the next capitalized word.
5. **False drops from the generator's dictionary** (forth, haga, vea; also vida, debo,
   cierra, math, fallen…): en_US.dic lacks forth/fallen/math and es_MX.dic is a stem list,
   so real words become NAME_ONLY and are refused even lowercase. Root fix in
   `scripts/gen-exemplar-wordlists.mjs`: decide "is a word" with an affix-aware Hunspell
   check (nspell, MIT; dev-time only, never shipped) over en_US+en_GB(+en_CA) and
   es_MX+es_ES; the script prints every top-20k word that ends NAME_ONLY so a dictionary gap
   shows at build time. No new runtime dependency.
6. **Weak-name cutoff uses the wrong population** (47/47 probed Mexican surnames kept
   mid-sentence; Ding, Tao, Kan, Sen, Raja, Pilar, Serge…; 2,369 net names exempt). Take
   the reviewer's (a)+(b): a weak name is exempt only if it is in the top 3,000 words, and a
   Census surname with ≥ 50% Hispanic or Asian share counts as strong.
7. **Lowercase subject tokens** (your departure): house-style subjects are lowercase, so
   case says nothing there. Lowercase subject tokens use the capital-tier rule (strong
   names denied). Conductor decision: accept the cost ("the price of…" may drop).
Optional, take if cheap: capital tiers strip only plural -s/-es (Thind → thin+d); lazy-init
the word sets (~400 ms / 45 MB at import of every composer route even with the switch off);
flag \p{Zs} other than U+0020/U+00A0 between letters; add AI, PDF, FAQ, API, QR, IVA, PYME,
PYMES, RFC, CFDI, SAAS, WIFI, NPS, ERP, TPV, SPEI to OWN (all-caps only); correct the header
claim that the leak check "shares only the word lists" (inWords/bases/hostOf are shared:
split them or say so); put the .rda→csv command in the generator.
First merge `origin/claude/optimistic-tesla-3gceud` (now main 9c98448 + follow-ups): every
conflict outside the exemplar files takes the base side (hold.ts carries the weekday-only
digest text); afterwards `git diff origin/claude/optimistic-tesla-3gceud --name-only` lists
only exemplar files, claude-composer.ts and the shared predicate module.
Acceptance (round 6): every reviewer probe above drops or scrubs clean (add them as tests);
held-out names ≥ 98% still; the conductor re-runs the 30 real pitches: target every drop a
real leak, kept exemplars carry no capitalized mid-sentence token from a public names list.
Stop rule: if the round-6 review finds another BLOCKING leak class, #17 is parked and the
conductor proposes a different design to Pedro (exemplars written as templates at
generation time). Say in the PR body what you could not close.
