# NEXT SESSION — start here

Prod = `main` (2026-10-17): Phase 0 + Phase 1 part 1 shipped (Nils/Henry sender, pitch prompt v2, send gate v2, sourced benchmarks). Phase 1 part 2 shipped the same day (review loop, decision record + events, warmup placement / chain filter / domain ownership). Read `tasks/audit-2026-10-16.md` (the full audit + plan) and the
"Phase 0" section of `tasks/project-state.md` first.

Cost rule (CLAUDE.md): near-free until proven. AI API spend OK; no paid
external platforms; scheduler = Supabase `pg_cron` + `pg_net`.

**Goal (Pedro, 2026-10-17): total automation that learns.** Phase 2 (autopilot
+ learners) is built on `claude/great-planck-w6w25t`, NOT shipped. See
project-state "Phase 2". Previous leads were testing; don't look back at them.

## 0. Ship Phase 2 (only on Pedro's explicit "ship it")

Order matters (0041 turns the autopilot on):
1. Apply migration 0040 (brain tables) to prod; record version 0040. No DROP
   statements (the Supabase MCP holds DROPs for a confirmation, lessons.md).
2. Clear the one stale queued pitch from July (43 North,
   e341491c-5412-47a4-9cc9-51a650161302: approved + scheduled, never sent;
   blocked by the first-touch guard): set status draft, scheduled_send_at null.
3. Fast-forward main → push → Vercel deploy READY.
4. Apply migration 0041 (pg_cron + pg_net jobs, Vault-held scheduler token,
   autonomy_state veto/enabled for the Rünna tenant); record version 0041.
5. runna-hunter: fast-forward its main to `867d007` (learned finding weights).
6. Verify: `select * from cron.job_run_details order by start_time desc limit 10`,
   `select status_code, left(content::text, 300) from net._http_response order by created desc limit 5`,
   `select * from autonomy_state`, `select * from learning_insights order by created_at desc limit 10`,
   and Vercel runtime errors for /api/autopilot/tick.
Kill switch: `update autonomy_state set enabled = false`.

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
placement / chain filter / domain ownership) is SHIPPED.
See project-state "Phase 1 part 2".

SHIPPED 2026-10-17 on Pedro's "ship it": migration 0038 applied (recorded as
version 0038), main = `ae03703`. Verify after the first real use:
1. Generate one pitch on /pitches: the "AI review" panel shows, and
   `select decision from pitches order by created_at desc limit 1` is filled.
2. `select * from pitch_events order by event_at desc limit 5` has a
   "generated" row (column is event_at, not created_at).
3. After the next warmup tick (14:00–15:00 UTC): new `warmup_log` rows have
   RFC Message-IDs (contain "@"); the tick after, `landed_in_inbox` values.

Still open from Phase 1:
- Attribution is live end to end (runna-hunter `3b4077f` + migration 0039):
  `select * from pitch_events where event_type = 'audit_scan'`. Not yet shown
  in the UI: a "ran the free check" / "asked to talk" badge on /pitches would
  make these hot leads visible.
- Per-contact source URL (enables the just-in-time page-freshness check).
- Follow-up template fallback in the cron (Pedro's call, see project-state).
