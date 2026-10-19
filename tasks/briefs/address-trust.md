# Brief: address-trust

| | |
|---|---|
| Module | `lib/research/` (Anymail client + the recipient verifier) and the one place each consumer reads "is this address source trusted" |
| Model / effort | opus-5.5 / high (decides what the autopilot may send unattended) |
| Branch | `claude/address-trust` from `claude/phase3-batch4-integration` |
| PR target | `claude/phase3-batch4-integration` |
| Reserved migration | none |
| Depends on | none. Parallel with the other three; it edits ONE line in `lib/autopilot/governor.ts` and one list in `lib/pitches/send-gate.ts` (see "Runtime neighbours") |
| Conductor session | `session_017nqBxLFFXKbhDwKiPi6xLf` (send_message here ONLY if blocked; the PR body is the report) |
| Size | S/M |

## Goal
Keep the Anymail lookups (they found 30 contacts in their first 3 days, roughly as many as
the websites gave us), but only keep the addresses Anymail itself VERIFIED, and let those
send without a person like an address the company publishes. Today our client also
accepts Anymail's unverified best guesses, which is the likely source of the 2026-10-19
bounce (not checked: the status was never stored). After the #31 hotfix every Anymail
address waits for a person and is then closed by the autopilot, so the credits buy nothing.

## Context the worker needs
- `lib/research/anymail-finder.ts` takes `d.valid_email ?? d.email` and only rejects
  `email_status` `not_found`/`blacklisted`, so a response with `valid_email: null` and a
  guessed `email` (status e.g. `risky`) is accepted. Per its header, Anymail charges
  credits only when a valid email is found. Confirm the response shape and the
  `email_status` values from Anymail's v5.1 docs if the sandbox can reach them; if not,
  say so and code against `valid_email` being present AND `email_status === "valid"`.
- `lib/discover/enrich-contacts.ts` (~l.88) inserts `selected_by: "anymail"`.
- Four lists answer "how far do we trust this source", and they must agree:
  `provenanceOf` + `FINDER_SOURCES` + `isFinderSource` + `storedVerdictUsable` in
  `lib/research/verify-recipient.ts`; `TRUSTED_SOURCES` in `lib/autopilot/governor.ts`
  (~l.35, read by `laneFor`); `VERIFIED_PROVENANCE` in `lib/pitches/send-gate.ts` (~l.162).
  Other readers of `selected_by`: `lib/autopilot/tick.ts` (labelDrafts ~l.513, scheduleAuto
  relabel ~l.698, both via `isFinderSource`), `app/api/pitches/send-queue/route.ts`
  (passes it to the verifier), `lib/discover/prospects-queries.ts` (~l.137 catch-all check),
  `lib/discover/pipeline-stage.ts` (~l.688–723), `lib/pitches/contacts.ts`.
- Prod (2026-10-19): 30 `anymail` contacts (all since 10-17), 9 sent, 1 bounced; 591
  `scraper`, 442 sent, 1 bounced; 0 `hunter` ever (Hunter is not in use).

## The changes
1. **Verified only.** `anymailFindDecisionMaker` returns a contact only when Anymail marks
   the address valid (see above); anything else is "no valid email found" (no insert, the
   waterfall moves on). The result carries the status it saw.
2. **New source value** `anymail_verified` for those inserts. Existing `anymail` rows (status
   unknown) keep today's treatment: a finder address that needs a person.
3. **One predicate.** `verify-recipient.ts` exports the single answer (e.g.
   `isTrustedForAutoSend(selectedBy)` and the provenance level); `TRUSTED_SOURCES` in
   governor.ts and `VERIFIED_PROVENANCE` in send-gate.ts are replaced by imports of it (one
   line each; behaviour for every existing value unchanged). `anymail_verified` is trusted:
   provenance medium, NOT a finder, so the verdict is `send` when DNS and domain match.
4. Every reader listed above is checked for the new value; say per reader in the PR what it
   now does with `anymail_verified`.

## Runtime neighbours (same batch)
- autopilot-trust-split also edits `governor.ts` (stage + breakers). You change ONLY the
  `TRUSTED_SOURCES` line; the conductor merges both.
- With trust-split, a bounce from an `anymail_verified` address pauses the inbox but does not
  drop the autopilot's level. The bounced-domain rule in `verifyEmailPure` still drops any
  non-published address on a domain that bounced before.

## Files
Allowed: `lib/research/anymail-finder.ts`, `lib/research/verify-recipient.ts`,
`lib/discover/enrich-contacts.ts`, `lib/autopilot/governor.ts` (the `TRUSTED_SOURCES` line only),
`lib/pitches/send-gate.ts` (the `VERIFIED_PROVENANCE` list only), `tests/*.test.ts`.
Read only: every reader listed above.
Forbidden: `lib/supabase/types.ts`, `vercel.json`, `CLAUDE.md`, `lib/{anthropic,gmail,compliance,supabase}/`, migrations.

## Must not change (negative set)
- Every existing `selected_by` value gets the same provenance, finder flag, lane trust and
  send-gate result as today (table test over all of them: `scraper`, `manual`,
  `snapverify_smtp`, `snapverify_catchall_guess`, `engine`, `anymail`, `hunter`, null).
- The 2026-10-19 cases: henry.jonk@absolute-hydraulics.com as `anymail` → review;
  contacto@dentistaenguadalajara.com as `scraper` → send.
- Hunter's path is untouched.

## Acceptance checks
1. `npm run typecheck && npm run lint && npm test` pass; new tests: Anymail fixtures
   (valid → contact `anymail_verified`; `valid_email: null` + guessed `email` → none;
   `risky` → none; `not_found` → none); the table test above plus `anymail_verified` → send;
   governor `laneFor` and send-gate agree with the predicate for every value.
2. `grep -rn '"anymail"' lib app` shows each remaining use is intentional (listed in the PR).
3. Mutation table in the PR.

## External prerequisites
none (the same `ANYMAIL_FINDER_API_KEY`).

## Prod verification
After deploy: new `prospect_contacts` rows from Anymail have `selected_by = 'anymail_verified'`;
`select selected_by, count(*), count(*) filter (where verify_verdict='send') ...` shows them
as `send`; their bounce rate is tracked by the conductor for 2 weeks.

## Out of scope
Re-checking the 30 legacy `anymail` contacts (a re-lookup costs credits; they stay review),
Hunter, stopping lookups, the pipeline's spend guards (pipeline-guards).
Lessons go to `tasks/lessons-inbox/address-trust.md`.

## Questions already answered
Q: Should a verified Anymail address on a domain that already bounced send?  A: No: the bounced-domain rule keeps dropping it.
Q: Store the raw status?  A: Only as the new `selected_by` value; no schema change.

## If blocked
Message the conductor with what you tried, what you need, and what you can still do meanwhile.
