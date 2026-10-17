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
- Prod = `main` = `ae03703` (2026-10-17, Phase 1 parts 1 and 2 shipped on Pedro's "ship it"). `main` = prod.
- Migration **0038** (pitches.decision + write-once trigger, pitches.attribution_code, pitch_event_type values, prospect_contacts.verify_*) applied to prod 2026-10-17, recorded as version 0038.
- Migration **0039** (hunter_scans.ref + trigger `hunter_scans_pitch_event`: a scan carrying a pitch's attribution code → `pitch_events` 'audit_scan' {stage: scan}; its contact-form submit → {stage: contact_request}) applied 2026-10-17, recorded as version 0039. runna-hunter `3b4077f` sends `?r=` with each scan. Before this: `hunter_scans` had 6 rows ever, the last on 2026-06-25, i.e. the Jul–Aug sends produced no logged scans.
- Migrations **0036** (pitches.gate_verdict + gate_override) and **0037** (sourced benchmarks: 41 seeded + 4 activated → 48 active) applied to prod 2026-10-17, recorded as versions 0036 / 0037.
- Migration **0035** applied to prod 2026-10-16 (RLS on warmup_buddies / warmup_templates / dmarc_reports / dmarc_report_records; anon + authenticated grants revoked; recorded as version 0035).
- Warmup engine live (pedro@runnareach.com, now 5/day maintenance; 7 buddy inboxes). Inbox placement has never been measured in prod (1,289 sends, 0 checks: Message-ID bug); fixed in P1.6 (shipped 2026-10-17); first real placement data expected from the 2026-10-18 tick.
- Pipeline: discovery → scrape → deep research → SnapVerify → score → triage → draft. **Nothing has run since Jul 21 (discovery) / Aug 16 (last send)** — discovery is manual-only.
- Full audit + autopilot/learning plan: `tasks/audit-2026-10-16.md` (read it first).

## Phase 0 — "stop the bleeding" (SHIPPED 2026-10-16)
361 tests, build green:
- **CASL**: footer (Rünna · Mexico City address · runnik.ca or runna.com.mx · hola@runna.mx · unsubscribe link; ES adds the aviso de privacidad) + List-Unsubscribe / one-click on every prospect-facing send; `/api/unsubscribe` (HMAC token, GET = confirm page, POST = opt out → DNC + suppress + stop sequences). Sender details are code defaults in `lib/compliance/outbound.ts` (env overrides). **Fails closed without `TOKEN_ENCRYPTION_KEY`.**
- **Encoding**: QP encoder no longer splits `=C3=BA` (was garbling ~39% of long Spanish lines); header injection blocked.
- **Replies**: classify only their own text (quoted thread stripped); EN/ES/FR opt-outs auto-honoured (DNC); bounce suppression no longer undone; OOO postpones instead of killing the sequence; "Delivery incomplete" ≠ bounce; replies keyed on the thread's first send.
- **Send safety**: Gmail thread re-read right before every follow-up/nudge; follow-ups at-most-once (claim before send); one first email per prospect/address; stuck `sending` rows resolved from Gmail Sent; unsendable pitches leave the queue.
- **Cost**: cost-tracking + audit log use the service-role client (cron AI spend was uncapped and unrecorded); cache tokens billed; cap sum paged.
- **SPAM Verify** (`lib/research/verify-recipient.ts`): free verifier (format, never-pitch, regulators, DNS with a control query, ownership, provenance, bounce memory). "drop" never sends.

Still open after the ship:
- Pedro: Settings → Sending → "Send a test email" (EN + ES, +tag address, plus Outlook); check accents, button, footer links, unsubscribe. Not done by Claude (no Gmail access from the session).
- Sentry: already correct (warmup-engine active; postmaster-sync, dmarc-sync, reactivation disabled). warmup-engine's first post-fix check-in expected ~14:22 UTC 2026-10-17.
- Optional: unsubscribe links still read `spam-runnareach.vercel.app/...` — a free `go.runnareach.com` CNAME + `UNSUBSCRIBE_BASE_URL` fixes the look.
- pedrojr22@gmail.com is Pedro's (confirmed) → the GYMVMT "reply" was a test; exclude from metrics.

## Phase 1 — "make good measurable" (part 1 SHIPPED 2026-10-17)
396 tests, build green. Shipped:
- **P1.1 `1741bc9` Sender identity**: prospect emails come from "Nils · Runna Advertising" (ES) / "Henry · Runna Advertising" (EN), signed the same (Pedro, 2026-10-16: both real team members; sending address stays pedro@runnareach.com). `lib/pitches/sender-identity.ts`; env overrides RUNNA_SENDER_NAME_EN / _ES / RUNNA_AGENCY_NAME. Legacy "Pedro" sign-offs are swapped at send time (`reconcileSignOff`). Follow-up templates now bilingual.
- **P1.2 `cb26785` Pitch prompt v2** (`PITCH_PROMPT_VERSION = pitch-v2-2026-10-16`): one rule per topic, no contradictions. Never a client (case studies no longer sent to the model; case_study_id always null), numbers only from verified benchmarks + "about 30 seconds", no internal product names (`RUNNA_CAPABILITIES_FOR_PITCHES`).
- **P1.3 `50afda4` Send gate v2** (`lib/pitches/send-gate.ts` pure, `lib/pitches/gate.ts` DB): block vs review severity; enforced at approve (review = "Approve anyway", audited), bulk approve (pass only), send-queue + Send now (exact body/recipient), follow-ups (template fallback, else pause), nudges (review lane). Verdict stored on `pitches.gate_verdict`, shown on /pitches. Replay over the last 60 sent emails: 30 blocked (all real violations), 16 review, 14 pass.

- **Sourced numbers** (Pedro, 2026-10-16: "not inventing numbers but do be flexible… research real data… and use that"): benchmark library of 48 active, sourced stats (publisher, URL, caveat, vendor flag) across enquiry response, automation, dashboards, B2B online buying, clinic reminders/booking, site speed, restaurants, online stores, retention, reviews, hotels. The prompt USES a matching benchmark, attributed and framed as what businesses like theirs see; the gate holds any other number. Checked via search excerpts of each publisher's page (the session couldn't open pages); review/deactivate on /benchmarks.
- **Cold-email evidence in the prompt**: 60–100 words, ~5th-grade reading level, 1–2 sentence paragraphs, 2–6 word subjects; sender-made % / ROI claims LOWER replies in the data (Gong −15%), so stats describe the reader's world, never promise a result. Stat-vs-no-stat should be measured once the decision record (P1.5) exists.

### Phase 1 part 2 — SHIPPED 2026-10-17 (`ae03703`, migration 0038 applied first)
425 tests, build green.
- **P1.4 `de91b92` Write → review → revise** (`lib/pitches/review.ts`): every Claude pitch is checked by the gate's writing rules + a Haiku critic (rubric: grounded, relevant, plain, native language, fit, shape); issues go back to the writer, max 2 revisions inside the 60s action (deadline startedAt+48s); best draft wins. Verdict on /pitches ("AI review" panel). Rewrite-with-angle uses the same loop.
- **P1.5 `de91b92` Traceability**: `pitches.decision` (immutable JSONB, trigger-enforced: path, prompt version, model, fallback, lang/register, segment, pain, benchmarks offered + cited, recipient shape, critic, gate) · `pitches.attribution_code` → `&r=` on the audit-tool link (runna-hunter must store `r`) · `pitch_events` rows for generated / approved / gate_held / sent (recipient source, verify verdict, accepted gate codes, edit ratio) / reply / bounce / unsubscribe · `prospect_contacts.verify_*` · test addresses (`RUNNA_TEST_EMAILS`, default pedrojr22@gmail.com, +tags and Gmail dots normalized) excluded from pitch/reply analytics · hunter link market check was case-sensitive (prospects store "CA"/"MX") so every prospect fell back to language — fixed.
- **P1.6 Quality fixes**:
  - Warmup placement: the log stored Gmail's internal id, but the buddy IMAP search needs the RFC Message-ID → 0 of 1,289 sends were ever checked and the spam-rate pause never had data. Now the RFC id is read after each send (and resolved lazily for older rows); check window 24h → 72h newest-first (the daily cron fires anywhere in its hour). Also: a message found in SPAM was recorded as inbox (`foundInInbox || movedToInbox`) — now recorded as spam. Expect real placement numbers within a day of deploy; a ≥20% spam rate over ≥5 checks will auto-pause warmup, as designed.
  - Chain filter: ambiguous brands (Safeway, Staples, Winners, Atmosphere, McDonald's, Wendy's, Desjardins, Liverpool, Del Sol, Coppel…) drop only as the bare brand, brand + branch tail, or brand + its own qualifiers ("Safeway Pharmacy"); "McDonald Law Office", "Panadería del Sol", "Atmosphere Salon" survive. "Sucursal Centro" / "Location #2" / "Mattress Supercentre" no longer read as chains (store numbers need 2+ digits). All 14 real chain listings in prod still drop.
  - Domain ownership: new review-level gate code `domain_ownership_unsure` when a non-manual first-email recipient is on the prospect's domain and `siteOwnership` (now pure, `lib/research/site-ownership.ts`) can't tie the domain to the company, or it's parked. Acronym domains that spell the initials (4+ letters, e.g. sbghc.on.ca) count as a match. Replay on the 12 real sent first emails with an on-domain address: 0 flagged; Corvex → linamar.com flagged.
- Deliberately unchanged: the follow-up cron still falls back to the (bilingual, gate-checked) template when the AI follow-up fails or fails the gate. The audit says "templates never enter AUTO"; the risky first-pitch templates only go out after approval. Pedro to decide whether follow-ups should wait for the AI instead.
Possible follow-ups: the sequence is 3 emails; the research says 4–6 touches over 2–4 weeks get more replies (Hunter: 3 messages = +106% vs one). Canadian/Mexican-specific stats (BDC, StatCan, AMVO) were found but not confirmed.

## Phase 2 — Autopilot + learning (SHIPPED 2026-10-17)
Pedro, 2026-10-17: "the end goal of total automation with learnings that make it smarter at searching, smarter ICPs, smarter pitches, smarter emails… and continuously improve the hunter… autonomous". 499 tests, build green.
SHIPPED on Pedro's "ship it": migrations 0040 + 0041 applied, main = `4b22ad1`+, runna-hunter main = `867d007`. Autopilot ON for the Rünna tenant at stage **veto** (AUTO pitches are approved and scheduled 18h out, digest email to `AUTOPILOT_NOTIFY_EMAIL` → `REPLY_FUNNEL_NOTIFY_EMAIL` → petedv31@gmail.com). Kill switch: `update autonomy_state set enabled = false`.
- First runs (05:39 + 05:45 UTC): tick 200 both times; the scout started cell "direct to consumer × Alberta"; the 05:45 tick's watchdog resumed the chain and the job finished unattended. That cell returned news/government pages (CityNews, Winnipeg Free Press, news.gov.bc.ca), 0 pitches; the scout will score it down.
- Fixed during the ship: (1) every route had been capped at 60s since June. Vercel uses the FIRST matching `functions` pattern and `app/**` was first, so no 120s override ever applied (lessons.md). (2) A slice waited for its successor's whole slice, so it ran twice as long. It now hands over and stops waiting after 8s. (3) The tick's daily discovery budget wasn't counted across jobs, so an empty cell would re-crawl every 15 min. It now counts the last 24h, allows at most 6 autopilot jobs a day, and gives each job its remaining budget as `stats.max_processed`. (4) Brave results on government, news.* and major-paper hosts are dropped (`lib/discover/non-business.ts`).
- Second pass (06:00 job "spa × Nuevo León": 16 new, pitches written, writer arms recording benchmark / no_benchmark): (5) the cell's region never reached the search. Mexican runs always searched "Mexico" and Canadian city cells all of Canada, so that job pitched Mexico City spas. `lib/discover/search-geo.ts` now sends each source the focused region (INEGI code → Places query + location bias). (6) `candidateCells` skips technology/attribute keywords (Shopify, Meta Pixel, premium, direct to consumer…), about a quarter of all cells. (7) Brave drops numbered list pages in EN/ES. (8) The first 30-min reply poll lost 89 of 178 thread reads to Gmail's per-minute quota. Reads now back off and retry, and the poll defers the oldest threads after 100s.
- First unattended day (05:39–15:00 UTC): 38 ticks and 19 reply polls, all HTTP 200, no breaker trips. 6 discovery jobs (the new daily cap, reached 08:30): 115 prospects researched, 25 pitched, 29 drafts, **all in REVIEW, nothing sent**. Cause: the AI reviewer passed a draft only with zero issues of any kind, so 0/29 passed (every score 0.62). Fixed in `4b22ad1`: each issue is blocking or polish, and pass = no blocking issue (see `lib/pitches/review.ts`). The 29 existing drafts keep REVIEW (the decision record is write-once); tomorrow's jobs are the first test. Other REVIEW reasons: verifier unsure (4), template path (3), gate codes (6).
- Reply poll, third fix (`49e05e4`): retries alone still lost 10 threads and deferred 55 at 15:00. A half-hourly run now lists inbound mail from the last 2 days (one call per inbox, spam included) and reads only those threads. The daily Vercel cron (user agent vercel-cron) still reads every thread.
- Test-era data deleted (migration 0042, run by Pedro in the SQL editor, recorded as version 0042): the unsent July draft, 649 never-emailed prospects, 36 old discovery jobs and 206 old runs. Kept: the 176 emailed businesses with 478 sent pitches and 32 replies (stops a second cold email; CASL record), the DNC list, and everything the autopilot made since 05:39 UTC.
- Limits (Pedro, 2026-10-17, "no need to scale up yet"): autopilot research at most 100 prospects/day (`MAX_PROSPECTS_PER_DAY`) and 6 jobs/day; Claude spend capped at $3 per rolling 24h (`ANTHROPIC_DAILY_USD_CAP`=3 in Vercel production). Day one cost $3.06 for 115 prospects and 25 pitches (~$0.12 per pitch).
- Not fixed, noted: DENUE answers "No autorizado. Utilice una clave válida" (key invalid; it was already recommended off). Several ICPs carry technology keywords that manual runs still search with.
- **Explicit actor** (`lib/actor.ts`, `c434609`): every pipeline stage (discover → crawl → scrape → research → score → triage → pitch) lives in `*-stage.ts` as `xxxWith(actor, …)`; the `"use server"` files are thin session-only wrappers. `systemActorFor(tenant)` (service role, tenant's first admin id, named "Autopilot") only behind the CRON_SECRET check. The discovery worker chains system jobs with the cron secret + tenant header. Also closed: `generatePitch` accepted an injected user from any browser caller.
- **Governor** (`lib/autopilot/governor.ts`, pure): AUTO/REVIEW/DROP lanes; circuit breakers (inbox bounces, daily bounces, opt-out spike, DMARC < 90%, blocklist, warmup placement < 80%); stages off → shadow → veto → auto with automatic promotion/demotion. Never learnable.
- **Tick** (`/api/autopilot/tick`, every 15 min via pg_cron, `lib/autopilot/tick.ts`): breakers → watchdog (resume dead discovery chains) → scout starts a focused discovery job when capacity needs pitches → label drafts (verifying recipients) → veto: approve AUTO through the normal gate-checked action and schedule 18h out + digest email; a pitch a person pulls back is never re-queued; auto: schedule now → stage evaluation → learners.
- **Learners** (`lib/autopilot/learn.ts`, pure parts in `lib/learning/*`): shared segments/reward/bandit; `writer.evidence` (benchmark vs none) and `writer.guidance` (weekly AI review proposes ≤ 2 one-line instructions, safety-checked, tested as challengers, ≤ 4 live) recorded per pitch in `decision.arms`; `scout.cell` credited by what its prospects became; weekly ICP learner adds search cells for the industries that convert or that visit the Hunter organically.
- **Hunter loop**: `/api/public/hunter-signals` (aggregate weights per industry × finding) → runna-hunter `867d007` orders findings by them (time sink still first) and records finding ids per scan.
- **Scheduler** (migration 0041): pg_cron + pg_net; token generated inside Postgres, kept in Vault, checked via `scheduler_token_valid` (service role only); tick every 15 min, reply poll every 30 min, send-queue every 10 min and follow-ups hourly Mon–Fri 15–22 UTC. Vercel daily crons stay as backstop.
- Session note: the Auto-mode safety check refused the service-role pipeline and creating an account; Pedro switched the session to "Accept edits" and approved. Permission rules were not edited.

## Phase 3 — batch 1 (ON INTEGRATION BRANCH `claude/gallant-gauss-gly093`, awaiting Pedro's "ship it")
First batch run through the conductor/worker workflow (`.claude/skills/conductor/SKILL.md`,
retro in `tasks/retros/2026-10-17-phase3-batch1.md`). 593 tests, build green, 6 PRs reviewed
and merged into the integration branch in 58 minutes. NOT in prod yet.
- **Booking → opportunities** (`lib/opportunities/calendar-sync.ts`, `/api/opportunities/calendar-sync`,
  migration 0044 = hourly pg_cron): Google Calendar appointment-schedule bookings on the
  connected inbox become `opportunities` rows (stage meeting_booked, source calendar,
  idempotent on calendar_event_id), a `meeting_booked` pitch event on the ROOT pitch,
  audit `opportunity.booked`, and `prospects.status = 'booked'` (which stops follow-ups).
  Cancellations → lost / "booking cancelled". Only events the inbox organizes count.
  Needs `calendar.readonly` scope: **Pedro reconnects Google once after ship**; until then
  the sync reports `needsReconnect` (HTTP 200, no error). Optional env `CALENDAR_BOOKING_INBOX`.
- **Pipeline on /opportunities** (`lib/opportunities/{queries,actions,outcome}.ts`): list +
  mark won (value) / mark lost (reason); sets `prospects.status`, writes `won`/`lost`
  pitch events on the root pitch and audit `opportunity.won/lost`.
- **Hot-lead badge on /pitches** (`lib/pitches/hot-lead.ts`): "Asked to talk" / "Ran the
  check" from `pitch_events.audit_scan`, plus a "Hot leads" filter. One extra query.
- **Learners section on /learning** (`lib/learning/{report,queries}.ts`): arms per learner
  with trials, rate, confidence label (<20 trials: rate hidden). Observation only.
- **Contact source URL** (`prospect_contacts.source_url`, migration 0043): the scraper
  records the page each address was mined from (Contact page wins); other sources null.
- **Exemplar memory** (`lib/pitches/exemplars.ts`, `exemplar-queries.ts`): up to 2 scrubbed
  past pitches from the same segment (score ≥ 0.5, settled ≥ 14 d, root, sent, critic pass)
  go into the writer's and critic's USER messages; system prompts byte-identical; fails
  closed (exemplar dropped if any distinctive company/name/city token survives scrubbing);
  recorded in `decision.exemplars_used`. No embeddings (would need a paid API).
- Shared: migration 0043 (opportunities.source/calendar_event_id, pitch_event_type
  +meeting_booked/won/lost, prospect_contacts.source_url), `lib/pitches/root-pitch.ts`
  (`latestRootSentPitchId`, the one lookup for timeline events), audit actions
  `opportunity.booked/won/lost`, send-gate blocks 1-char placeholders (`[n]`).

**Ship steps (order matters, batch audit):** 1) apply 0043 in the SQL editor FIRST: every
contact insert now names `source_url`, so code deployed before 0043 would fail each insert
and the autopilot research path would silently stop saving contacts; 2) merge the integration
PR (deploy); 3) apply 0044 (schedules the hourly calendar sync; before deploy it would 404);
4) reconnect Google in Settings so the new calendar scope is granted; 5) optionally set
`CALENDAR_BOOKING_INBOX` in Vercel.
**Open questions** (board): invite you send counts as booked before acceptance (default keep);
cancel-then-rebook makes two opportunities (default accept).

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
- Discovery "discovering" phase is still one slice — can exceed 120s on 5-keyword ICPs (it was really capped at 60s until 2026-10-17, see lessons). Autopilot jobs search ONE keyword × region, so they stay well inside it. Now SAFE (20s keepalive heartbeat stops false "stalled" restarts; 3-attempt cap stops infinite re-running), but a genuinely-too-slow ICP will FAIL with "narrow the ICP's keywords". Real fix = per-source slicing, deferred by Pedro.
- /companies loads max 500 prospects — silent truncation above that.
- Julien & Cormier: one draft pitch on a garbage address; remediation SQL ready (real addresses confirmed live).
- Google Places reviews/rating as a web-intel signal — NOT wired; different SKU, pricing unverified.
- **National-chain filter is a silent-deletion risk.** `lib/discover/chain-filter.ts` drops chains at insert. If a REAL prospect ever goes missing from discovery, check that list first and add a must-survive test for it.

## Recently CLOSED (do not re-open)
- **`site_name` now persisted (migration 0027)** → send-gate rule 4 ("stored company name contradicts the site's own name") had NEVER fired, because gate-dryrun.ts hard-coded `siteName: null`. It caught a real mismatch within hours of going live (2026-07-22).
- **Unsendable pitches** → `generateWebsitePitch` had no contact gate (only `generatePitch` did), `bulkApprovePitches` had none, and "Queue N for send" counted pitches the queue filters out. All gated (2026-07-22).
- **Sub-page emails were binned** → sub-pages were fetched for BODY TEXT only, so the /contact page was downloaded on every scrape and its `mailto:` links discarded. Mined at fetch time now; 57 contacts recovered in a sweep (2026-07-22).
- **Named clients in pitches** → removed from EVERY path; client names are no longer sent to the model at all (2026-07-22).
- **Fabricated statistics** → the prompt literally instructed "Use industry BENCHMARKS for any numbers". Replaced by a sourced `benchmarks` table (2026-07-22).
- **The duplicate `0005` migration** → two files shared a version, and `schema_migrations` is keyed by version, so `db push` died on a duplicate-key insert. This had silently blocked EVERY CLI migration in this repo since 0005 was written (which is why 0001-0026 all went through the Management API). Renumbered to 0028; `db push` works normally now (2026-07-22).
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
- **2026-10-16** — Full audit (live data + 4 code audits) → `tasks/audit-2026-10-16.md`; Pedro's near-free cost rule (CLAUDE.md); Phase 0 built on the branch (above). Key numbers: 176 companies emailed, 3 real human replies, 0 real positives (the GYMVMT "interested" was a test to pedrojr22@gmail.com), bounce 6.1% after July fixes, 0 emails to a named person.
- **2026-07-22** — Started from Pedro spotting 11 unsendable "Approved" pitches. Closed the pitch-gate hole in every path; discovered sub-page emails were being fetched and binned (57 contacts recovered); **INCIDENT: a re-scrape sweep wrote two privacy commissioners as prospect contacts** — Canadian privacy policies must name the regulator, so /privacy is the page most likely to hold one (fixed structurally, 16 rows deleted); persisted `site_name` so the wrong-company gate finally fires; removed named clients everywhere (Pedro's 2nd override); fixed a CTA button shipping a literal `{hunter_url}`; built the sourced **benchmark library** + /benchmarks admin page; and traced "the Spanish pitches are meh" to a JSON parse failure silently discarding good Claude output. 15 commits, migrations 0027-0031. (this session)
- **2026-07-21** — Pitch integrity (greeting≠recipient across 3 composers; glued-domain addresses; initial+surname greetings), bulk-job UI resume, honest status filter, **Brave removed from the per-prospect path (6→0)**, the **send-gate + dry run**, and — caught by Pedro post-wrap — the cheerio text-boundary root cause behind every mangled scraped email, the Yellow Pages bot-block, a national-chain filter, the discovery restart loop (self-inflicted by the YP fix), and DENUE's real defects (our own Accept header + an endpoint that never existed). 18 commits. (this session)
- **2026-07-17** — Critical-fail audit: fixed the Acadian fake-website pitch, email-bounce root causes, Yelp/Brave/DENUE, + ~20 more via a 3-agent full-system audit. Shipped `38e04e4`.
- **2026-07-09** — Cost reduction: prompt caching, closed a cap hole, cut redundant scoring (~20-35% cheaper/run).
- **2026-06-25** — Pitch↔Hunter handoff (P1-P4), reply nudge, bounce→suppress, triage tiers, discovery time-budgeting.
