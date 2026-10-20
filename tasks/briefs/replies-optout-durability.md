# Brief: replies-optout-durability

| | |
|---|---|
| Module | `lib/replies/` + the reply poll route (`app/api/replies/poll/route.ts`) |
| Model / effort | opus-5.5 / high (`lib/replies/` lane: high for poll-route changes; compliance-adjacent) |
| Branch | `claude/replies-optout-durability` from `claude/phase3-batch5-integration` |
| PR target | `claude/phase3-batch5-integration` |
| Reserved migration | none |
| Depends on | none. Parallel with the other batch 5 tasks. `followup-path-hardening` READS this route's `postponeSequence` (do not change its update or filters) |
| Conductor session | `session_017nqBxLFFXKbhDwKiPi6xLf` (send_message here ONLY if blocked; the PR body is the report) |
| Size | M |

## Goal
Every reply that says "remove me" ends with the sender's address on the do-not-contact list,
even if the poll run that stored the reply failed or was killed before the opt-out landed. Today
such a reply is stored, then skipped by every later run, and the address never reaches the list.
This is a compliance promise (CASL / unsubscribe), so it must repair itself without a person.

## Context the worker needs
- Per message the poll does (`app/api/replies/poll/route.ts`): classify (`:277`) → insert the
  `replies` row (`:280-299`; `23505` → skip, `:301-308`) → audit `reply.imported` → pitch event →
  then by intent. `hard_no` (`:402-413`): `const optOut = await recordOptOut(supabase, { ...,
  email: inbound.fromEmail, source: "reply", note: ... })`; on `ok:false` it pushes an error and
  sets `engaged = true` ("at least pause the sequence below").
- `recordOptOut` (`lib/compliance/opt-out.ts`, conductor-only: CALL it, do not edit it):
  DNC lookup `.from("do_not_contact_list").select("id").eq("tenant_id").eq("email", email)`, insert
  `{ entry_type: "unsubscribed", email, notes }` if missing (either failure → `ok:false`), then
  suppress the prospect, pause its pitches, a pitch event `unsubscribe`, audit `prospect.opted_out`.
  It is idempotent on the DNC row (select before insert).
- **Why it never repairs:** the next run reads the stored ids first
  (`.from("replies").select("gmail_message_id")...in(candidateIds)`, `:240-245`) and drops them
  (`:253`), so a stored `hard_no` reply is never classified or opted-out again. No sweep reads
  `replies.intent = 'hard_no'` against `do_not_contact_list`. The lead alert's `optOutFailed`
  flag (`lib/replies/lead-alert.ts:45-46`, `:175`) only labels an email "removal NOT confirmed,
  check by hand", and only while the alert is unsent.
- Send paths check DNC through `isEmailOnDncList` (`lib/discover/dnc-check.ts:62-99`):
  `.or(email.eq.<addr>,domain.eq.<domain>)`; a lookup error fails open.
- **Prod today (2026-10-20):** 2 `hard_no` replies ever (2026-07-11, 2026-07-23), **both senders
  NOT on `do_not_contact_list`**; their prospects are `suppressed`, 0 `prospect.opted_out`
  audit rows (they predate `recordOptOut`). One sender is a gmail.com address (54 live prospects
  share that domain: never add a domain row for a free-mail domain). Your sweep repairs both.
- `do_not_contact_list` (0001:688-701): no unique index on (tenant_id, email); `addEmailToDnc`
  inserts without a check. `recordOptOut` dedupes by select.
- Time budget: `maxDuration` 120 s; `POLL_BUDGET_MS = 100_000`, `ALERT_RESERVE_MS = 60_000`,
  pg_cron every 10 min at :05 plus the Vercel 13:00 sweep. Anything you add must be safe to be
  killed at any point (idempotent) and must not push the lead alerts past their reserve.
- `DEAD_STATUSES` (`:83-84`) skips threads of booked/suppressed/archived/won/lost prospects.
  An earlier review suggested adding `no_match`. **Decided: do not.** Adding it would stop
  importing opt-outs from `no_match` prospects (today they are imported and reach DNC). Leave a
  one-line comment saying why.
- No test drives the poll route today. tasks/lessons.md 2026-10-19: extract the db step into a
  db-injected function in an importable module and test it with a fake whose columns are checked
  against the migrations (see `tests/send-path-hardening.test.ts` for a schema-checked fake).

## Brain lessons
- serverless-durable-background-jobs.md: "Fire-and-forget does not exist: await every side
  effect before you send the response." A repair that may be killed must be idempotent.

## The changes
1. **Opt-out repair sweep.** A db-injected function (in `lib/replies/`) that finds stored
   `hard_no` replies whose sender is not on the tenant's DNC list (by email; a domain row also
   counts) and calls `recordOptOut` for each, bounded per run (say how many and why), with a
   note that says it was repaired by the sweep and names the reply id. Called once per poll run
   where it cannot starve thread polling or the lead alerts. Report `{ repaired, failed }` in
   the run's JSON.
2. **Bounces, check only:** a stored `bounced` reply whose DNC insert failed has the same gap.
   Check whether the bounced address can be recovered from stored data. If yes, repair it the
   same way; if not, say so in the PR (no new columns in this task).
3. The `DEAD_STATUSES` comment (above).

## Files
Allowed to edit:
- `app/api/replies/poll/route.ts` (call the sweep, add its result to the report, the comment; do not change `postponeSequence`)
- `lib/replies/*.ts` (new module for the sweep)
- `tests/*.test.ts`
Read for context, do not edit:
- `lib/compliance/opt-out.ts`, `lib/discover/dnc-check.ts`, `lib/replies/lead-alert.ts`, `lib/replies/intent-actions.ts`, `app/api/unsubscribe/route.ts`, `supabase/migrations/0001_*.sql` (replies, do_not_contact_list), `0046_*.sql`
Forbidden: `lib/supabase/types.ts`, `vercel.json`, `CLAUDE.md`, `lib/{anthropic,gmail,compliance,supabase}/`, migrations.

## Must not change (negative set)
- A reply that is not `hard_no` (and not a bounce you can repair) never causes a DNC write.
- A sender already on the list (email or domain row) gets no second row and no second audit.
- The poll's import, classification, OOO postponement, lead alerts and `replied` write behave as today.
- No domain-level DNC row is ever written by the sweep.

## Acceptance checks
1. `npm run typecheck && npm run lint && npm test` pass.
2. Fake-db tests: a stored `hard_no` reply not on DNC → `recordOptOut` called once, DNC row
   present after; already on DNC (email) → no call; on DNC by domain row → no call; `recordOptOut`
   returns `ok:false` → counted as failed, retried next run; more than the bound → the rest wait
   for the next run; a read error → no writes, error reported (fail closed toward "try again").
3. A test that the route calls the sweep and puts its result in the report (route-level loader
   hook, or a source check if the route cannot be loaded: say which).
4. Mutation table in the PR.

## External prerequisites
none.

## Prod verification
After deploy, the first poll run's JSON shows `repaired: 2`; then
`select count(*) from replies r where r.intent = 'hard_no' and not exists (select 1 from do_not_contact_list d where d.tenant_id = r.tenant_id and (lower(d.email) = lower(r.from_email)))` = 0,
and the next run shows `repaired: 0`.

## Out of scope
Changing `recordOptOut` (conductor-only; note anything it should change in the PR), a unique index
on the DNC list, importing replies from DEAD_STATUSES prospects, the booking alert and calendar
sync items. Lessons go to `tasks/lessons-inbox/replies-optout-durability.md`.

## Questions already answered
Q: Repair only recent replies?  A: All stored `hard_no` replies; there are 2 today, and an opt-out does not expire.
Q: Re-send the lead alert for a repaired opt-out?  A: No.

## If blocked
Message the conductor with what you tried, what you need, and what you can still do meanwhile.
