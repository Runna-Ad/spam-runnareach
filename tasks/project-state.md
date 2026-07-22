# S.P.A.M. — Project State

> Rünna CA Opportunity Engine: discovers Canadian/Mexican SMB prospects, researches +
> scores them, auto-composes bilingual cold pitches, sends via warmed Gmail inboxes,
> and runs a reply/follow-up/nudge funnel. Created this file 2026-07-17 (wrap-up).

## Stack
- **Next.js 16** (App Router, server actions, `after()`), React, TypeScript (no `any`)
- **Supabase** — Postgres + RLS + pgvector + edge functions (`verify-email` SMTP probe). Project ref `ybbrpqzbedaxsmotgtkh` (S.P.A.M — East US). Auth: cookie-based `requireUser()`.
- **Anthropic SDK** — Sonnet (pitch/research/search), Haiku (SnapVerify people-extract, website pitch). Cost-tracked + daily-capped.
- **Vercel** — prod `spam-runnareach.vercel.app` (project `pedros-projects-c43384db/spam-runnareach`). Daily-cron tier → background jobs self-chain via `after()`+fetch, not queues.
- Tailwind 4, Radix, cmdk, zod, cheerio, p-retry, Sentry.
- **Sibling repo:** `runna-hunter` (separate Vercel project) — the self-serve Inefficiency Hunter the pitch CTA deep-links to.

## What's deployed
- Prod = commit **`72f5b28`** (2026-07-21). `origin/main` in sync, working tree clean.
- Warmup engine live (pedro@runnareach.com, ramped to 50/day across 7 buddy inboxes).
- Full pipeline live: discovery → scrape → deep research → SnapVerify → pain extraction → score → triage (<50 suppress / 50-69 B-list / ≥70 enrich+pitch) → drip send → reply funnel.

## API integrations
| Service | Status |
|---|---|
| Anthropic (Claude) | ✅ working |
| Google Places | ✅ working (primary discovery source — carried the 2026-07-21 runs) |
| Yellow Pages CA | ✅ working — was 403'ing on a bot UA (2026-07-21), fixed with a browser UA. Free, no key. If it 403s again the headers need refreshing, NOT the selectors. |
| Brave Search | ⚠️ HTTP 402 (quota). **No longer critical** — per-prospect calls went 6 → 0 on 2026-07-21. Now used ONLY by the two user-triggered discovery sources; research is 100% first-party. |
| DENUE (INEGI, MX) | ⚠️ **Never returned a row since it was written.** The 406 was OUR `Accept: application/json` header (reproduced from a residential IP — the old "Vercel datacenter IP block" note was WRONG), and the URL matched no documented method (`Buscar` is a GEO search). Both fixed 2026-07-21 → now uses `BuscarEntidad`. STILL UNVERIFIED: INEGI emits malformed HTTP responses intermittently. **Recommendation: leave off** — Google Places covers MX. |
| Hunter.io | ✅ working (contact tier 3) |
| Anymail Finder | ✅ working (contact tier 2) |
| Gmail API (OAuth) | ✅ working (send + reply poll + DMARC ingest) |
| Yelp | ❌ **REMOVED 2026-07-17** (expired trial; code deleted). `YELP_API_KEY` still in Vercel but inert — safe to delete. |

## Key DB tables
`prospects` · `prospect_research` (pain_points, what_they_do, tech_stack) · `prospect_contacts` (priority_rank: 0 manual > 1 verified > 2 scraped > 3-5 role/guess) · `pitches` · `scores` · `discovery_runs` · `discovery_jobs` (self-chaining worker) · `replies` · `icps` · `case_studies` · `pain_taxonomy` · `sender_inboxes` · `cost_tracking` · `audit_log` · `hunter_scans` · `do_not_contact_list` · `blackout_dates`.

## Automation status (2026-07-21)
- **Pre-send verification gate** — built (`lib/pitches/send-gate.ts`, pure, 15 tests) and running in **DRY RUN**: every generated pitch is evaluated and the verdict logged to `audit_log` (`action='pitch.gate_dryrun'`). It blocks nothing.
- **Decision point:** run `scripts/gate-dryrun-review.sql`. Query 3 (pitches the gate would have held that Pedro sent anyway) decides whether auto-send is enabled. Pedro has chosen AUTO-SEND for PASS once it proves out.
- Gate rules: recipient usable + verified provenance (catch-all guesses never auto-send) · greeting == recipient · no website claim unless fetched · company name matches the site · metrics must appear in stored evidence.

## Known issues / tech debt (open, deliberate — need Pedro's call)
- Catch-all *guessed* addresses (`snapverify_catchall_guess`) are still inserted and can be approved by hand — but they are flagged "guessed address" on /pitches and the gate refuses to AUTO-send them.
- Discovery "discovering" phase is still one slice — can exceed 120s on 5-keyword ICPs. Now SAFE (20s keepalive heartbeat stops false "stalled" restarts; 3-attempt cap stops infinite re-running), but a genuinely-too-slow ICP will FAIL with "narrow the ICP's keywords". Real fix = per-source slicing, deferred by Pedro.
- `prospect_research` doesn't persist the scraped `site_name`, so the gate's company-name rule is skipped in the dry run.
- /companies loads max 500 prospects — silent truncation above that.
- Julien & Cormier: one draft pitch on a garbage address; remediation SQL ready (real addresses confirmed live).
- Google Places reviews/rating as a web-intel signal — NOT wired; different SKU, pricing unverified.
- **National-chain filter is a silent-deletion risk.** `lib/discover/chain-filter.ts` drops chains at insert. If a REAL prospect ever goes missing from discovery, check that list first and add a must-survive test for it.

## Recently CLOSED (do not re-open)
- Hunter 50-69 confidence → now SMTP-screened before insert (2026-07-21).
- LATAM mapping contradiction → LATAM retired from the ICP selector and maps to MX everywhere (2026-07-21).
- Per-email suppression → `do_not_contact_list` now enforced in all 3 send paths; bounces auto-add the dead mailbox (2026-07-21).
- Website-pitch fallback English-only → full ES template + localized greeting (2026-07-21).
- Greeting/recipient divergence, glued-domain addresses, initial+surname greetings → fixed with shared predicates + tests (2026-07-21).
- **Scraped-email glue (root cause)** → cheerio's `$("body").text()` has no element separator, so on a normal contact page EVERY plaintext match was garbage and the repair layer had *manufactured* a fake address that passed all guards. Fixed at the extractor (`textWithBoundaries`), verified against the live page. Do NOT add more repair heuristics — check the extractor first (2026-07-21).
- **"Re-enrich contacts" never re-scraped** → it now re-reads the site first and short-circuits the paid waterfall when the site yields a usable address (2026-07-21).
- **Yellow Pages HTTP 403** → bot-UA detection, not broken selectors. Browser UA restored it; verified by parsing the live page (2026-07-21).
- **Discovery "resetting itself"** → the discovering phase emitted no heartbeat, so the watchdog restarted healthy runs every ~100s. Keepalive + 3-attempt cap (2026-07-21).
- **DENUE's "Vercel IP block"** → FALSE. It was our own `Accept` header (406) plus a URL matching no documented method. Never re-assert the IP theory (2026-07-21).

## Recent sessions
- **2026-07-21** — Pitch integrity (greeting≠recipient across 3 composers; glued-domain addresses; initial+surname greetings), bulk-job UI resume, honest status filter, **Brave removed from the per-prospect path (6→0)**, the **send-gate + dry run**, and — caught by Pedro post-wrap — the cheerio text-boundary root cause behind every mangled scraped email, the Yellow Pages bot-block, a national-chain filter, the discovery restart loop (self-inflicted by the YP fix), and DENUE's real defects (our own Accept header + an endpoint that never existed). 18 commits. (this session)
- **2026-07-17** — Critical-fail audit: fixed the Acadian fake-website pitch, email-bounce root causes, Yelp/Brave/DENUE, + ~20 more via a 3-agent full-system audit. Shipped `38e04e4`.
- **2026-07-09** — Cost reduction: prompt caching, closed a cap hole, cut redundant scoring (~20-35% cheaper/run).
- **2026-06-25** — Pitch↔Hunter handoff (P1-P4), reply nudge, bounce→suppress, triage tiers, discovery time-budgeting.
