[2026-10-20] A library EventEmitter with no 'error' listener is a process crash, not a rejected promise
WHAT HAPPENED: `lib/warmup/imap.ts` built ImapFlow clients with no `.on("error")`. On a socket timeout imapflow calls `emitError` (emit 'error' + closeAfter), so Node threw an uncaught exception (Sentry SPAM-6) even though every command was awaited in a try; `close()` then rejected the queued work (SPAM-7). The hidden auto-IDLE (15s after any command) and an IMAP socket held idle across an SMTP send made the timeout likely.
RULE: Every client object that extends EventEmitter (imapflow, nodemailer pools, sockets, streams) gets an 'error' listener at construction, in the shared helper that builds it, not in the factory a test can replace. Turn off library timers we do not use (auto-IDLE, keep-alives), and do not hold a connection open across an unrelated slow call: read, disconnect, act, reconnect. Test with a fake that emits 'error' on a later tick and assert no uncaughtException/unhandledRejection fired.
TAGS: warmup, imap, reliability, events

[2026-10-20] A count cap with "skip" rows inside it starves the work; slice by time and let skips cost nothing
WHAT HAPPENED: The warm-up engine took `.slice(0, 4)` of pending placement checks newest first, once a day, 5 sends a day; skips used a slot and rows aged out of the 72h window unchecked (10-19: 3 of 5 checked). Replaced with `runPlacementChecks` (lib/warmup/intelligence.ts): oldest first, no new check after a 40s budget, each check hard-capped at 20s by closing the connection.
RULE: For a daily batch with a tail deadline, process oldest-first by wall-clock budget, put the per-item cap inside the item (a real cancel such as `client.close()`, not Promise.race), and assert in a test that budget + one capped item leaves the next step its reserve.
TAGS: warmup, time-budget, cron

## Out of scope, noticed
- `app/api/warmup/engine/route.ts` step 8 comment says "60s timeout" (maxDuration is 120s) and runs with no deadline check; bounded now by IMAP/SMTP timeouts, not by the route clock.
- Gmail folder names are locale-specific. `client.list()` + `specialUse` (`\All`, `\Junk`) would find All Mail/Spam in any language (FR `[Gmail]/Tous les messages`, PT `[Gmail]/Todos os e-mails` are the likely next ones for buddies in Canada/Mexico).
- Before this change the ES `[Gmail]/Todas las conversaciones` hit was MOVEd to INBOX; a MOVE out of All Mail expunges there, which Gmail treats as delete. Now it is counted without moving.
