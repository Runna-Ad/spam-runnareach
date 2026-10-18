# Brief: exemplar-scrubber-gaps

| | |
|---|---|
| Module | `lib/pitches/` (hub): `exemplars.ts` only |
| Model / effort | opus-5.5 / high (hub; a miss sends one prospect's details to another) |
| Branch | `claude/exemplar-scrubber-gaps` from `claude/conductor-skill-board-tasks-cu74t5` |
| PR target | `claude/conductor-skill-board-tasks-cu74t5` |
| Reserved migration | none |
| Depends on | none. Runs alongside learning-meeting-outcomes, which makes booked pitches qualify as exemplars: more past emails will pass through this scrubber after both merge |
| Conductor session | `session_018Qvu38cNFVCuWNq41wYfxJ` (send_message ONLY if blocked) |
| Size | M |

## Goal
Past winning emails are shown to the writer as examples after `scrubExemplar` blanks the
old prospect's name, company, site and city, and `exemplarLeaks` drops any exemplar
where a distinctive word survives (fail closed). Batch 1's review left three classes the
leak check cannot see, so a leak there reaches a new prospect's email. Close them by
widening the INVARIANT (what `exemplarLeaks` checks), then make the scrubber clean
enough that the invariant rarely has to drop. Good = the property test below would have
caught all three classes on today's code.

## Context the worker needs
Read `lib/pitches/exemplars.ts` lines 170–430 and `tests/pitch-exemplars.test.ts` first.
The three gaps (verify each on today's code with a failing test before fixing):
1. **Short tokens.** `distinctive()` keeps pieces of 4+ letters, so 3-letter company or
   domain words ("BMO", "ABC Plumbing" → "ABC", "kpi-law.ca" → "kpi") and 2–3 letter
   surnames ("Lee", "Ng", "Wu", "Li") are neither leak-checked nor, for company/domain,
   scrubbed alone. Check 3-letter company/domain pieces unless generic (extend
   GENERIC_WORDS with short business words: spa, art, law, bar, inn, pub, gym, car, pet,
   tax, kid, dog, cat, bio, eco, pro, med, vet, dds, cpa, llp, plc, sas, cv, sa, de, rl,
   and articles/particles you find in the existing sets). Check the contact's surname
   pieces of 2+ letters; common-word names stay capitalized-only as today.
2. **Lowercase honorific names.** `HONORIFIC_RE` requires a capitalized name, so
   "dr. patel" or "lic. núñez" in a lowercase subject survives when the contact row names
   someone else. After a dotted honorific (dr., dra., lic., ing., arq., mtro., mtra.,
   prof., sr., sra., srta.), blank the next word in any case. A blanked ordinary word
   ("dr. visit" → "dr. [name]") is acceptable; a leaked name is not.
3. **City short forms.** A city's common abbreviation or nickname is not checked:
   Ciudad de México → CDMX, DF; Guadalajara → GDL; Monterrey → MTY; Querétaro → QRO;
   Toronto → TO (capitalized only), GTA, YYZ; Vancouver → YVR; Calgary → YYC;
   Edmonton → YEG; Ottawa → YOW; Montréal → MTL, YUL. Add an alias table keyed by the
   folded city name; scrub aliases to [city] and include them in the leak check.
Bump `EXEMPLAR_PROMPT_VERSION` to `exemplar-v2-2026-10-18` (the decision record names it).

## Files
Allowed to edit:
- `lib/pitches/exemplars.ts`
- `tests/pitch-exemplars.test.ts` (and a new `tests/pitch-exemplars-property.test.ts`)

Read for context, do not edit: `lib/pitches/exemplar-queries.ts`, `lib/pitches/claude-composer.ts`, `lib/pitches/review.ts`.

Forbidden: every other file in `lib/pitches/`, `lib/learning/**` (another worker is in
`reward.ts`), `lib/supabase/types.ts`, `vercel.json`, migrations.

## Must not change (negative set)
- Every existing test in `tests/pitch-exemplars.test.ts` passes unchanged.
- An exemplar for a prospect whose fields are all generic (company "The Art Spa",
  city "Toronto", contact "Will Smith") still survives when its body only contains generic
  words, "will" in lowercase, and no alias: the leak check must not drop ordinary text.
- `toExemplar` still returns the same object shape; `selectExemplars` and the prompt
  sections are untouched.
- Placeholders stay exactly `[name] [company] [site] [city] [n]` and `{hunter_url}`.

## Acceptance checks
1. Property test: for generated prospects (company of 1–3 words incl. a 3-letter
   acronym, domain from the company, a city from the alias table, contact with a 2-letter
   surname) and templates that insert each field (and each alias) in original, lower and
   upper case, in subject and body, `toExemplar(...)` is either `null` or contains no
   field value, no alias, no surname (whole-word, accent-insensitive). ≥ 200 cases, seeded.
2. Shown failing on the integration-branch `exemplars.ts` for each of the three classes
   (paste the output), passing after.
3. The negative-set exemplar above survives (explicit test).
4. Report the drop rate: run the property generator's "clean" templates (no leaked field)
   and show the share dropped stays under 5%.

## External prerequisites
none

## Prod verification
After deploy, AI pitches that were shown exemplars record the new version:
`select decision->>'exemplar_prompt_version' as v, count(*) from pitches where created_at > '<deploy time>' group by 1;`
(null rows = no exemplar qualified; that is normal while few outcomes are settled).

## Out of scope
- Exporting one placeholder regex for send-gate and composer (lessons inbox).
- Any change to how exemplars are chosen or how many.

## Questions already answered
Q: Drop or scrub when unsure?  A: Scrub what you can; the leak check drops anything left. Fail closed.
