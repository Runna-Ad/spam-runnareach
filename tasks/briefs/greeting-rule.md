# Brief: greeting-rule

| | |
|---|---|
| Module | `lib/pitches/greeting-name.ts` + the greeting part of `lib/pitches/send-gate.ts` |
| Model / effort | opus / high (routing: `lib/pitches/` hub, send gate) |
| Branch | `claude/greeting-rule` from `claude/phase3-batch10-integration` |
| PR target | `claude/phase3-batch10-integration` |
| Reserved resource | none |
| Depends on | none (parallel with `site-crawler`, disjoint files) |
| Conductor session | `session_01HtEg7XG4MPQU4omrd2BX69` (send_message ONLY if blocked; the PR body is the report) |
| Size | S |

## Goal
A pitch never greets a "name" built from a word in the address. Prod 2026-10-28 (34 drafts on prompt v3.3): "Hola Cursos," (cursos@), "Hi Care," (care@), "Hi Nfo," were written; all three were auto_rejected for other reasons, but nothing stopped them as greetings. Good looks like: one rule decides the greeting name, the writer gets it, and the send gate checks the email against that SAME rule (not its own copy).

## Context the worker needs (conductor-verified)
- `greetingName` / `emailGreetingName` (`greeting-name.ts:~95-145`): with no stored name, the first address segment becomes the name when it is ≥3 letters, not in `GENERIC_LOCALS`, not the company/domain, and (no separator) ≤6 letters. So `cursos@` → "Cursos", `care@` → "Care". There is no check that the token IS a given name.
- A given-names list already exists: `lib/pitches/wordlists/names.ts` (header: 6,782 given names (SSA top 1,000), 16,667 long-tail given names, surnames, plus `NAME_WORDS` / `NAME_WEAK` subsets that are everyday words). Read its exports; do not add a new list.
- Readers of the rule: `claude-composer.ts:566-586` (`firstNameGuess = greetingName`, payload `first_name`), `exemplars.ts:813` (scrubber; must keep agreeing).
- The gate has its OWN rule (`send-gate.ts:~306-345`): no stored name → it allows any greeting whose first token is inside the local part (`localPart.includes(greetedTok)`), role check via `isRoleBasedEmail` (`lib/research/email-utils.ts:208`), not `isRoleInbox`. That is the second predicate. Gate callers: `gate.ts:279`, `review.ts:56`, `app/api/pitches/follow-up/route.ts:474`, `app/api/replies/nudge/route.ts:249` (signature must stay compatible; grep tests for stub loaders of these routes).

**Decisions (conductor):**
1. An address-derived name is accepted only if the token is a GIVEN name in the names list (given or long-tail given), and not one of the everyday-word names unless it is a top-1,000 given name with a separator form (`ana.lopez@` → "Ana" stays; `cursos@`, `care@`, `nfo@` → null). Keep every existing rule (generic parts, company/domain, ≤6 letters without separator).
2. The gate's "no stored name" branch uses the same rule: the greeted name must equal `greetingName(null, email, roleBased, company)` (case/accents folded); a greeting of a name when that returns null fails `greeting_not_a_name`. Role check in the gate = `isRoleBasedEmail(email) || isRoleInbox(email)`. Stored-name branch unchanged.
3. "Hi [company] team," / "Hola, equipo de [empresa]," stays valid for every address.

## Brain lessons
none matched (second brain not attached). Core-context: one predicate per question (P1).

## Files
Allowed to edit: `lib/pitches/greeting-name.ts`, `lib/pitches/send-gate.ts` (greeting section only), `tests/greeting-rule.test.ts` (new), existing tests that pin old greeting outputs (name them in the PR: grep tests/ for `greetingName`, `emailGreetingName`, `greeting_mismatch`, `greeting_not_a_name`).
Read only: `lib/pitches/wordlists/names.ts`, `lib/pitches/claude-composer.ts`, `lib/pitches/exemplars.ts`, `lib/research/email-utils.ts`, the four gate callers.
Forbidden: `lib/supabase/*`, `lib/research/*` (other worker), migrations, `vercel.json`, the writer prompt text.

## Must not change (negative set)
- A contact with a real `full_name` greets its first token exactly as today; the gate's stored-name branch unchanged.
- `john.sipos@` → "John", `miguel@` → "Miguel", `ana.lopez@` → "Ana", `vfournier@` → null, `manus-sales@` → null, `ecof@` at ECOF Cabinets → null, `pparker@` → not "P".
- Gate codes and severities (`greeting_mismatch`, `greeting_not_a_name` = review) unchanged; nothing new blocks a "[company] team" greeting.

## Acceptance checks
1. `cursos@`, `care@`, `nfo@`, `reservas2@`, `hola.mx@` → `greetingName` null; the gate fails "Hola Cursos," / "Hi Care," with `greeting_not_a_name`.
2. The negative set above, as tests.
3. A property test: for every address in a list of 50 (mix from the cases above plus 20 given-name addresses), the gate passes exactly the greeting `greetingName` produces (or the team greeting) and fails any other name.
4. The exemplar scrubber still blanks the same names on its existing tests.
5. Project checks green (`npm run typecheck && npm run lint && npm test`), count reported.

## External prerequisites
none.

## Prod verification
After deploy, 2 days: `select split_part(coalesce(body_edited, body_original), E'\n', 1) g, count(*) from pitches where created_at > '<deploy>' and parent_pitch_id is null group by 1 order by 2 desc;` → no greeting built from a non-name address word.

## Out of scope
Research's `email_is_role_based` flag; the writer prompt; recipient choice.

## If blocked
Message the conductor with what you tried, what you need, and what you can still do meanwhile.
