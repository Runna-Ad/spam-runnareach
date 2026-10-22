# Brief: tracked-links

| | |
|---|---|
| Module | `lib/pitches/` link building + follow-ups, new redirect route `app/r/[code]/route.ts` |
| Model / effort | opus-5.5 / high (routing: `lib/pitches/` hub and a send path) |
| Branch | `claude/tracked-links` from `claude/phase3-batch8-integration` |
| PR target | `claude/phase3-batch8-integration` |
| Reserved migration | none (`pitch_event_type` already has `click` in prod; checked 2026-10-22) |
| Depends on | none (parallel with `reply-on-root`, `presend-learning`; `presend-learning` READS the click events you write, contract below) |
| Conductor session | `session_01HtEg7XG4MPQU4omrd2BX69` (send_message ONLY if blocked; the PR body is the report) |
| Size | M |

## Goal
Every email we send (first email AND follow-ups) carries the free-check link, and every click on it is recorded against the conversation's first email, whether or not the visitor finishes the check. Today nothing tells us if anyone clicks: the free-check tool (runna-hunter) only saves a row when a visitor RUNS the check (`runna-hunter/index.html:1239-1262`, verified 2026-10-22 with a rolled-back probe: a scan with a code does land as an `audit_scan` event), and follow-ups carry no link at all. Good looks like: a click on any email in a thread produces one `click` event on that thread's root pitch within a second, the visitor lands on the free check with the same parameters as today plus `r=<code>`, and the redirect can never send anyone anywhere except the free check.

## Context the worker needs
**Today's link.** `buildHunterUrl` (`lib/pitches/hunter-mapping.ts:250-268`) returns `https://runna-hunter.vercel.app/?market=..&industry=..&timesink=..&tools=..&website=..&lead=..&r=<code>&v=1`; `buildHunterUrlForPitch` (`:271+`) is called at `lib/pitches/pitch-stage.ts:385` (first generation) and `:866` (rewrite with angle) with `ref: attribution_code`. Prod check 2026-10-22: 34 of 34 first emails since 10-19 carry it.

**Follow-ups have no link and the wrong goal.** `lib/pitches/followup-composer.ts:24` bare `HUNTER_URL`, passed as `hunter_url` at `:191`; the link is optional (`:157` "If you reference a free check/audit…"); the goal is "a 20-minute chat" (`:8`, `:132`, `:196`), against standing rule 8 (every cold-email CTA goes to the free check, no calls). `lib/pitches/followup-templates.ts` (the fallback) has no link. The follow-up route builds the email at `app/api/pitches/follow-up/route.ts:~371` and inserts the follow-up row at `:569-588` (no `attribution_code`; `pitch` there is the ROOT: `parent_pitch_id: pitch.id`). Prod 2026-10-22: 9 follow-ups sent, 0 links.

**Decisions (conductor):**
1. Tracked link: `${APP_BASE}/r/<code>?<same query as today without r and v>`; the route `app/r/[code]/route.ts` (GET) responds 302 to `https://runna-hunter.vercel.app/?<that query>&r=<code>&v=1`. The destination HOST is a constant, never read from the request (no open redirect). An unknown or malformed code still redirects (to the free check without r), never 404s a prospect. `APP_BASE`: the same origin the unsubscribe link uses (`lib/compliance/outbound.ts:17,61`: `UNSUBSCRIBE_BASE_URL`, default `NEXT_PUBLIC_APP_URL`; conductor-only folder, read-only; if no exported helper returns it, say so under "Needs conductor" and read the same env vars with the same fallback).
2. Click event: `recordPitchEvent(service-role client, { pitchId: <root pitch with that attribution_code>, type: "click", payload: { code, step: <0 first email / 1,2 follow-up, from a `s` query param you add>, ua: <user-agent, max 200 chars> } })`. Add `"click"` to `PitchEventType` (`lib/pitches/events.ts:17-28`). Frozen contract for `presend-learning`: event_type `click`, on the ROOT pitch, payload `{code, step, ua}`.
3. Noise: do not record for HEAD requests or user agents of known link scanners/prefetchers (state your list, e.g. Microsoft Safe Links, Barracuda, Proofpoint, Mimecast, `bot`/`preview`/`scanner` substrings); at most one recorded click per pitch per 10 minutes. Record nothing for test addresses (the pitch's recipient passes `isTestAddress`, `lib/compliance/test-addresses.ts:34`).
4. Follow-ups: pass the root's tracked link (root's attribution_code, `s=1|2`) to the composer and REQUIRE it on its own 👉 line; replace the "20-minute chat" goal with the free check as the one CTA (no call request, standing rule 8); the template fallback appends the 👉 line when absent. The follow-up row keeps `attribution_code` null (the code belongs to the root).
5. Readers of the link that must keep working (grep-derived): `resolveCtaLink` (`claude-composer.ts:695-712`, matches `hunterUrl` literally); `heldBodyForRevision` / `RESOLVED_HUNTER_LINK_RE` (`claude-composer.ts:254-270`, matches the `HUNTER_URL` prefix to turn a stored link back into `{hunter_url}` before a rewrite, so the rewrite does not inherit the old code: it must ALSO match the new tracked prefix, tested with a fake model that copies its input); `send-gate.ts:371` (literal `{hunter_url}` check); exemplar scrub of the 👉 line (`exemplars.ts:760-776`, host-agnostic, confirm); `industry-templates.ts:18-28,558` (template first emails: give them the tracked link too when a code exists).

## Brain lessons
none matched (second brain not attached).

## Files
Allowed to edit: `lib/pitches/hunter-mapping.ts`, `lib/pitches/events.ts` (the union only), `lib/pitches/followup-composer.ts`, `lib/pitches/followup-templates.ts`, `lib/pitches/claude-composer.ts` (`RESOLVED_HUNTER_LINK_RE` / `heldBodyForRevision` only), `lib/pitches/industry-templates.ts` (link only), `app/api/pitches/follow-up/route.ts` (link plumbing only), `app/r/[code]/route.ts` (new), `tests/tracked-links.test.ts` (new), existing tests that pin the old link (name them).
Read only: `lib/pitches/pitch-stage.ts` (no change needed if `buildHunterUrlForPitch` returns the tracked link; if you must touch it, only the two call sites), `lib/compliance/*`, `lib/learning/reward.ts`, `runna-hunter` (clone at /home/user/runna-ad/runna-hunter if present).
Forbidden: `lib/supabase/*`, `lib/compliance/*`, `vercel.json`, migrations, `app/api/replies/*` (another worker), `lib/learning/*`, `lib/autopilot/*`.

## Must not change (negative set)
- The free check still receives every parameter it receives today, in the same names.
- A rewrite of a held draft never carries the old pitch's code (batch 6 bug class): test with a fake model that copies its input.
- Unsubscribe link, footer, List-Unsubscribe headers untouched.
- The send gate verdict for today's first-email bodies (other than the link host) is unchanged.
- Follow-up stop rules (reply/bounce/OOO pause, thread re-read before send) unchanged.

## Acceptance checks
1. Redirect tests: valid code → 302 to the free check with all params + `r`; unknown/malformed code → 302 to the free check without `r`; an attacker-supplied `?to=`/host param is ignored; HEAD and scanner UA record nothing; a second click within 10 min records nothing; a test-address pitch records nothing.
2. Click lands on the ROOT: code of a root pitch → event on it; a follow-up link (`s=2`) → same root.
3. Follow-up composer prompt and payload snapshot: free-check CTA required, no "20-minute chat" or call request; template fallback contains the 👉 tracked line.
4. `heldBodyForRevision` turns both the old link and the new tracked link into `{hunter_url}`.
5. `npm run typecheck && npm run lint && npm test && npm run build` green; count reported.

## External prerequisites
none (the route lives on the existing Vercel project; the domain is the one the unsubscribe link already uses).

## Prod verification
After deploy: the next first email and follow-up bodies contain `/r/<code>?`; `select event_type, count(*) from pitch_events where event_type='click' and event_at > <deploy> group by 1;` (expect ≥ 0; then the conductor clicks one link from a test-address email and confirms NO event is written, and the redirect lands on the free check).

## Out of scope
Changing what the free check does; open tracking (never); the reward weight of a click (presend-learning); website pitches (no link today, next batch).

## Questions already answered
Q: Should the follow-up row get its own code? A: No, the root's code; one timeline per conversation.
Q: Could link scanners inflate clicks? A: Yes; filter as in decision 3 and keep the payload ua so the conductor can audit.

## If blocked
Message the conductor with what you tried, what you need, and what you can still do meanwhile.
