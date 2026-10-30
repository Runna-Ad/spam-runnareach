# Brief: site-crawler

| | |
|---|---|
| Module | new `lib/research/site-crawl/` + route `app/api/research/observe/route.ts` + migration 0054 |
| Model / effort | opus / high (new module that decides what reaches a pitch as "seen"; migration + cron) |
| Branch | `claude/site-crawler` from `claude/phase3-batch10-integration` |
| PR target | `claude/phase3-batch10-integration` |
| Reserved resource | migration `0054_site_observations.sql` (do not take another number) |
| Depends on | none (greeting-rule already merged; disjoint files) |
| Conductor session | `session_01HtEg7XG4MPQU4omrd2BX69` (send_message ONLY if blocked; the PR body is the report) |
| Size | L |

## Goal
The writer has nothing real to point to: research reads a summary paragraph, never the site, so "I checked your site: no way to book" is a guess (prod 2026-10-28: v3.3 critic pass 24%, the top blocker is claims about the site that nobody saw). Pedro (2026-10-28) chose: a smarter crawler in our app plus Google PageSpeed Insights (free). Good looks like: for every researched prospect we store a list of checked facts about its website, each with the URL or test that shows it, AND an explicit "could not see" when the page was not readable, so a later step can state as fact only what was observed and never claim an absence it could not see. This task stores the facts; wave 2 (dossier + writer) uses them.

## Context the worker needs (conductor-verified 2026-10-30)
- **Study, 33 recent prospect sites** (prototype: plain `fetch` + cheerio, home + up to 6 same-origin pages whose link text/path matches contact/book/reserv/menu/services/pricing/shop/about/rooms, ~3.5 s per site): 33/33 reachable; 4.7 pages per site on average; 3 homes under 4,000 visible characters; forms on 28, `tel:` 14, `mailto:` 16, social links 32, JSON-LD on 21 (LocalBusiness, Hotel, Dentist, OpeningHoursSpecification, AggregateRating...), copyright year on 19 (3 older than 2024); builders: WordPress 10, Shopify 8, Wix 2, Squarespace 1, GoDaddy 1, other 11.
- **Booking is found by LINKS, not scripts.** Script matching found booking tools on 3 sites. Link text/href found more: a hotel's "BOOK NOW" → `reservations.travelclick.com` (an external engine: a "no online booking" claim there would be false), lodges with on-site `#booknow` anchors, a dental clinic whose "Agendar cita" goes only to `wa.me/...` (WhatsApp), lodges with no booking link at all. A Wix lodge returned 0 links to plain fetch (links render in JavaScript): that site must come out as **not readable for links**, never "no booking".
- Current scraper: `lib/research/scraper.ts` (`scrapeSite`, `MAX_SUBPAGES = 4`, `detectTechStack :567`, `extractKeyPages :782`, `fetchSubPageHtml :957`). Research calls it at `lib/research/deep-research-stage.ts:117` and stores `tech_stack` / `evidence_urls` / `last_scraped_at` on `prospect_research`. Reuse its fetch/parse helpers where they fit; do not change what `scrapeSite` returns (other callers: `scrape-stage.ts:90`).
- Reader to know about (do NOT change it here): the send gate's "claims about their website need a verified fetch" rule reads `websiteVerified` from `gate.ts:181` (`last_scraped_at` + `evidence_urls`). Wave 2 may point it at observations; keep `prospect_research` writes as they are.
- **PageSpeed Insights API** v5 (`https://www.googleapis.com/pagespeedonline/v5/runPagespeed?url=…&strategy=mobile&category=performance&category=seo&category=accessibility&category=best-practices&key=…`). Free with a key; keyless requests return 429 from here. Env var `PAGESPEED_API_KEY` (Pedro creates it; the conductor never handles it). No key → skip PSI and record `psi.status = "no_key"`; the crawl still runs. A PSI call takes 10-40 s: never inside research or the tick.
- **Vercel budget:** free plan, ~4 h Fluid CPU a month, already tight (PR #63). Waiting on network I/O is cheap; parsing big HTML is not. Every pg_cron call is a cold start (~1 s CPU): write calls/week × 1 s in the migration header (lesson 2026-10-26). Route `maxDuration` lives in `vercel.json` (conductor-only: put the entry you need under "Needs conductor"; default is 60 s for `app/**`).
- Cron pattern: `select public.spam_cron_call('/api/...')` (see `0050_wanted_facts.sql:136`, `0053_quiet_hours_cron.sql`). Health: `lib/reports/heartbeat.ts:25 CRON_JOBS` lists jobs the job_silent rule watches.
- Cost rule: no paid service; no AI call in this task.

**Decisions (conductor):**
1. New table `site_observations` (0054): one row per prospect crawl (`tenant_id`, `prospect_id`, `url`, `crawled_at`, `crawler_version`, `status` ok / unreachable / blocked / not_html, `readable` per page and overall, `pages` jsonb [{url, title, text_chars, links_seen}], `checks` jsonb, `psi` jsonb, `psi_status`). RLS on like 0050; service role writes. Keep the newest row per prospect queryable cheaply (index).
2. `checks` = deterministic detectors, each `{found: boolean | null, evidence: [{url, text or href}]}`, where `null` means "could not see" (page or links not readable). At least: booking (external engine domain or on-site booking anchor; WhatsApp-only and phone-only as their own values), ecommerce/cart, chat (incl. WhatsApp link), contact form (and field count), tel, mailto, social links, mobile viewport, JSON-LD types + opening hours + rating, copyright year, builder/CMS, languages, analytics/pixels. An absence is `found: false` ONLY when every page checked was readable (text and links present); otherwise `null`.
3. Crawl: home + up to 7 same-origin pages chosen by link text/path (EN + ES keywords), each fetch with `AbortSignal.timeout`, a per-site budget, a size cap, robots-friendly (one request at a time per site, a real UA string naming us is fine).
4. Route `/api/research/observe` (cron-auth like the other cron routes): picks researched prospects with a website and no observation newer than 30 days, newest-researched first, up to N per run inside the route budget (state the math: N × (crawl + PSI) with PSI calls in parallel, at the largest designed load = 100 researched prospects a day). pg_cron job in 0054 inside the weekday send window only (state calls/week). Add the job to `CRON_JOBS`.
5. PSI result kept small: the 4 category scores, LCP, CLS, TBT, and third-party script domains (from the network list) as extra tool evidence.

## Brain lessons
none matched (second brain not attached). Core-context: P4/P7: never read meaning into an absent input; an absence is a fact only after excluding every path that empties it on purpose (a JS-rendered page empties links). P5: time budget at the largest designed load.

## Files
Allowed to edit: `lib/research/site-crawl/*` (new), `app/api/research/observe/route.ts` (new), `supabase/migrations/0054_site_observations.sql` (new), `lib/reports/heartbeat.ts` (`CRON_JOBS` entry only), `tests/site-crawl*.test.ts` (new), `tests/fixtures/site-crawl/*` (new: saved HTML pages; the cloud network now allows prospect sites, so save REAL pages, no personal data beyond what the business publishes).
Read only: `lib/research/scraper.ts`, `lib/research/deep-research-stage.ts`, `lib/pitches/gate.ts`, `lib/cron-auth.ts`, `supabase/migrations/0050_wanted_facts.sql`, `0053_quiet_hours_cron.sql`, `lib/reports/health.ts`.
Forbidden: `lib/supabase/types.ts` (list the new table's type under "Needs conductor"), `vercel.json` (same), `lib/pitches/*`, `lib/anthropic/*`, any other migration.

## Must not change (negative set)
- `scrapeSite` output and every current `prospect_research` write.
- The tick, research and pitch routes' timing (nothing new runs inside them).
- No AI call, no paid API. No prospect is crawled twice in 30 days.

## Acceptance checks
1. **Real data:** run the crawler (dry, no DB) on the 33 study sites (list: the 33 root pitches on prompt `pitch-v3.3-2026-10-26`; the conductor can paste the URLs if you ask) and paste the summary table in the PR: per check, found / not found / could not see. It must classify the travelclick hotel as booking found (external engine), the WhatsApp-only clinic as booking via WhatsApp, and the Wix lodge as could-not-see for booking.
2. Fixture tests for each detector, including the JS-rendered page → `null`, never `false`.
3. Budget test at the designed load (100 prospects/day): N per run, runs per day, worst-case route time under its `maxDuration` with PSI timing out.
4. No key → `psi_status = "no_key"`, crawl stored, no error.
5. Migration header: before/after deploy, calls/week × 1 s CPU. Project checks green (`npm run typecheck && npm run lint && npm test`) + `npm run build`.

## External prerequisites
Pedro: a free Google API key with "PageSpeed Insights API" enabled (same GCP project as Gmail), in Vercel as `PAGESPEED_API_KEY` (Production + Preview). Without it the crawl still runs.

## Prod verification
After deploy and the first runs: `select status, psi_status, count(*), avg(jsonb_array_length(pages)) from site_observations where crawled_at > '<deploy>' group by 1,2;` and the first `net._http_response` rows for `/api/research/observe` → 200, counts, no error.

## Out of scope
The dossier, the writer, the gate's `websiteVerified`, a real browser, Places reviews.

## If blocked
Message the conductor with what you tried, what you need, and what you can still do meanwhile.
