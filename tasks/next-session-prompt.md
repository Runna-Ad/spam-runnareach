# NEXT SESSION — start here

Prod = `72f5b28` (2026-07-21). Working tree clean, `origin/main` in sync.
Run the SQL below in the Supabase SQL editor (project `ybbrpqzbedaxsmotgtkh`)
and paste the results in with the prompt.

---

## 📋 THE PROMPT (copy this)

> Picking up S.P.A.M. Since 2026-07-21 the send-gate dry run has been live and
> I've been generating pitches. Here are the gate review results: [PASTE QUERY
> RESULTS].
>
> Tell me whether the gate is safe to enable for auto-send. If yes, wire it up
> (I already chose AUTO-SEND for anything that PASSes — HOLDs go to my review
> queue). If the false-positive count is high, tune the offending rules first
> and tell me which ones were wrong and why.
>
> Also worth knowing since last session: Yellow Pages is working again, a
> national-chain filter now drops Walmart-class listings at insert, Brave is
> out of the per-prospect path entirely, and DENUE is fixed-but-unverified
> (recommendation was to leave it off).

---

## 🔢 RUN THIS FIRST

Full file: `scripts/gate-dryrun-review.sql`. **Query 3 is the one that decides.**

### Query 1 — headline
```sql
select
  count(*)                                                 as pitches_evaluated,
  count(*) filter (where (metadata->>'pass')::boolean)     as would_auto_send,
  count(*) filter (where not (metadata->>'pass')::boolean) as would_be_held,
  round(100.0 * count(*) filter (where (metadata->>'pass')::boolean) / nullif(count(*),0), 1)
                                                           as auto_send_pct
from audit_log
where action = 'pitch.gate_dryrun';
```

### Query 2 — why things get held (the tuning list)
```sql
select code as failure_reason, count(*) as times, count(distinct entity_id) as pitches
from audit_log, lateral jsonb_array_elements_text(metadata->'failure_codes') as code
where action = 'pitch.gate_dryrun'
group by code order by times desc;
```

### Query 3 — ⭐ THE DECIDING NUMBER (false positives)
Pitches the gate would have **held** that you approved and **sent** anyway.
~0 rows → auto-send is safe. Many rows → the rules are too strict.
```sql
select p.id as pitch_id, pr.company_name, p.subject, p.sent_at,
       a.metadata->'failure_codes' as gate_would_have_held_for
from audit_log a
join pitches   p  on p.id = a.entity_id
join prospects pr on pr.id = p.prospect_id
where a.action = 'pitch.gate_dryrun'
  and not (a.metadata->>'pass')::boolean
  and p.sent_at is not null
order by p.sent_at desc limit 50;
```

### Query 4 — the gate agreeing with you
```sql
select pr.company_name, p.status, a.metadata->'failure_codes' as reasons
from audit_log a
join pitches   p  on p.id = a.entity_id
join prospects pr on pr.id = p.prospect_id
where a.action = 'pitch.gate_dryrun'
  and not (a.metadata->>'pass')::boolean
  and p.sent_at is null
order by a.created_at desc limit 50;
```

### How to read it
| Result | Meaning | Action |
|---|---|---|
| Q3 ≈ 0 rows | Gate agrees with Pedro | **Enable auto-send for PASS** |
| Q3 many rows | Too strict — would throttle good outreach | Tune the rules Q2 names, re-measure |
| Q1 auto_send_pct very low | Most pitches can't prove themselves | Likely a data gap, not a gate bug |
| Q4 has rows | Caught things Pedro also rejected | Review time it saves |

---

## ✅ CLEANUPS PENDING (safe to leave — none can send)

Both in `scripts/audit-2026-07-17-review.sql`:
- **Label-glued contacts** (`emailsrgjulien@…`) — delete, then Re-enrich
  (which now re-scrapes first and recovers the real addresses).
- **Julien & Cormier** — one draft pitch on a garbage address. Real addresses
  confirmed live: `pjcormier@`, `rgjulien@`, `vfournier@julien-cormier.ca`.

## ⚠️ OPEN ITEMS

- **Brave billing** — api-dashboard.search.brave.com. No longer caps research
  (per-prospect calls are 0), but the discovery *sources* still want quota.
- **DENUE** — three real defects fixed (our own `Accept` header caused the 406;
  the URL matched no documented method, so it had **never** returned a row).
  Still **UNVERIFIED** — INEGI emits malformed HTTP responses intermittently.
  **Recommendation: leave it off.** Google Places covers MX.
- **Discovery restart loop** — fixed via a keepalive heartbeat + a 3-attempt cap.
  If a run now *fails* with "narrow the ICP's keywords", that's the cap working:
  discovery genuinely can't finish in one slice for that ICP, and the real fix
  is per-source slicing (deferred).
- **`chain-filter.ts` is a silent-deletion risk** — if a REAL prospect goes
  missing from discovery, check that list FIRST and add a must-survive test.
- **/companies caps at 500 prospects** — silent truncation above that.
- **`site_name` not persisted** → the gate's company-name rule is skipped in the
  dry run. Persist it if the other rules prove out.

## 🛣️ ROADMAP AFTER THE GATE
1. **Prospect pre-filter** — the big one. Stop paying to research prospects that
   get suppressed (7 of 22 did on 2026-07-21). Chains were only one category.
2. **Health dashboard** — gate pass-rate, bounce trend, cost per pitched prospect.
3. **B-list promotion flow** — cheaper than re-running the full pipeline.
   (For now: use "Generate pitches", NOT "Run pipeline", on b_list prospects.)
