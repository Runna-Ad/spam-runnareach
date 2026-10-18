# Brief: pitches-list-resilience

| | |
|---|---|
| Module | `lib/pitches/queries.ts` (listPitches only) + `/pitches` page and its component |
| Model / effort | sonnet-5.5 / medium (dashboard/query lane, promoted in batch 1) |
| Branch | `claude/pitches-list-resilience` from `claude/optimistic-tesla-3gceud` |
| PR target | `claude/optimistic-tesla-3gceud` |
| Reserved migration | none |
| Depends on | send-path-safety merged (pitches tasks run one at a time; batch 3 wave 2) |
| Conductor session | `session_017nqBxLFFXKbhDwKiPi6xLf` (send_message ONLY if blocked; the PR body is the report) |
| Size | S |

## Goal
`/pitches` is the page Pedro opens most, and today one failing side query takes the whole
page down: `listPitches` throws when the `pitch_events` lookup for hot-lead badges
errors. Make the list survive that: log the error, return every pitch with no hot-lead
level, and tell the page so it shows a small honest notice ("Hot-lead badges couldn't be
loaded") instead of silently showing no hot leads. The main pitches query failing still
throws, as today (no list is worse than an error).

## Context the worker needs
- `lib/pitches/queries.ts` ~line 121–140: the events query and its `throw`.
- Only caller: `app/(dashboard)/pitches/page.tsx` → `components/pitches/pitches-page.tsx`
  (renders the badges and the "Hot leads" filter).
- Pick the smallest API change: e.g. `listPitches` returns `{ pitches, hotLeadsUnavailable }`,
  or a second exported function. Whatever you choose, the page is the only caller; update it.
- Notice copy (English UI): `Hot-lead badges couldn't be loaded. The list is complete; the "Hot leads" filter is unavailable.`
  When unavailable, disable the "Hot leads" filter rather than showing it empty.
- Log with `console.warn("[pitches] hot-lead events not loaded:", message)`.

## Files
Allowed to edit:
- `lib/pitches/queries.ts` (listPitches only)
- `app/(dashboard)/pitches/page.tsx`
- `components/pitches/pitches-page.tsx`
- `tests/pitches-hot-lead.test.ts` (add) or a new `tests/pitches-list.test.ts`

Read for context, do not edit: `lib/pitches/hot-lead.ts`.

Forbidden: every other file in `lib/pitches/`, `lib/supabase/types.ts`, `vercel.json`, migrations.

## Must not change (negative set)
- With both queries succeeding, the returned rows (every field) and the page are identical.
- A failing main pitches query still throws the same error.
- `getPitchCounts` untouched.

## Acceptance checks
1. `npm test` passes, including a test where the events query errors and the function
   returns all pitches with no hot level and `hotLeadsUnavailable: true` (fake client).
2. `npm run typecheck && npm run lint && npm run build` green.
3. PR body shows the notice's markup (or a screenshot if you run the app).

## External prerequisites
none

## Prod verification
`/pitches` loads (HTTP 200) after deploy; no new Sentry error for `/pitches`.

## Out of scope
The 200-row window that hides older hot leads; sharing `levelOf` with `reward.ts`; chip
colours. Write them in the lessons inbox if you see more.
