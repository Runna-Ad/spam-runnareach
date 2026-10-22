# Readiness check: fully automated, self-learning flow (2026-10-22)

Conductor session_01HtEg7XG4MPQU4omrd2BX69, before batch 8. Method: prod SQL run 2026-10-22 ~15:00-16:00 UTC, three read-only Opus code audits (notes in the conductor scratchpad: audit-signal.md, audit-learning.md, audit-autonomy.md), the key claim re-checked by the conductor in code. Target = tasks/audit-2026-10-16.md §5 and §6.

## Verdict
The machine runs on its own (find → write → check → send → follow up → read replies, every 10-15 min, all HTTP 200). It does NOT yet learn: the outcome signal is broken or missing, and the writer tests cannot move at today's volume. Four places can stall it until Pedro steps in, three of them silently.

## Prod numbers (queried 2026-10-22)
- 521 emails sent all time; human replies ever: 4 (last 2026-08-06). Since the autopilot (10-17): 43 sent, 0 human replies, 3 bounces.
- hunter_scans: 6 rows ever, last 2026-06-25. Every first email since 10-19 carries `runna-hunter.vercel.app/?…&r=<code>` (checked 34/34). Follow-ups carry no Hunter link.
- Stage veto since 10-19: 18 auto-scheduled, autoBounceRate 6.7% (promotion bar 2%).
- 7 days: 68 drafts auto_rejected vs 43 sent (34 "still held after one rewrite: AI review flagged issues", 12 "verifier unsure about the address").
- Writer tests: guidance arms used on 10-20+ pitches (g-1: 12 pitches, 4 sent; g-2: 7, 1 sent); learning_arms trials 0 for every writer arm. scout.cell (search areas) is the only learner moving.
- prompt_change_proposals: 0 rows ever (nothing writes it). opportunities: 0. EXEMPLARS_ENABLED unset.
- Sends 10-22: 6 first emails at 15:00, then 9 follow-ups 15:20:20-15:21:16 (~8 s apart). 0 sends on 10-20.

## A. Learning has no fuel (fix first)
1. BROKEN: a reply or bounce on a thread that already had a follow-up is recorded on the follow-up row (`app/api/replies/poll/route.ts:150-171` keeps the newest pitch, `:337` records the event there); the learners read first emails only (`lib/autopilot/learn.ts:184`). Fix: record on the root (`lib/pitches/root-pitch.ts` exists) + backfill.
2. BROKEN: follow-ups have no free-check link and no code (`lib/pitches/followup-composer.ts:24,157,191`, `followup-templates.ts`), and their goal is "a 20-minute chat" (`followup-composer.ts:8,132,196`), against standing rule 8. Fix: root's code on the Hunter link in both composer and template.
3. UNKNOWN (outside this repo): 0 free-check rows since June. Either nobody clicks or runna-hunter does not write them. Vercel keeps 1 h of logs on Hobby and Web Analytics is off for runna-hunter, so it cannot be told apart from here. Check the runna-hunter repo (Supabase project env, insert of `ref`, swallowed errors) and add our own free click counter: a `/r/<code>` redirect on our domain that records a `click` event, then forwards to the Hunter.
4. TOO SLOW: an email counts only once it is "settled" (a reply/scan/opt-out, or 14 days of silence, `lib/learning/reward.ts:84`), a test needs 30 settled emails per variant (`lib/learning/bandit.ts:164`), and every reward today is 0. The 68 thrown-away drafts (each already tagged with its test variant) teach nothing. Fix: a pre-send score per variant (held/rejected rate) that can retire a harmful writing instruction within days.
5. MISSING: no alarm when learning stalls (variants at 0 trials for N days, review job failed, learner skipped). Errors sit in the tick report nobody reads (`lib/autopilot/tick.ts:159-166`).

## B. Places it stops and waits for Pedro
6. One opt-out spike drops the stage to "shadow" (Pedro approves everything), and getting back needs 100 pitches approved by a person (`lib/autopilot/governor.ts:282,295-306`). In a hands-off setup that is a full stop.
7. A breaker pauses the inbox and emails once; the health check then stays silent about it (`lib/reports/health.ts:136`). With one inbox, all sending stops.
8. Bounces block going fully automatic (6.7% vs 2%). Root cause is address quality: "verifier unsure" drafts are dropped with no attempt at another contact (`governor.ts:68`).
9. Silent failure risks: the Gmail-error breaker can never fire (`tick.ts:271` hard-codes 0); tick, send-queue, follow-up and poll have no Sentry cron monitor; all alerts go out through the same Gmail inbox (a dead token hides its own alert).

## C. How it sends
10. Bursts: follow-ups go out with no gap, up to 30 per run (`app/api/pitches/follow-up/route.ts:104`); first emails 6 per run. The plan (§5.2) says 1-2 per 10 minutes. The window is fixed in UTC, not the prospect's local morning/afternoon.
11. A draft thrown away is lost for good: the prospect is never drafted again (`tick.ts:643-650`); 68 drafts closed this way in 7 days (prospect count not queried).
12. Veto pitches made before ~21:00 UTC skip their own day's send window (scheduled +18 h, `lib/autopilot/hold.ts:317`).

## D. Decision only Pedro can make
13. AI-written writing instructions go live and winning variants get promoted with nobody approving (`learn.ts:642`, `bandit.ts:197-203`). The original plan (§6.4) said "all prompt changes are human-approved at first"; decision 4 (audit 2026-10-16 §8) was never answered. The /learning "proposals" page is a dead end (nothing writes `prompt_change_proposals`; the writer prompt is hard-coded, `claude-composer.ts:310`).

## E. Volume (for information; the volume rule stands)
About 8 first emails a day at best: $3/day ÷ $0.03 = 100 prospects → ~22 drafts → ~39% sendable. At that rate the writer tests need weeks even after A is fixed, and the send machinery (30/day inbox cap) is not the limit.

## Not checked
runna-hunter code and its env; Vercel env values; whether Sentry pages Pedro; whether the Google OAuth app is in Testing mode (7-day tokens); exemplar count by the code's definition (likely 0: no send is 14 days old yet).
