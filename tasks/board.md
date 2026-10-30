# Board (conductor-owned)

Single source of truth for who is doing what. A fresh conductor session resumes from this
file alone. Update it on every spawn, every status change, every merge. Batches older than the
previous one move to `tasks/archive/board-<YYYY-MM>.md` at each retro (batches 1-8: `tasks/archive/board-2026-10.md`).

## Current phase
`phase3-batch10` READY (all tasks merged, audit clean, retro written; waiting for Pedro's "ship it") — active since 2026-10-28 19:12 UTC on `claude/phase3-batch10-integration` (main 1bd256b + notes branch). **Owner: session_01HtEg7XG4MPQU4omrd2BX69.** Rows and log: "Batch 10" section at the end.
`phase3-batch9` SHIPPED 2026-10-26 16:21 UTC (main 7a76b66, PR #62; no migrations) — active since 2026-10-26 15:20 UTC on `claude/phase3-batch9-integration` (main 7e55e1b + batch 8 notes). **Owner: session_01HtEg7XG4MPQU4omrd2BX69.** Rows and log: "Batch 9" section at the end.

## Environment (written at resume)
2026-10-27, cloud session: remote sessions yes (`create_session`) · in-session workers yes · wake-ups yes (`send_later`) · PR events yes (`subscribe_pr_activity`) · GitHub MCP yes · brain via cloud hooks.

## Approvals and checks
| Item | State |
|---|---|
| Prod = main head before cutting integration | |
| Batch plan sent to Pedro | |
| Integration → main PR | |
| Build green on integration | |
| Origin in sync (`git status -sb`) | |

## Reserved migration numbers
| Number | Reserved for | Status (reserved → used → applied) |
|---|---|---|
| 0045 | platform-reports: `0045_reports_cron.sql` (spam-health-check hourly :25, spam-weekly-report Mon 13:10 UTC) | APPLIED 2026-10-18 16:23 UTC via connector after dry runs were clean; version normalised to `0045` |
| 0046 | conductor wave 0: `0046_replies_gmail_message_unique.sql` (unique (tenant_id, gmail_message_id) where not null; poll skips 23505) | APPLIED 2026-10-18 20:15 UTC via connector (0 dup pairs just before), version normalised to `0046`, index verified |
| 0047 | booking-alert-durability: `0047_opportunities_alert_markers.sql` (booked/cancelled alert markers + meeting_start/time zone + cancelled_at; backfill). Written by the conductor in wave 0 | APPLIED 2026-10-18 20:16 UTC via connector, version normalised to `0047`, 5 columns verified |
| 0048 | bounce hotfix | APPLIED (version 20261019190301) |
| 0049 | batch 4 send slot | APPLIED (version 20261019211644) |
| 0050 | batch 7: `0050_wanted_facts.sql` | APPLIED 2026-10-21 21:56 UTC via connector before the merge, verified, version normalised to 0050 |
| 0051 | batch 8 health-alarms: `0051_cron_heartbeats.sql` | APPLIED 2026-10-22 21:28 UTC via connector, verified (6 cols, RLS on, 0 policies), version normalised to 0051 |
| 0052 | batch 8 send-pacing: `0052_follow_up_every_10min.sql` | APPLIED 2026-10-22 21:29 UTC via connector, verified (spam-follow-up = 7-59/10 15-22 * * 1-5, active), version normalised to 0052 |
| 0053 | quiet hours (branch `perf/quiet-hours-cron`, PR #63, outside the batch flow): `0053_quiet_hours_cron.sql` (moves 12 pg_cron jobs) | used; apply AFTER the deploy |
| 0054 | batch 10 site-crawler: `0054_site_observations.sql` (table + claim fn + cron spam-site-observe) | used; apply AFTER the deploy |
| 0055 | — | free |

## Worktrees to clean up (in-session workers only)
| Path | Branch | Remove after |
|---|---|---|

## Optional findings carried (✔ = taken into a batch)
- ✔ meeting_booked/won/lost do not feed scoreOutcome or the exemplar shortlist → learning-meeting-outcomes.
- ✔ three prospects.status writers with three overwrite rules → prospect-status-guard (also: markProspectBooked overwrites suppressed; prospects update should skip 'suppressed').
- ✔ calendar-sync route has no maxDuration; getAccessToken has no timeout; opt-out.ts own root-pitch query → wave 0.
- ✔ listPitches throws on a pitch_events error → pitches-list-resilience (wave 2).
- ✔ exemplars: 3-letter brands, lowercase honorific names, city abbreviations (CDMX) → exemplar-scrubber-gaps.
- From PR #13 review (batch audit): points sum per event ([sent,booked,booked] = 40; nothing reads .points yet); hunter-signals route also calls scoreOutcome, so bookings now raise runna-hunter findingWeights (intended, note in audit); [sent, hard_no, booked] → value 1 + negative (cautious, fine). Bounced-root-as-exemplar → sent to exemplar-scrubber-gaps worker 06:57.
- From PR #14 review: intent-actions toast + audit say "booked"/"suppressed" even when the guard blocked the write (show what was observed); bounced path skips cooldown_until when guarded (write it unguarded); other status writers outside the rule: discover/pipeline-stage.ts:641 reactivation (suppressed/no_match → researched, breaks I5), deep-research-stage.ts:378, hunter/actions.ts:202; pin DO_NOT_SEND_STATUSES to send-action/send-queue/follow-up copies with a test. Decision: replied guard now also protects no_match (I5 wins over the brief's 'exact string'; nudge would otherwise reach a no_match prospect).
- From PR #15 review: no unique index on replies(tenant_id, gmail_message_id) (0 dups in prod today) → overlapping pg_cron + Vercel poll runs could store one message twice → next-batch migration; booking alerts not durable (Google notifies the organizer anyway); sendGmailMessage had no timeout → conductor added opt-in timeoutMs, notifications only (7941c5b).
- Open: placeholder regex duplicated in send-gate and composer (export one); needsReconnect persists silently (Sentry warning); warn when CALENDAR_BOOKING_INBOX matches no inbox; root-pitch.ts drops its query error; prospect activity feed does not render opportunity.won/lost; reward.ts and hot-lead.ts decide audit_scan stage with different rules (share levelOf); 200-row /pitches window hides old hot leads; "Asked to talk" chip tone; /learning: trials=100 boundary test, honest "arms not loaded" error state, order + truncation notice at 2000, icp learner never writes arms, UI <20 vs bandit 15/30 thresholds; dedupe opportunities per prospect on rebook.

- From batch 3 reviews (carried, not done): reply poll — a run killed between the reply insert and its opt-out leaves the opt-out to the lead alert's optOutFailed flag (0046 makes the next run skip the row); calendar-sync — kill between createOpportunity and recordEvent/audit loses those writes (pre-existing); booking alert "Who" reads "unknown attendee" when the contact row is gone; one shared deadline across tenants in the calendar sync; follow-up DNC/suppression pauses write no audit row; follow-up release restores next_followup_at and can undo a concurrent OOO postponement (inherited); the recheck's two GETs run on a client with no fetch timeout (service-role, conductor-only); poll DEAD_STATUSES lacks no_match; nudge route accepts only CRON_SECRET; first-read DNC checks fail open by design; 200-row /pitches window; share levelOf with reward.ts.

- From PR #26 (worker, out of scope): a prospect parked mid-run can still get an orphan draft pitch before the guarded status write refuses (status stays parked, sends blocked; generatePitchWith could check status before the Claude call); standalone deep research (UI button) still spends Claude on a do-not-send prospect (only its suppress write is guarded).

- From the e20b246 review (pre-existing, next batch): /companies "Run pipeline" accepts any status and processSingleProspectWith's writeStatus has no from-state, so re-running a sent/replied/ghosted/bounced/pitched prospect moves it back to pitched/b_list/suppressed (allowed by I1–I5 but backwards in the funnel); the scrape bump and deep-research suppress ignore `error`; run route's suppressUnfinished sweeps only `raw`, so a prospect bumped to researched then errored is neither swept nor re-selected.

- From #17 (rounds 6–6d, carried, not blocking): brands alone (Toyota, Volvo); nicknames missing from the names list (Memo, Nacho; third person only); ROLE_LOCALS department inboxes (fails closed); lowercase COMMON_NAMES false drops (rojas, ríos); placeWords at a sentence start drop (Doctores…, Madera…, Lagos y ríos…; fail-closed); lowercase places in a body pass (Claude capitalizes); neighbourhoods Don Mills / Le Plateau / Zona Rosa; streets made of everyday words; the beach-club template ("In Cancún and Los Cabos…") never becomes an exemplar (switch: CAPITALIZED_PHRASES, deliberately off). Worker out-of-scope:
  - lib/pitches/exemplars.ts: a company ending in "Inc."/"Ltd." leaves the trailing dot after `[company]` ("[company]. answers"); cosmetic, pre-existing.
  - One placeholder regex for send-gate, composer and exemplars is still separate (brief's out-of-scope item; `PLACEHOLDER_RE` in exemplars.ts is a third copy).

## Shared-file changes pending (conductor does these)
| Requested by | File | Change | Done |
|---|---|---|---|
| pitches-hot-lead-badge (b1) | lib/supabase/types.ts | add pitch_events so the any-cast can go | pending |
| prospect-status-guard | lib/compliance/opt-out.ts | adopt the status predicate | done 6f9ff16 |
| prospect-status-guard | app/api/replies/poll/route.ts (bounce ~353 + replied ~449, `@/lib/prospects/status` ok), lib/opportunities/calendar-sync.ts markProspectBooked (RELATIVE `../prospects/status.ts`; tests/opportunities-calendar-sync.test.ts:362 asserts "(won,lost)" → compare as sets) | adopt after lead-alerts merges | done 82a163e (bounce audit row only when the status changed) |
| platform-reports | vercel.json | daily Vercel cron backstop for /api/reports/health | done (40 12 * * *) |

## Batch 9 (phase3) — started 2026-10-26 15:20 UTC
Scope (Pedro 2026-10-26 "go with all three and run batch 9", plus the digest noise): (1) stop guesses stated as fact (writer and/or critic calibration, measured on real failed drafts); (2) rewrites compose fresh instead of revising the held draft (fresh 27% vs revised 12% sent/approved); (3) greeting rules (role inbox → "Hi <company> team", no "pass this along"); (4) the veto digest announces each email once (Pedro: 6-8 digests listing the same prospects; "1 or 2 heads up is more than enough").
Evidence: batch 6 three-day check (project-state batch 6): rewrites 10/68 sent/approved vs 41% baseline; 79% of critic failures = guess stated as fact. Digest audit rows 10-21..26: 12 digests, same queue repeated over the weekend.
Workers: writer-honesty (1-3, pitches hub, opus/high), digest-once (4, lib/autopilot, opus/high), parallel (disjoint files). Writer brief waits for a 30-draft calibration study (Opus subagent, running) so it fixes the right side.

| Slug | Module | Model/effort | Branch | Session | PR | Depends on | Status | Turns | Review findings | CI reds | Rework |
|---|---|---|---|---|---|---|---|---|---|---|---|
| digest-once | veto digest: each email announced once, no empty digest, truthful subject | opus/high | claude/digest-once | session_01F9yRiYtBRPzsFF8VqUReoQ | #60 | — | MERGED c733ecb (0 blocking) | | | | |
| writer-honesty | writer + critic calibration on guesses, greeting rules, fresh rewrites, prompt v3.3 | opus/high | claude/writer-honesty | session_01HVDrD3T9YACnHYzGea5QkE | #61 | calibration study | MERGED bf05f9a (r1: 2 blocking fixed, verified) | | | | |

Log:
- 2026-10-26 15:20 UTC — Pedro picked all three + digest fix. Integration cut (main merged into batch 8 notes; code identical to main). digest-once brief written; calibration study running.
- 2026-10-26 15:45 UTC — Calibration study (Opus, newest 30 failed v3.2 drafts, 64 blocking issues): critic over-strict 31, writer unsupported 16 (11 from research advice stored as evidence_quote), greeting code/writer 7, critic wrong on greeting 4, recipient data 2, statistic 4. Estimate: both fixed → ~20-25 of 30 pass (critic only ~12, writer only ~3). writer-honesty brief written (writer + critic + greetingName + observed flag + fresh rewrites, prompt v3.3).
- 2026-10-26 15:55 UTC — #60 digest-once (15:29) and #61 writer-honesty (15:45) opened; subscribed; two Opus reviewers running.
- 2026-10-26 16:00 UTC — #60 review (Opus): merge, 0 blocking (every send path traced; property test 672 emails over a week each listed exactly once before send; 1537 tests, build). Merged c733ecb. Optional noted, not taken: pitches query .limit(200) could hide a fresh item only above 200 total daily cap (1 inbox, cap 30 today).
- 2026-10-26 16:10 UTC — #61 review (Opus): fix-then-merge, 2 blocking (subject rule 'always polish' lets a claim in the subject reach AUTO; PR-body SQL uses a non-existent enum value 'queued'). Optional taken: offer-sentence loophole, 'yours', isAdviceQuote gaps both ways (debe/sugerimos/needs a; 'Use our…' is site copy), full_name company rule, no forwarding line to ceo@/owner@. Noted: template fallback still uses advice quotes (review lane only); role-inbox predicate in two places (next batch).
- 2026-10-26 16:20 UTC — #61 fix verified (subject claims judged like body, offer/yours, advice list both ways, owner inboxes, full_name company rule): 1548 tests, build → merged bf05f9a. digest-once archived ($1.54). Batch audit (Opus) running.
- 2026-10-26 16:45 UTC — Batch audit (Opus): 3 blocking (critic house lines let the CTA's pain and proof-line results pass unchecked; presend guardrail mixing prompt versions would retire challengers wrongly) → fixed by the conductor in 5de9827 (new test fails without the fix). Typecheck, lint, 1549 tests, build green. Retro + lessons merged (4135744). Integration → main PR next.
- 2026-10-26 16:50 UTC — Integration → main PR #62 opened; subscribed. Waiting for Pedro's "ship it".
- 2026-10-26 16:28 UTC — Pedro "ship it". PR #62 squash-merged → main 7a76b66; production deploy dpl_81vTsJt74z2kQYXm5BpYJ78q2dLd READY. writer-honesty archived ($7.09). Two-day check armed 2026-10-28 17:00 UTC (v3.3 critic pass rate, rewrites, digest rows, greetings). Batch 9 CLOSED except that check.
- 2026-10-28 17:20 UTC — First fact-research run (cron 14:20 Wed): /api/benchmarks/research 200, 2 calls, $0.43 (4 web searches each), 4 proposals on /benchmarks (all inactive + unverified; market GLOBAL; pain_codes set). 2 of 4 are vendor-sourced (85% Mikla.ai, 78% "MIT" via Conduit.ai: weak sources); 53% Forrester via LeadResponse, ~35% Expedia instant-booking conversion. No Sentry issues in 24h. Wanted facts: 86 open, near-duplicates exist (law-firm lead response ×3, restaurant social ×3) but the two researched were distinct gaps.
- 2026-10-28 17:20 UTC — Batch 9 two-day check: v3.3 critic pass 8/34 (24%) vs v3.2 18/81 (22%) = no real change. Rewrites now fresh: 4/18 approved (22%) vs 14% before. Digests since deploy: 4 slots, 1 email listed once, empty slots sent nothing. Greetings: 29/34 "[company] team" or a name; 3 built from the address ("Hola Cursos", "Hi Care", "Hi Nfo"), all auto_rejected, none sent. No presend retire rows. Remaining v3.3 blockers: writer still claims site checks it did not make; the CTA/subject templates ("where [pain] is costing you", "dónde X pierde clientes") assert a loss about the business; critic still blocks some allowed general lines; 2 "ran out of time" reviews.

## Batch 10 (phase3) — started 2026-10-28 19:12 UTC
Scope (Pedro 2026-10-28, "go"): option 1 = smarter crawler in the app + Google PageSpeed Insights (free); prospect dossier for pitch candidates; writer/critic state only dossier facts; closing line (a) "see what a customer sees on their phone", subject (a) "what I noticed on [company]'s site"; one greeting rule. Statistics: 53% + ~35% approved, 85% + 78% rejected (conductor, on Pedro's call).
Waves: 0 study (conductor, free) → 1 site-crawler (lib/research, 0054) ∥ greeting-rule (lib/pitches greeting + send-gate) → 2 dossier + writer/critic/CTA (pitches hub).
External prerequisite: Pedro creates a free Google API key with the PageSpeed Insights API enabled, Vercel env `PAGESPEED_API_KEY` (before wave 1 ships).

| Slug | Module | Rung | Model/effort | Branch | Session | PR | Depends on | Status | Turns | Review findings | CI reds | Rework |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| study | conductor | 0 | opus/high | — | this | — | — | blocked: session network policy refuses prospect sites (403 CONNECT); PageSpeed keyless = 429 | | | | |
| site-facts-writer | lib/pitches site-facts + writer/critic v3.4 + loaders | 3 | opus/high | claude/site-facts-writer | session_01XYnsssur8sUg8r9LvJFsxJ | #71 | site-crawler | merged (1724 tests; 1 review round + conductor-verified delta) | | | | |
| site-crawler | lib/research/site-crawl + observe route + 0054 | 3 | opus/high | claude/site-crawler | session_01XYnsst3eC4Z2opXkGNEubD | #70 | — | merged ea292cd (1672 tests; 2 review rounds + 1 conductor-verified delta); wrapped + archived ($15.13) | | | | |
| greeting-rule | lib/pitches greeting + send-gate | 3 | opus/high | claude/greeting-rule | session_01XYnsss9MDXbKnz7oCzk2MW | #65 | — | merged 4631556 (1570 tests); wrapped + archived ($3.46) | | | | |

Log
- 2026-10-28 19:12 UTC — Batch 10 started; integration cut from the notes branch (main 1bd256b + 4 notes commits). 0054 reserved.
- 2026-10-28 20:58 UTC — Study blocked (cloud network policy: prospect hosts 403; PageSpeed without key 429). greeting-rule spawned (session_01XYnsss9MDXbKnz7oCzk2MW). Asked Pedro to set this environment's network to Full (or accept a study run from a Vercel preview).
- 2026-10-28 21:12 UTC — #65 opened (1566→1570 tests). Conductor decision: drop the NAME_WORDS exclusion for single tokens (NAME_WORDS holds dictionary proper nouns: juan@, maria@, pedro@ lost their names); NAME_WEAK stays refused. Reviewer running.
- 2026-10-28 21:25 UTC — #65 reviewer: merge, 0 blocking. Follow-up commit (job words never greet, GATE_VERSION 3) verified by conductor: typecheck, lint, 1570 tests → merged 4631556. Wrap up + archive next.
- 2026-10-28 21:24 UTC — greeting-rule wrapped + archived ($3.46). Late lesson for the retro: before adding stop-set entries, check which the existing refusals already catch (only doctor/doc carried weight). Follow-up noted: names.ts has no given-name-only export, so surname-only locals (lopez@) still greet by surname.
- 2026-10-30 03:31 UTC — site-crawler spawned (session_01XYnsst3eC4Z2opXkGNEubD); PR discovery armed.
- 2026-10-30 04:26 UTC — #70 opened 04:04 (found 22 min late: L-task discovery at +20 min). Study table: booking found 7/33 (4 external engines incl. the 'Wix' lodge = WebRezPro, so its v3.3 'no easy way to book' line was false), WhatsApp-only 1. Two one-line edits outside the allow-list (health.ts JOB_STOPS, health-alarms test). Reviewer running.
- 2026-10-30 04:35 UTC — Out-of-flow work found (resume check): main moved 1bd256b → 97bb3a0 (#66 vercel-ignore skips claude/* previews; #67 drop addresses with dead mail servers, lib/research/verify-recipient.ts; no migration). Open on main from another session: #68 (notes) and #69 AI showcase email (claude-composer, review, pitch-stage, send-gate, followup-composer, learn.ts): same files as wave 2 and #65's gate → wave 2 waits for Pedro's call on #69. Integration will merge main before the batch PR.
- 2026-10-30 04:50 UTC — #70 review: fix-then-merge, 1 blocking (availability forms posting to an engine read as 'no booking' + 'contact form'; live repro hotelzed.com). Sent with 6 optionals that wave 2 will read as facts (online/channel fields, Cloudflare email, too_large/blocked status, abandoned retry 1 day, cart text, tracking params).
- 2026-10-30 04:36 UTC — Pedro "ship #69" → squash-merged 2003f85 (no migration). main merged into integration (75551c8): send-gate.ts auto-merged with #65; typecheck, lint, 1607 tests green. Deploy check armed 04:40. Wave 2 can now be briefed on top of the showcase email.
- 2026-10-30 05:00 UTC — #70 round 2: merge (0 blocking); last delta (contact-form false absence, negated booking text, readable-target links, abandoned cap) verified by conductor: typecheck, lint, 1672 tests → merged ea292cd. types.ts gains site_observations + claim_site_observations (conductor). 33-site booking row now: 7 found, 17 no online booking, 9 could not see.
- 2026-10-30 05:01 UTC — site-crawler wrapped + archived ($15.13; 4 late lessons → tasks/lessons-inbox/site-crawler-wrapup.md). Wave 2 site-facts-writer spawned (session_01XYnsssur8sUg8r9LvJFsxJ). Conductor decision: site facts built in code (no extra AI call, cost cap); closing line 'see what our free check finds on [company]'s site' pending Pedro's confirmation (his pick promised a phone view the free check may not show).
- 2026-10-30 05:40 UTC — #71 opened 05:24 (v3.4, site facts in code, new CTA/subjects, showcase pinned by hash). Reviewer running.
- 2026-10-30 06:00 UTC — #71 review: fix-then-merge. Blocking: loader trusts an ok row whose url is no longer the prospect's site (domain corrected after a company_name_unverified hold). Sent with 7 small fixes (newest non-pending row, hook example, viewport text, 'only way we saw', CTA says [company]'s site, exemplar carry-over line, template loss subject). websiteVerified hold risk checked in prod: 1 of 821 claude_assisted research rows lack evidence_urls → no action.
- 2026-10-30 06:10 UTC — #71 delta verified by conductor (site match via the crawler's bareHost, newest finished crawl decides, wording fixes, exemplar carry-over line, template subject): typecheck, lint, 1724 tests → merged into integration. All batch 10 tasks merged; next: wrap-up, batch audit, retro, integration → main PR.
- 2026-10-30 06:25 UTC — Batch audit (Fable): merge, 0 blocking; button label fix add2f7f. site-facts-writer wrapped + archived ($10.56). Retro tasks/retros/2026-10-30-phase3-batch10.md, lessons merged, checklists + conductor §E network row + core-context updated, batch 8 archived. Integration → main PR next.
- 2026-10-30 06:30 UTC — Integration → main PR #72 opened; subscribed. Waiting for Pedro's "ship it".
