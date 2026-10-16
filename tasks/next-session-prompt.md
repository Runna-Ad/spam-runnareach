# NEXT SESSION — start here

Prod = `5a4f326` (2026-10-16). **Phase 0 is on branch `claude/great-planck-w6w25t`,
not deployed.** Read `tasks/audit-2026-10-16.md` (the full audit + plan) and the
"Phase 0" section of `tasks/project-state.md` first.

Cost rule (CLAUDE.md): near-free until proven. AI API spend OK; no paid
external platforms; scheduler = Supabase `pg_cron` + `pg_net`.

---

## 1. Ship Phase 0 (needs Pedro)

1. Vercel env: `RUNNA_MAILING_ADDRESS` (**required**: sending is blocked
   without it), optionally `RUNNA_PRIVACY_URL` (MX aviso de privacidad) and
   `UNSUBSCRIBE_BASE_URL` (a link domain without "spam" in it, e.g. a free
   `go.runnareach.com` CNAME to the Vercel project).
2. Apply `supabase/migrations/0035_lock_down_warmup_dmarc_tables.sql`.
3. Merge the branch → deploy ("ship it").
4. After deploy: send one EN and one ES test email to your own Gmail AND an
   Outlook address. Check accents, the footer, the unsubscribe link (GET shows
   a confirm page; the button opts out) and Gmail's own "Unsubscribe" button.
5. Sentry: turn `warmup-engine` monitor on, `postmaster-sync` off.

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
