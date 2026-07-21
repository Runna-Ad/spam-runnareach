# NEXT SESSION — start here

Paste the prompt below to pick up. Run the SQL first (Supabase SQL editor →
S.P.A.M project `ybbrpqzbedaxsmotgtkh`) and paste the results in with it.

---

## 📋 THE PROMPT (copy this)

> Picking up S.P.A.M. I've been generating pitches since 2026-07-21 with the
> send-gate dry run live. Here are the results of the gate review SQL: [PASTE
> RESULTS]. Walk me through whether the gate is safe to enable for auto-send,
> and if it is, wire it up. If the false-positive count is high, tune the rules
> first and tell me which ones were wrong.

---

## 🔢 THE SQL TO RUN FIRST

Full file: `scripts/gate-dryrun-review.sql`. If you only run one, run **query 3**
— it's the one that decides everything.

### Query 1 — headline (how much would auto-send?)
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

### Query 3 — ⭐ THE DECIDING NUMBER: false positives
Pitches the gate would have **held** that you approved and **sent** anyway.
If this is ~0 → auto-send is safe. If it's high → the rules are too strict.
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

### Query 4 — the gate agreeing with you (held + you never sent)
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

---

## 🧭 HOW TO READ IT

| Result | Meaning | Action |
|---|---|---|
| Query 3 returns ~0 rows | Gate agrees with Pedro | **Enable auto-send for PASS**; HOLDs go to the review queue |
| Query 3 returns many rows | Rules too strict — would throttle good outreach | Tune the offending rules (query 2 names them), re-measure |
| Query 1 auto_send_pct very low | Most pitches can't prove themselves | Likely a data gap (missing contact provenance / unscraped sites), not a gate bug |
| Query 4 has rows | Gate caught things Pedro also rejected | Review time it will save — a point in its favour |

---

## ⚠️ OTHER OPEN ITEMS (not blocking the gate)

- **Brave billing** — api-dashboard.search.brave.com. No longer caps research
  (per-prospect calls are 0), but the discovery *sources* still need quota.
- **DENUE** — three real defects fixed 2026-07-21 (Accept header caused the 406;
  the URL matched no documented method, so it had NEVER returned a row; now uses
  `BuscarEntidad`). Still UNVERIFIED — INEGI returns malformed HTTP responses
  intermittently, which is their fault, not ours.
  **Recommendation: leave DENUE off.** Google Places already covers MX. If you
  do test it, one MX discovery run will now show an honest error.
- **Label-glued contacts** — `scripts/audit-2026-07-17-review.sql` (bottom) lists
  contacts like `emailsrgjulien@…`. Already unsendable; delete them, then
  Re-enrich (which now re-scrapes first and will recover the real addresses).
- **Julien & Cormier remediation** — run the cleanup at the bottom of
  `scripts/audit-2026-07-17-review.sql`, then Re-enrich contacts →
  Generate pitches. Real addresses confirmed live: `pjcormier@`, `rgjulien@`,
  `vfournier@julien-cormier.ca`.
- **/companies caps at 500 prospects** — silent truncation above that.
- **`site_name` not persisted** → the gate's company-name rule is skipped in the
  dry run. Persist it if the other rules prove out.

## 🛣️ ROADMAP AFTER THE GATE
1. Prospect pre-filter — stop paying to research prospects that get suppressed
   (7 of 22 did on 2026-07-21).
2. Health dashboard — gate pass-rate, bounces, cost per pitched prospect.
3. B-list promotion flow — cheaper than re-running the full pipeline.
