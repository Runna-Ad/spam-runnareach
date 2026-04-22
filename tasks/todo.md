# S.P.A.M. — Current Todo

Plan file: `/Users/work/.claude/plans/users-work-downloads-spam-partner-deck-spicy-sparkle.md`
Deck: `/Users/work/Downloads/SPAM_Partner_Deck.pdf`

---

## Phase 0 — Foundation (in progress)

### Code scaffolding (unblocked — no credentials needed)
- [x] Create tasks/ folder + seed lessons.md / research.md / todo.md
- [x] Log PEDRO_OVERRIDE about hallucinated prior handoff
- [ ] Write root configs (package.json, tsconfig, next.config, postcss, .gitignore, .env.local.example)
- [ ] Create directory structure (app/, components/, lib/, supabase/)
- [ ] Write globals.css with Tailwind 4 @theme tokens + Geist fonts
- [ ] Write root layout.tsx + redirect page.tsx
- [ ] Write dashboard layout shell skeleton
- [ ] Write lib/utils.ts + lib/supabase/ scaffolds
- [ ] Write 13 UI primitives
- [ ] Write dashboard components (Shell, Sidebar, CommandPalette, PhasePlaceholder)
- [ ] Write keyboard shortcut registry
- [ ] Write 14 placeholder route page.tsx files
- [ ] Write Supabase migration (~28 tables, tenant_id, RLS, pgvector)
- [ ] Write seed.sql
- [ ] Write /design showcase route
- [ ] Write README.md
- [ ] Initialize git + first commit

### Credentials-blocked (waiting on Pedro)
- [ ] Wire Supabase auth (blocked: Supabase creds #1)
- [ ] Wire Gmail OAuth connect flow (blocked: Google Cloud #3)
- [ ] /case-studies CRUD live with Supabase (blocked: #1)
- [ ] /icp CRUD live with Supabase (blocked: #1)
- [ ] /settings subpages live (blocked: #1)
- [ ] Places reachable-pool preview (blocked: #3)

### Credentials checklist (Pedro)
Per plan file, External Dependencies section. Minimum unlock = Supabase:
- [ ] Supabase project (URL + anon key + service-role key + project ref + vector extension enabled)
- [ ] Anthropic API key + $100/mo limit
- [ ] Google Cloud (Places API + Gmail API + OAuth consent + OAuth client + restricted Places key)
- [x] Domains locked: runna.agency (primary) + runnareach.com (outreach secondary). Public name: Runna CA.
- [ ] Name sender #1 Runna CA principal + buy both domains + add runnareach.com to Rünna Workspace + DNS (SPF/DKIM/DMARC) → START TODAY for warming (see tasks/warming-setup-guide.md)
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
