# Lessons — S.P.A.M. / Runna CA Opportunity Engine

Running log of mistakes, root causes, and rules to prevent recurrence. Newest at top.

---

[2026-06-03] LESSON: Sentry cron monitor timeout — no AbortSignal on external API fetch calls
ROOT CAUSE: postmaster-sync and warmup-engine both had fetch() calls with no timeout. If Google/Gmail API hung, the Vercel function hit its 60s hard kill AFTER withMonitor sent in_progress but BEFORE it could send ok. Sentry saw: in_progress → silence → timeout.
RULE: Every external fetch() call must have AbortSignal.timeout(N). postmaster: 10s. IMAP connections: connectionTimeout 8s, greetingTimeout 5s, socketTimeout 12s. Also cap unbounded loops (IMAP checks) at a per-tick max.
TAGS: #bug #sentry #cron #imap #timeout

[2026-06-03] LESSON: Sentry checkinMargin too tight for Vercel Hobby crons
ROOT CAUSE: checkinMargin: 5 min caused false "missed" alerts — Vercel Hobby crons can fire 20-30 min late.
RULE: Always set checkinMargin: 30 for Vercel Hobby cron monitors. maxRuntime should match what the function SHOULD take, not the Vercel timeout ceiling.
TAGS: #sentry #cron #vercel

[2026-06-03] LESSON: GitHub Actions CI failed on first push — pre-existing lint errors + wrong Node.js version
ROOT CAUSE 1: Lefthook only lints staged files ({staged_files}), so pre-existing unused imports and type errors across the whole codebase were never caught locally. CI runs `eslint .` on everything — 12 errors appeared on first push.
RULE: Before connecting any project to GitHub for the first time, run `npm run lint` and `npm test` on the FULL codebase and fix all errors first. Don't rely on Lefthook alone — it only sees staged files.
TAGS: #ci #github #lint

[2026-06-03] LESSON: Node.js 20 in GitHub Actions can't run TypeScript test files
ROOT CAUSE: `node --test` on Node.js 20 can't resolve glob patterns for `.ts` files and has no built-in TypeScript support. Tests pass locally because dev machine runs Node.js 22+.
RULE: Always use `node-version: 22` in GitHub Actions workflows for TypeScript projects. Add `--experimental-strip-types` to the node test command: `node --experimental-strip-types --test --test-reporter=spec 'tests/**/*.test.ts'`
TAGS: #ci #github #nodejs #typescript

[2026-06-03] LESSON: ESLint flags `process`/`console`/`fetch` as undefined in scripts/ directory
ROOT CAUSE: ESLint treats .mjs files as browser environment by default. Node.js globals need to be explicitly declared.
RULE: In eslint.config.mjs, add an override for `scripts/**/*.mjs` with `languageOptions: { globals: { process, console, URL, fetch } }`. Also add `.claude/**` to ignores to stop ESLint scanning Claude worktree files.
TAGS: #ci #eslint #scripts

---

[2026-05-29] LESSON: ⛔ generatePitch silently failed when called from nested server action
ROOT CAUSE: generatePitch called requireUser() → createClient() → cookies(). In Next.js,
cookies() can be restricted inside nested server action chains (bulkRunPipeline → processSingleProspect → generatePitch). getUser() returned null, requireUser() called redirect('/sign-in') which throws a non-standard error — not instanceof Error. Our catch swallowed it, writeAuditLog also failed (no session), leaving pitch_gate_passed=false with zero trace.
RULE: Never call requireUser() inside a function that will be called from within another server action. Accept user+supabase as optional parameters and use the caller's already-authenticated instances. Pattern: `async function generatePitch(id, injected?: { user, supabase })`.
TAGS: #bug #nextjs #server-actions #auth #pitch

[2026-05-29] LESSON: Claude composer Zod validation failed on preview_text length
ROOT CAUSE: Zod schema had `max(150)` on preview_text. Claude occasionally returns longer strings. Hard max caused parse failure → full heuristic fallback for all pitches.
RULE: For LLM output validation, use `.transform()` to clip rather than hard `.max()` that fails. Pattern: `z.string().max(500).transform(s => s.slice(0, 150))`. Hard max is only appropriate for DB constraints where the field will be truncated at insert anyway.
TAGS: #bug #claude #zod #pitch

[2026-05-29] LESSON: Em dash violation detector penalized score but didn't remove the dash
ROOT CAUSE: detectViolations() counted em dashes and lowered quality_self_score but the dash was still in the final body string passed to the DB and sent to the prospect.
RULE: For banned characters/patterns in LLM output, STRIP them at output time, not just penalize the score. Detection ≠ removal. Pattern: replace em dashes in finalBody before returning. Score penalty is secondary signal; the output must be clean regardless.
TAGS: #bug #pitch #output-quality

[2026-05-29] LESSON: Supabase MCP was connected to SnapPad project, not S.P.A.M
ROOT CAUSE: MCP configured in Claude desktop app with SnapPad project ID. Every execute_sql attempt returned permission denied.
RULE: Supabase MCP project is configured in Claude desktop app settings (not settings.json). When switching projects, update it there. S.P.A.M = ybbrpqzbedaxsmotgtkh, SnapPad = brofoxamdozserkamudf.
TAGS: #supabase #mcp #project-confusion

[2026-05-29] LESSON: Pipeline gate scored on structural signals only before pain extraction
ROOT CAUSE: Pain extraction was running before deep research, giving Claude Haiku incomplete data. Pain points extracted from homepage-only content were generic and low-confidence.
RULE: Pipeline order matters: scrape → gate score (structural only, threshold=10) → deep research → SnapVerify → pain extraction (ONCE, on all data) → final score. Never extract pain points before you have maximum data.
TAGS: #pipeline #architecture #quality

[2026-05-29] LESSON: SnapVerify couldn't find founders because scraper missed About page
ROOT CAUSE: Shopify stores use /pages/our-story, /pages/about-us — not /about. KEY_PAGE_PATHS only matched /about pattern. The About page with founder bios was never scraped, SnapVerify had no names to work with.
RULE: KEY_PAGE_PATHS must include Shopify /pages/* variants. Always check both standard (/about) and platform-specific (/pages/about-us, /pages/our-story) patterns. When adding a new platform, audit its URL conventions first.
TAGS: #scraper #shopify #snapverify #contacts

[2026-05-29] LESSON: IMAP "not found" was treated as spam
ROOT CAUSE: checkMessageInbox returned {foundInInbox:false, foundInSpam:false} when email wasn't found. Engine wrote landed_in_inbox=false, counting it as spam. Warmup auto-paused at 100% spam rate on Day 1 even though emails actually landed in inbox (Pedro confirmed).
RULE: IMAP "not found in inbox or spam" must return null (pending), not false (spam). Also check Gmail category folders (Promotions, Updates, Social) before declaring not found — warmup emails from cold domains land there first.
TAGS: #warmup #imap #bug

---

[2026-05-28] LESSON: Handwritten Supabase types were missing fields causing widespread `as never` casts
ROOT CAUSE: `lib/supabase/types.ts` was manually maintained and lagged behind actual schema. Missing fields: `sender_inboxes.Update` lacked all gmail token fields and sends_today; `pitches.Insert` lacked preview_text; `discovery_source`/`source` enums lacked `denue` and `yelp`; `prospect_research.Update` lacked `updated_at`; `pitches.Update` lacked sender/contact foreign keys.
RULE: After any migration, immediately update `lib/supabase/types.ts` with new columns. Run `supabase gen types typescript` in a worktree to auto-generate. The `as never` cast is a red flag that a type gap exists — always fix the type, never paper over it.
TAGS: #types #supabase #typescript #architecture

[2026-05-28] LESSON: React hooks (useState, useEffect) cannot be imported from files used by Server Components
ROOT CAUSE: Added `useDebounce` hook to `lib/utils.ts` which is imported by Server Components. This caused "Ecmascript file had an error" at build time because hooks are client-only.
RULE: Client-side React hooks must live in a file marked "use client" or in a dedicated `lib/hooks.ts` that is only imported from client components. Never put hooks in shared utility files.
TAGS: #nextjs #react #server-components #bug

[2026-05-28] LESSON: `} as never)` replacement pattern requires careful regex — '}' closes object, ')' closes method call
ROOT CAUSE: When doing bulk replacement of `as never` casts, replacing `} as never)` with `}` dropped the `)` needed to close the Supabase method chain (`.insert()`/`.update()`).
RULE: When removing `as never` casts from Supabase chains, replace `} as never)` with `})` — the `)` belongs to the builder method, not the cast.
TAGS: #typescript #supabase #refactoring

---

[2026-05-28] LESSON: Generating pitches for prospects with no contact email is wasteful
ROOT CAUSE: The pipeline was generating full pitches (Haiku + Sonnet call) even when all three enrichment tiers (SnapVerify → Anymail → Hunter) came back empty. The pitch would land in `status=pitched` but the UI would show "no contact — pick one manually". An unsendable pitch is a wasted credit and a misleading pipeline outcome.
RULE: After contact enrichment, always gate on `prospect_contacts` having at least one non-null email before calling `generatePitch()`. If no email: `pitch_gate_passed=false`, return `needs_review`. Never auto-generate a pitch you can't send.
TAGS: #pipeline #contacts #gate #credits

[2026-05-28] LESSON: Brave people-intel queries can return wrong business (name collision)
ROOT CAUSE: In Test A, Brave query `"Adorn Boutique" CEO OR founder` returned Nicole Whitesell — CEO of a Portland OR boutique also named "Adorn", not the Calgary one. Generic boutique names are common enough to collide. This means SnapVerify can insert a wrong person's first name as the email guess.
RULE: Brave people-intel queries in snapVerifyEnrich should be scoped with the city/region when available. Improve query to: `"${companyName}" "${city}" CEO OR founder OR owner` and `"${companyName}" "${domain}" owner`. Also: when Haiku extracts people, it should cross-reference that the person is associated with THIS domain (not a homonym company). Short-term fix: add domain to the Brave query to narrow results.
TAGS: #snapverify #brave #data-quality #false-positive

[2026-05-28] LESSON: Old scraper inserted 7 garbage emails into prospect_contacts
ROOT CAUSE: The original scraper blindly extracted any string matching an email pattern from scraped HTML — including placeholder emails (`example@email.com`, `john.doe@email.com`), phone-numbers concatenated with emails (`922-2281intheknow@...`), and href garbage (`0j1780-709-8242hello@bougierougeboutique.comfirst`). These are useless and pollute the contact table.
RULE: The scraper email extraction regex must validate: (1) no leading digits/special chars in local part, (2) domain part matches a real TLD pattern, (3) not a known placeholder (example@, test@, john.doe@, abuse@). SnapVerify avoids this entirely by generating structured guesses (firstname@domain) rather than scraping raw strings. Consider a one-time cleanup migration to delete scraper contacts with malformed emails.
TAGS: #scraper #data-quality #contacts #bug

[2026-05-28] LESSON: Deno edge functions don't share tsconfig with Next.js
ROOT CAUSE: `supabase/functions/` directory was included in the root tsconfig, so Deno-specific globals (Deno.connect, Deno.resolveDns, Deno.TcpConn) and Deno URL imports caused TS errors in `npx tsc --noEmit`.
RULE: Always exclude `supabase/functions` from the root tsconfig.json `exclude` array. Deno edge functions have their own runtime types — they cannot be type-checked with Next.js tsconfig.
TAGS: #supabase #deno #typescript #edgefunctions

[2026-05-28] LESSON: Supabase CLI deploy requires `supabase login` first
ROOT CAUSE: `supabase functions deploy` returned 403 because the CLI wasn't linked/authenticated. The Supabase MCP also lacks deploy permissions.
RULE: Before any `supabase functions deploy` call, run `supabase login` and `supabase link --project-ref <ID>` first. Deploy edge functions manually — don't assume CLI auth persists across machines or sessions.
TAGS: #supabase #deploy #cli

[2026-05-28] LESSON: Email enrichment should be free-first, paid-last
ROOT CAUSE: Previous architecture ran Anymail+Hunter for every ≥70 prospect, burning API credits even when named people were already visible in scraped site content.
RULE: Three-tier waterfall for contact enrichment: (1) SnapVerify — free, uses scraped notes + Claude Haiku + SMTP edge function; (2) Anymail Finder — paid, verified decision-maker; (3) Hunter.io — paid, domain sweep. Short-circuit on first success. SnapVerify alone handles Google Workspace + Microsoft + SMTP-reachable domains.
TAGS: #contacts #enrichment #cost #architecture

[2026-05-26] LESSON: Pain points must be evidence-backed, not AI-inferred
ROOT CAUSE: Structured research generates pain points (e.g. "no email capture", "cart abandonment") for most prospects regardless of whether the scraped content actually showed that signal. The AI infers from industry pattern rather than real source data — so every boutique ends up with the same 3 pains. This dilutes the pitch: if the pain isn't real and specific, the email reads generic.
RULE: Every pain point in prospect_research MUST have a non-null, non-empty evidence_quote pulled from actual scraped content (website copy, about page, product page, etc.). Pains with no quote = AI assumption = should be filtered out before scoring or pitch generation. When auditing: check if evidence_quote is just a rephrased version of the pain label (that's also fabrication). Real evidence sounds like "Free shipping on orders over $75" or "Sign up for our newsletter" — not "likely uses email marketing."
TAGS: #quality #research #pain-points #pitch

---

[2026-05-29] LESSON: ⛔ BIG FAIL — Code reaper removed active Hunter/Anymail logic by assuming "no API key"
ROOT CAUSE: The code reaper found Hunter and Anymail imports and calls, and judged them "dead code" because it didn't check `.env.local`. Both `HUNTER_API_KEY` and `ANYMAIL_FINDER_API_KEY` were set and working. The reaper removed the entire enrichment blocks from `scrape-action.ts` and `crawl-action.ts` without verifying env var existence first.
WHY IT'S COSTLY: Pedro caught this in code review — the entire contact enrichment pipeline would have been silently broken in production. Score-gated enrichment at ≥70 (the core monetisation-preserving mechanism) would have fired nothing.
RULE: Before removing ANY integration code, ALWAYS run `grep -r "ENV_VAR_NAME" .env.local .env* 2>/dev/null` to confirm whether keys exist. "I don't see it being used" is NOT the same as "it isn't configured". Dead-code determination requires verifying the full runtime context, not just static imports.
TAGS: #big-fail #reaper #hunter #anymail #contacts #pipeline

[2026-05-29] LESSON: ⛔ BIG FAIL — Crawl-time Anymail/Hunter was burning credits on ALL prospects (wrong design)
ROOT CAUSE: `crawl-action.ts` had a block that ran Anymail → Hunter for EVERY newly discovered prospect immediately at crawl time, before any scoring. Score doesn't exist at crawl time so there was no gate. This meant every Yelp, DENUE, or Brave result (even ones that would score 20 and get suppressed) spent paid API credits on contact lookup.
WHY IT'S COSTLY: Anymail and Hunter have credit-based billing. Running them on 100 raw prospects to keep 15 is ~85% credit waste. The correct design is SnapVerify (free) at Pass 1, then Anymail → Hunter only for score ≥70 in the pipeline.
RULE: Paid enrichment APIs (Anymail, Hunter) must ONLY fire inside `enrichContactsForProspect()` which is called from `processSingleProspect()` after the score ≥70 gate is confirmed. SnapVerify (free) runs earlier. No paid tier runs at crawl time or before scoring. If you see Anymail/Hunter imports in crawl-action.ts — that's a bug.
TAGS: #big-fail #credits #anymail #hunter #pipeline #architecture

[2026-05-29] LESSON: ⛔ BIG FAIL — Ran Supabase migration against wrong project (SnapPad instead of S.P.A.M)
ROOT CAUSE: The Supabase MCP was connected to `brofoxamdozserkamudf` (SnapPad) but S.P.A.M uses `ybbrpqzbedaxsmotgtkh`. Ran the full 0016_warmup_system.sql migration — 5 tables + 52 seed rows — into SnapPad. Had to manually drop all created tables from SnapPad and re-run in the correct project.
WHY IT'S COSTLY: SnapPad is a live production app. Injecting warmup tables into it polluted the schema. Could have corrupted data if any table names collided.
RULE: Before ANY Supabase SQL execution, confirm the active project ref matches the current task's project. Check `mission-control_3.html` or `.env.local` for `NEXT_PUBLIC_SUPABASE_URL` and verify it contains the correct project ID. S.P.A.M = `ybbrpqzbedaxsmotgtkh`. SnapPad = `brofoxamdozserkamudf`. These must never be swapped.
TAGS: #big-fail #supabase #wrong-project #migration

[2026-05-29] LESSON: Pipeline diagram presented incorrect Stage 1 enrichment as correct design
ROOT CAUSE: When asked to map the full pipeline, described crawl-time Anymail/Hunter as intentional architecture ("runs immediately for every new prospect with a domain"). This was actually a bug in the code — not intentional design. The diagram normalised the bug rather than flagging it.
RULE: When documenting pipeline logic, READ the actual code first and flag anything that looks architecturally wrong. "The code does X" is not the same as "X is correct". If a pipeline step fires paid APIs without a quality gate, that must be called out as a suspected bug, not documented as intended.
TAGS: #pipeline #diagnosis #documentation

[2026-05-29] PEDRO_OVERRIDE: SnapVerify should run in Pass 1 for all prospects, not just ≥70
PEDRO'S APPROACH: Move SnapVerify to run right after Structured Research (Pass 1), before initial score. It's free, uses already-scraped data, and gives the score a contact signal.
WHY IT WAS BETTER: SnapVerify is zero-cost. Running it early means: (1) the initial score reflects contact availability, (2) by the time a prospect reaches ≥70, we already know if free enrichment worked and can skip straight to Anymail/Hunter. No downside to running it early.
RULE: Free enrichment (SnapVerify) runs in Pass 1 for every prospect with a domain. Paid enrichment (Anymail, Hunter) runs only at ≥70. Never conflate "runs early" with "runs expensively". Cheap things run eagerly; expensive things are gated.
TAGS: #override #pipeline #snapverify #architecture

[2026-05-26] LESSON: ⛔ BIG FAIL — Assumed API keys weren't configured without checking
ROOT CAUSE: The discovery run returned results from Google Places only. Rather than verifying the actual Vercel env vars first, Claude assumed Yelp and Brave "weren't configured" and told Pedro so. In reality all keys (YELP_API_KEY, BRAVE_SEARCH_API_KEY, DENUE_API_KEY, HUNTER_API_KEY) had been set for 4+ days. The real root cause was sequential execution in runAllSources: each runCrawl call was doing Anymail+Hunter enrichment per prospect (~80s per source), so 3 keywords × 3 sources = 720s+ → Vercel 504 cut the run after only Google Places completed. Yelp and Brave never got their turn.
WHY IT'S COSTLY: Pedro had to correct this explicitly. It wasted trust and time — he'd set up those keys himself and the false diagnosis implied his work was wrong.
RULE: BEFORE stating any integration "isn't configured" or "isn't set up", run `vercel env ls` (or equivalent) first. Never assume from symptoms alone. Always check the actual state.
FIX APPLIED: Moved Anymail+Hunter from runCrawl (per-discovery) to processSingleProspect (per-pipeline, score-gated at ≥70). Each runCrawl is now ~5s instead of ~80s. Sequential execution now completes in ~50-100s for a typical run — well under 300s Vercel limit.
TAGS: #bug #api #discovery #diagnosis #big-fail

---

[2026-05-25] LESSON: Playwright screenshots hit the login wall when using `npx playwright screenshot <url>` directly against a deployed app with auth.
ROOT CAUSE: Playwright CLI has no session state — it starts a fresh unauthenticated browser every time.
RULE: Always use the project's `scripts/screenshot-*.mjs` auth pattern (create Supabase session → inject cookie via `context.addCookies` or sign-in form fill → then navigate). Never use bare `npx playwright screenshot <url>` for authenticated pages.
TAGS: #bug #playwright #auth #screenshot

[2026-05-25] LESSON: Supabase MCP `execute_sql` and `apply_migration` tools silently require elevated permissions — they return "You do not have permission" for DDL and even SELECT on user tables.
ROOT CAUSE: The connected MCP token may be scoped read-only or the project-level MCP config doesn't include the management API scope.
RULE: Don't assume the Supabase MCP can run arbitrary SQL. For DDL migrations, write the SQL file locally and ask Pedro to paste into the Supabase Dashboard SQL Editor. For verification queries, try `execute_sql` but have a fallback (TypeScript compile check, or ask Pedro to confirm in the dashboard).
TAGS: #supabase #mcp #permissions #migrations

[2026-05-25] LESSON: Design God Mode and huashu-design are different passes with different outputs — don't conflate them.
ROOT CAUSE: Design God Mode = systematic polish (token consistency, component states, hover/focus, accessibility). huashu-design = philosophical audit (anti-AI-slop, information density for AI tools, the one "120% detail", empty state quality, typography expressiveness).
RULE: Run Design God Mode first (it fixes the broken stuff), then huashu-design as a second pass (it elevates what's working into something with character). The two complement; neither replaces the other.
TAGS: #design #workflow #huashu #process

[2026-05-25] LESSON: Empty states with only plain text and no visual weight communicate "broken app" not "no data yet."
ROOT CAUSE: Default EmptyState renders title + description as centered text — honest but passive. Users scan, not read. Without icon + CTA button, the page feels abandoned.
RULE: Every empty state needs three things: (1) an icon or visual element that reinforces *what* is empty, (2) a one-line title that's honest about the state, (3) a primary or secondary CTA button that takes the user to the next step. Never leave them with just text and a URL in prose.
TAGS: #design #ux #empty-states

[2026-05-25] LESSON: "plan already written" doesn't mean "already implemented" — always verify before assuming done.
ROOT CAUSE: The notable_clients tier plan was fully written (migration SQL, type, filter code) but the DB migration had not been applied. Code compiled cleanly because the type was declared manually in queries.ts, masking the missing column.
RULE: When a plan file exists and code looks complete, always verify DB state independently (check migrations list, query the column, or ask Pedro). TypeScript compiling ≠ schema applied.
TAGS: #migrations #schema #verification #supabase

[2026-05-23] LESSON: `import type` from a server-only module still bleeds into the client bundle in Next.js/Turbopack.
ROOT CAUSE: Even `export type { X } from "./server-module"` in a re-exporting file causes Turbopack to trace the dependency graph through the server module, pulling in `next/headers` into the client bundle.
RULE: Always split server-only types into a separate `types.ts` file with zero server imports. Client components import from `types.ts`; queries/actions import from `types.ts` too. Never re-export types from a file that also imports server-only modules.
TAGS: #bug #architecture #nextjs #server-client-boundary

[2026-05-23] LESSON: Inserting new table types into types.ts outside the `Tables` object causes `Property 'x' does not exist` errors.
ROOT CAUSE: Miscounted closing braces — the `Tables: {` block was closed one `};` early, so new table definitions were at the top-level `public` object instead of inside `Tables`.
RULE: When extending types.ts, always grep for `Tables:\|Views:\|icps:` to confirm nesting before adding. New tables go BEFORE the `Views` line.
TAGS: #bug #typescript

---

## [2026-04-25] LESSON: TypeScript status arrays drifted from the prospect_status enum

**What went wrong:** Six files (`STATUS_OPTIONS` arrays in detail-actions schema, prospect-detail, companies-page; `ColStatus` union + `COLUMNS` config + grouped `Record` keys in funnel-board; pipeline strip in dashboard) all referenced `"meeting_booked"`. The `prospect_status` enum in `0001_initial_schema.sql` actually has `"booked"` — `meeting_booked` is the value of a *different* enum (`opportunity_stage`). Anyone trying to mark a prospect as that stage would hit `invalid input value for enum prospect_status: meeting_booked` at runtime. Caught only when seeding screenshot fixtures.

**Root cause:** Two enums with overlapping but different value sets, and no single source of truth from DB → TS. The TS arrays were hand-typed from memory of the spec doc.

**RULE:** When TypeScript code references DB enum values, generate the union from `supabase gen types` (or at minimum, copy from the migration file with the path noted in a code comment). Add a Zod enum validator at the action boundary that lists every allowed value — typecheck won't help with strings, but Zod throws at request time so we hear about it before users do. For multi-enum domains (status vs opportunity_stage), name the TS unions explicitly to match: `ProspectStatus` and `OpportunityStage`, never share.

**TAGS:** #bug #schema #enum #drift

---

## [2026-04-24] LESSON: Splitting server-only queries from client-safe constants in the same module poisons the client bundle

**What went wrong:** `lib/discover/runs-queries.ts` exported both `listDiscoveryRuns` (server-only — imports `next/headers` via `createClient`) and `SOURCE_META` (a plain constant). The client `<DiscoverPage>` imported just `SOURCE_META` from that file. Next dragged the *whole module* into the client bundle, and Turbopack crashed because `next/headers` can't run in the browser.

The visible symptom: clicking the "Upload CSV" button in the smoke test timed out because the page never finished rendering — the topbar button never mounted.

**Root cause:** ESM module barrels are bundle-level, not symbol-level. A client component that imports `{ SOURCE_META }` from a file that also exports server code still pulls the server code into the bundle. Tree-shaking doesn't help — `createClient`'s top-level `import { cookies } from "next/headers"` runs at module-eval time.

**RULE:** Any `lib/<domain>/` module needs ONE of:
1. Server-only (uses `next/headers`, service role, etc.) — only server components or `"use server"` actions may import.
2. Client-safe (pure types + constants + helpers) — both server and client components may import.

Never mix in the same file. When in doubt, split into `queries.ts` (server) + `source-meta.ts` / `types.ts` / `helpers.ts` (client-safe).

**How to apply:** Before exporting a constant from a server module, ask: "will any client component want this?" If yes, move it to a sibling client-safe file. The split is cheap; the bundle bleed is annoying to diagnose.

**TAGS:** #bug #rsc #bundling #lesson

---

## [2026-04-24] LESSON: Don't pass Lucide icon components across the Server→Client component boundary

**What went wrong:** `/settings/layout.tsx` (server component) passed a TABS array with `icon: User` / `icon: Send` / `icon: Users` — the LucideIcon function references — down to `<SettingsTabs tabs={TABS} />` (client component). React 19 threw "Functions cannot be passed directly to Client Components", returning 500s on every /settings subroute. Sign-in kept re-rendering because the unsigned-in fallback was the only code path that didn't try to hydrate the crashing layout.

**Root cause:** Lucide icons are forward-ref React components — i.e. functions with `$$typeof: Symbol(react.forward_ref)`. React 19 + RSC serialization only passes plain JSON-compatible props across the boundary; functions get rejected unless annotated with `"use server"`.

**RULE:** When a client component needs React components as props, either:
1. Inline the list inside the client component (the fix here — moved TABS into `SettingsTabs`), or
2. Pass a string/enum id and resolve to a component inside the client component's own registry.

Do NOT pass React element types (including lucide-react icons) across the RSC boundary.

**How to apply:** Before writing a server component that forwards `children` / a config array to a client component, check every prop field — if any value is a function reference, either move the whole structure inside the client component or map by string id. The 500 error message is clear ("Only plain objects can be passed to Client Components"), but the symptom was a downstream redirect to /sign-in which obscured the root cause — always check dev logs first, not just screenshots.

**TAGS:** #bug #react-19 #rsc #server-components #lesson

---

## [2026-04-23] LESSON: supabase-js 2.47 types `.update()` / `.insert()` payload as `never` when Database type is hand-written

**What went wrong:** Wrote clean server actions for `case_studies` update + `case_study_pain_tags` insert. `npm run typecheck` failed with:
```
Argument of type '{ client_name: string; ... }' is not assignable to parameter of type 'never'.
```
Both calls ended up with `Row = never` in the `update<Row extends Relation['Update']>` generic even though `Relation['Update']` was a valid `Partial<Row>` type.

**Root cause:** `@supabase/supabase-js@^2.47.0` tightened the way `Schema` gets resolved from `Database`:
```ts
Schema extends (Omit<Database, '__InternalSupabase'>[SchemaName] extends GenericSchema
  ? Omit<Database, '__InternalSupabase'>[SchemaName]
  : never)
```
Our hand-written `lib/supabase/types.ts` satisfies `GenericSchema` structurally for `.select()` and `.insert()` on tables it fully describes (users), but when a table uses `Update: Partial<Row>` with a `Row` containing `unknown`-typed columns (case_studies.measurable_results) the inference falls through to `never`. Further, tables the local `Database` type doesn't declare at all (case_study_pain_tags before I added it) fall through the `Views: Record<string, never>` overload and resolve to `never` too. Reading operations worked because SELECT doesn't depend on the Relation['Update'] path.

Spent ~45 min trying to make the Database type satisfy GenericSchema — adding `__InternalSupabase`, rewriting `Insert`/`Update` as explicit non-Partial objects, changing `Views` to `Record<never, never>`. None of it cleared the error. The fix is known: generate types with `supabase gen types typescript`. We haven't run that yet because Phase 0 types.ts is hand-written and `types.ts` even says so.

**RULE (until generated types land):**
1. For any `.update()` / `.insert()` call that TS narrows to `never` with this pattern, cast the payload with `as never` at the call site, and keep a locally-typed variable above it so structural type safety isn't lost. Pattern:
   ```ts
   const payload = { ...fields... } satisfies SomeType;
   await supabase.from("case_studies").update(payload as never).eq(...)
   ```
2. Always add new tables to `lib/supabase/types.ts` the moment you query them — don't rely on "any string key" fallback through Views. A missing table type makes every `.from("unknown_table")` return `never` at runtime-silent typecheck cost.
3. When the Anthropic/Google creds land and we're about to use tables beyond case_studies/pain_tags, run `supabase gen types typescript --project-id ybbrpqzbedaxsmotgtkh > lib/supabase/types.ts` to replace the hand-written stub. That removes every `as never` cast in one stroke.

**How to apply:** If a supabase mutation typecheck fails with "not assignable to parameter of type 'never'", do NOT spend time restructuring the Database type. Cast with `as never`, leave a short comment naming this lesson, add a TODO referencing the generated-types migration, and move on. Document the table you touched in the TODO so the migration knows what to cover.

**TAGS:** #bug #supabase #typescript #lesson #typing-quirks

---

## [2026-04-23] LESSON: Next.js dev server in a git worktree needs its own `.env.local`

**What went wrong:** Started `npm run dev` inside `/Users/work/Projects/S.P.A.M/.claude/worktrees/pensive-wilson-3cc368` to smoke-test /case-studies. Server started but every request 500'd with "Your project's URL and Key are required to create a Supabase client!". Only the parent `/Users/work/Projects/S.P.A.M/` has `.env.local`.

**Root cause:** `next dev` reads `.env.local` from the current working directory, not from anywhere upward. Git worktrees are sibling directories — they don't inherit env from the main checkout. The `.env.local.example` was committed but the real `.env.local` is gitignored (correctly), so a fresh worktree starts dry.

**RULE:** When working in a worktree, copy the parent's `.env.local` into the worktree root before running dev/tests. One-liner:
```
cp ../../../.env.local .env.local
```
(Path depends on worktree depth — ours is `.claude/worktrees/<name>/`.)

Alternative: a `scripts/bootstrap-worktree.sh` that does this + any other worktree-local prep. Skipped for now — low friction to copy manually.

**How to apply:** First action in any worktree session that needs to run the app (not just typecheck / lint): `ls .env.local` — if missing, copy it from the main checkout. Typecheck and lint don't need env, so they work immediately.

**TAGS:** #lesson #dev-workflow #worktrees #env

---

## [2026-04-23] LESSON: Never fabricate metrics in seed data

**What went wrong:** Three of the ten case studies I seeded in the original `seed.sql` contained details I invented when I didn't have the real Rünna portfolio.
- **Niki** was seeded as "AI assistant for Mexican Spanish speakers, full brand + product launch" — the real Niki is a platform that places international students in Canadian institutions.
- **SnapPad** was seeded with a fabricated "+10% sales YoY, +50% email revenue" — those numbers are not in any Rünna source; Rünna actually did packaging design, no revenue claim.
- **DevFest** was seeded as "event brand + content system" — the real work was a Meta + Instagram ad campaign for DevFest Calgary 2024.

Pedro caught it when he handed over the real 2026 ESP deck. Had a pitch generator shipped these stories to real prospects, Rünna would have been caught lying about its own work — the exact opposite of the case-study-grounding moat.

**Root cause:** In early sessions I had partial / indirect information about Rünna's portfolio (the SAGA partner deck, the S.P.A.M. pitch) and filled in plausible-sounding metrics to hit the "10 case studies with measurable results" shape Pedro asked for. I treated "plausible" as sufficient. Plausible is not the same as verified.

**RULE:** Every measurable number that appears in `case_studies.measurable_results`, `hero_metric_en`, or `result_description_en` must be traceable to one of three sources:
1. A Rünna-owned document (deck, portfolio, case-study PDF, client-delivered report)
2. A direct Pedro assertion ("we did X for client Y, here's the number")
3. A client-authored artifact (testimonial, press release, public case study)

If none of those exist, the case study gets a deliverable-scoped entry (e.g. "Canadian retail packaging system") but **no numeric metric**. It's honest and still citeable. A case without numbers just means the Phase 3 pitch validator won't pair it with pitches that require a measurable result — it can still serve as a credibility anchor.

**How to apply:** When seeding any client-facing claim (case studies, testimonials, results, industry metrics), cite the source inline in the SQL comment. If I can't cite, I don't write the claim. When in doubt, ask Pedro rather than invent.

**TAGS:** #lesson #honesty #seed-data #case-studies #fabrication

---

## [2026-04-23] PEDRO_OVERRIDE: Pedro's full name is Pedro De Velasco, not Pedro Torres

**What Claude got wrong:** Every commit, every hardcoded string, every README reference used "Pedro Torres." Source is unclear — possibly I fabricated "Torres" from the very first session and it stuck because nothing ever corrected it, or picked it up from a stale handoff.

**Pedro's correction:** "my names is not Pedro Torres is Pedro De Velasco"

**RULE:** The user's full name is **Pedro De Velasco**. Use this in:
- All git commits (`--author` / `user.name`)
- Any hardcoded defaults in scripts or seed data
- README / docs
- User-facing copy where a real name is needed

**How to apply:** When setting git config or signing commits, use `Pedro De Velasco`. Never invent or assume a last name — if I don't know it from an authoritative source (the user typing it, their email signature, a verified memory), I ask or use "Pedro" alone.

**TAGS:** #override #naming #facts-not-assumptions

---

## [2026-04-22] PEDRO_OVERRIDE: Stop asking me to run things you can run yourself

**What Claude originally did:** Wrote code, committed it, then told Pedro: "run `npm install`, run `npm run dev`, visit /sign-up, test the flow, paste errors back." Treating Pedro as the verification layer for things Claude could verify directly.

**Pedro's correction:** "yo do it dont ask me to do things you can do alway try yourself first"

**Why it was better:** Pedro shouldn't be the one running `npm install` to find dependency resolution errors, or `npm run build` to find TypeScript errors. Those are verifications I can perform in my own shell — I have bash, I have the filesystem. Pedro is expensive attention; compile-time errors are cheap to catch. Using him as my test runner wastes cycles and shifts my failures onto him.

**RULE:** Before asking Pedro to run anything, try it yourself first:
- `npm install` — I can run it, see dependency errors, update versions
- `npm run build` / `typecheck` / `lint` — I can run these, read errors, fix
- `npm run dev` — I can start it (in background), hit routes via curl/fetch to check HTTP status, read logs
- Migration / SQL — I can apply via MCP when access is available
- Anything scriptable — I do it first, report the outcome, then only pause for input when truly blocked

**Only hand off to Pedro when:**
- Interactive browser UI testing (visual click/type flows — computer-use is sometimes available but slow)
- Account creation / purchases / financial actions (domains, cards, subscriptions)
- Credentials I don't have (API keys, OAuth consents)
- Business/brand decisions (what to name things, ICP priorities, legal posture)
- Approval gates (deploy, push, destructive ops)

**How to apply:** When finishing a code change, instead of "run this and tell me what breaks," run it myself, read the output, fix what breaks, THEN report to Pedro with "here's what's working and here's what I couldn't verify without your eyes on it."

**TAGS:** #override #autonomy #verification #respect-pedros-attention

---

## [2026-04-22] PEDRO_OVERRIDE: Trusted hallucinated handoff without verifying disk state

**What Claude originally suggested:** Accept the prior session's handoff claim that "~40% of Phase 0 is done" (dashboard shell, design system, 18-table schema, seed data, Supabase clients scaffolded, /design route live, 14 routes returning 200) and plan incremental work on top of that.

**What Pedro caught (and the truth):** Nothing existed. The directory `/Users/work/Projects/S.P.A.M/` was empty except for a `.claude/` folder. Prior agent's "What's built" section was aspirational / hallucinated. No package.json, no app/, no components/, no supabase/, no seed data. Phase 0 was at 0%, not 40%.

**Why it matters:** Had I not searched the disk before writing the plan, I would have produced an incremental plan referencing files that don't exist. Every subsequent step would have failed or introduced drift. Pedro would have wasted time debugging imports against phantom modules.

**Root cause:** Prior agent wrote a persuasive-sounding handoff document that matched the shape of real engineering output without being grounded in actual file operations. My initial instinct was to build on top of it without verification.

**RULE:** Before planning any work on an "existing" codebase described in a handoff document or prior session summary, verify disk state first:
1. `ls` the claimed project directory
2. Check for `package.json` / `go.mod` / equivalent
3. Read the actual file tree, not the described one
4. If handoff mentions specific files/schemas, check that they exist with `Glob` or `find`
5. If mismatch found, surface it to user BEFORE writing a plan — ask which is true

**When to apply:** Every session that starts with a handoff block, prior-agent summary, or "picking up from" context. Treat those as claims to verify, not facts to trust.

**TAGS:** #override #handoff #verification #trust-but-verify #session-start

---

[2026-05-23] SESSION WRAP — key decisions + state for next session:

SHIPPED THIS SESSION:
- Connection error root cause was trailing \n in Vercel API key → fixed with .trim()
- No-keepalive agent (https.Agent keepAlive:false) prevents stale TCP on Vercel warm starts
- Collapsed 3-stage to 2-stage Claude pipeline (Stage 1 deterministic + Stage 2 Sonnet)
- Pedro's 5 subject line engines wired into system prompt (Named+Numbered, Leak, Niche Mirror, Reframe, Peer Pressure)
- 8 industry fallback templates (Pedro-authored) replacing heuristic slop
- 3 hospitality sub-type templates: hotel, beach_club, villa_rental (from Templates_Cancun_LosCabos_Hospitality.docx)
- Hospitality calculator is LIVE at https://runna-hunter.vercel.app/ (same URL, hospitality mode built)
- All pitches now CTA to Hunter URL (hunter_url in payload) — Loom offer removed everywhere
- ICP "Suggest from name" wired to Claude Haiku (getClient() + full field coverage including excluded_keywords + size/revenue ranges)
- placesKeyConfigured passed from server → grid → drawer (no longer hardcoded false)
- 6 strategic ICPs created in DB: Alberta, Western CA, Eastern CA, CDMX, Norte MX, Sur MX/Destinos
- GOOGLE_PLACES_API_KEY confirmed set in Vercel — Places preview now active in /icp

RULE: ALL cold email CTAs → https://runna-hunter.vercel.app/ — no Loom, no call ask, no video offer. Hunter self-qualifies the prospect. This is permanent.

RULE: Hospitality prospects (hotel, resort, villa, beach club) get English templates by default — they market to North American travellers, English is the right language regardless of MX market setting.

OPEN ITEMS FOR NEXT SESSION:
- New sender inbox setup (Gmail OAuth + runnareach.com SPF/DKIM/DMARC warm-up)
- Clean DELETE of all test prospect rows in /companies
- Full UX/UI audit (screen by screen)
- Code reaper (dead imports, stubs, as never casts)
- Design God Mode + Huashu Designs (Pedro to clarify "Huashu")
- Learning section (Pedro to define scope)
- Analytics dashboard


[2026-05-23] LESSON: OAuth client secret invalid_client despite correct-looking value
ROOT CAUSE: Reading secrets from screenshots causes character misreads (l vs I, 0 vs O, etc.). The original secret had a lowercase `l` that was misread as uppercase `I`. Even after fixing that, the first creation dialog secret was already gone (Google only shows it once) leaving "Client secrets" section empty.
RULE: NEVER read secrets from screenshots. Always use the copy button, Download JSON, or Reset Secret to get a machine-accurate value. To validate credentials before deploying, curl Google's token endpoint with a dummy code — `invalid_grant` = creds OK, `invalid_client` = creds bad.
TAGS: #bug #api #oauth

[2026-05-23] LESSON: UX audit — calling intentional empty states "bugs"
ROOT CAUSE: Did a screen-by-screen audit without full product context. Flagged Funnel "Empty." columns and disabled discovery source buttons as bugs when they are correct intentional behavior. Pedro called it out.
RULE: Before flagging something as broken in an audit, ask "could this be intentional given the product's state?" Empty states that depend on data (funnel with no prospects) are correct. Disabled buttons on locked features are correct. Only flag things that are unambiguously wrong (404 on a sidebar link, wrong copy, crashes).
TAGS: #ux #audit #overcalling

[2026-05-23] LESSON: vercel env add with echo adds a trailing \\n that breaks OAuth
ROOT CAUSE: `echo "value" | vercel env add KEY production` stores "value\n". Google OAuth rejects credentials with trailing whitespace — returns invalid_client.
RULE: ALWAYS use `printf "value" | vercel env add KEY production` (no -n flag needed — printf has no trailing newline by default). After adding any OAuth credential, verify with the debug-creds pattern (show length + last charCode) and curl Google's token endpoint with a dummy code to confirm invalid_grant (creds OK) vs invalid_client (creds bad).
TAGS: #bug #oauth #vercel #credentials

[2026-05-25] LESSON: noUncheckedIndexedAccess breaks string[0] even after truthiness guard
ROOT CAUSE: tsconfig has `noUncheckedIndexedAccess: true` — means `string[0]` returns `string | undefined` even when the string is confirmed truthy (TS doesn't narrow string to "non-empty" based on truthiness).
RULE: Use `.charAt(0)` instead of `[0]` for string character access. For array first-element access, use `arr.find(Boolean)` or destructuring with defaults. Always check tsconfig for noUncheckedIndexedAccess when debugging TS2532 errors.
TAGS: #bug #typescript #config

[2026-05-25] LESSON: .returns<T>() before .maybeSingle() doesn't fix never — maybeSingle() overwrites the type
ROOT CAUSE: In supabase-js, `.returns<T>()` overrides SELECT row type but `.maybeSingle()` wraps the result in its own narrowing. When the base table type is `never` (table not in schema types), `.returns<T>().maybeSingle()` still resolves data as `never`.
RULE: For single-row queries on tables missing from types.ts, cast the raw result directly: `const r = rawData as unknown as MyType`. For list queries, `.returns<Row[]>()` at the END of the chain (before `.eq()` calls are already processed) works. Don't put `.returns<T>()` before terminal calls like `.maybeSingle()` or `.single()`.
TAGS: #bug #typescript #supabase

[2026-05-26] LESSON: Supabase select("col1, col2") returns `never` without .returns<T[]>()
ROOT CAUSE: When querying columns via string select, TS infers the row shape from the Database type. Partial selects on tables with complex union types sometimes collapse to `never` due to how supabase-js generic inference works with Pick<>.
RULE: Any query that processes `data` rows (not just head/count) needs `.returns<MyLocalType[]>()` as the last chain call. Define the local type inline above the query. This is idempotent — it doesn't affect runtime, only satisfies TS.
TAGS: #bug #typescript #supabase
