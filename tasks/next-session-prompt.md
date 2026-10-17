# NEXT SESSION — start here

Prod = `main` (2026-10-17): Phase 0 + Phase 1 part 1 shipped (Nils/Henry sender, pitch prompt v2, send gate v2, sourced benchmarks). Phase 1 part 2 is ready on the branch, waiting for "ship it". Read `tasks/audit-2026-10-16.md` (the full audit + plan) and the
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

Phase 1 part 2 (P1.4 review loop, P1.5 decision record + events, P1.6 warmup
placement / chain filter / domain ownership) is DONE on
`claude/great-planck-w6w25t`, not shipped. See project-state "Phase 1 part 2".

To ship (only on Pedro's explicit "ship it"):
1. Apply `supabase/migrations/0038_pitch_decision_record.sql` to prod (record as
   version 0038). It must land BEFORE the code: generation inserts
   `attribution_code`.
2. Fast-forward `main` to the branch, push, watch the Vercel deploy go READY.
3. Generate one pitch on /pitches: check the "AI review" panel, then
   `select decision from pitches order by created_at desc limit 1` and
   `select * from pitch_events order by created_at desc limit 5`.
4. Next warmup tick (14:00–15:00 UTC): `warmup_log` rows should get RFC
   Message-IDs (contain "@") and the day after, `landed_in_inbox` values.

Still open from Phase 1:
- runna-hunter must store the `r` query parameter (attribution code) on scans
  and write an `audit_scan` pitch_event (or a row SPAM can join on).
- Per-contact source URL (enables the just-in-time page-freshness check).
- Follow-up template fallback in the cron (Pedro's call, see project-state).
