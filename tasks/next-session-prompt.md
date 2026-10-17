# NEXT SESSION — start here

Prod = `main` (2026-10-17): Phase 0 + Phase 1 part 1 shipped (Nils/Henry sender, pitch prompt v2, send gate v2, sourced benchmarks). Read `tasks/audit-2026-10-16.md` (the full audit + plan) and the
"Phase 0" section of `tasks/project-state.md` first.

Cost rule (CLAUDE.md): near-free until proven. AI API spend OK; no paid
external platforms; scheduler = Supabase `pg_cron` + `pg_net`.

---

## 1. Phase 0 is SHIPPED (migration 0035 applied)

Loose ends:
1. Pedro: Settings → Sending → "Send a test email" to pedrojr22+test1@gmail.com
   (ES) and +test2 (EN), plus an Outlook address. Check accents, button, footer
   links, Gmail's Unsubscribe button; click "darse de baja" to prove opt-out.
   (Plain pedrojr22@gmail.com is refused by the one-first-email rule on the
   pitch path; the test panel doesn't create pitches, but +tags keep the real
   address off the do-not-contact list.)
2. Sentry (checked 2026-10-16 via the Sentry MCP): warmup-engine ACTIVE,
   postmaster-sync / dmarc-sync / warmup-reactivation DISABLED. warmup-engine's
   last check-in is 2026-06-14 (pre-flush-fix); first real one expected
   ~14:22 UTC 2026-10-17 — verify it arrived.
3. Optional, free: `go.runnareach.com` CNAME → `cname.vercel-dns.com`, add the
   domain to the Vercel project, set `UNSUBSCRIBE_BASE_URL` (link targets still
   point at spam-runnareach.vercel.app; visible text no longer shows it).

## 2. Phase 1 — part 1 SHIPPED 2026-10-17 (main = prod, migrations 0036 + 0037 applied)

Live: Nils/Henry · Runna Advertising sender, pitch prompt v2 (+ cold-email
evidence), send gate v2 enforced everywhere, 48 sourced benchmarks the
composer may quote. See project-state "Phase 1".

Remaining Phase 1 items (from audit §7):

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
