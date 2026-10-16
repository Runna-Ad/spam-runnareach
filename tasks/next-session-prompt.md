# NEXT SESSION — start here

Prod = `52ccc1e` (2026-10-16): Phase 0 shipped. Read `tasks/audit-2026-10-16.md` (the full audit + plan) and the
"Phase 0" section of `tasks/project-state.md` first.

Cost rule (CLAUDE.md): near-free until proven. AI API spend OK; no paid
external platforms; scheduler = Supabase `pg_cron` + `pg_net`.

---

## 1. Phase 0 is SHIPPED (prod `52ccc1e`, migration 0035 applied)

Loose ends (Pedro):
1. Send one EN and one ES test email to pedrojr22@gmail.com AND an Outlook
   address. Check accents, the footer, the unsubscribe link (GET shows a
   confirm page; the button opts out) and Gmail's own "Unsubscribe" button.
2. Sentry: turn `warmup-engine` monitor on, `postmaster-sync` off.
3. Optional, free: `go.runnareach.com` CNAME → set `UNSUBSCRIBE_BASE_URL`, so
   links stop reading "spam-runnareach.vercel.app".

## 2. Then Phase 1 — make "good" measurable (see audit §7)

- Gate v2, enforcing on every path (approve, queue, send, follow-ups, website
  pitch, edits); verdict shown on /pitches.
- AI critic + auto-revise loop; templates out of any automatic path.
- One coherent pitch prompt (it contradicts itself on numbers and client names).
- Decision record per pitch (prompt version, path, angle, CTA, verifier
  verdict…), immutable step/intent history, `pitch_events`.
- Audit-tool attribution token (needs a runna-hunter change).
- Persist SPAM Verify verdicts on contacts + per-contact source URL (enables
  the just-in-time page-freshness check).
- Fix warmup placement measurement (Message-ID), chain-filter false positives,
  "unsure" domain ownership → review.
- Exclude test addresses (e.g. pedrojr22@gmail.com) from metrics.
