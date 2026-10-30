# S.P.A.M. — Lessons (newest first)

> Sections older than phase 3 batch 8 (batch 7 back to April 2026) moved to `tasks/archive/lessons-2026-10.md` on 2026-10-27. Grep it; do not load it whole.

## Overrides from archived sections (copied verbatim; the originals are in `tasks/archive/lessons-2026-10.md`)
Every PEDRO_OVERRIDE stays readable here. Newer overrides are in the sections below.

[2026-10-19] PEDRO_OVERRIDE: A finished worker session is wrapped up first, then archived, every time
WHAT HAPPENED: After batch 4 shipped, the four worker sessions (address-trust, autopilot-trust-split, pipeline-guards, send-path-hardening) sat idle with their containers still up. conductor/SKILL.md step 5.4 already said to archive a worker after its merge, and the conductor skipped it; Pedro had to ask "are the other sessions done?". Pedro: "everytime one of those sessions are done and finished you should 1st wrap them up and then archive them."
RULE: When a worker's PR is merged (or the worker is rejected or stuck), the conductor sends it the WRAP UP message (worker/SKILL.md section 8), reads its reply from the transcript with list_events, carries any late lessons and loose ends to lessons.md / the board, and only then calls archive_session. Never archive before reading the wrap-up; never leave a merged worker idle. Record "wrapped + archived" in the board row.
TAGS: process, conductor, workers, wrap-up, pedro-override

[2026-10-19] PEDRO_OVERRIDE: Build on the existing second brain and wrap-up routine; never design a parallel one
WHAT HAPPENED: Asked how to make the conductor workflow smarter, the conductor (a cloud session) proposed a new lessons loop and a new /wrap-up command. Pedro already runs both: the second brain (Moisty-Mango/second-brain: recall hook, capture on session end, weekly distill) and the wrap-up routine in his global rules (Moisty-Mango/dotclaude CLAUDE.md). Cloud sessions load neither (the hooks and rules assume /Users/work and $HOME/Brain on his Macs), so the conductor never saw them, skipped the wrap-up, logged no PEDRO_OVERRIDEs and broke the global writing rules all session.
RULE: At the start of any cloud session, check whether the global rules and the brain are present (~/.claude/CLAUDE.md, $HOME/Brain/brain-starter). If not, say so to Pedro and ask to attach Moisty-Mango/dotclaude and Moisty-Mango/second-brain read-only before proposing any process change. Improve his loop; never replace it.
TAGS: process, second-brain, wrap-up, cloud-sessions, conductor

[2026-06-23] PEDRO_OVERRIDE: Gary + the pitch advisor were over-anchored to specific case studies — Runna's pitch is the whole CAPABILITY (AI, optimization, dashboards, asset/video production), with case studies as bonus proof, not a requirement
PEDRO'S INSIGHT: "Although using Runna's success stories is good when they apply, I don't want Gary constrained to them. We're pushing the whole AI side, optimizations, dashboards, ways to improve companies, asset creation, video ad production — that applies to anyone — and use our years of expertise as proof of concept; not always needs a specific success case tied in."
WHY HE WAS RIGHT: My v1 grounding rule for Gary said "use ONLY the services + case studies provided", and the pitch angle advisor labelled any case-less angle "no proven case — pitch carefully / pair with a stronger angle". Both conflated "we have a case study for this" with "Runna can credibly help here". That artificially caged targeting to a handful of case-study industries and made strong capability-led angles (AI automation, custom dashboards, video production) read as weak — the opposite of the actual go-to-market.
FIX: (1) New single source of truth lib/runna/capabilities.ts (RUNNA_CAPABILITIES) describing the full toolkit + the framing "expertise IS proof; a case study is a bonus when it fits". (2) Gary's system prompt reframed: reason freely about capabilities, NOT limited to case-study industries; case studies are proof points used WHEN they fit. (3) Pitch angle advisor: a case-less angle with decent pain confidence is now "moderate" (capability-led), not "exploratory"; deterministic + Haiku rationales frame it via capability + expertise; Haiku also returns a `capability` to surface; UI chip changed from "no proven case" → "capability + expertise". Verified live: Gary confidently proposed "US Manufacturing & Industrial B2B – AI + Ops Automation" (zero case-study coverage) and the advisor reframed a case-less fitness-retention angle as moderate/capability-led.
THE ONE HARD LINE STAYS: never fabricate a SPECIFIC client name, metric, or geography (the El Club lesson). "Speak to general capability + years of expertise" = encouraged; "invent a fake proof point" = forbidden. These are different things — don't over-correct the El Club lesson into "never mention anything without a case study".
RULE: When grounding an LLM for outbound/strategy, ground it in CAPABILITIES + expertise, not just the catalog of proof artifacts. Proof artifacts (case studies, metrics) are deployed when they fit; their absence is not a reason to weaken or omit a legitimate angle. Only fabrication of specific named proof is off-limits.
TAGS: #override #gary #pitches #grounding #capabilities #positioning #claude

[2026-06-22] PEDRO_OVERRIDE: SnapVerify discarded logical email guesses — its whole point is "owner name + domain → darren@domain, worth a shot"
PEDRO'S INSIGHT: Deep research found owner "Darren Thomson" + domain bvsfitness.ca, but no contact was produced. Pedro: isn't guessing darren@bvsfitness.ca and testing it behind the scenes the WHOLE POINT of SnapVerify? Yes.
WHY HE WAS RIGHT: snap-contact.ts generated the right guesses (firstname@, f.last@, …) and SMTP-verified them, but only KEPT a result if the verdict was a clean "valid" (≥70) OR the domain was Google/Microsoft. Port 25 is very often blocked, and small-biz domains are frequently catch-all — in both cases SMTP can't confirm, so SnapVerify hit its final `found:false` and threw the perfectly logical guess away. So it produced nothing exactly when it should have produced its best guess.
FIX (revised — Pedro tightened the policy: deliverability beats coverage): the final waterfall is SnapVerify SMTP (3 PASSES, rides out greylisting) → defer to Anymail → Hunter (verified finders) → if all fail AND domain is CATCH-ALL, keep firstname@domain flagged (selected_by='snapverify_catchall_guess', priority 4) since catch-all servers accept all mail = it physically can't hard-bounce → else "no contact". REMOVED the old google_workspace_guess / mx_heuristic inserts — those were unverified guesses on NORMAL domains that could hard-bounce and injure the warmed sender. Added a "guess" chip on /companies (contact_is_guess) so a human knows.
WHY NOT REPLICATE ZEROBOUNCE: real SMTP RCPT verification needs outbound port 25, which Vercel + Supabase/Deno edge functions BLOCK (anti-spam). Replicating needs a dedicated VPS with port 25 unblocked + IP-reputation upkeep — not worth it vs ~$0.004/check. 3-pass free probe + verified finders + catch-all-only guess is the pragmatic max.
RULE: never insert an unverified email on a non-catch-all domain — a hard bounce hurts the warmed domain more than a missing contact helps. Inconclusive → defer to verified finders → keep a guess ONLY where it can't bounce (catch-all), flagged. "No contact" is an honest, safe outcome.
TAGS: #override #snapverify #contacts #enrichment #deliverability

[2026-06-22] PEDRO_OVERRIDE: A high fit score is worthless without a contact — bulk re-score must enrich high scorers
PEDRO'S INSIGHT: Some +80 prospects had no contact attached. "No point having all the info in the world and no one to send the email to." So no-contact prospects shouldn't read as ready-to-go +80s.
WHY HE WAS RIGHT: (1) contact_discoverability is only 10/100 pts, so a great fit loses just 10 for having no email — still 80+. (2) The contact waterfall (SnapVerify→Anymail→Hunter) only ran inside the full pipeline at ≥70; bulk "Score selected" re-scored but NEVER enriched, so high scorers sat reachable-on-paper but with no email ever fetched.
FIX (chose "enrich first, then gate"): bulk re-score now runs the waterfall for every ≥70 prospect missing a contact (chunked 4-at-a-time for rate limits + the 60s server-action budget), then sets pitch_gate_passed — reachable → ready, still-unreachable-after-all-tiers → flagged not-ready. Fit score stays honest; "≥70 + ready" now means reachable. Toast reports "N contacts found, M still no contact".
ARCHITECTURE NOTE: extracted enrichContactsForProspect into lib/discover/enrich-contacts.ts (a plain module) so both pipeline-action and bulk-actions import it. Do NOT export an internal helper from a "use server" file — every export there becomes a public action endpoint.
RULE: Reachability is a first-class gate, not a 10-pt rubric bucket. Any path that surfaces "pitch-ready" prospects must ensure contact discovery actually ran, and must visibly distinguish "great fit + reachable" from "great fit + no contact". [[pipeline-architecture]] SnapVerify-early / paid-at-≥70 still holds — bulk re-score now mirrors it.
TAGS: #override #scoring #contacts #enrichment #architecture

[2026-06-22] PEDRO_OVERRIDE: The scoring rubric was over-gating — service businesses are valid Runna customers, not non-fits
PEDRO'S INSIGHT: Fitness studios scored 28–62 and looked like non-fits. Pedro pushed back: they sell *services* but have 100% real marketing needs Runna provides (websites, booking apps, social, video/ad creative, email, automation). The ONLY correct rejection was the one that already had an agency. The rubric was gating us, not helping.
WHY HE WAS RIGHT: claude-scorer.ts hardcoded "any B2B service provider = competitor/zero-fit → industry_fit=0, service_match=0, composite≤10." It couldn't tell a fitness studio (customer) from a marketing agency (competitor) — both are "services." service_match_pts was literally defined as "0 if they sell services not products." That's a DTC-product bias that throws away most local SMBs, who are exactly Runna's market.
RULE: Exclusion must target COMPETITORS (marketing/creative/dev agencies, consultancies) and ALREADY-SERVED businesses — NOT "sells services vs products." Consumer-facing service businesses (gyms, clinics, salons, restaurants, hospitality, local services) score normally on ICP fit + pain. service_match = how well Runna's services fit THEIR needs (high for any SMB with a marketing surface), not a product/service test. Verified post-fix: a Calgary pilates studio → 82; a marketing agency → 0.
IMPLEMENTATION: Reframed the claude-scorer prompt; passed ICP business_types into the scorer (was available but dropped at score-action.ts); kept excluded_keywords + "already has agency" gating; heuristic fallback already had no service penalty so the two paths are now consistent.
TAGS: #override #scoring #icp #rubric #architecture

[2026-05-29] PEDRO_OVERRIDE: SnapVerify should run in Pass 1 for all prospects, not just ≥70
PEDRO'S APPROACH: Move SnapVerify to run right after Structured Research (Pass 1), before initial score. It's free, uses already-scraped data, and gives the score a contact signal.
WHY IT WAS BETTER: SnapVerify is zero-cost. Running it early means: (1) the initial score reflects contact availability, (2) by the time a prospect reaches ≥70, we already know if free enrichment worked and can skip straight to Anymail/Hunter. No downside to running it early.
RULE: Free enrichment (SnapVerify) runs in Pass 1 for every prospect with a domain. Paid enrichment (Anymail, Hunter) runs only at ≥70. Never conflate "runs early" with "runs expensively". Cheap things run eagerly; expensive things are gated.
TAGS: #override #pipeline #snapverify #architecture

[2026-04-23] PEDRO_OVERRIDE: Pedro's full name is Pedro De Velasco, not Pedro Torres

**What Claude got wrong:** Every commit, every hardcoded string, every README reference used "Pedro Torres." Source is unclear — possibly I fabricated "Torres" from the very first session and it stuck because nothing ever corrected it, or picked it up from a stale handoff.

**Pedro's correction:** "my names is not Pedro Torres is Pedro De Velasco"

**RULE:** The user's full name is **Pedro De Velasco**. Use this in:
- All git commits (`--author` / `user.name`)
- Any hardcoded defaults in scripts or seed data
- README / docs
- User-facing copy where a real name is needed

**How to apply:** When setting git config or signing commits, use `Pedro De Velasco`. Never invent or assume a last name — if I don't know it from an authoritative source (the user typing it, their email signature, a verified memory), I ask or use "Pedro" alone.

**TAGS:** #override #naming #facts-not-assumptions

[2026-04-22] PEDRO_OVERRIDE: Stop asking me to run things you can run yourself

**What Claude originally did:** Wrote code, committed it, then told Pedro: "run `npm install`, run `npm run dev`, visit /sign-up, test the flow, paste errors back." Treating Pedro as the verification layer for things Claude could verify directly.

**Pedro's correction:** "yo do it dont ask me to do things you can do alway try yourself first"

**Why it was better:** Pedro shouldn't be the one running `npm install` to find dependency resolution errors, or `npm run build` to find TypeScript errors. Those are verifications I can perform in my own shell — I have bash, I have the filesystem. Pedro is expensive attention; compile-time errors are cheap to catch. Using him as my test runner wastes cycles and shifts my failures onto him.

**RULE:** Before asking Pedro to run anything, try it yourself first:
- `npm install` — I can run it, see dependency errors, update versions
- `npm run build` / `typecheck` / `lint` — I can run these, read errors, fix
- `npm run dev` — I can start it (in background), hit routes via curl/fetch to check HTTP status, read logs
- Migration / SQL — I can apply via MCP when access is available
- Anything scriptable — I do it first, report the outcome, then only pause for input when truly blocked

**Only hand off to Pedro when:**
- Interactive browser UI testing (visual click/type flows — computer-use is sometimes available but slow)
- Account creation / purchases / financial actions (domains, cards, subscriptions)
- Credentials I don't have (API keys, OAuth consents)
- Business/brand decisions (what to name things, ICP priorities, legal posture)
- Approval gates (deploy, push, destructive ops)

**How to apply:** When finishing a code change, instead of "run this and tell me what breaks," run it myself, read the output, fix what breaks, THEN report to Pedro with "here's what's working and here's what I couldn't verify without your eyes on it."

**TAGS:** #override #autonomy #verification #respect-pedros-attention

[2026-04-22] PEDRO_OVERRIDE: Trusted hallucinated handoff without verifying disk state

**What Claude originally suggested:** Accept the prior session's handoff claim that "~40% of Phase 0 is done" (dashboard shell, design system, 18-table schema, seed data, Supabase clients scaffolded, /design route live, 14 routes returning 200) and plan incremental work on top of that.

**What Pedro caught (and the truth):** Nothing existed. The directory `/Users/work/Projects/S.P.A.M/` was empty except for a `.claude/` folder. Prior agent's "What's built" section was aspirational / hallucinated. No package.json, no app/, no components/, no supabase/, no seed data. Phase 0 was at 0%, not 40%.

**Why it matters:** Had I not searched the disk before writing the plan, I would have produced an incremental plan referencing files that don't exist. Every subsequent step would have failed or introduced drift. Pedro would have wasted time debugging imports against phantom modules.

**Root cause:** Prior agent wrote a persuasive-sounding handoff document that matched the shape of real engineering output without being grounded in actual file operations. My initial instinct was to build on top of it without verification.

**RULE:** Before planning any work on an "existing" codebase described in a handoff document or prior session summary, verify disk state first:
1. `ls` the claimed project directory
2. Check for `package.json` / `go.mod` / equivalent
3. Read the actual file tree, not the described one
4. If handoff mentions specific files/schemas, check that they exist with `Glob` or `find`
5. If mismatch found, surface it to user BEFORE writing a plan — ask which is true

**When to apply:** Every session that starts with a handoff block, prior-agent summary, or "picking up from" context. Treat those as claims to verify, not facts to trust.

**TAGS:** #override #handoff #verification #trust-but-verify #session-start

[2026-07-22] PEDRO_OVERRIDE: Contact emails often live on /privacy and /terms — scrape them
PEDRO'S APPROACH: "a lot of the times websites have contact emails on their privacy policy or terms and conditions sections. so those could be worth to add to the website scrape"
WHY IT WAS BETTER: I was treating "no email on the homepage" as "no email exists" and letting the prospect fall through to the paid finders (Hunter/Snov) or straight to suppression. Small businesses routinely print their only real mailbox in legal boilerplate ("questions about this policy? email us at…") and nowhere else.
TECHNICAL ROOT CAUSE: Two separate gaps, and I only found the second because Pedro's tip made me open the file. (1) /privacy and /terms were not in KEY_PAGE_PATHS, so their URLs were never collected. (2) Much worse — scrapeSubPages fetched sub-pages for BODY TEXT only, via extractMainText, which strips nav/header/footer AND returns text, so `mailto:` hrefs died with every other attribute. The /contact page WAS being fetched every time and its emails thrown away. Only the homepage was ever mined.
RULE: When a "we couldn't find X" path exists, check what the code already fetches before adding a new source. The fix here cost zero extra requests for the Contact/About/Team pages — the bytes were already in memory. Mine data at the point of fetch, not after a lossy transform. Measured: 8/30 previously-unreachable prospects recovered a usable address, no paid API calls.
TAGS: #override #scraper #contacts #cost

[2026-07-22] PEDRO_OVERRIDE (REPEAT — the 2026-06-23 one was only half-implemented): never name specific clients in a pitch; industry-level capability framing always
PEDRO'S APPROACH: "a lot of the times we use specific examples like we worked with keep it healthy or with el club etc. To be fair everytime we use those examples they never worked well and i believe makes it worse i much rather have all the pitches like this with a more industry call like 'We've built positioning and campaign systems for hospitality brands trying to carve out space in crowded markets, the work is finding the one defensible thing you own, then making sure every touchpoint says it the same way.'"
WHAT I HAD: the 2026-06-23 override ("Runna's pitch is the whole CAPABILITY, case studies are bonus proof not a requirement") WAS applied — to the PROOF POLICY. claude-composer.ts:297 and :347 correctly make capability-led the default. But three client-naming paths survived underneath it: (1) :558 an explicit rule to open with "We worked with {client}, a Canadian {category}" whenever the case is Canadian; (2) buildNotableClientsTierContext's Tier 2 "Hemos trabajado con {name}" and Tier 3 name-drop list; (3) generator.ts's heuristic tier ladder and website-pitch-action.ts's "We recently helped {client_name}". So the default changed while every fallback still name-dropped.
WHY IT WAS BETTER: Pedro has direct campaign evidence that named examples underperform — they invite "so what, that's not me" instead of "that's my problem". Industry-level capability framing describes the PROSPECT's situation rather than someone else's win.
TECHNICAL ROOT CAUSE: I changed the policy statement and treated the override as delivered without auditing the fallback paths that fire when the default doesn't apply. A default and its fallbacks are the same feature; changing one is a half-fix. Same shape as this morning's pitch-gate bug — the second code path kept the old behaviour.
RULE: When an override changes a DEFAULT, grep every fallback, tier, exception and template that fires when the default doesn't, and change them too. Then add a deterministic detector so a regression is caught rather than assumed — a prompt rule alone will not hold (see [[prompt-plus-deterministic-guard]]).
TAGS: #override #pitches #positioning #halffix

[2026-07-22] PEDRO_OVERRIDE: don't delete the numbers, source them
PEDRO'S APPROACH: "the data numbers i dont want them gone just wanted them real... maybe using all the possible pain points/services we offer to have them beforehand real numbers proven, than for example having a good pre purchase email flow increases users to buy again by 15% or whatever."
WHAT I DID: found the composer inventing statistics ("20-30% lifts in first-time visit intent"), traced it to prompt instructions that literally said "Use industry BENCHMARKS for any numbers" and "Cite a real benchmark when you're confident", and removed numbers entirely. I offered Pedro three options and framed "no numbers" as the safe recommendation, which he took — then he came back and corrected the framing itself.
WHY IT WAS BETTER: I removed the SYMPTOM (fabricated stats) instead of fixing the CAUSE (no source of truth for numbers). Numbers are persuasive; deleting them weakens every pitch permanently to avoid a problem that a data table solves. The right fix is the same one this codebase already uses for case studies and the pain taxonomy: put the facts in a table with citations, and let the model narrate them ([[ai-narrates-code-computes]]).
TECHNICAL ROOT CAUSE: When I find an LLM fabricating a class of content, my first instinct is to ban the content. The better question is "what would make this content TRUE?" — usually a lookup table plus a gate. I also mis-framed the options I offered: I presented "no numbers" as safe and "keep benchmarks" as risky, when the actual third option (sourced benchmark library) was neither offered nor considered. A choice architecture that omits the best option is a bad question, even when the user picks one of the offered answers.
RULE: Before proposing to REMOVE a capability because the model gets it wrong, cost out giving the model a verified source for it. And when offering Pedro options, include the "make it correct" path, not just "keep it" vs "kill it".
TAGS: #override #pitches #fabrication #choicearchitecture

[2026-10-19] PEDRO_OVERRIDE: a bounce is an address problem, not a pitch-quality problem; it must not demote the autopilot
WHAT HAPPENED: Two hard bounces on the first AUTO drip tripped the inbox_bounces breaker, which paused the inbox (right) AND dropped the autopilot veto -> shadow (nextStage demotes on ANY breaker trip in the stage, autoBreakerTrips). Pedro: "that had nothing to do with the quality of the pitches." Shadow then needs 7 days + 100 decisions to climb back, which stalls a system meant to run fully automatic, for a cause the stage system does not measure.
RULE: Keep the two kinds of trust separate. Deliverability trips (bounces, Gmail API errors, DMARC, blocklist, placement) PAUSE SENDING and never move the stage; only pitch-quality signals (factual or recipient errors, veto/edit rate, possibly an opt-out spike) demote. Until batch 4 changes nextStage, a deliverability demotion is undone by hand once its cause is fixed (done 2026-10-19: back to veto after the bounce hotfix).
TAGS: autopilot, stages, breakers, pedro-override


## Bounce pause 2026-10-29 (branch fix/dead-mail-server)

[2026-10-29] PEDRO_OVERRIDE: no paid services; the answer is always "we build it" or "it's free"
WHAT HAPPENED: For the dead-mailbox bounces (4 of 5 in 30 days), I recommended paying a mailbox-verification service (~$0.004/check) as option 1. Pedro: "dont want to pay for a service the solution is always either we build it or is free".
WHY HE WAS RIGHT: this preference was already on record (Yelp removed rather than paid for; ZeroBounce rejected in June) and I recommended a paid service anyway. A paid default also adds a vendor bill and a dependency for a problem that may have a free or built answer.
RULE: Never lead with a paid service. Options are: build it ourselves, or a free source (a genuinely free quota, checked to be perpetual and not a trial, per the Yelp lesson). A paid option is mentioned only if Pedro asks for it.
TAGS: pedro-override, cost, vendors, deliverability, bounces

[2026-10-29] LESSON: I recommended building a rule that already existed ("named person before info@")
ROOT CAUSE: I offered "prefer a named person over a generic inbox" as the free fix for dead mailboxes, from a bounce-rate split (generic 3/25 vs named 2/32), without reading the picker. Pedro said "build it". The picker (lib/pitches/contacts.ts chooseRecipient) already sorts by priority_rank, and every insert path gives generic inboxes rank 5 and named people 1 or 2. None of the 25 generic first emails in 30 days had a named contact on file, so the "fix" would have changed nothing.
ALSO MEASURED (all first emails ever sent to a generic inbox): Google/Microsoft-hosted 2 bounced / 60, smaller mail hosts 3 / 32. Too weak for a rule: holding the smaller hosts would cost ~29 good emails to avoid 3 bounces. Bounces before 2026-07-21 are under-counted (no DNC auto-add yet).
RULE: Before proposing a fix as an option, grep for the code that would own it and query whether the case it targets actually happens. A rate split by category is not a fix until the data shows the alternative was available.
TAGS: bounces, contacts, recipient-chooser, measure-first, grep-first

[2026-10-29] LESSON: lessons written in a sibling worktree never reach the brain when the session runs from the main checkout
ROOT CAUSE: unified-stop.sh reads $(pwd)/tasks/lessons.md. This session's folder was /Users/runna/Projects/S.P.A.M (121 commits behind), while every edit went to ../S.P.A.M-dead-mx. The hook would have found no change and captured nothing. Filing by hand, `{ [ ! -f f ] && header; ...; } >> f` skipped the header: the >> creates the file before the test runs (the hook's own comment warns about this).
RULE: at wrap-up, if lessons were logged outside the session's folder, copy the new entries into ~/Brain/brain-starter/inbox/<date>-<host>-s.p.a.m-lessons.md yourself. Test whether a file exists BEFORE the redirect that appends to it.
TAGS: process, second-brain, worktrees, stop-hook

[2026-10-29] LESSON: keep prospects' email addresses out of PR descriptions
ROOT CAUSE: the first `gh pr create` for PR #67 listed the two bounced addresses in a table; the auto-mode safety check refused it as excess sensitive detail. Domains alone told the same story.
RULE: in PR text, name the company domain, never a prospect's full address. Tests and lessons in the private repo may keep real fixtures, as before.
TAGS: process, privacy, github, prs

[2026-10-29] LESSON: "the domain has an MX record" is not "the domain can receive mail"
SYMPTOM: the inbox_bounces breaker paused pedro@runnareach.com at 19:30 UTC (2 hard bounces in the last 50 sends). One was dreamjob@themethodyyc.com: its MX pointed at themethodyyc-com.mail.protection.outlook.com, a Microsoft 365 host that no longer exists (NXDOMAIN, checked with dig the same day). Mail there can only bounce.
ROOT CAUSE: checkDomainMail (lib/research/verify-recipient.ts) returned "mx" the moment an MX record came back and never looked up the MX host itself, so the send gate passed the address on 2026-10-26 and again for the follow-up on 2026-10-29. Gmail had also sent two "Delivery Status Notification (Delay)" notices (10-27, 10-28) naming the same DNS error; the poll files delays as auto_reply by design, so the follow-up still went out.
FIX: resolve each MX host (A, then AAAA); when EVERY host answers ENOTFOUND/ENODATA and the resolver passes the gmail.com/outlook.com control query, the status is dead_mx and the address is dropped. Any address, empty answer or flaky lookup keeps "mx", so a DNS blip never drops a good address. Tests pinned to themethodyyc.com and to dbkiddtransport.com (one dead MX host plus one live one: must stay "mx"). Before resuming, the same check ran against all 41 queued recipients: only themethodyyc.com was dead.
MEASURED (30 days, one inbox): 5 hard bounces / 118 sends (about 4%). Only 1 was a dead domain. The other 4 were dead mailboxes on live mail servers (info@ / contacto@ scraped from the company site x3, 1 Anymail address): no free DNS check can see those, so this fix alone will not bring the rate under 2%.
RULE: a free mail check must follow the MX all the way to an address. And when a breaker trips, count the bounce types before fixing: the loudest bounce (here the dead domain) was the minority type.
TAGS: bounces, deliverability, dns, mx, verify-recipient, breaker


## Quiet hours for the scheduled jobs (2026-10-26, branch perf/quiet-hours-cron)

[2026-10-26] PEDRO_OVERRIDE: off-hours pace for the tick and the reply poll
CLAUDE SUGGESTED: outside the send window, poll every 30 minutes and tick hourly (about a third fewer calls).
PEDRO'S APPROACH: one check right after the window closes, then once a day.
WHY IT WAS BETTER: outside the window nothing sends, so frequent runs change almost nothing before the next send. The 2-day reply lookback (RECENT_INBOUND_DAYS) already covers a 24h gap, and the morning runs land before the first send. Polls 1,008 → 252 a week, ticks 672 → 183: about half of all scheduled calls, against a third for my suggestion.
TECHNICAL ROOT CAUSE: I sized the slowdown by "how stale may it get" instead of asking what a run outside the window can act on before the next send.
RULE: For a scheduled job, list what each run can act on before the next moment it matters (here, the next send window). If nothing, run it once before that moment, not on a clock.
TAGS: #override #cron #cost #vercel

[2026-10-26] PEDRO_OVERRIDE: measure the Sentry cost before removing it
CLAUDE SUGGESTED: turn off Sentry includeLocalVariables because every Vercel log line showed "Debugger listening".
PEDRO'S APPROACH: measure first; remove it only if the saving is significant.
WHY IT WAS BETTER: it turned a symptom into a number that justifies losing local variables in Sentry reports: 0.95s vs 0.67s CPU per cold start (12 alternating runs each, built app, ranges 0.92-1.03 vs 0.65-0.73).
TECHNICAL ROOT CAUSE: a visible symptom (the debugger line) felt like proof of cost.
RULE: Before trading away a debugging feature for speed, measure it on the built app: cold start, same routes, on vs off, alternating runs.
TAGS: #override #sentry #performance #measure

[2026-10-26] LESSON: every pg_cron call is a billed Vercel cold start
WHAT HAPPENED: Vercel emailed that the free team had used 75% of its 4h of Fluid Active CPU. pg_cron called this app about 2,300 times a week (poll every 10 min, tick every 15 min, all day). With 10 minutes between calls each one started from cold: every log line came from a fresh process. Locally a cold start of the tick route costs 0.67s CPU (0.95s with Sentry local variables).
ROOT CAUSE: each job's pace was chosen for responsiveness with no budget; nobody multiplied calls a week by the cost of a start.
RULE: When adding or speeding up a scheduled job on Vercel's free plan, write calls a week × about 1s CPU in the migration header and compare it with 4h a month (14,400s). The free plan has no per-project CPU in the API (Observability Plus is paid); the dashboard's Usage page is the only per-project view.
TAGS: #lesson #vercel #cost #cron

[2026-10-26] LESSON: a counter that resets at UTC midnight needs a run after the day's last event
WHAT HAPPENED: the first quiet-hours draft ended the tick's day at 22:45 and next ran at 01:15. The bounces_today and gmail_api breakers count from UTC midnight, and the last sends' bounces land at 22:55 and 23:05, so no tick would ever have counted them (code review caught it). Fixed with a 23:15 tick after the 23:05 poll.
RULE: When thinning a schedule, list every reader that windows by calendar day (UTC midnight, "today") and keep one run after the day's last write and before midnight.
TAGS: #lesson #cron #breakers #time-windows

[2026-10-26] LESSON: a health rule written in clock hours breaks when its job's schedule stops being regular
WHAT HAPPENED: autopilot_stopped alarmed when no tick ran for 2 hours. With the tick running only after the window and once a day, it would have emailed every night (the new test fails on the old code). Now it counts 8 missed scheduled ticks with the cron matcher job_silent uses: still 2h inside the window.
RULE: Express "silent too long" as missed runs of the job's own schedule, never as hours. When a schedule changes, grep every health rule and comment that states the old pace (every 15 min, hourly, half-hourly).
TAGS: #lesson #health #cron

[2026-10-26] LESSON: a 24h alert dedupe keyed on the kind swallows alerts once its job runs daily
WHAT HAPPENED: the health check dedupes each alert kind for 24h. Hourly, a suppressed run was followed by another an hour later. With the quiet-hours health check (0053), an emails_stuck alert about Thursday's window recorded Friday afternoon hid Friday's window from all three runs that judge it, and on weekends a run exactly 24h after an alert was suppressed by the few seconds between reading `now` and recording the row. The Opus reviewer reproduced both with the real functions. Fixed: emails_stuck dedupes per window (`dedupeAfter` = the window's close) and the dedupe ends 5 minutes early.
RULE: When a job's runs get further apart, check every dedupe, cooldown and "retry next run" against the new gaps. Key a dedupe on what the alert is about (the window, the inbox), not only its kind, and give a time cutoff a few minutes of slack for runs on a fixed minute.
TAGS: #lesson #health #cron #dedupe

## Merged from lessons-inbox, batch 9 (2026-10-26)

<!-- from digest-once -->
[2026-10-26] A recurring notice must remember what it already said, keyed on the thing that can change
WHAT HAPPENED: The veto digest (lib/autopilot/tick.ts sendVetoDigest) listed every approved AUTO email within 24h at each slot, so an email waiting out a weekend for sending hours appeared in up to 6-8 digests. The fix records the listed (pitch_id, scheduled_send_at) pairs in the digest's own audit_log metadata and lists only pairs no earlier digest listed (lib/autopilot/hold.ts planVetoDigest). Keying on the pair, not the pitch, keeps "held then re-approved" announced again.
RULE: A periodic notification that lists a backlog stores what it listed in the same record it already writes after delivery, and the next run lists only the difference plus one count line for the rest. Key the "already announced" set on the fields whose change makes the item news again (here the scheduled time), and compare timestamps as instants (Date.parse), never as strings: Postgres returns "+00:00" where JS writes "Z".
TAGS: autopilot, notifications, digest

<!-- from writer-honesty -->
[2026-10-26] A field named "evidence" can hold advice: label what it is before a writer reads it
WHAT HAPPENED: the research step wrote recommendations into `pain_points[].evidence_quote` ("Replace outdated WordPress with … live wait times", "Build chatbots for 24/7 inquiry handling"), and the writer, told evidence may be stated as fact, repeated them as things it saw. 11 of the study's 16 writer errors came from that one cause. `normalizePains` (lib/pitches/pitch-stage.ts) only checked length and "not the label". Fix: `isAdviceQuote` (lib/pitches/claude-composer.ts) marks each pain `observed`, and both the writer and the critic get the mark in their payloads.
RULE: When a prompt says "X may be stated as fact", check what actually lands in X in prod, not what the field name promises. A stored field another model wrote is that model's opinion until a check says otherwise. Mark it in the payload (observed: true/false) instead of dropping it, so the downstream model can still use it as a general pattern.
TAGS: pitches, prompts, research, evidence

[2026-10-26] A critic that is stricter than the writer's own rules burns good drafts
WHAT HAPPENED: 31 of the 64 blocking issues in the calibration study were the critic blocking things the writer prompt REQUIRES: the general "what tends to happen" line, our own CTA wording, the proof line, the forwarding line our code appends, and subject wording. It even blocked the correct "Hi [company] team," and suggested "Hi there", which the writer prompt bans. The critic prompt didn't know which lines were house text.
RULE: Every sentence the writer is told to write, and every line code appends, is listed in the critic prompt as house text or as allowed. When a writer rule changes, grep the critic prompt for the same rule in the same commit. A study of real failures (the critic's verdict next to the payload) is the only way to see this. The pass rate alone can't tell you who was wrong.
TAGS: pitches, critic, prompts, calibration

<!-- conductor, batch 9 audit -->
[2026-10-26] A learner that compares arms over a time window must restart at a prompt change
WHAT HAPPENED: the pre-send guardrail compared held rates per writer.guidance arm over 14 days. A new writer prompt (v3.3) lowers every arm's held rate at once while the bandit sends most new drafts to the champion, so a challenger would be judged mostly on the old prompt and retired for nothing. Fixed: only drafts of the newest prompt_version in the window count (lib/autopilot/learn.ts latestPromptOnly).
RULE: Any comparison of arms or segments over a window keys its sample on the version of everything that changes all arms at once (prompt, critic, gate). Changing that version restarts the comparison.
TAGS: learning, presend, prompts

[2026-10-26] "House text, not yours to dispute" must say which part of the line is still checked
WHAT HAPPENED: to stop the critic blocking our own CTA and proof line, #61 told it they are house text. The writer fills the CTA's [pain] and writes the proof line fresh each time, so "where your slow replies are costing you" or "we've helped clinics like yours cut no-shows in half" would have passed unchecked into the AUTO lane. Caught by the batch audit.
RULE: When a reviewer is told a template line is ours, name the slots the writer fills in and say they are still judged by the normal rules.
TAGS: pitches, critic, prompts

## Merged from lessons-inbox, batch 8 (2026-10-22)

<!-- from reply-on-root -->
[2026-10-22] A schema comment and the code disagreed on the shape of parent_pitch_id
WHAT HAPPENED: supabase/migrations/0001_initial_schema.sql:610 says "follow-up step N points to step N-1", while app/api/pitches/follow-up/route.ts only sends from rows with no parent, so every follow-up points straight at the root. Git history starts on 2026-10-17, so older rows could not be proven chain-free. The poll now prefers the thread's own parentless row, and the backfill walks parent_pitch_id up to the top ancestor, so both shapes resolve.
RULE: When a stored relation's meaning comes from a comment and the code that writes it, and they disagree, make readers and repairs correct for both shapes (resolve to the top ancestor) unless the data can be checked. A backfill must not trust the comment.
TAGS: replies, pitches, backfill, data-shape

[2026-10-22] Next.js route files cannot export helpers, so route logic is tested through the loader hook
WHAT HAPPENED: The root resolution lives in app/api/replies/poll/route.ts, and the brief's allow-list had no lib file. A route.ts may only export route fields, so the test drives GET through the stub loader from tests/optout-repair.test.ts, with lib/pitches/events.ts loaded for real against a fake db that stores rows.
RULE: To test logic inside a route without a lib file, load the route with the loader hook, stub every import except the module whose writes you assert, and check the stored rows rather than spy arguments.
TAGS: tests, routes

<!-- from tracked-links -->
[2026-10-22] A Next route file can't export helpers, so the testable logic of a public route lives in lib/
WHAT HAPPENED: The /r/<code> redirect needed tests for HEAD, scanners, dedupe, test addresses and open-redirect safety. `app/r/[code]/route.ts` can only export GET/HEAD/config, and `after()` throws outside a request, so the logic went to `lib/pitches/tracked-links.ts` as `planTrackedClick(db, req)` returning `{ location, record }`; the route only wires `after(record)`.
RULE: For any public route, put the decision in a lib function that takes the db client and a plain request object and returns the response plan plus a deferred side effect; the route file stays a three-line adapter. Test the lib function with a fake db that rejects unknown columns, and prove each filter by deleting it and watching a test fail.
TAGS: app-routes, testing, pitches

[2026-10-22] An LLM-written CTA is enforced after the call, and a missing one falls back instead of being patched in
WHAT HAPPENED: The follow-up prompt used to make the free-check link optional. Now `enforceFollowupCta` (lib/pitches/followup-composer.ts) swaps {hunter_url} and any direct Hunter link for the tracked link and adds the 👉 marker; a body with no link line returns ok:false with usage, so the route records the cost and sends the template, which always carries the line.
RULE: When a link or line is required, the prompt asks for it, code fills and normalises it, and a body that still lacks it is refused (paid usage returned), never guessed into place.
TAGS: pitches, follow-ups, llm-output

<!-- from presend-learning -->
[2026-10-22] Build a reason-string classifier's test inputs with the code that writes the reasons, plus a fixture-is-clean check
WHAT HAPPENED: The pre-send guardrail (lib/learning/presend.ts heldForWriting) reads auto_rejected_reason strings that governor laneFor + heldAction write. The tests build every reason by calling those two functions on a clean LaneInput with one field changed. A first test asserting the clean fixture is lane "auto" failed at once: I had guessed the trusted address source as "website_scrape" (the real list says "scraper"), so every "writing-only" case also carried an untrusted-source reason and the exclusion tests would have passed for the wrong reason.
RULE: When a module classifies strings another module writes, generate the test inputs by calling the writer, and add one assertion that the base fixture produces no reasons at all. Each case then changes exactly one thing, and a wrong guess about the fixture fails loudly instead of making every negative case pass vacuously.
TAGS: learning, autopilot, testing

[2026-10-22] A Bayesian "P(A worse than B)" with integer counts has an exact closed form; prefer it over Monte Carlo for an autonomous retire rule
WHAT HAPPENED: The brief asked for Beta posteriors with a seeded RNG. With Monte Carlo, a challenger near the 0.9 line could flip between retire and keep tick to tick on the same counts. lib/learning/presend.ts probabilityWorse uses the exact sum for integer Beta parameters (lnGamma, ~n terms), and the test checks it against a seeded Monte Carlo (within 0.006) and that P(A>B)+P(B>A)=1.
RULE: For a threshold rule that acts without a person, make the statistic deterministic in its inputs (exact or fixed-seed), so the same evidence always gives the same decision and the boundary tests are exact.
TAGS: learning, bandit

<!-- from handsoff-autopilot -->
[2026-10-22] A breaker input hard-coded to 0 passes every pure test
WHAT HAPPENED: governor.evaluateBreakers had a tested gmail_api rule (≥ 3 errors), but lib/autopilot/tick.ts passed `apiErrorsToday: 0` for every inbox, and nothing durable recorded Gmail send failures, so the breaker could never fire. The pure tests fed the rule its number directly and stayed green.
RULE: For every rule in a pure governor, keep one test that drives the real caller (the tick through the loader-hook harness in tests/autopilot-trust-split.test.ts) from stored rows to the trip. A literal constant passed into a rule's input is a finding by itself.
TAGS: autopilot, breakers, testing

[2026-10-22] A clock restart must check its own write
WHAT HAPPENED: The veto restart's only guard against re-firing every 15 minutes is that the trip predates the new stage_since. tick.ts's existing stage write ignores its error; for the restart, an unrecorded write would restart, pull back and email on every tick. restartStageClock checks the write, still pulls back, and throws (into report.errors, so the tick_errors row shows it) without the email.
RULE: When "this event was already handled" is encoded as a timestamp the handler writes, check that write's error and skip the side effects (emails, insights) when it fails; keep only the idempotent safety action.
TAGS: autopilot, stage, idempotency

[2026-10-22] A clock that starts at the tick's `now` recounts what the same tick wrote
WHAT HAPPENED: Review of #55 found the veto clock restarting twice: restartStageClock (and the existing auto→veto write) set stage_since = the tick's start, but runBreakers had inserted the opt_out_spike insight milliseconds later in the same tick (DB now()), so the next tick's `created_at >= stage_since` counted it again. Fixed with governor.stageClockStart: the later of the write clock and 1 ms after the newest counted evidence.
RULE: A "since" boundary that decides what is already handled starts after the newest row it handled, never at a timestamp taken before that row was written. Test it with the evidence written INSIDE the first run and three runs in a row.
TAGS: autopilot, stage, time-windows, testing

<!-- from health-alarms -->
[2026-10-22] A new import in a cron route breaks every test that stubs that route's imports
WHAT HAPPENED: adding `import { withHeartbeat } from "@/lib/reports/heartbeat"` to the poll and tick routes failed 12 tests in tests/reply-on-root.test.ts, tests/optout-repair.test.ts and tests/autopilot-trust-split.test.ts. Their loader stubs every import of the route, and any stub without an answer throws "stub withHeartbeat called". Fixed with a pass-through entry in each file's `__stubValues`, three files outside the brief's allow-list.
RULE: before adding an import to a route, grep tests/ for the route's path (`replies/poll/route`, `autopilot/tick/route`, ...). Every hit that stubs imports needs an answer for the new name, so the brief's allow-list should include those test files.
TAGS: tests, cron routes, stubs

[2026-10-22] A "has it learned lately" alarm needs a column the learner writes, and learning_arms has none for trials
WHAT HAPPENED: learning_stalled was briefed as "no writer arm gained a trial in 7 days". learning_arms.trials is recomputed from scratch on every tick (lib/autopilot/learn.ts settleLearner), so its history is never stored. settleLearner does write `updated_at = now` on every arm on every tick it runs. The rule therefore reads two signals: trials = 0 while 5+ settled first emails exist, or the newest writer-arm write is 7+ days old.
RULE: before writing a "stopped changing" alarm, read the writer and find the column it sets on every run. updated_at only works when the learner is the table's only writer (true for writer.* arms). If no such column exists, compare against what the learner should have counted, using its own exclusions (test sends, bounces, pitches without arms).
TAGS: health, learning, alerts

<!-- from send-pacing -->
[2026-10-22] A "max per run" that is also the query LIMIT starves other inboxes once a per-inbox rule is added
WHAT HAPPENED: The follow-up route used MAX_PER_RUN = 30 both as the read window (`.limit(MAX_PER_RUN)`) and the run size. Cutting the run to 2 by lowering that constant would have read only the 2 oldest due rows; if both belong to one inbox, the second inbox's follow-ups are never seen. Split into DUE_WINDOW (read) and the pacer (send) in app/api/pitches/follow-up/route.ts.
RULE: When a per-run limit gains a per-key rule (per inbox, per tenant), the read window must stay wider than the send limit, or the head of the queue blocks every other key. Name the two numbers separately.
TAGS: send-path, cron, pacing

[2026-10-22] pg_cron installs locally with apt in the cloud container
WHAT HAPPENED: The brief allowed a stub `cron` schema if pg_cron couldn't be installed. `apt-get install -y postgresql-16-cron` worked in under a minute; initdb + `shared_preload_libraries='pg_cron'` in a dir the postgres user can traverse (/var/tmp, not the scratchpad under /tmp/claude-0) gave a real cron.alter_job to test 0052 against.
RULE: For a pg_cron migration, test against the real extension (apt postgresql-16-cron, cluster under /var/tmp) before reaching for a stub.
TAGS: migrations, testing, pg_cron

[2026-10-22] A schedule change has a ship order when the health check reads the schedule from code
WHAT HAPPENED: lib/reports/heartbeat.ts quotes each job's cron and the health check counts missed runs from it. Deploying the code that says "every 10 min" while pg_cron still ran the hourly job would make job_silent fire every window hour. My first PR body claimed the opposite; the conductor reproduced it (now 15:55, last ok 15:20:30 -> 3 missed). Fixed by writing SHIP ORDER into the 0052 header and a test that pins it.
RULE: When code quotes a pg_cron schedule (heartbeat.ts, health rules), work out both orders of "migration applied" vs "code deployed" before writing the PR body, and put the safe order in the migration header where the person applying it reads it.
TAGS: migrations, cron, health-check, deploy

[2026-10-22] Running a job more often multiplies the cost of every retry path that redoes paid work
WHAT HAPPENED: Hourly -> every 10 min made a follow-up that fails after its Claude compose (gate unavailable, no slot, recheck skip, Gmail failure) recompose up to 48x a day instead of 8x. Fixed with a 60-min back-off on those exits (lib/pitches/send-pacing.ts backOffFollowup, or the claim release writing retryAt) and the inbox used up for the run.
RULE: When a cron's cadence goes up, list every exit that leaves the item due after paid work (AI calls, API quota) and give it a back-off, or the cap pays for the cadence.
TAGS: cron, cost, follow-up

<!-- from redraft-pool -->
[2026-10-22] Changing "who gets the email" in one picker silently splits the email from its greeting
WHAT HAPPENED: The brief moved the recipient choice into `fetchTopUsableContact` (lib/pitches/contacts.ts). That only sets the pitch's `contact_id`. The greeting comes from `pickAddressContact` over pitch-stage's own contacts query (generator.ts, industry-templates.ts, review.ts), and the generation-time gate's recipient from `loadGateContext` (gate.ts:173), each "first usable by priority". Skipping contact A would have produced "Hi <A>" drafts linked to contact B, gated against A (so labelled AUTO), caught only by the send-queue gate's greeting_mismatch.
RULE: Before changing a "which X" rule, grep every reader that answers the same question by its own copy (here: `pickAddressContact`, `pickTopUsableContact`, `loadGateContext`, the /pitches display) and change them together, or change none. A rule that sets an FK is not the rule the text was written for unless the composer reads the same FK.
Found mid-task; the conductor extended the scope to pitch-stage.ts, gate.ts and queries.ts the same hour.
TAGS: pitches, recipient, one-predicate

[2026-10-22] A "one try per X" cap needs a mark that survives the rewrite that replaces X
WHAT HAPPENED: The re-draft's `decision.redraft_of` mark would have been lost when the tick's rewrite replaced the re-draft (generatePitchWith deletes drafts and writes a fresh decision), so a twice-failed prospect could be re-drafted again 14 days later. resolveHeld now copies the mark onto the rewrite, and a failed generation marks the old pitch (`redraft_failed`) so a repeating failure is not retried every tick.
RULE: When a marker lives on a row some other step deletes and recreates, carry it across that step and test the full chain (mark → rewrite → drop → next window), not only the first write.
TAGS: autopilot, tick, caps

[2026-10-22] A revision carries its recipient: change the recipient, compose fresh
WHAT HAPPENED: The autopilot's rewrite revises the held draft's text (`retryOf`, pitch-stage.ts heldDraftRevision). A rewrite to a different contact would have handed the reviser "Hi Ana" while the pitch now went to Bo. generatePitchWith now composes fresh when the held draft's contact_id is not the new recipient.
RULE: Stored text handed back to a model carries every fact it was written for (recipient, link, language); when one of them changes, do not revise, write fresh.
TAGS: pitches, rewrite, recipient

[2026-10-22] A column with a write-once trigger cannot carry a later mark, and the fake db must say so
WHAT HAPPENED: The re-draft step marked pitches.decision after generatePitchWith had written it. Migration 0038 makes decision write-once (trigger raises), so in prod every mark would fail silently: the 10/day cap would never bind, a failing re-draft would retry every tick. All tests passed because the fake db accepted the update. Fix: the mark goes in at the first write (`generatePitchWith(…, { redraftOf })`), a failed try is an audit_log row, and the test fake now refuses a second decision write.
RULE: Before writing to an existing column, grep the migrations for triggers on that table (`create trigger … on public.<table>`); a fake db must enforce every such trigger the code path can hit, the same way it must reject a column the table lacks.
TAGS: autopilot, migrations, fake-db, decision
