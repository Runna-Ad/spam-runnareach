[2026-10-22] A Next route file can't export helpers, so the testable logic of a public route lives in lib/
WHAT HAPPENED: The /r/<code> redirect needed tests for HEAD, scanners, dedupe, test addresses and open-redirect safety. `app/r/[code]/route.ts` can only export GET/HEAD/config, and `after()` throws outside a request, so the logic went to `lib/pitches/tracked-links.ts` as `planTrackedClick(db, req)` returning `{ location, record }`; the route only wires `after(record)`.
RULE: For any public route, put the decision in a lib function that takes the db client and a plain request object and returns the response plan plus a deferred side effect; the route file stays a three-line adapter. Test the lib function with a fake db that rejects unknown columns, and prove each filter by deleting it and watching a test fail.
TAGS: app-routes, testing, pitches

[2026-10-22] An LLM-written CTA is enforced after the call, and a missing one falls back instead of being patched in
WHAT HAPPENED: The follow-up prompt used to make the free-check link optional. Now `enforceFollowupCta` (lib/pitches/followup-composer.ts) swaps {hunter_url} and any direct Hunter link for the tracked link and adds the 👉 marker; a body with no link line returns ok:false with usage, so the route records the cost and sends the template, which always carries the line.
RULE: When a link or line is required, the prompt asks for it, code fills and normalises it, and a body that still lacks it is refused (paid usage returned), never guessed into place.
TAGS: pitches, follow-ups, llm-output

## Out of scope, noticed
- `pitches.attribution_code` lookup by the redirect uses the unique partial index from 0038 (`pitches_attribution_code_key`), fine; `pitch_events` dedupe uses `idx_pitch_events_pitch_type`. No index work needed.
- The 10-minute click dedupe is a read-then-insert: two clicks in the same few milliseconds can both record. Acceptable for a best-effort signal; a partial unique index would need a migration.
- `proxy.ts` calls `supabase.auth.getUser()` on every matched request, `/r/*` included. Harmless (no session cookie → no redirect) but it adds a hop to every prospect click; excluding `/r/` from the matcher would be a conductor call.
