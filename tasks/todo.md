# S.P.A.M. — Current Todo

Plan file: `/Users/work/.claude/plans/users-work-downloads-spam-partner-deck-spicy-sparkle.md`
Deck: `/Users/work/Downloads/SPAM_Partner_Deck.pdf`

---

## Phase 0 — Foundation (shipped)

### Code scaffolding (complete)
- [x] Create tasks/ folder + seed lessons.md / research.md / todo.md
- [x] Log PEDRO_OVERRIDE about hallucinated prior handoff
- [x] Root configs (package.json, tsconfig, next.config, postcss, .gitignore, .env.local.example)
- [x] Directory structure (app/, components/, lib/, supabase/)
- [x] globals.css with Tailwind 4 @theme tokens + Geist fonts + Rünna brand palette
- [x] Root layout.tsx + redirect page.tsx
- [x] Dashboard layout shell (Sidebar, Topbar, UserMenu)
- [x] lib/utils.ts + lib/supabase/ (browser, server, service-role, actions, types)
- [x] UI primitives: Button, Card, Chip, EmptyState, Kbd
- [x] Keyboard shortcut registry (inside sidebar ⌘\)
- [x] 14 placeholder route page.tsx files
- [x] Supabase migrations: 0001 schema (~28 tables, RLS, pgvector), 0002 rebrand, 0003 refresh case studies
- [x] seed.sql (tenant, brands, services, pain taxonomy, ICPs, prompts, blackouts)
- [x] Case studies refreshed: 20 active rows from real Rünna 2026 ESP deck
- [x] /design showcase route
- [x] README.md
- [x] Auth flow: sign-in, sign-up, email domain allowlist, Pedro exception
- [x] Playwright + auth screenshot utility
- [x] Typecheck + Next 16 proxy convention + end-to-end green
- [x] Git init + several commits

---

## Active slice — /case-studies CRUD

Build grid of all 20 seeded cases with click-to-edit drawer, using data already in DB.

### Scope (agreed with Pedro)
- Drawer-based edit (not /[id] page) — 20 fixed cases, drawer lets you bounce between them
- Update only — no create/delete this slice (seed is fixed; prevents accidental portfolio damage)
- EN/ES completeness chips as indicators only — no "Translate with Claude" button yet (Anthropic key not in)
- Logo-or-initials fallback (all 20 rows have null logo_url, confirmed)

### Tasks
- [x] Add Drawer UI primitive (radix-dialog right-side sheet)
- [x] Add Input, Textarea, Label primitives
- [x] Server actions: list case studies w/ pain tags + services, updateCaseStudy, updatePainTags
- [x] CaseStudyGrid component (cards with logo/initials, hero metric, pain chips, EN/ES chips)
- [x] CaseStudyEditDrawer (form covering all EN/ES fields + pain tag selector + measurable results)
- [x] Wire app/(dashboard)/case-studies/page.tsx to real data
- [x] Typecheck + lint + dev-server smoke test (Playwright: 20 cards + drawer verified)
- [x] Log lessons + commit

### Verification (done)
- /case-studies renders 20 cards with hero metric + pain tag chips + EN/ES chips ✓
- All 20 show "ES missing" chip (no Spanish translations in seed) ✓
- Cards with testimonials show a quote icon in the top-right ✓
- Click card → drawer opens with all fields populated ✓
- Typecheck passes, lint clean on new code, dev server renders without errors ✓

### Slice Review

**What worked:**
- Scope stayed tight — drawer edit, update-only, no create/delete. 20 cases of fixed portfolio data didn't need more.
- `deriveCompleteness()` utility made it cheap to compute EN/ES coverage once and reuse on both the card and the page header stats.
- BilingualSection component inside the drawer (EN + ES side-by-side with a small "ES needed" chip) is the right UX for this case — Pedro can paste Spanish translations next to the English copy without context-switching.
- Playwright smoke test caught zero visual regressions and confirmed card count in one script.

**What didn't:**
- Spent ~45 min on the supabase-js 2.47 typing quirk before accepting the `as never` cast. Should have cast after 10 min and moved on — the cast is documented in lessons.md, and generated types will wipe it.
- Next.js dev server in the worktree needed `.env.local` copied — should have been first action, not a mid-slice debug. Logged as lesson.

**What I'd do differently:**
- Before writing mutations against supabase-js, run a 1-line test mutation to catch typing issues before writing 250 lines of component code on top.
- Add a `bootstrap-worktree` step that copies `.env.local` automatically when a new worktree is created.

**Tech debt introduced:**
- Two `as never` casts in `lib/case-studies/actions.ts` (flagged with comments referencing the lesson). Remove when generated types land.
- Drawer animations use custom CSS keyframes in `globals.css` instead of `tailwindcss-animate`. Fine for now; if we add more Radix overlays we should pull in the plugin.
- Measurable results uses a simple Input-based row editor. Fine for 3-5 rows per case; if cases grow to 10+ rows we'd want drag-to-reorder.

---

## Active slice — /icp CRUD

Build grid + drawer for managing Ideal Customer Profiles. 2 Alberta ICPs seeded. Unlike case studies, ICPs grow over time → full CRUD (create + update + soft-delete).

### Scope (agreed with Pedro, 2026-04-24)
- Grid of all ICPs with active-filter toggle (show inactive off by default)
- Click card → edit in drawer (same pattern as case-studies)
- "+ New ICP" button → drawer in create mode
- Soft delete only (`is_active = false`) — past pitches/opportunities may reference an inactive ICP
- Reusable `<TagInput>` primitive for 6 array fields (industry_tags, geo_regions, business_types, google_places_types, search_keywords, excluded_keywords)
- Places reachable-pool preview stubbed in this slice → shows "Google Places API key required" state until Google Cloud creds land

### Tasks
- [x] Add types for icps to lib/supabase/types.ts (existing Partial<Row> was fine for reads; writes use `as never` cast per 2026-04-23 lesson)
- [x] Build TagInput primitive (pill editor with Enter/comma/backspace)
- [x] Build Select primitive (market + language enum dropdowns)
- [x] Server actions + queries: list, create, update, softDelete ICP
- [x] IcpGrid + IcpCard (name, market flag, geo/industry chips, size range, active toggle)
- [x] IcpEditDrawer (Identity / Targeting / Geo / Size & Revenue / Keywords / Places sections)
- [x] Places reachable-pool preview stub (disabled w/ "Google Places API key required")
- [x] Wire app/(dashboard)/icp/page.tsx to real data + active filter
- [x] Typecheck + lint + Playwright smoke (2 cards, edit drawer, create drawer all verified)
- [x] Log lessons + commit

### Verification (done)
- /icp renders the 2 seeded Alberta ICPs ✓
- "+ New ICP" opens drawer in create mode with sensible defaults (market=CA, language=en, is_active=true) ✓
- Editing a tag-pill field: type + Enter adds pill, × button removes, comma-paste splits ✓
- Archive button in edit drawer footer (hidden in create mode) ✓
- Places preview button disabled with "Google Places API key required" state ✓
- Typecheck passes, lint clean on new code, dev server renders without errors ✓

### Slice Review

**What worked:**
- Reusing the case-studies drawer pattern made this slice fast — same Drawer, same Section/Field helpers, same save/error flow.
- Applied the supabase-js typing lesson immediately — `as never` casts on insert/update from the start, no rabbit hole this time.
- `TagInput` is genuinely reusable — clean API (`value` + `onChange`), Enter/comma/backspace/paste all work, × per pill. Already eyeing it for /settings/users (invite by email list) and the Phase 1 Discovery keyword tuning.
- Soft delete via `is_active=false` + UI filter toggle scales — ICPs never disappear from history.

**What didn't:**
- First draft of `lib/icp/actions.ts` had a stray `RUNNA_CA_BRAND_ID_PLACEHOLDER: never = null as never` line from a thought mid-write. Caught and removed before commit. Low impact but sloppy — should write actions start-to-finish in one pass.
- Places-preview stub is UX-only — no state handling for "preview in progress" or "preview failed". Acceptable since the button is disabled, but worth flagging.

**What I'd do differently:**
- Before writing a drawer with 6 TagInput fields, draft the FormState shape on paper first. Had to reshuffle `updateField` generic twice to satisfy the 4 different value types (string / string[] / boolean / enum).

**Tech debt introduced:**
- 3 `as never` casts in `lib/icp/actions.ts` (insert, update, soft-delete). Same rationale as case-studies — removable when generated types land.
- Places preview button is a no-op. Ticket to wire: add Places API integration in Phase 1 Discovery slice, then flip `placesKeyConfigured` flag in `icp-edit-drawer.tsx`.

---

## Active slice — /settings (Profile, Sending, Users + invite accept)

Three Phase-0 settings pages under a shared sub-nav, plus a public invite
accept route. Scope approved 2026-04-24.

### Scope
- `/settings/layout.tsx` — sub-nav tabs: Profile · Sending · Users
- `/settings/profile` — edit full_name, timezone (common-list Select + "Other…"), avatar_url
- `/settings/sending` — list sender_inboxes, +Add drawer (email/display_name/linkedin/daily_cap/paused), Gmail OAuth connect button **stubbed** until Google creds land
- `/settings/users` — members list + pending invitations + invite form + role change + remove (hard delete w/ confirm dialog). Email delivery **not wired** — Pedro copies the invite link manually
- Public `/invite/[token]/page.tsx` accept flow
- New `<ConfirmDialog>` primitive for destructive actions
- Self-protection: current admin can't demote themselves (prevents zero-admin lockout)

### Tasks
- [x] Update tasks/todo.md
- [x] Build /settings/layout.tsx with sub-nav
- [x] Build ConfirmDialog primitive
- [x] Build /settings/profile (full_name, timezone with common-list Select + Other, avatar_url)
- [x] Build /settings/sending (list + drawer + Gmail OAuth stub)
- [x] Build /settings/users (members + invitations + invite form + role change + remove w/ confirm)
- [x] Build public /invite/[token] accept-invite route (new account + signed-in paths)
- [x] Server actions for all pages + types extension (invitations, sender_inboxes, brand_instances)
- [x] Typecheck + lint + Playwright smoke across all 3 pages + invite accept form
- [x] Log review + commit

### Verification (done)
- /settings sub-nav active-tab state works ✓
- Profile renders with avatar fallback, role/tenant chips, editable fields ✓
- Sending shows empty state + "+ New sender inbox" + disabled "Connect Gmail" ✓
- Users: 2 members, invite form works, copy-link banner appears after invite ✓
- /invite/[token] renders full accept-invite form (email locked, name + password) ✓
- Typecheck + lint clean; Lucide-icon RSC crash caught + logged as a lesson ✓

### Slice Review

**What worked:**
- ConfirmDialog primitive is tight (80 LOC) and already reused from two delete paths (sender inbox + member remove).
- Splitting invite accept into "new user" (password form) vs "current user" (single button) keeps each branch simple.
- `listPendingInvitations` filters accepted + expired at query time so the UI never has to worry about stale rows.
- Last-admin protection lives in the server action (not the UI) so it's uncheatable.

**What didn't:**
- Lost ~10 min on the Lucide-icon RSC crash — the dev-log "Functions cannot be passed to Client Components" error made it obvious, but the visible symptom was a redirect to sign-in and I screenshot-debugged first. Log dev output before screenshots next time.

**What I'd do differently:**
- Start with the client-component RSC boundary check as an explicit step before writing any layout.tsx that forwards non-primitive props.

**Tech debt introduced:**
- Invite email is not actually sent — Pedro copies the link manually. Ticket: wire Postmark (or SES) transactional send when the account lands, plus accept-notification to the inviter.
- `removeMember` leaves a one-line window where the profile is deleted but the auth user might linger if `admin.auth.admin.deleteUser` fails. Logged error surfaces to the admin; a nightly cleanup job would close the gap properly.

---

## Active slice — ⌘K Command Palette

Topbar button already exists (text "Search or run command" with ⌘ K kbd) —
wire it. Use cmdk library (already installed).

### Scope
- `<CommandPalette>` client component using cmdk
- Global ⌘K (Cmd/Ctrl) listener to toggle open
- Topbar button click → opens the palette
- Sources: nav items (static), case studies (client_name), ICPs (name), members
- Navigation-only — selecting a case study or ICP lands on its page (no
  drawer-deep-link in v1; defer to a separate slice if needed)

### Tasks
- [x] Server action: fetch searchable items once per palette open
- [x] CommandPalette component (cmdk + Dialog wrapper + keyboard shortcut)
- [x] Wire Topbar button + global ⌘K listener
- [x] Typecheck + lint + Playwright smoke
- [x] Log review + commit

### Verification (done)
- ⌘K opens palette; Topbar button opens palette; ESC closes ✓
- "ford" surfaces all 3 Ford case studies ranked first ✓
- Enter navigates to /case-studies ✓
- "alberta" surfaces the Alberta DTC ICP + team members ✓
- Lazy-loads DB items on first open, cached for the session ✓

### Slice Review

**What worked:**
- `cmdk` is exactly the right primitive — 150 LOC to render the whole palette with fuzzy match, keyboard nav, groups, and ARIA.
- Single-source `loadPaletteItems` server action keeps all the joins in one place; cached via `loadedRef` on the client so re-opens are instant.
- `CommandPaletteProvider` context lets the Topbar button + global keyboard listener share state without a heavier store.
- Nav items are built client-side from the same `NAV_SECTIONS` registry the sidebar uses — no duplication.

**What didn't:**
- Cmdk's default fuzzy scoring is loose — "alberta" surfaces "Blues Real" as the first case-study hit because it includes "a"/"l"/"b". Functionally fine but surprising. Could tighten with a custom `filter` prop later; for now the right result is still in the list.

**What I'd do differently:**
- Pre-seed nav results and load DB items async in the background so first keystroke is instant even before `loadPaletteItems` returns. Current "Loading…" placeholder flashes for ~300ms on first open.

**Tech debt introduced:**
- No deep-link to open a case-study / ICP drawer directly from the palette — selecting a case study lands on /case-studies and the user has to click the card. Small follow-up: add `?edit=<id>` support to case-studies + icp grids.

---

## Active slice — Phase 1a (Discovery scaffolding, no-creds path)

Phase 1 total is ~20 hrs in the plan but 90% blocked on Google Cloud /
SerpAPI / BuiltWith / Unipile / Postmark / Slack creds. This slice (1a)
ships everything that doesn't need creds so Pedro can hand-curate
prospects today and Slice 1b plugs real engines into the scaffolding
when creds land.

### Scope
- `/compliance` page: Do-not-contact CRUD + blackout calendar viewer (both tables already seeded/ready)
- `/discover` page: run-history list, source-availability indicators, CSV
  upload path (the only discovery source that works without creds is
  `manual_upload`)
- `/companies` page: prospects list with filters (status, market, ICP),
  sort (score, created_at), empty state
- Pure utilities in `lib/discover/`:
  - `fuzzy-dedupe.ts` — name + domain normalization + similarity score
  - `role-email.ts` — detect info@ / sales@ / hello@ / support@ patterns
  - `mx-verify.ts` — `dns.resolveMx` wrapper for email-domain validation
  - `blackout.ts` — is-blackout-date check backed by `blackout_dates`
- Manual CSV upload → `prospects` rows with `discovery_source='manual_upload'`, dedupe on domain, role-email auto-flag

### Out of scope (defer to 1b when creds land)
- Google Places API integration
- Industry directory crawler (needs designing per-directory selectors)
- SerpAPI / Google search operator harvester
- BuiltWith / competitor mining
- Unipile / LinkedIn scraper
- Nightly cron runs
- Slack hot-lead webhook

### Tasks
- [x] Update tasks/todo.md
- [x] Types extension (prospects + discovery_runs + do_not_contact_list + blackout_dates + brand_instances)
- [x] Pure utilities (fuzzy-dedupe, role-email, mx-verify, blackout, csv parser)
- [x] Server queries + actions (DNC, prospects, runs, manual upload)
- [x] /compliance page (DNC CRUD + blackout calendar grouped by month)
- [x] /discover page (6 source cards w/ availability state + run history + CSV upload drawer)
- [x] /companies page (prospects table + search + status/market/ICP filters + 5 sort modes)
- [x] Typecheck + lint clean; Playwright smoke green (4 prospects upload + 1 MX filter)
- [x] Log review + commit

### Verification (done)
- /compliance: 14 seeded blackouts render grouped by month; DNC add → table updates ✓
- /discover: sources show ready/blocked w/ blockers stated; CSV upload inserts 4 rows; run shows complete in history ✓
- /companies: 4 uploaded prospects render with flags + missing-domain red flag chip; market=MX filter narrows to Smoke Four ✓

### Slice Review

**What worked:**
- Pure utilities are tiny and standalone — `fuzzy-dedupe`, `role-email`, `mx-verify`, `blackout`, `csv` total ~250 LOC and have zero external deps. Easy to unit-test later.
- Source-availability metadata in a separate `source-meta.ts` file lets the client palette + future cron + this UI all share one source of truth.
- CSV upload UX with file-drop + preview table + per-row errors + dedupe count keeps the trust loop tight — Pedro can see what'll happen before clicking Import.
- Reusing existing primitives (Drawer, ConfirmDialog, Chip, Select, Input) made all three pages fast to assemble.

**What didn't:**
- Lost ~5 min on a server-only-import-bleeding-into-client-bundle issue. `lib/discover/runs-queries.ts` exported both server queries AND the client-safe `SOURCE_META` constant — importing from `<DiscoverPage>` (client) dragged `next/headers` into the client bundle and crashed with "You're importing a component that needs `next/headers`". Fixed by splitting into `runs-queries.ts` (server) + `source-meta.ts` (client-safe).

**What I'd do differently:**
- Default rule: any `lib/<domain>/` module that contains BOTH server-only queries and shared types/constants gets split into two files (`queries.ts` server, `types.ts` or `meta.ts` client-safe) up front.

**Tech debt introduced:**
- Manual CSV upload doesn't yet run MX-verify per row — `mx-verify.ts` is written but not wired. Easy add when Pedro wants email-domain validation; today the only red-flag is `missing_domain`.
- DNC matching is set up at the table level but not yet enforced at send-time — that gate lives in Phase 4 (send queue). The data is captured correctly in the meantime.
- /discover "Run discovery" buttons for blocked sources are present-but-disabled stubs. Slice 1b will replace them with real source runners (Google Places, SerpAPI, BuiltWith, Unipile) when creds land.

---

## Active slice — Prospect detail page (/companies/[id])

Click on any /companies row → opens a detail page with editable Overview,
Research notes, and Activity log. Also adds a "Scrape website" stub
button (real scraper lands as the next slice). Uses a separate
`prospect_research` table (not JSONB on prospects).

### Scope
- New migration: `0004_prospect_research.sql` creating `prospect_research`
  table (1:1 with prospects, FK + RLS)
- Server queries + actions for read/write of research + status transitions
- /companies/[id] page with tabs: Overview · Research · Activity
- Click-through from /companies list rows
- ConfirmDialog for status transitions to terminal states (won / lost / suppressed)
- "Scrape website" button stub that reads "scraper lands in next slice"

### Tasks
- [x] Update tasks/todo.md
- [x] Migration: prospect_research table (file written, awaiting Pedro to apply via SQL editor)
- [x] Apply migration (auto-apply via REST not possible — Pedro pastes SQL once)
- [x] Types extension
- [x] Queries (getProspect, getProspectResearch, listProspectActivity)
- [x] Actions (updateProspect, upsertResearch, transitionStatus, scrapeWebsiteStub)
- [x] Build /companies/[id] page + ProspectDetail client (3 tabs)
- [x] Wire click-through from /companies
- [x] Status transitions w/ ConfirmDialog (terminal states only — won/lost/suppressed)
- [x] Typecheck + lint clean; Playwright smoke captures all 3 tabs
- [x] Log review + commit

### Verification (done)
- Click /companies row → lands on /companies/[id] ✓
- Overview: editable form with company info, location, scoring; saves ✓
- Research: gracefully shows "table not yet created" empty state w/ migration link until Pedro applies 0004 ✓
- Activity: shows "Added to pipeline" entry ✓
- Status select w/ confirm dialog when going to won/lost/suppressed ✓
- Schema-cache error gracefully detected (PGRST205) — page never crashes ✓

### Slice Review

**What worked:**
- The 3-tab layout (Overview / Research / Activity) maps cleanly to how
  the data gets used at different stages of the pipeline.
- "Research table missing" empty state with a direct link to the SQL
  editor is way better UX than an opaque 500. Pedro can self-serve.
- Reused the entire `<ConfirmDialog>` + tag-pill + drawer-form pattern —
  zero new primitives needed.
- Status transitions are gated server-side; the UI just calls the action
  and the server enforces who can do what.

**What didn't:**
- Tried to auto-apply migrations via REST — Supabase doesn't expose a
  generic SQL endpoint. `apply-0004.mjs` is left as a stub that prints
  the SQL editor URL. Should just commit the script as a no-op until we
  add a `pg` dependency for direct connections.

**What I'd do differently:**
- Add `pg` as a dep next time we need to apply DDL — it's worth one tiny
  dependency to remove Pedro's "paste SQL" step.

**Tech debt introduced:**
- `apply-0004.mjs` doesn't actually apply anything. Could replace with a
  `pg`-based applier in a follow-up.
- Activity feed is hand-rolled from prospects + research timestamps. Real
  audit_log integration lands when we wire write-side hooks (probably
  Phase 4 or a dedicated slice).
- Pain points editor stores `pain_label` (free text) — eventually we want
  it to pick from `pain_taxonomy.id`. Add a combobox in the next iteration.

---

## Active slice — Site scraper (Cheerio)

Wires the "Scrape website" button on the prospect detail page. Fetches
the prospect's homepage + key pages, extracts what_they_do / tech stack /
contact links / social, writes into `prospect_research`. Pure code, no
external creds. When Anthropic credits land, Claude consumes this scraped
output as input for higher-quality research.

### Scope
- `lib/research/scraper.ts` — pure scraping logic
  - `fetchHtml(url)` — Node fetch, polite UA, 15s timeout, follows redirects
  - `parseSite(html, baseUrl)` — cheerio extraction
  - `detectTechStack(html)` — fingerprint matching against ~15 known platforms
    (Shopify, Klaviyo, Webflow, WordPress, HubSpot, Stripe, GA, Meta Pixel, etc.)
  - `extractWhatTheyDo($)` — og:description / meta description / h1+first paragraph
  - `extractContacts($)` — mailto: links + plaintext email scan
  - `extractSocials($)` — known social-domain hrefs
- `lib/research/scrape-action.ts` — replaces `scrapeWebsiteStub`. Calls scraper,
  upserts `prospect_research` with method='scraped', sets last_scraped_at.
- Prospect detail UI: refresh research display after successful scrape.

### Out of scope (future)
- Multi-page crawl (about, pricing, contact) — homepage only for v1
- Robots.txt respect — add when scaling to nightly cron
- Storage of raw HTML (saved as text in DB column for now; move to Storage later)
- JS-rendered SPAs (no headless browser this slice — Cheerio sees only server-rendered HTML)

### Tasks
- [x] Update tasks/todo.md
- [x] Build scraper.ts (fetch + cheerio + 19 tech fingerprints + extractors)
- [x] Build scrape-action.ts replacing stub
- [x] Wire detail page to real action with `router.refresh()` + key remount
- [x] Test against real domain (shopify.com — clean detection, no false positives)
- [x] Typecheck + lint clean on app code; Playwright E2E smoke green
- [x] Log review + commit

### Verification (done)
- shopify.com end-to-end smoke: Shopify detected, what_they_do filled,
  6 socials + 2 key pages + 1 email found, 3 evidence URLs, status auto-bump
  raw → researched ✓
- Form fields re-mount after scrape (key={research?.updated_at}) so Pedro
  sees the scraped values ready to edit ✓
- Tightened fingerprints — no false positives (Shopify scrape returns
  ['Shopify'] alone, not also WooCommerce/WordPress)
- Network failures (parked domain, timeout, 404) surface friendly errors

### Slice Review

**What worked:**
- 19 fingerprints cover the real platforms we'll hit in DTC + agency
  prospecting. Asset-URL + meta-generator matching is way more accurate
  than substring-on-html.
- Merge logic preserves human edits — only fills empty fields, unions
  tech_stack arrays, strips prior `[Scraped …]` blocks before appending.
- Polite UA + 15s timeout + 2 MB cap = sane defaults for cron use later.
- The `key={research?.updated_at}` remount trick was the right fix for
  the prop-vs-state-after-server-action issue.

**What didn't:**
- First fingerprint pass had false positives — Shopify's marketing copy
  mentioned "WooCommerce" and "WordPress" and matched my too-loose regex.
  Fixed with tighter asset-URL + meta-generator patterns.
- runna.agency timed out — the domain is parked at Namecheap with no site
  deployed yet. Scraper handled it correctly (network error surfaced).

**What I'd do differently:**
- For v2: respect robots.txt (parse + cache per-host).
- Add 2-3 internal-page crawl (about, pricing) to enrich `what_they_do`.
- Save raw HTML to Storage (currently truncated/discarded after parse).

**Tech debt introduced:**
- No retry on transient errors (single attempt). Phase 1b cron should
  add exponential backoff.
- Tech fingerprints are statically defined — eventually we'd want a
  config table so non-engineers can extend them.

### Verification
- Click "Scrape website" on a prospect with a real domain → research fields
  populate (what_they_do, tech_stack, contact emails, evidence URLs)
- Tech fingerprints work on a known case (e.g. shopify.com → ["Shopify"])
- Existing manual research isn't clobbered if user already had notes
  (merge: scraper fills empty fields only, doesn't overwrite)
- Failure cases (404, timeout, NXDOMAIN) surface friendly error to UI
- Typecheck + lint clean

## Active slice — F→A→C→E (no-creds quartet, 2026-04-25)

Pedro picked the recommended order: type generation → research stub → bulk
actions → utility tests. Sequenced because each one builds on the previous
and gets us closer to "credits land = 1 line swap per phase" cleanliness.

### Scope (agreed with Pedro)

**F — Generate Supabase types from DB (~30 min)**
- DONE = `lib/supabase/database.types.ts` exists + reflects current schema
- DONE = `createClient<Database>()` typed in both server + browser clients
- DONE = at least the most-touched 5 tables (prospects, prospect_research,
  scores, audit_log, icps) no longer need `as never` on update/insert
- DONE = typecheck passes; nothing visually changes in the app

**A — Stub `research-action.ts` (~1.5 hrs)**
- DONE = `lib/research/structured-research-action.ts` exists with
  `runStructuredResearch(prospectId)` server action
- DONE = heuristic body extracts pain-point candidates from scraped notes +
  cross-references `pain_taxonomy` evidence_phrases — populates
  `prospect_research.pain_points` with `{pain_id, pain_label, evidence_quote}`
- DONE = decision-maker stub: best email from `prospect_research.notes`
  (already extracted by scraper) → row in `prospect_contacts`
- DONE = clear "PHASE 2 SWAP POINT" comment marking the Claude line
- DONE = button on prospect detail Research tab → "Run structured research"

**C — Bulk actions on `/companies` (~1.5 hrs)**
- DONE = checkbox column in companies table, header checkbox = select all visible
- DONE = floating action bar appears when ≥1 selected, shows count
- DONE = bulk actions: Set status (raw/researched/pitched/suppressed),
  Score selected (calls scoreProspect on each in parallel),
  Unscored selected → run scrape + score chain
- DONE = optimistic updates with router.refresh on success
- DONE = audit_log captures bulk operations as one entry per prospect

**E — Tests for utilities (~1 hr)**
- DONE = `tests/csv.test.ts` covers: header detection, comma/semicolon
  delimiter, quoted fields, missing required cols, oversized rows
- DONE = `tests/mx-verify.test.ts` covers: valid CDMX/state names,
  RFC-style validation if present, edge case city names
- DONE = `tests/fuzzy-dedupe.test.ts` covers: domain-normalized match
  (www. prefix, http(s)://), name+city collision, false-positive guards
- DONE = `tests/blackout.test.ts` covers: weekend skipping, public
  holidays per market, blackout windows
- DONE = `npm test` runs all suites, all green

### Verification

After each slice ships:
- typecheck + lint clean
- relevant smoke screenshot taken
- single commit per slice with clear message
- lessons.md updated if anything bit me

### Credentials still blocked (waiting on Pedro)
- [ ] Supabase: ANON + SERVICE_ROLE keys live (connection works — Phase 0 unblocked)
- [ ] Anthropic API key + $100/mo limit
- [ ] Google Cloud (Places API + Gmail API + OAuth consent + OAuth client + restricted Places key)
- [x] Domains locked: runna.agency (primary) + runnareach.com (outreach secondary)
- [ ] Name sender #1 Runna CA principal + buy both domains + add runnareach.com to Rünna Workspace + DNS (SPF/DKIM/DMARC)
- [ ] Postmark or SES account
- [ ] Cal.com account
- [ ] Slack hot-lead webhook URL
- [ ] CRON_SECRET + TOKEN_ENCRYPTION_KEY (`openssl rand -hex 32`)

---

## Active slice — Phase 2 swap point #1: pitch generator (Claude) — 2026-04-27

Pedro: "go pitch 1st". Anthropic credits live (verified with a test
call to claude-sonnet-4-5-20250929 at 2.6s, ~21+13 tokens).

### Scope (Pedro confirmed: pitch first, my defaults for the rest)

Build shared Anthropic infrastructure THEN wire the pitch generator
swap point end-to-end. Heuristic stays as fallback when API fails or
spend cap is hit.

DONE looks like:
1. `lib/anthropic/client.ts` — single SDK instance + 15s timeout +
   retry (3x with backoff) + cost-tracking + structured JSON output
   helper that runs Zod-validated parsing on responses.
2. `lib/anthropic/cost-tracking.ts` — write to `cost_tracking` table
   per call (model, input_tokens, output_tokens, cost_usd, action,
   prospect_id?). Daily-cap guard via `ANTHROPIC_DAILY_USD_CAP` env
   (default $5).
3. `lib/pitches/claude-composer.ts` — drop-in replacement for
   `composePitchHeuristic`. Same `GeneratorInputs → ComposedPitch`
   shape. System prompt + user prompt template + Zod schema for
   response. Returns `method: "claude"` instead of `"heuristic"`.
4. `lib/pitches/actions.ts::generatePitch` — flips method based on
   `process.env.ANTHROPIC_API_KEY` presence + daily-cap state.
   Falls back to heuristic if Claude errors or cap is hit.
5. UI surface — pitch detail "How was this composed?" expander shows
   the actual prompt + reasoning when method=claude (transparency).
6. Browser verify — generate a real pitch on the Demo · Quebec Pet
   Food prospect, screenshot, confirm copy quality > heuristic.
7. Tests — mock the SDK and verify:
   - Successful Claude response parses + persists correctly
   - Malformed JSON falls back to heuristic
   - Rate-limit error falls back to heuristic + logs warning
   - Daily cap hit falls back to heuristic + emits hint

### Defaults Pedro implicitly approved with "go"

- Model: **claude-sonnet-4-5** (latest snapshot pinned in client config)
- Streaming: **yes** for pitch — server action streams body so the UI
  can show progressive reveal (Phase 4 follow-up if not in this slice)
- Cost cap: **$5/day** default, configurable via env
- Mock SDK in unit tests: **yes** (don't burn credits on test runs)

### Out of scope this slice

- Other 4 swap points (research, score, reply, ICP suggest) — separate
  slices once pattern is proven on pitch.
- Streaming UI — backend ready, but UI may render full-result first
  if the streaming integration is messy. Plumbing must support it.
- A/B variants — still single output. Phase 3 may add.

### Verification

- typecheck + lint clean
- npm test 99/99 still green + new mocked tests
- Browser screenshot of a Claude-generated pitch
- cost_tracking row appears in DB after generation
- Heuristic fallback tested by toggling ANTHROPIC_API_KEY off

---

## Active slice — Pitch quality 4-layer fix (2026-04-27)

Pedro caught a real quality bug after the first Claude pitch landed: the
prospect's pain was "checkout breaks on iPhone Safari" but the chosen
case study was Pet's Club (packaging design — wrong fit). Audit revealed
case_study_pain_tags is mostly empty, so the generator silently fell
back to "first available case study," and Claude only saw
`client_name + industry + hero_metric` — not the result description, so
it couldn't reason about semantic fit.

Pedro: "hagamos los 4 niveles del fix"

### Scope (all 4 layers, in order)

**Layer 1 — Richer Claude context (~10 min)**
- Add `result_description_en/es`, `testimonial_quote_en/es`, and
  `measurable_results[]` to the candidates_cases payload.
- Update system prompt: "if no case clearly addresses the prospect's
  pain, prefer case_study_id=null over forcing a bad bridge."

**Layer 2 — Allow `case_study_id: null` in response (~15 min)**
- Migration 0006: drop NOT NULL from `pitches.case_study_id`.
- Update zod response schema to allow null.
- Update generator types to mirror.
- Body template branches: if null, skip the "We helped X" line; lean on
  prospect's pain framing + soft CTA only.
- Heuristic generator gets a small NULL-friendly path too (it currently
  always picks something — make it return null when no case has any
  pain_strength).

**Layer 3 — Auto-tag empty case_study_pain_tags (~30 min)**
- One-time script `scripts/audit-case-pain-tags.mjs` that uses
  claude-haiku to score each (case, pain) pair from 0.0–1.0.
- Inserts pairs with strength ≥ 0.4 into `case_study_pain_tags`.
- Skips pairs that already exist (idempotent).
- Cost cap ~$0.10 total (20 cases × 15 pains × $0.0003 each at haiku
  rates with caching). Reports to console + audit_log.

**Layer 4 — Capture rejection reasons + downrank (~30 min)**
- Extend pitches detail UI: when rejecting, dropdown with reason kinds
  (`wrong_case`, `wrong_pain`, `tone_off`, `wrong_contact`, `other`)
  in addition to the free-text reason.
- transitionPitchStatus stores reason_kind in metadata.
- Generator reads recent rejection counts per (case_study_id, pain_id)
  and applies a downrank to that pair's effective strength
  (e.g. -0.1 per rejection in last 30 days, capped at 0).
- audit_log gets pitch.rejected with reason_kind so /today activity
  feed sees the signal.

### Verification

After each layer:
- typecheck + lint clean
- npm test green (add tests as needed for layers 2 + 4)

End-to-end after all 4:
- Re-run pitch on Demo · Quebec Pet Food (mobile checkout pain)
- Expected: Claude either picks a case that ACTUALLY addresses
  checkout/conversion, OR returns null + writes a generic-but-honest
  pitch
- Reject the pitch with reason_kind=wrong_case, regenerate, and confirm
  the previous case has a downrank applied next time

### Out of scope (future)

- Vector embeddings for semantic case matching — heuristic+LLM is
  enough for now
- Per-tenant tag strength learning — needs more rejection data first
- A/B variants — Phase 3 separate slice

---

## Phase 0 Review (to be filled when Phase 0 complete)

### What worked
_TBD_

### What didn't
_TBD_

### What I'd do differently
_TBD_

### Tech debt introduced
_TBD_

---

## 🔴 Next session checklist — updated priority order (2026-05-23)

> ❌ NEVER auto-insert contacts from scraping — prospects are being reset, this plan is cancelled.
> ❌ Notable clients tier filter (plan file) — parked until after reset + audit.

### OPERATIONAL (do first)

### 1. 📧 Email sender inbox
- Connect Gmail OAuth in /settings/sending (GOOGLE_CLIENT_ID + GOOGLE_CLIENT_SECRET already in Vercel)
- Configure runnareach.com SPF, DKIM, DMARC records
- Warm-up period before ANY live sends (cold domain = spam folder — critical)
- Wire the inbox to the pitch send queue

### 2. 🗑️ Company reset
- Clean DELETE of ALL test prospect rows — they were all test data
- Keep discovery_runs history if any (optional)
- ⚠️ CONFIRM WITH PEDRO BEFORE RUNNING — do not delete without explicit "yes"

### PRODUCT

### 3. 🔍 UX/UI audit
- Screen-by-screen punch list before touching anything
- Flag: inconsistent spacing, stale labels, disabled states that should be live, mobile breakpoints
- Cross-reference with live build at spam-runnareach.vercel.app
- Output a ranked list — don't fix anything during the audit pass

### 4. ✂️ Code reaper
- Dead imports, commented-out blocks, stubs with no callers, stale `as never` casts
- `npx tsc --noEmit` baseline is 64 errors — reduce where possible
- Remove `as never` where generated types now cover them

### 5. 🎨 Design God Mode + Huashu
- Ask Pedro to clarify "Huashu" before starting (specific design system? reference brand? visual direction?)
- Full visual pass: typography hierarchy, color token consistency, spacing, hover/focus states
- Target: Nike meets Vercel — dark, sharp, zero clutter

### 6. 📚 Learning section
- Ask Pedro to define scope before building: internal training? prospect-facing? agent docs?
- Build /learning route once scope confirmed

### 7. 📊 Analytics
- Pitch funnel metrics, cost tracking, Claude vs template breakdown, ICP match rates, funnel by status
- Decision needed: custom Supabase queries vs PostHog/Amplitude


---

## SESSION LOG — 2026-05-23 (Evening)

### Priority list (Pedro's order — do not change):
- [x] ✅ #1 Sender inbox — Gmail OAuth setup (pedro@runnareach.com connected, Runna Outreach brand, 30/day cap)
- [x] ✅ #2 Company reset — deleted all test prospects + cascading data (opportunities, contacts, research, pitches, replies)
- [x] ✅ #3 UX/UI audit — full screen-by-screen sweep + critical fixes deployed
- [x] ✅ #4 Code reaper — DONE: 68 → 0 TS errors. as-never casts across all supabase mutations, pitches query fix, dashboard name-casing, noUncheckedIndexedAccess char fix. Deployed 2026-05-25.
- [x] ✅ #5 Design God Mode + Huashu — DONE 2026-05-25. Full audit + implement: colored pipeline stages, hash-based case study avatars, discover button hierarchy, sidebar gradient + active indicator, user avatar gradient, ICP card improvements, learning empty states. 0 TS errors maintained.
- [x] ✅ #6 Learning section — built (prompt version control, A/B, Sunday proposals, diff view, approve/reject/rollback)
- [ ] ⏳ #7 Analytics — pitch funnel metrics, cost tracking, Claude vs template breakdown

---

### What was done this session:

**Gmail OAuth (#1)**
- Added `RUNNA_OUTREACH` brand_code enum + brand instance in DB
- Built `/api/auth/google/connect` + `/api/auth/google/callback` routes
- Added error surfacing (banner on /settings/sending for gmail_error + gmail_connected params)
- Root cause of `invalid_client`: Google client secret was misread from screenshot (`I` vs `l`), then after fixing that, original secret was gone (Google only shows it once). Reset secret in GCP console, updated Vercel with `printf` (no trailing newline), tested with curl → `invalid_grant` (correct), deployed → ✅ connected
- Debug endpoint `/api/auth/google/debug-creds` created + deleted after diagnosis

**Company reset (#2)**
- SQL: `DELETE FROM opportunities WHERE tenant_id = '...'` first (RESTRICT FK), then `DELETE FROM prospects WHERE tenant_id = '...'` (cascades contacts, research, pitches, replies)
- ICPs preserved (already updated to correct ones)
- Prompt variants, case studies, notable clients, brands — all untouched

**UX/UI audit (#3)**
- Full sweep: dashboard, discover, companies, pitches, funnel, opportunities, inbox, analytics, learning, settings/sending, settings/users, icp, case-studies, notable-clients, compliance, design
- Fixed: name casing (PEDRO → Pedro) in dashboard greeting + users table
- Fixed: "When Phase 4 sends pitches" → "When pitches are sent" in inbox empty state  
- Fixed: Phase chip removed from topbar + all PhasePlaceholder pages (Opportunities, Analytics, etc.)
- NOT fixed (intentional behavior, not bugs): Funnel empty columns, blocked source buttons, Brave Search "ready" chip
- Still open (minor): SnapPad "saales yoy" typo, "pool not computed" on ICP cards, activity log showing 15 stale entries

---

### Next session — start here:
**#4 Code reaper** — 68 TS errors currently. Goals:
- Remove dead imports + unused variables
- Replace `as never` casts with proper types where possible
- Delete stub/placeholder code that's been superseded
- Target: get TS errors to 0 or as close as possible
- Run `npx tsc --noEmit 2>&1 | grep "error TS"` to see current list

After reaper → #5 Design God Mode (wait for Pedro) → #7 Analytics

---

## SESSION LOG — 2026-05-25

### What was done this session:

**Design deployment catch**
- All Design God Mode + huashu-design changes were sitting uncommitted from previous session
- Committed 34 files + deployed via Vercel CLI (`vercel --prod --yes`)

**huashu-design second pass (P0 + P1)**

*P0 — Embarrassing empty states fixed:*
- Funnel: replaced 7× "Empty." void with guided pipeline-journey empty state (colored stage dots + CTA) when total=0; per-column contextual hints when individual columns empty
- Learning: status dots on every prompt row (green glow = champion, amber = active/not set, gray = inactive)
- Companies: Building2 icon + "Go to Discover" primary CTA button
- Pitches: Sparkles icon + "Go to Companies" secondary CTA button

*P1 — 120% detail:*
- Dashboard greeting: purple→pink left-border bar + radial brand glow (color-mix ~8% opacity)
- Learning page title: text-xl → text-2xl + tracking-tight

**Notable client tier filtering**
- Confirmed all code was already written from previous session (migration SQL, NotableClient type with tier, size filter in actions.ts)
- Pedro applied `0010_notable_clients_tier.sql` migration via Supabase dashboard
- All current clients (Ford, La Comer, DiDi, Aeromexico) default to 'enterprise' tier
- SMB prospects now get empty notable_clients → capability-focused pitch, no enterprise name-drops

### Still open:
- [ ] ⏳ #7 Analytics — pitch funnel metrics, cost tracking, Claude vs template breakdown
- [x] ⏳ #1C — Language + market detection in scraper (ALREADY DONE — detectLanguage + detectMarket in scraper.ts, write-back in scrape-action.ts)
- [ ] Minor: "saales yoy" typo in SnapPad case study (must fix in DB directly)

### Next session — start here:
Pick up with **#7 Analytics** (biggest remaining feature) or **#1C scraper** (smaller, self-contained).
Run `npx tsc --noEmit` first to confirm baseline is still 0 errors.

---

## Session 2026-05-26 — Analytics (#7)

### Completed
- [x] Created `lib/analytics/queries.ts` — 6 server queries: pipeline counts, pitch stats, cost summary, daily spend (14d sparkline), reply intents, ICP leaderboard
- [x] Built `app/(dashboard)/analytics/page.tsx` — replaced PhasePlaceholder with real data
  - Top-line KPI strip (prospects, pitches sent, reply rate, deals won)
  - Pipeline funnel (horizontal bars with stage colors + conversion rates strip)
  - Pitch quality panel (avg quality score, auto-rejected %, Claude vs heuristic acceptance bar)
  - AI spend panel (total + 30d, 14-day SVG sparkline, cost by category bars, per-pitch estimate)
  - Reply signals panel (wants_meeting / wants_info / hard_no highlights + all intents bars)
  - ICP leaderboard table (prospects / pitched / replied / won / reply rate per ICP)
  - Per-category cost footer strip
- [x] TS: 0 errors (was 0 baseline, still 0)
- [x] Build: clean
- [x] Deployed: https://spam-runnareach.vercel.app

### Review
What worked: Server component with parallel Promise.all for all 6 queries — fast initial load, no client JS bundle overhead. CSS-only bars + SVG sparkline = zero new dependencies. `.returns<T[]>()` pattern cleanly solves the Supabase `never` inference issue.
What to improve later: Add date range selector (last 7d / 30d / all time) — currently all-time except sparkline. Could also add case-study leaderboard when pitch volume grows.
Tech debt: `perPitchUsd` estimate uses cost_tracking "pitch" category rows as proxy for sent pitches — works for now but slightly off if pitches are drafted without sending.

### Next priorities
- [x] #1C — Language + market detection in scraper (already implemented)
- [ ] Minor — "saales yoy" typo in SnapPad DB (direct DB fix)

---

## Session 2026-05-26 — Discovery Pipeline Overhaul + Pitch Quality

### Completed
- [x] EmailBodyPreview component — live CTA button preview in pitch editor (mirrors buildHtmlBody, React JSX)
- [x] Gmail multipart/alternative — text/plain + text/html parts. 👉 CTA lines render as dark pill button to recipient
- [x] Stuck runs UX — "Close N stuck runs" button in run history (closeStuckRuns marks >15min running → failed)
- [x] Pitch voice fixes: (a) "Hi {first_name}" fallback → "Hi {company} team," never "Hi there,", (b) mandatory Runna one-liner intro as step 2, (c) CTA rewritten to explain Inefficiency Hunter tool
- [x] Discovery pipeline overhaul:
  - Removed Anymail+Hunter from runCrawl (was ~80s/source → Vercel 504 → Yelp/Brave never ran)
  - Contact enrichment moved to processSingleProspect, score-gated ≥70 only
  - pruneRunToTop30: after pipeline keep top 30 by match_score, hard-delete rest
  - Scraper already auto-saves contact emails found on site (kept)
- [x] Anymail key refreshed in Vercel
- [x] Deployed: https://spam-runnareach.vercel.app

### Where things stand (updated 2026-05-29)
Full pipeline live and correct:
  Pass 1: Scrape → Structured Research → **SnapVerify** (free, all prospects) → Initial Score
  < 35: suppressed. ≥ 35 → Pass 2: Deep Research → Structured Research → Final Score
  < 40: suppressed. 40–69: needs_review. ≥ 70: **Anymail → Hunter** → Pitch → Prune to top 30

All sources (YP CA / Google Places / Yelp / Brave / DENUE) complete in ~60s total.
Warmup live: Day 1 sent 5/5 emails, pedro@runnareach.com.
19 Alberta test prospects still in DB (below 30 cap).

### Backlog (priority order):
- [x] SnapVerify Tier 1 — built + wired into Pass 1 of pipeline
- [x] notable_clients tier column — migration 0010_notable_clients_tier.sql applied ✓
- [x] Language + market detection in scraper (Task 1C) — confirmed done ✓
- [x] Code reaper — 47 files cleaned, deployed (commit d254ebc)
- [ ] **Deploy verify-email edge function** (one manual step, Pedro runs):
  ```bash
  supabase login
  supabase link --project-ref ybbrpqzbedaxsmotgtkh
  supabase functions deploy verify-email
  ```
- [ ] Test SnapVerify end-to-end on 3 prospects (rvsnappad.com, adornboutique.ca, pieceonpeace.com)
- [ ] Run a fresh full discovery run to confirm all sources fire post-reap
- [ ] Companies page — sort by match_score DESC (highest scored first, not discovery order)
- [ ] Pain point quality audit — every pain must have a real evidence_quote, not AI-inferred
- [ ] Inbox warming — pedro@runnareach.com (self-hosted warmup active, confirm Day 2+ firing)
- [ ] Rename "duplicate" counter → "filtered" in run history UI
- [ ] Delete/archive the 19 Alberta test prospects if they're just noise
- [ ] UX/UI full audit (screen by screen)

---

## Session Wrap-Up — 2026-05-29

### What shipped
- ✅ Warmup engine live: Day 1 complete, pedro@runnareach.com, 5/5 emails sent to buddy inboxes
- ✅ Postmaster Tools sync wired (daily cron, auto-pause on reputation drop)
- ✅ Full code reap: 47 files, `as never` casts removed, typed routes, analytics dashboard, invite emails, ICP prospect counts, search debounce, stuck-run recovery, email prompt updated (7-step structure)
- ✅ Pipeline restructured: SnapVerify moved to Pass 1 (free, all prospects), Anymail+Hunter strictly ≥70
- ✅ Crawl-time Anymail/Hunter removed (was burning credits on unscored prospects — wrong design)
- ✅ notable_clients tier filter applied (SMB prospects don't see Ford/La Comer)
- ✅ Deployed: https://spam-runnareach.vercel.app (commit d254ebc)
- ✅ Task 1C (language + market detection in scraper) — confirmed already done, marked complete

### Critical failures logged to lessons.md
1. Reaper removed active Hunter/Anymail as "dead code" without checking .env.local
2. Crawl-time Anymail/Hunter was wrong design (credits burned pre-scoring) — now fixed
3. Supabase migration ran against wrong project (SnapPad instead of S.P.A.M)
4. Pipeline diagram documented a bug as intentional design

### Next session — start here (priority order)
1. Deploy verify-email edge function (see Backlog above for exact commands)
2. Confirm warmup Day 2 fired at 14:00 UTC — check /warmup dashboard
3. Test SnapVerify on 3 real prospects once edge function is deployed
4. Run fresh full discovery run (verify all sources fire: YP / GP / Yelp / Brave / DENUE)
5. Pain point quality audit (evidence_quote must be real scraped text, not AI inference)

---

## SYSTEM: Multi-Project & State Confusion Prevention

Problems this session exposed:
- Claude ran a migration against SnapPad instead of S.P.A.M
- Claude confused "the code does X" with "X is correct design"
- Claude removed active integrations by assuming context instead of checking

### Protocol — SESSION START CHECKLIST (mandatory, every session)
Before touching any code:
1. `cat .env.local | grep SUPABASE_URL` — confirm which Supabase project is active
2. `git log --oneline -3` — confirm we're on the right repo/branch
3. Check mission-control_3.html for the current project's: Vercel URL, Supabase ID, folder
4. State out loud: "Working on: [project], Supabase: [id], Deploy: [url]"

### Protocol — BEFORE REMOVING ANY CODE
- Run: `grep -r "FUNCTION_NAME\|ENV_VAR" .env.local .env* lib/ app/` to confirm whether it's truly unused
- If it's an API integration: check .env.local for the key FIRST. "No key = dead" is wrong.
- If it's business logic: ask Pedro "this looks unused — is X still needed?" before deleting

### Protocol — BEFORE RUNNING ANY SQL
- Print the target Supabase project ref from `.env.local`
- Confirm it matches the project in mission-control for the current task
- S.P.A.M = `ybbrpqzbedaxsmotgtkh` | SnapPad = `brofoxamdozserkamudf`
- If using Supabase MCP: check which project it's connected to (`list_projects`)

### Protocol — PIPELINE DOCUMENTATION
- "The code does X" is not the same as "X is correct"
- If a pipeline step fires paid APIs without a quality gate → call it out as a suspected bug
- Always read comments in the code — if a comment says "TODO" or looks wrong, flag it before documenting

### Protocol — WHAT'S DONE VS IN PROGRESS
- Tasks marked [x] in todo.md = done and shipped
- Tasks marked [ ] = not done, even if discussed or partially implemented
- If unsure: `git log --oneline --all | head -10` to see what commits exist
- Never assume something is done because it was "worked on" in a prior session

---

## Session 2026-07-17 — Critical-fail audit (fake website in pitch, bounced junk emails, MX discovery fails)

### Root causes found
1. **Fake website in sent pitch (Acadian Log Works — lost lead):** `discoverWebsiteViaBrave`
   attached the FIRST Brave result for `"Company" city official website` with no
   name-match and no liveness check → scrape failed (domain has no DNS) → scrape-action
   logged a "website unreachable" pain citing the guessed domain → composer wrote a
   confident email about "their broken site".
2. **Bounces:** scraped emails inserted with no SMTP screen; regex glued postal codes
   (66220store@ — 5 digits, strip threshold was 6) and run-together TLDs
   (godaddy.comreservaciones…); filler@godaddy.com is GoDaddy's builder placeholder and
   wasn't blocklisted.
3. **Yelp still firing:** availability = "YELP_API_KEY set in env" and the key was never
   removed from Vercel.
4. **Brave 402** = quota/subscription exhausted (deep research burns 4-6 queries per
   prospect). **DENUE 406** = INEGI WAF rejecting bot UA / Vercel datacenter IP — runs
   never originate from Pedro's location, so "running from Mexico" changes nothing.

### Fixed (all verified: 170/170 tests, tsc + eslint clean)
- [x] discoverWebsiteViaBrave: company-name token must match domain/title + HEAD liveness
      probe (only DNS ENOTFOUND = dead)
- [x] scraper: DNS failures classified as `dns` error kind
- [x] scrape-action: DNS-dead domain → `domain_dead` flag, NO fabricated pain point;
      "website unreachable" pain now only for verifiable 404/410/5xx
- [x] pipeline: dead domain → clear domain + red_flag `dead_domain` → honest no-website
      pitch lane (extracted `runNoWebsiteLane`)
- [x] email-utils: shared placeholder lists (godaddy/secureserver/wixsite + filler),
      TLD allowlist (`hasValidTld`), glued-digit-prefix check (≥5 digits);
      `hasUsableEmail` enforces all → send path retroactively refuses stored junk
- [x] scraper: uses shared gate; leading-digit strip threshold 6→5
- [x] scrape-action: same-domain scraped emails SMTP-screened via new
      `screenEmailsAgainstSmtp` (drops 550-class); off-domain kept
- [x] Yelp removed from run-all orchestration, crawl-action, source-meta, modal; yelp.ts deleted
- [x] Brave 402 → explicit quota error; DENUE → browser UA + status-specific diagnostics
- [x] firstNameGuess: local-part inference capped at 9 chars (no more "Hi Calgauthier,")
- [x] tests/email-utils.test.ts — 7 suites pinned to the real bounces

### Pedro action items
- [ ] Brave: check billing/usage at api-dashboard.search.brave.com (402 = quota out)
- [ ] DENUE: token may need regenerating at inegi.org.mx; may stay blocked from Vercel IPs
- [ ] Optionally remove YELP_API_KEY from Vercel env (now unused by code)
- [ ] Run scripts/audit-2026-07-17-review.sql in Supabase SQL editor — review unsent
      pitches citing unverified domains + legacy junk contacts
- [ ] Deploy approval pending

### Tech debt
- structured-research contact inserts + composer audit → see audit-agent findings below

### Round 2 — audit-agent findings fixed (same session, all verified: build + 170/170 tests + tsc + lint clean)
- [x] Drip cron: hasUsableEmail + prospect status/cooldown gate at send time (was: null-check only)
- [x] Follow-up cron: same gates (was: suppressed prospects kept getting follow-ups)
- [x] Poll cron: bounces now AUTO-suppress (1y cooldown) + pause sequence; no longer mark the prospect "replied"
- [x] Suppression (single + bulk) now pauses sequences + unschedules queued sends
- [x] Bulk pitch generation skips suppressed/archived/no_match
- [x] structured-research, manual contact, Anymail, Hunter inserts all gated by hasUsableEmail
- [x] Follow-up + nudge composers: factual-integrity rules added (were auto-sending with ZERO anti-fabrication rules)
- [x] Follow-up "We found $X in recoverable revenue" removed — hunter_scans provenance unverifiable = fabricated audit claim
- [x] follow-up/nudge/poll/reply routes: read prospect_research (were reading the never-written legacy "research" table → composed blind)
- [x] Deep research: bails instead of confabulating when scrape+Brave return nothing; Brave queries disambiguated with city
- [x] "Website unreachable" pain additionally requires a company-name token in the domain
- [x] claude-search: returned websites whitelisted against domains Brave actually showed (no hallucinated domains stored)
- [x] Pipeline: final-score failure = error (no more pitching on the structural pre-research score)
- [x] Pipeline: discovered-website domain now used by SnapVerify + enrichment (was stale → good leads auto-suppressed "no contact")
- [x] nameMatchesListing: domain-only (title matching could attach directory domains)
- [x] claude-scorer: composite recomputed from breakdown (model's own total no longer trusted)
- [x] generatePitch advances b_list → pitched (stops janitor TTL suppressing live outreach)
- [x] Watchdog claim made atomic (no double-processing)
- [x] Janitor also closes stuck discovery_runs (>30 min running)
- [x] Google Places: platform/link-in-bio hosts (linktr.ee, business.site, facebook…) no longer stored as "their website" (suffix match; prospect kept, URL dropped)
- [x] DENUE names: legal suffixes stripped (no more "Sa De Cv" greetings)
- [x] Scrape backfills hostname-derived company names from the site's own og:site_name/title
- [x] Heuristic template no longer invents "${company}.com" subjects

### Known-open (deliberate, needs Pedro's call — see session report)
- [ ] Catch-all guessed addresses (snapverify_catchall_guess) still auto-send when they're the only contact
- [ ] Hunter results with confidence 50-69 still inserted (rank 3)
- [ ] Discovery "discovering" phase still one slice — can exceed 120s on 5-keyword ICPs (janitor now cleans up; per-source slicing deferred)
- [ ] LATAM ICP market mapping contradictory (run-all→CA, crawl insert→MX)
- [ ] Suppression is per-prospect, not per-email-address
- [ ] Website-pitch fallback template is English-only (Claude path localizes)

### Round 3 — post-SQL-audit (2026-07-17, cont.)
- [x] INEGI token re-requested via browser → re-sent EXISTING token to petedv31@gmail.com (so token likely valid → 406 = WAF/IP, UA fix is the relevant one)
- [x] Scraper: same-domain TLD-glue repair (info@neeralta.commonday → info@neeralta.com); foreign-domain glue stays rejected (CPA4IT scam-comment gmails). 172/172 tests.
- [x] Cleanup DELETE appended to scripts/audit-2026-07-17-review.sql (Pedro to run)
- [ ] Pedro: compare token vs Vercel `DENUE_API_KEY`; run the DELETE; after deploy bulk re-scrape affected prospects to recover real contacts

### Round 4 — Pedro's six decisions + contact-gate fix (2026-07-17, built; deploy pending)
- [x] Pipeline no-contact gate now uses hasUsableEmail (was creating limbo prospects: gate-passed, no pitch, never suppressed)
- [x] #1 Website-pitch fallback localized — full ES template + localized greeting; "Hi there" removed from the Claude path too
- [x] #2 Hunter results <70 confidence SMTP-screened (free — our own edge fn, no API cost)
- [x] #3 "guessed address" badge on /pitches for catch-all guesses (selected_by plumbed through list + detail queries)
- [x] #4 LATAM retired: removed from the ICP selector (legacy rows still load, labelled "retired"); LATAM now maps to MX EVERYWHERE (was run-all->CA vs crawl->MX); Yellow Pages CA no longer runs for it; Brave/Places/preview all use the resolved market
- [x] #5 Per-email suppression: lib/discover/dnc-check.ts enforced in all 3 send paths (address OR domain, fails open); bounces auto-add the dead mailbox, parsed from the NDR only when positively identified
- [x] New pure lib/replies/bounce-parse.ts + 9 tests pinned to Pedro's real NDRs (caught a regex truncation bug: ana@clinica.mx -> ana@clinica)
- [ ] #6 Discovery per-source slicing — DEFERRED (Pedro: "leave it at the end"). Janitor already auto-closes stuck runs.
- VERIFIED: 180/180 tests, tsc + eslint + next build all clean.
- OPEN QUESTION for Pedro: US market — you said "only Mexico and Canada". US is still in the ICP selector (it has no bug, unlike LATAM). Remove it too?

### Round 5 — pitch integrity + UI honesty (2026-07-21)
- [x] Greeting != recipient (CRITICAL): one shared pickAddressContact() across all 3 composers; regression test on the Waghorn shape
- [x] Glued-domain contacts (julien-cormier.cavfournier@...): rejected by hasUsableEmail (legacy rows unsendable) + repaired at extraction
- [x] Resume in-flight bulk pipeline jobs (getActiveBulkPipelineJob) — the "nothing happens" report
- [x] Pipeline failures no longer hidden behind "done — 0 processed"; worker keeps error reasons
- [x] Status filter: "Active (needs action)" + real "Everything (no filter)"; all 19 statuses listed
- [ ] Pedro: run the two new queries at the bottom of scripts/audit-2026-07-17-review.sql (glued-domain contacts + affected unsent pitches), then re-enrich those prospects
- [ ] Known limit: /companies loads max 500 prospects — silent truncation above that. Offer pagination/indicator.
