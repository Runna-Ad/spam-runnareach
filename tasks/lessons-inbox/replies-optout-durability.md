[2026-10-20] A "stored, then acted on" pipeline needs a sweep keyed on the stored state, not on the import
WHAT HAPPENED: app/api/replies/poll/route.ts inserts the reply row, then calls recordOptOut. The next run skips every stored gmail_message_id, so a run that died (or got ok:false) between the two left the opt-out off do_not_contact_list for good. Prod had 2 such senders. lib/replies/optout-repair.ts now reads stored hard_no / recent bounced replies against the DNC list each run and repairs the gap.
RULE: When a job stores a record and then performs a side effect from it, and the import dedupe stops it from ever seeing that record again, the side effect needs its own idempotent sweep that compares the stored record with the side effect's result (here: reply intent vs DNC row). Leave a settle window (longer than maxDuration) so the sweep never races the run that is still acting, and fail closed on an unreadable target: a lookup error must not read as "missing".
TAGS: replies, compliance, durability

[2026-10-20] A PostgREST `in` filter is case-sensitive: lowercasing before the lookup hides hand-entered rows
WHAT HAPPENED: The first version of the sweep lowercased the reply address before querying `do_not_contact_list.email in (...)`. A mixed-case row typed by hand (dnc-actions lowercases, older rows may not) would never match, and the sweep would add a duplicate row and a second audit. Mutation testing caught it (case mutation survived); fixed by querying both the stored and the lowercased form and comparing lowercased in JS.
RULE: When matching addresses through `eq`/`in`, query every case form you hold and compare normalised in code; a mutation that removes your normalisation must fail a test.
TAGS: supabase, dnc, testing

## Out of scope, noticed
- lib/compliance/opt-out.ts `recordOptOut`: its DNC lookup is `.eq("email", lowercased)`, so a mixed-case existing row is missed and a second row is written. Harmless for blocking (the send check reads lowercase), but it can double the audit row. A `lower(email)` lookup (or a unique index on (tenant_id, lower(email))) would fix it.
- lib/discover/dnc-check.ts `addEmailToDnc` swallows insert errors, so the live bounce path can never report a failed DNC write. The sweep covers it for 14 days.
- The live bounce path's prospect suppression and sequence pause are not repaired by the sweep (address only): the DNC row already blocks every send.
