# Brief: site-facts-writer

| | |
|---|---|
| Module | `lib/pitches/` hub: new `site-facts.ts`, writer prompt (`claude-composer.ts`, normal pitch path), critic (`review.ts`), loaders (`pitch-stage.ts`), `generator.ts` (input type) |
| Model / effort | opus / high (routing: `lib/pitches/` hub) |
| Branch | `claude/site-facts-writer` from `claude/phase3-batch10-integration` |
| PR target | `claude/phase3-batch10-integration` |
| Reserved resource | none |
| Depends on | `site-crawler` merged (ea292cd: `site_observations`, `lib/research/site-crawl/types.ts`), greeting-rule merged, PR #69 showcase email (on main, merged into integration 75551c8) |
| Conductor session | `session_01HtEg7XG4MPQU4omrd2BX69` (send_message ONLY if blocked; the PR body is the report) |
| Size | L |

## Goal
The writer may state as fact only what our crawler saw on the prospect's site, and the AI reviewer judges claims against the same list. Today it has a research summary and audit quotes; 2026-10-28 prod: v3.3 critic pass 8/34 (24%), the top blocker a claim about the site nobody saw (one lodge was told it had "no easy way to book a cabin"; the crawler found its "Book Now" → WebRezPro booking engine). Good looks like: every "I saw / your site …" sentence traces to a site fact with its URL; no absence is ever claimed from a "could not see"; the closing line and subject stop asserting a loss.

## Context the worker needs (conductor-verified 2026-10-30)
- **Data:** `site_observations` (0054), newest row per prospect, readers filter `status = 'ok'` (pending/abandoned rows keep `checks = '{}'`). Shapes and meanings: `lib/research/site-crawl/types.ts` (READ ITS HEADER): `found: true` seen with evidence `{url, text?, href?}`; `false` = looked everywhere readable, not there; `null` = could not see, never an absence. Booking: `online` / `channel` (external_engine, marketplace, on_site, whatsapp, phone) / `strength` (strong, weak: phrase weak softly). `tel`/`mailto` false = "no clickable link", never "no phone/email". `jsonld_opening_hours` false = no structured hours, never "no hours". `psi` (PageSpeed) may be null (`psi_status` no_key until Pedro adds the key): use it only when `psi_status = 'ok'`.
- 33-site study (`tasks/board.md`, batch 10): booking online 7 found / 17 not / 9 could not see; forms 19; WhatsApp-only clinic 1.
- **Writer (normal path)** `claude-composer.ts`: `PITCH_PROMPT_VERSION = "pitch-v3.3-2026-10-26"` (:356); FACTS 1 (:506-507) says what counts as seen (what_they_do, tech_stack, observed pain quotes); payload `buildStage2UserPrompt` (:882-~990: prospect, pain_candidates with `observed`, benchmarks, address_contact, hunter_url). CTA template EN :423 ("…see for yourself where [the pain] is costing you…"), ES :480 ("…mira tú mismo dónde [el dolor] te está costando…"); subject guidance EN :426 ("their business + a quiet loss (the default): 'where [company] loses online orders'…"), ES :483. The showcase prompt (`buildShowcaseSystemPrompt`, :586+, `SHOWCASE_PROMPT_VERSION`) is a separate arm: do not change it.
- **Critic** `review.ts`: rule 1 (:172-173) defines "shown" (prospect fields, observed pain_evidence); house facts include the CTA wording (batch 9 audit: the CTA's [pain] slot is still judged); payload (:211-245) has `pain_evidence`.
- **Loaders:** `pitch-stage.ts` `generatePitchWith` (:116, research read :162, inputs :428) and `rewritePitchWithAngleWith` (:805, research :856, inputs :923) both read `prospect_research`; the follow-up writer (`app/api/pitches/follow-up/route.ts:281`, `followup-composer.ts`) also does (out of scope, see below). Input type `GeneratorInputs` in `lib/pitches/generator.ts:151`.
- Send gate rule 3 (`send-gate.ts:176-187, 349`): a website claim needs `websiteVerified` (`gate.ts:181`: research scraped). Unchanged here.
- Learners: the pre-send guardrail counts only the newest prompt version (`learn.ts latestPromptOnly`, batch 9). Bumping the version restarts its sample on purpose.
- No new AI call (cost rule, $3/24h cap): site facts are built in code.

**Decisions (conductor; Pedro chose the wording 2026-10-28/30):**
1. New pure module `lib/pitches/site-facts.ts`: from the newest `ok` observation build `site_facts: [{id, fact, url, strength}]` in plain English (the writer translates), only from `found: true` / `found: false` (never null), each with its evidence URL. Examples: "Their 'Book Now' button goes to an outside booking engine (reservations.travelclick.com)"; "Bookings are taken only by WhatsApp ('Agendar cita' opens a WhatsApp chat)"; "No way to book online was found on the pages we read (home, rooms, contact)"; "The contact page has a form with a message box"; "Copyright line says 2019"; "Google's mobile speed test scored 34/100" (psi ok only). Facts with no URL are not facts. Unit-test every check's mapping, including null → no fact.
2. Loaders fetch the newest observation (status ok, ≤ 60 days) for `generatePitchWith` and `rewritePitchWithAngleWith`; a read error or no row → `site_facts: []` (never fail the draft, P7: no row is not "nothing on the site").
3. Writer (normal path) prompt `pitch-v3.4-2026-10-30`: FACTS 1 = what you may state as seen: site_facts (with their meaning), what_they_do, tech_stack, observed pain quotes. Absence only from a site_facts absence entry, said as "I didn't see a way to book online on your site", never "you have no…/customers can't…". When site_facts is empty, the email makes no claim about the site (lead with what_they_do and a general pattern).
4. Closing line (EN/ES): replace "see for yourself where [the pain] is costing you" with "see what our free check finds on [company]'s site" / ES "y mira lo que nuestra herramienta gratis encuentra en el sitio de [empresa]" (keep the rest of the line: 30 seconds, no signup, hunter link, reply). Pedro picked "see what a customer sees on their phone"; the conductor changed it to this until Pedro confirms, because the free check is not known to show a phone view (see PR body).
5. Subject: default "what I noticed on [company]'s site" / "lo que vi en el sitio de [empresa]", allowed ONLY when site_facts is non-empty; otherwise a neutral subject with no loss claim ("an idea for [company]", "una idea para [empresa]"). Remove every "quiet loss" subject instruction. Subjects still carry no numbers.
6. Critic: payload gains `site_facts`; rule 1's "shown" includes site_facts; a sentence claiming something about their site that no site_fact or prospect field shows is blocking; an absence claim is blocking unless a site_facts absence entry supports it; "I didn't see …" phrasing for a supported absence is fine. House facts: replace the old CTA text with the new one; a "what I noticed" subject with empty site_facts is blocking.
7. Reason strings consumed by `presend.ts` ("AI review flagged issues" / "AI review score x < y") unchanged.

## Brain lessons
none matched (second brain not attached). Core-context: P1 readers (which X: both loaders, writer and critic use the same `site_facts`); P4/P7: an absent row or a null is never an absence.

## Files
Allowed to edit: `lib/pitches/site-facts.ts` (new), `lib/pitches/claude-composer.ts` (normal path, CTA, subjects, version), `lib/pitches/review.ts`, `lib/pitches/pitch-stage.ts` (the two loaders only), `lib/pitches/generator.ts` (`GeneratorInputs.site_facts`), `tests/site-facts*.test.ts` (new), existing tests that pin the old CTA, subject text or prompt version (name them).
Read only: `lib/research/site-crawl/types.ts`, `supabase/migrations/0054_site_observations.sql`, `lib/pitches/send-gate.ts`, `lib/pitches/gate.ts`, `lib/autopilot/learn.ts`, `lib/learning/presend.ts`, `followup-composer.ts`.
Forbidden: `lib/supabase/*` (types already added by the conductor), `lib/research/*`, migrations, `vercel.json`, the showcase prompt, the send gate.

## Must not change (negative set)
- The showcase arm (prompt, version, critic showcase rules).
- No number, client or claim rule is loosened; the send gate untouched.
- A prospect with no observation drafts exactly as today except the new CTA/subject and "no site claim" rule.
- Greeting rules (batch 10 greeting-rule) unchanged.

## Acceptance checks
1. `site-facts.ts` tests: every check × true/false/null; null → no fact; booking weak → softened wording; WhatsApp-only → "only by WhatsApp", never "no booking".
2. Real data: build site_facts for 5 of the 33 study sites from the saved fixtures (`tests/fixtures/site-crawl/*`) through the real detectors and paste them in the PR (sundial, omdental, hiddenacres, whitemoose or firvale (no online booking), hotelzed).
3. Prompt/critic tests: v3.4; new CTA EN/ES present, old CTA and "quiet loss" absent; subject rule tied to non-empty site_facts; critic payload carries site_facts; the house-facts line updated.
4. With a fake model, a draft claiming "you have no online booking" for a prospect whose booking is `null` is flagged by the critic prompt's rule text (assert the rule is present; judgment itself is checked by the conductor's study after deploy).
5. Project checks green (`npm run typecheck && npm run lint && npm test`) + `npm run build`.

## External prerequisites
none for this task (PageSpeed key is the crawler's; without it psi facts are simply absent).

## Prod verification
After deploy + 2 days: `select decision->>'prompt_version' pv, count(*), count(*) filter (where (decision->'critic'->>'pass')::boolean) passed from pitches where created_at > '<deploy>' and parent_pitch_id is null group by 1;` → v3.4 pass rate vs v3.3's 24%; sample 10 drafts: every site claim matches a stored site fact.

## Out of scope
The follow-up writer (it reads research too; next batch, say so in the PR), the showcase email, the gate's `websiteVerified`, Hunter's report content.

## If blocked
Message the conductor with what you tried, what you need, and what you can still do meanwhile.
