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

## Future (creds-blocked)

Slice 1b — Plug real discovery engines into the scaffolding once Google
Cloud / SerpAPI / BuiltWith / Unipile creds arrive. Each source ≈ 2–4 hrs
of plumbing onto the existing `discovery_runs` + `prospects` pipeline.

Phase 2 — Claude-powered research + scoring once Anthropic key is set.

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

## Phase 0 Review (to be filled when Phase 0 complete)

### What worked
_TBD_

### What didn't
_TBD_

### What I'd do differently
_TBD_

### Tech debt introduced
_TBD_
