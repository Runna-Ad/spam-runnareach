[2026-10-30] A shared prompt builder changed for one arm silently changes the other arm's prompt
WHAT HAPPENED: `criticSystem` (lib/pitches/review.ts) builds both the pain-led and the showcase critic from one template, and the showcase writer reuses `englishPack()` / `spanishPack()` from the pain-led writer. The brief said "showcase unchanged"; editing rule 1, the house CTA line or a pack field would have changed the showcase prompts with no failing test. I hashed every showcase system prompt on the base branch before editing and pinned the hashes in tests/site-facts-writer.test.ts, then gated each new critic sentence on `showcase`.
RULE: When a brief says "arm X must not change" and X shares a prompt builder with the arm you edit, capture X's full rendered prompt (hash) on the base branch BEFORE the first edit and assert it after. String-contains tests on a few lines do not catch a changed shared sentence.
TAGS: pitches, prompts, critic, showcase, testing

[2026-10-30] A fail-safe text must not contain the words the guard forbids
WHAT HAPPENED: The structured-hours absence first read "No opening hours were found in the site's structured data…". The test guard "hours false never says 'no hours'" failed on it: a cheap model reading "No opening hours were found" can drop the qualifier and write "you don't list your hours". Reworded to "Their opening hours are not in the site's structured data…". Same for the WhatsApp-only booking fact, which first carried "no way to book online was found" and now says only "Bookings are taken only by WhatsApp…".
RULE: A fact handed to a model as "say exactly this and no more" should not open with the forbidden misreading, even when a later clause corrects it. Test the fact text against the misreading regex, not only for the qualifier being present.
TAGS: pitches, site-facts, prompts, claims

## Out of scope, noticed
- lib/pitches/send-gate.ts / gate.ts: `evidenceQuotes` holds pain quotes and what_they_do, not site facts. A number from a site fact (copyright year, PageSpeed score, rating count) is "unsourced" to the gate, so the prompt tells the writer to describe those in words. Adding site-fact texts to the gate's sources (and to `writingFailures`) would let them be quoted.
- lib/pitches/gate.ts:181 `websiteVerified` is research-scraped only; a prospect with an ok site observation but no research `evidence_urls` would have a site-fact claim held as `unverifiable_website_claim`. The claim function only crawls researched prospects, so it should be rare; not checked against prod.
- The follow-up writer (`app/api/pitches/follow-up/route.ts`, `followup-composer.ts`) still reads research only (next batch, per the brief). Its showcase critic path is unaffected (it always runs as showcase).
