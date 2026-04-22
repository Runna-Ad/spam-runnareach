# S.P.A.M. — SAGA Opportunity Engine

**Smart Prospecting & Acquisition Machine.** A single-tenant-launch, multi-tenant-capable, human-in-the-loop AI sales system for SAGA (the Canadian arm of Rünna).

> Grounded pitches. Real replies. 12 years of Rünna receipts, one browser tab.

---

## Status

**Phase 0 — foundation (in progress).** Skeleton is up; credentials needed to wire Supabase auth and go live.

See `tasks/todo.md` for the current checklist and `/Users/work/.claude/plans/users-work-downloads-spam-partner-deck-spicy-sparkle.md` for the full 10-week plan.

---

## Stack

- **Next.js 16.2** (App Router, Turbopack default, React 19.2)
- **TypeScript 5** strict, with `noUncheckedIndexedAccess` + `noImplicitOverride`
- **Tailwind CSS 4** — CSS-based config via `@theme` in `app/globals.css`
- **Supabase** — Postgres + Auth + pgvector (single-tenant launch, `tenant_id` + RLS on every table)
- **Anthropic Claude** — Sonnet 4.7 (research, pitch, weekly learning), Haiku 4.5 (scoring, reply-classify)
- **Gmail API + Postmark** — Postmark for warming period, Gmail API after domain is warmed
- **Google Places API** — discovery (primary, complemented by directories, operators, competitor mining, LinkedIn)
- **Unipile** — LinkedIn scraping + invite + note (Phase 5)
- **Cal.com** — meeting booking
- **Vercel** — hosting (not deployed yet; ask before first deploy)

---

## Quick start

```bash
# Requires Node 20+
cp .env.local.example .env.local
# Fill in values per the credentials checklist below (minimum: Supabase block)

npm install
npm run dev
# → http://localhost:3000 (redirects to /dashboard)
```

Routes that work today without credentials: `/dashboard`, `/discover`, `/companies`, `/pitches`, `/funnel`, `/inbox`, `/analytics`, `/learning`, `/compliance`, `/case-studies`, `/icp`, `/opportunities`, `/design`, `/settings/*`. All show phase-labelled placeholders. Functional wiring lands progressively per the plan.

---

## Credentials checklist (Pedro)

Minimum unlock to proceed past the shell → Supabase block. See full detail in `tasks/todo.md` and the plan file.

- [ ] **Supabase** — project URL, anon key, service-role key, project ref. Enable `vector` extension.
- [ ] **Anthropic API key** — with $100/mo spend limit in Billing.
- [ ] **Google Cloud** — Places API + Gmail API enabled, OAuth consent screen, OAuth 2.0 client with redirect `http://localhost:3000/api/auth/google/callback`, restricted Places API key.
- [ ] **Secondary sending domain** + **Google Workspace inbox** + SPF/DKIM/DMARC. ⚠️ **Start warming today** — 2–3 weeks minimum before Phase 4 real sends.
- [ ] **Postmark or SES** for warming-period sends.
- [ ] **Cal.com** — 15- and 30-min event types, webhook secret.
- [ ] **Slack hot-lead webhook URL**.
- [ ] **Unipile** subscription (Phase 5).
- [ ] **SerpAPI** or similar (Phase 1).
- [ ] **BuiltWith API** (optional, Phase 1).
- [ ] **Hunter.io** (optional, 25 free/mo).
- [ ] **CRON_SECRET + TOKEN_ENCRYPTION_KEY** — `openssl rand -hex 32`.

---

## Non-negotiable principles

1. **Human-in-the-loop by default.** Every pitch approved before sending.
2. **CASL-first (CA) + LFPDPPP (MX).** Per-prospect `consent_basis` + URL evidence before any send.
3. **Dashboard-only operation.** No terminal commands or manual DB edits day-to-day.
4. **Case-study grounding.** Every pitch cites a specific Rünna case study with a measurable result. Pitches without one are auto-rejected.
5. **Budget discipline.** Per-domain daily caps, bounce auto-pause at 1%, cost hard-stop at 90% of monthly budget.
6. **Dark-only MVP.** No light theme until Phase 6+.

---

## Design language

Dark-first, Linear / Attio-inspired. Single saturated accent: electric lime `#BEF264` (`--color-accent-300`). Status colors: emerald (success), amber (warning), red (danger), cyan (info). Geist Sans for UI, Geist Mono for data / scores / IDs.

Minimal elevation — 1px inset ring on cards, no drop shadows except floating elements. Motion: 150ms `cubic-bezier(0.2, 0, 0, 1)`. Keyboard-driven (⌘K palette, ⌘\ sidebar toggle, A / E / R / S for approve / edit / reject / skip in the pitch queue).

Visit `/design` for the token + component showcase.

---

## Project layout

```
app/                     — Next 16 App Router
  (auth)/                — sign-in, sign-up, invite
  (dashboard)/           — dashboard shell + all reviewer routes
    settings/            — 6 admin subpages
    design/              — token + component showcase
  api/                   — cron handlers, webhooks, track endpoints
  layout.tsx             — root layout (Geist, dark-forced, Sonner)
  globals.css            — Tailwind 4 @theme tokens

components/
  ui/                    — primitives (Button, Card, Chip, Kbd, EmptyState, ...)
  dashboard/             — Sidebar, Topbar, PhasePlaceholder

lib/
  utils.ts               — cn, relative time, compact number
  supabase/              — browser, server, service-role clients (next turn)
  anthropic/             — client, prompts, cost accounting (Phase 2)
  discovery/             — places, directories, operators, competitor, linkedin (Phase 1)
  research/              — scraper, research prompt, quality gate (Phase 2)
  scoring/               — rubric, pain taxonomy (Phase 2)
  pitch/                 — generate, validator, compliance footer (Phase 3)
  send/                  — postmark, gmail, warming ramp, send-time (Phase 4)
  reply/                 — classifier, auto-draft (Phase 5)
  learning/              — weekly loop, champion/challenger (Phase 5)
  compliance/            — consent-basis, unsubscribe, do-not-contact (Phase 0–4)

supabase/
  migrations/            — 0001_initial_schema.sql (~28 tables, tenant_id, RLS, pgvector)
  seed.sql               — brand instances, services, case studies, ICPs, prompts

tasks/
  lessons.md             — session learnings and Pedro overrides
  research.md            — discoveries (Next 16 async, Tailwind 4, HITL, ESP warming)
  todo.md                — current phase checklist
```

---

## Scripts

```bash
npm run dev          # Turbopack dev server
npm run build        # production build
npm run start        # production server
npm run typecheck    # tsc --noEmit
npm run lint         # ESLint flat config (next lint removed in Next 16)
npm run format       # Prettier write
```

---

## Contributing (SAGA team)

This is an invite-only, single-tenant product. Admin issues invitations from `/settings/users`. Every action is audit-logged.

---

## License

Proprietary. © Rünna / SAGA 2026.
