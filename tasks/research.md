# Research — S.P.A.M. / Runna CA Opportunity Engine

Discoveries, patterns, libraries, and techniques learned during build. Newest at top.

---

## [2026-04-22] DISCOVERY: Next.js 16 async cookies/headers/params breaking changes

**What:** Next 16.2 (current at time of build) made `cookies()`, `headers()`, and `params` async across the App Router. Middleware was renamed to proxy. `next lint` removed.

**Use when:** Writing any route handler, layout, page, or server component that reads cookies/headers/params.

**How:** `const cookieStore = await cookies()` instead of `const cookieStore = cookies()`. Params: `const { id } = await params` in async function signatures. Check `node_modules/next/dist/docs/` for the full migration notes after install.

**Source:** Pedro's original handoff (which was hallucinated about code existence but correct about framework specifics).

---

## [2026-04-22] DISCOVERY: Tailwind 4 uses CSS-based config, not tailwind.config.js

**What:** Tailwind 4 replaces `tailwind.config.js` with `@theme` directives inside `globals.css`. Tokens live in CSS, not JS.

**Use when:** Scaffolding any Next 16 + Tailwind 4 project.

**How:** Put `@import "tailwindcss"` at top of globals.css, then `@theme { --color-accent-300: #BEF264; }` for custom tokens. No tailwind.config.js needed.

**Source:** Tailwind 4 release notes.

---

## [2026-04-22] DISCOVERY: Human-in-the-loop beats autonomous AI SDR

**What:** 2026 evaluation data — Artisan AI scored 35/231, 11x.ai scored 21/231, Amplemarket Duo (HITL model) scored 219/231. Autonomous AI SDR category collapsed.

**Use when:** Architecting AI-augmented sales workflows.

**How:** Design for AI doing 95% (discovery, research, drafting, matching) and human doing 5% (approve / edit / reject) — not the inverse. Amplemarket Duo architecture is the reference.

**Source:** S.P.A.M. partner deck, April 2026.

---

## [2026-04-22] DISCOVERY: Gmail API warming is harder than proper ESP warming

**What:** Google Workspace newly provisioned mailboxes have poor IP/domain reputation at start. Gmail API sending from a cold account is throttled and often lands in spam.

**Use when:** Deciding sending infra for a new B2B outbound engine.

**How:** Use a proper ESP (Postmark, SES) for first ~500 warming sends. Only migrate to Gmail API after 2-3 weeks of warmed domain with SPF/DKIM/DMARC green. Postmark gives better deliverability telemetry during warming than Gmail API.

**Source:** Deliverability best-practice research informing S.P.A.M. architecture.
