# Research — S.P.A.M. / Runna CA Opportunity Engine

Discoveries, patterns, libraries, and techniques learned during build. Newest at top.

---

## [2026-05-25] DISCOVERY: huashu-design "information density" rule for AI tools

**What:** For SaaS/AI products (not just dashboards), the design target is "high density" not "minimal" — each screen needs at least 3 visible signals of product intelligence. Empty pages and "not set" lists communicate nothing about the product's capability.

**Use when:** Auditing pages in an AI-driven product — pitches, learning, funnel, etc. If the page only shows empty states, add guided onboarding content that demonstrates what the AI will do, not just that there's no data yet.

**Pattern:** Replace dead empty states with: (1) visual pipeline/flow diagram showing the journey, (2) stage-level hints explaining how each state fills, (3) status dots/indicators so lists with no data still have visual rhythm.

---

## [2026-05-25] DISCOVERY: CSS radial-gradient as "120% detail" for page headers

**What:** A very subtle brand radial glow behind a heading (opacity ~6-8%) creates a premium "spotlight" feeling without being visible as a gradient. Combined with a thin left-border bar in brand color, this is the huashu "one detail at 120%" signature.

**Use when:** The hero greeting or main page title feels like generic SaaS. This is the minimum intervention that distinguishes designed from template.

**How:**
```tsx
<div
  className="relative pl-4"
  style={{
    background: "radial-gradient(ellipse 55% 80% at 0% 50%, color-mix(in oklab, var(--color-accent-300), transparent 92%) 0%, transparent 100%)",
  }}
>
  <span
    className="absolute left-0 top-0 bottom-0 w-0.5 rounded-full"
    style={{ background: "linear-gradient(to bottom, var(--color-accent-300), var(--color-brand-pink))" }}
  />
  {/* heading content */}
</div>
```
Cost: ~10 lines. Impact: the page feels intentionally crafted.

---

## [2026-05-25] DISCOVERY: Status dots are the minimum viable visual hierarchy for dense lists

**What:** A 6px colored dot (with optional glow via box-shadow) in front of every row in a list gives instant scannable status at a glance — green=active/good, amber=warning/pending, gray=off. Replaces reading text like "not set · —" for every row.

**Use when:** Any sidebar list, prompt list, settings list, or nav group where rows have a status that matters. 1.5px gap, `shrink-0`, aligned to text center.

**Pattern:**
```tsx
<span
  className="h-1.5 w-1.5 shrink-0 rounded-full"
  style={{
    background: hasChampion ? "var(--color-success-300)" : "var(--color-fg-700)",
    boxShadow: hasChampion ? "0 0 4px var(--color-success-300)" : undefined,
  }}
/>
```

---

## [2026-04-23] DISCOVERY: `pdftotext -layout` is the reliable path for Keynote-exported PDFs >100MB

**What:** Claude Code's built-in `Read` tool refuses PDFs over 100MB for text extraction (hard limit). Pedro's `MASTER- Runna Pres '26-ESP.pdf` is 211MB (60-page Keynote export, image-heavy). Poppler's `pdftotext -layout` extracts full readable text in under a second.

**Use when:** Any Keynote, Figma, or design-tool PDF export exceeds the Read tool's PDF limit.

**How:**
```bash
# Install once (macOS):  brew install poppler
pdftotext -layout "/path/to/deck.pdf" /tmp/deck.txt
# Then read /tmp/deck.txt in chunks via sed -n 'A,Bp' or Read with offset/limit.
```
The `-layout` flag preserves visual column order, which matters for slide decks where titles, metrics, and body copy are in different columns.

**Also useful:** `pdfinfo file.pdf` for page count + metadata; `pdftoppm` for page-as-image extraction when text-only isn't enough (e.g. logo extraction from a brand manual).

**Source:** S.P.A.M. Phase 0 case-study refresh (pulled the Rünna 2026 deck).

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
