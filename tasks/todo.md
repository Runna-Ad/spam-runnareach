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

## Next slices (unchanged)

_Handoff list cleared — Phase 0 foundation slices all shipped._

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
