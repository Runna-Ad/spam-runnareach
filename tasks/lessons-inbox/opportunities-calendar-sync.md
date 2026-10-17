[2026-10-17] A route test needs a handler that takes its deps; route.ts files can't load under node --test
WHAT HAPPENED: The brief asked for a 401/200 route test with a `Request`, but `app/api/**/route.ts` imports `@/` aliases, `next/server` and `server-only`, none of which load under `node --experimental-strip-types --test`. The handler lives in `lib/opportunities/calendar-sync.ts` as `handleCalendarSync(req, deps)` (auth, tenants, actor, sync injected) and `route.ts` only wires real deps; the test calls the handler with a real `Request`.
RULE: For any cron route whose auth or response shape must be tested, put the handler in a lib module with no server imports (relative `.ts` imports, `import type` for Actor) and make `route.ts` a one-call wiring file. Briefs asking for a route test should say so.
TAGS: testing, routes, cron

## Out of scope, noticed
- `lib/gmail/client.ts` `getAccessToken` and `sendGmailMessage` fetch with no `AbortSignal.timeout` (core-context rule). Every cron route that refreshes a token inherits an unbounded wait.
- The brief points at `app/api/autopilot/tick/route.ts` for a "Sentry check-in flush" pattern; the tick route has no Sentry monitor (only warmup/* routes use `withCronMonitor`).
