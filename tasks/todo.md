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

## Next slices (handoff list, unchanged)

1. /icp CRUD — edit the 2 Alberta ICPs, add new ones, preview reachable-pool size via Places (after Google Cloud creds)
2. /settings/profile, /settings/sending, /settings/users — the three settings pages Phase 0 needs
3. ⌘K Command Palette — fuzzy search across nav + case studies + ICPs once they're live

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
