# Brief: writer-honesty

| | |
|---|---|
| Module | `lib/pitches/` hub: writer prompt (`claude-composer.ts`), critic (`review.ts`), greeting (`greeting-name.ts`), evidence + rewrite mode (`pitch-stage.ts`) |
| Model / effort | opus-5.5 / high (routing: `lib/pitches/` hub) |
| Branch | `claude/writer-honesty` from `claude/phase3-batch9-integration` |
| PR target | `claude/phase3-batch9-integration` |
| Reserved migration | none |
| Depends on | none (parallel with `digest-once`, disjoint files) |
| Conductor session | `session_01HtEg7XG4MPQU4omrd2BX69` (send_message ONLY if blocked; the PR body is the report) |
| Size | L |

## Goal
Far fewer good drafts thrown away. Since batch 6, 79% of AI-review failures say "a guess stated as fact", and rewrites succeed 14% of the time (41% before). Pedro (2026-10-26) chose all three fixes: stop the guesses, rewrite fresh instead of revising, fix greetings. A calibration study on the newest 30 failed v3.2 drafts (conductor, 2026-10-26; summary below; raw notes kept out of the repo (real prospect addresses)) shows BOTH sides are wrong, the critic more often. Good looks like: the writer states as fact only what was seen; the critic blocks only unsupported claims about THIS business; greetings never invent a name or team; a rewrite starts fresh.

## Context the worker needs (study findings, conductor-verified file:line)
64 blocking issues on 30 drafts: **critic over-strict 31**, writer unsupported claim 16, greeting error by writer/code 7, critic wrong on greeting 4, recipient data 2, statistic 4 (critic right on 3).
- **Critic over-strict (B):** it blocks the general "what tends to happen to businesses with this gap" line the writer prompt REQUIRES (`claude-composer.ts:~500-505`, "SAY WHAT YOU SAW, THEN WHAT IT TENDS TO COST"; e.g. "most people who can't get an answer on the spot don't come back to finish" is nearly the prompt's own OK example), near-verbatim payload evidence, sentences describing OUR fix, the required CTA wording "where [pain] is costing you", the set proof line, subject wording (4 subject complaints marked blocking), and the forwarding line our code adds. Critic prompt: `review.ts:~100-145`; `criticVerdict` (`review.ts:105-115`): any non-polish issue fails the draft.
- **Writer unsupported (A), 11 of 16 from one cause:** the research step writes recommendations into `pain_points[].evidence_quote` ("Replace outdated WordPress with … live wait times … mobile-optimized", "Build chatbots for 24/7 inquiry handling"), and the writer repeats them as things it saw ("doesn't show live ED wait times", "loads slow on a phone"). `normalizePains` (`pitch-stage.ts:~1406`) only checks length ≥ 20 and ≠ label. Other A: "Revisé cómo manejan las solicitudes: la respuesta tarda horas" (no payload support), the cost line said about "you/your" ("te cuesta clientes", "a student you don't enroll").
- **Statistic:** a benchmark stretched to another industry ("En hotelería pasa lo mismo").
- **Greetings:** `greetingName` (`greeting-name.ts:24-60`) produced "Hi Manus" (manus-sales@: split on "-"), "Hi Ecof" (ecof@ = the company), "Hi Meng" (meng@ program inbox). `email_is_role_based` is false for department inboxes like reginfo@, ucwlibrary@, customersupport@, communications@, assistance@, informes@, reservaciones@, or.international@, liaisons_internationales@, ceo@. The writer invented team names from addresses ("Hi admissions and registry team at SFU", "Hi Liaisons team"), wrote bare "Hi," and "Hi P". The critic blocked the CORRECT "Hi [company] team," on info@ and suggested "Hi there" (banned by the writer prompt). Salutation rule: `claude-composer.ts:~354` (EN), `~412-413` (ES). Forwarding line: `claude-composer.ts:~209-215` (it picks its contact differently from address_contact: check, align to the batch 8 recipient chooser `chooseRecipient`).
- **Rewrites:** revise mode (`pitch-stage.ts:~449`, `heldDraftRevision`) carries the held text; measured since batch 6: revised 7/59 sent/approved (12%), fresh 3/11 (27%).

**Decisions (conductor):**
1. Writer prompt (bump `PITCH_PROMPT_VERSION` to `pitch-v3.3-2026-10-26`): only what is visible on their site, in tech_stack or what_they_do is an observation; an evidence_quote that reads as advice or opinion is never turned into something seen; never claim to have checked how they handle enquiries; the cost line is about businesses in general and never says you/your/[company]; never extend a benchmark to another industry or beyond what it measured; salutation exactly "Hi [first name]," (when address_contact.first_name is set) else exactly "Hi [company] team," (ES equivalent), never a name/team/department built from the address, never bare "Hi,".
2. Evidence: `normalizePains` marks each candidate `observed: boolean`; a quote that is a recommendation (starts with an imperative like Build/Replace/Implement/Add/Create/Use/Migrate/Consider, or contains should/needs to/recommend, EN and ES equivalents) is `observed: false`; the writer payload says so and the prompt says unobserved evidence may only be framed as a general pattern, never as a fact about them. Keep the pain usable (do not drop it).
3. Critic prompt: block only a sentence that states, about THIS business (you, your, company name), something the payload doesn't show; a sentence about people/businesses in general is allowed with or without a hedge; sentences describing what we would build and its effect are our offer, not a claim; a figure from payload.benchmarks cited for its pain is not an inference; "Hi [company] team," is correct for any address without a name, never suggest "Hi there", and who the recipient is is not the writer's issue; the forwarding line, the "where [pain] is costing you" CTA and the one-sentence proof line are ours (house facts); subject wording is never blocking. Each blocking issue quotes the sentence and names the payload field it lacks.
4. `greetingName`: reject a guessed name when any other part of the local part is a generic word (sales, info, admissions, …), when it equals or is contained in the company name or the domain's first label, and for single-letter results; expand GENERIC_LOCALS with department words (library, registry, registrar, admissions, international, communications, customersupport, assistance, informes, reservaciones, liaisons, ceo, reginfo …) and treat those as role-based. The exemplar scrubber uses the same rule (keep them agreeing).
5. Rewrites compose FRESH: the autopilot's retry no longer revises the held text (`retry_mode` always "fresh"). Keep the rule "a rewrite never inherits the old attribution code".
6. Record decision in the PR: what the critic change does to the AUTO lane (the critic is still the gate for AUTO; nothing about the score bar 0.8 changes).

## Brain lessons
none matched (second brain not attached). Core-context: one predicate per question (the forwarding line's contact must be the batch 8 recipient chooser's answer); stored text handed back to a model carries its facts (fresh rewrites remove that class).

## Files
Allowed to edit: `lib/pitches/claude-composer.ts`, `lib/pitches/review.ts`, `lib/pitches/greeting-name.ts`, `lib/pitches/pitch-stage.ts` (normalizePains + retry mode only), `lib/pitches/exemplars.ts` (only if the greeting rule change requires it), `tests/writer-honesty.test.ts` (new), existing tests that pin the old prompt text, greeting results, or revise mode (name them).
Read only: `lib/pitches/contacts.ts`, `lib/learning/presend.ts` (it classifies auto_rejected reasons: the critic's reason strings must stay "AI review flagged issues" / "AI review score x < y"), `lib/research/*`.
Forbidden: `lib/supabase/*`, `lib/compliance/*`, `lib/autopilot/*` (other worker), `lib/research/*` (upstream fix is out of scope), migrations, `vercel.json`.

## Must not change (negative set)
- No number, client name or claim rule is loosened in the WRITER; the send gate is untouched.
- The critic still blocks real unsupported claims about the prospect (test with the study's A examples: "doesn't show live ED wait times", "Revisé cómo manejan las solicitudes: la respuesta tarda horas", "a student you don't enroll").
- Reason strings consumed by `presend.ts` unchanged.
- Greeting for a contact with a real full_name unchanged.

## Acceptance checks
1. Prompt tests: the new rules are present in EN and ES; version bumped.
2. Critic prompt tests: house facts and the "about THIS business" rule present; a fake model is not enough to test judgment, so ALSO include in the PR body a table: the study's 3 A and 3 B example sentences, and for each, the rule in the new critic prompt that decides it.
3. `normalizePains`: recommendation quotes → observed false (EN + ES cases), real site quotes → true.
4. `greetingName`: manus-sales@ → null, ecof@ for company "ECOF Cabinets" → null, pparker@ with no name → not "P", reginfo@/library@ → role-based; john.sipos@ → "John" unchanged.
5. Retry: a held draft's rewrite composes fresh (no revision payload), code not inherited.
6. `npm run typecheck && npm run lint && npm test && npm run build` green; count reported.

## External prerequisites
none.

## Prod verification
After deploy, after ~2 days of drafts: `select decision->>'prompt_version' pv, count(*), count(*) filter (where (decision->'critic'->>'pass')::boolean) passed from pitches where created_at > '<deploy>' and parent_pitch_id is null group by 1;` → v3.3 critic pass rate vs v3.2's ~22% (66/85 failed); rewrites sent/approved vs 14%.

## Out of scope
Fixing the research step's evidence at the source (`lib/research`, next batch); recipient data problems; the AUTO score bar.

## If blocked
Message the conductor with what you tried, what you need, and what you can still do meanwhile.
