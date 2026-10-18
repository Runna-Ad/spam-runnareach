[2026-10-18] A fail-open helper can serve a fail-closed caller if the failure is visible
WHAT HAPPENED: `isEmailOnDncList` fails open on a query error by design (the queue must not stall), but the last-moment recheck before Gmail needs to fail closed. Instead of a second lookup or a mode flag, the unblocked branch of `DncHit` gained an optional `error`; every existing caller still reads only `.blocked` (unchanged), and `recheckBeforeSend` maps `error` to `unreadable`.
RULE: When one caller of a shared check must fail closed and the others must fail open, return the failure as data (additive optional field) and let each caller decide; never hide it inside the helper's choice.
TAGS: dnc, send paths, fail-closed

[2026-10-18] "Nothing slow between X and Y" is tested as "no await between X and Y"
WHAT HAPPENED: PR #21's source-order test banned two named calls (token exchange, jitter) between the recheck and Gmail; any other awaited call (DNS verify, a query) would have passed. The test now brace-matches the blocked branch and asserts no `await` between its end and `await sendGmailMessage(`, plus a self-test that splices an await in.
RULE: A structural test for "nothing happens in this window" bans the general form (`await`), not a list of known offenders, and proves itself by mutating the source in-test.
TAGS: tests, routes

## Out of scope, noticed
- nothing new beyond send-path-safety's list (nudge route auth, poll DEAD_STATUSES).
