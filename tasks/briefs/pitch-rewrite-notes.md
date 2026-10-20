# Brief: pitch-rewrite-notes

| | |
|---|---|
| Module | `lib/pitches/` (hub) |
| Model / effort | opus-5.5 / high  (see tasks/routing.md: pitches hub) |
| Branch | `claude/pitch-rewrite-notes` from `claude/phase3-batch6-integration` |
| PR target | `claude/phase3-batch6-integration` |
| Reserved migration | none |
| Depends on | none. Runs in parallel with `claude-calls-accounted`, which is forbidden from `lib/pitches/`; you are forbidden from its files |
| Conductor session | `session_017nqBxLFFXKbhDwKiPi6xLf` (send_message here ONLY if blocked; the PR body is the report) |
| Size | M |

## Goal
More of the pitches the autopilot writes should survive its own reviewer, with no check loosened. Last week 20 of the 40 auto-rejected drafts were rewrites the reviewer blocked again. You make four changes:
1. **The rewrite uses the reviewer's notes.** Today it starts from a blank page. After your change it revises the held draft and fixes each note.
2. **The writer and the reviewer agree.** The writer stops stating guesses about the company as facts.
3. **A missing field doesn't force a template.** An answer that only lacks the `pain_id` key is no longer thrown away for a template.
4. **No new pitch for a company already emailed.**

A good solution leaves the reviewer exactly as strict and changes what the writer produces.

## Context the worker needs
Pedro chose this (option 1, 2026-10-20) after the conductor's prod analysis. Every fact below was checked before spawning.

**Where pitches are lost (prod, 7 days, 40 `auto_rejected`).** Grouped by `auto_rejected_reason`:
- **20: "still held after one rewrite: … AI review flagged issues".** The blocking issues are almost all one class: a guess about the company stated as fact. Real blocked lines:
  - "Everyone who finds you on their phone after hours or on the weekend just leaves"
  - "it takes longer than three seconds to load on phones"
  - "someone fills out a form, gets a reply the next day, and by then they've already signed up somewhere else"
  - "Most of your traffic is mobile now"
  - "muchas ya se fueron con otro despacho"
- **15: address or domain** (correct, a rewrite can't fix them).
- **3: a rewrite that still failed a writing gate** (unsourced_metric, banned_jargon).
- **2: a template after Claude's answer failed** (`pain_id:Required`).

Rewrites that did pass: 13 sent and 1 approved.

**Cause 1: the writer prompt teaches the blocked pattern.**
- `lib/pitches/claude-composer.ts:414` "translate it into how the owner would describe it to a friend: the business consequence, not the symptom … That translation is your hook."
- `:312` subject shape "the leak, stated as fact".
- `:315` preview example "no way to book online, so every visitor after hours just leaves".
- The benchmark example at `:290` ends "and right now yours wait until morning".

The critic (`lib/pitches/review.ts:123`) blocks "A claim about the prospect … that the payload does not support, or an inference stated as fact." Lesson `llm-examples-become-templates`: the model copies examples nearly verbatim.

The fix direction: the observed finding (in the payload: what_they_do, tech_stack, evidence_quote) may be stated as fact in plain words. The consequence is framed as what usually happens ("which usually means…", "most visitors who…"), never as a fact about them. You may add ONE sentence to the critic prompt saying that framing is not an inference stated as fact. Do not remove or soften any of the 7 blocking rules. Bump `PITCH_PROMPT_VERSION` (`claude-composer.ts:243`): `decision.prompt_version` records it, so outcomes can be compared before and after.

**Cause 2: the rewrite starts from a blank page.**
- **The rewrite call.** `lib/autopilot/tick.ts:630` `generatePitchWith(actor, p.prospect_id, { retryOf: p.id })`. `generatePitchWith` (`lib/pitches/pitch-stage.ts:114`) never reads the held draft. It deletes it (`:505-510`), then composes fresh.
- **Only one revision fits.** `composeWithReview` (`review.ts:233`) gets `deadline: startedAt + 48_000` (`pitch-stage.ts:432`). It revises only while `remaining >= 25_000` (`review.ts:274`). In prod, `decision.critic.revisions` was never 2.
- **The revision input already exists.** `GeneratorInputs.revision = { subject, body, issues }` (prompt at `claude-composer.ts:548-558`). Hand-back issues are `revisionIssues`: gate details first, then critic issues, max 8 (`review.ts:225`).

Change: when `opts.retryOf` is set, read that held pitch (same tenant and prospect: `subject`, `body`, `decision.critic.issues`, `gate_verdict.failures` details) BEFORE the draft delete. When it was written by Claude (`decision.path === "claude"`) and has issues, the first compose is a revision of it with those issues. Otherwise compose fresh, exactly as today. A read error falls back to today's fresh compose and never refuses. The rewrite stays the only one (`decision.retry_of` is still written; `governor.heldAction:131` drops a rewrite held again: do not touch that).

Time budget: the tick has `TICK_BUDGET_MS = 90_000` (`tick.ts:102`) and route maxDuration 120. It allows `REWRITES_PER_TICK = 2` (`:104`) and starts a rewrite only with ≥ 60 s left (`:623`). Your revision-first compose must still fit the same 48 s compose deadline. Test at 2 rewrites in one tick.

**Cause 3: missing `pain_id`.**
- `claude-composer.ts:45` `pain_id: z.string().nullable()` fails when the key is absent. Prod, 30 days: 4 of 5 composer fallbacks were `Schema validation failed: pain_id:Required`; the 5th was `hallucinated_pain`.
- null is already a valid answer (test "accepts pain_id=null").
- Read absent as null. `contact_email` (`:49`) has the same shape and its comment says it "may be missing"; treat it the same.
- Keep strict:
  - `quality_self_score`;
  - `measurable_result_included`;
  - the hallucinated-pain check (`:166`).

**Guard.** `pitch-stage.ts:423` refuses only `DO_NOT_SEND_STATUSES`. Use `isSentOrParked` (`lib/prospects/status.ts:90`: sent, bounced, replied, ghosted plus do-not-send).

The callers:
- **The autopilot rewrite** (`tick.ts:630`). The prospect is `pitched` there, so it is still allowed. Do NOT use `isPastPipeline`: that would block every rewrite.
- **The manual button** (`lib/pitches/actions.ts:26` ← `components/prospects/prospect-detail.tsx:662`). This is the only path that can draft for an emailed company today.
- **Bulk and pipeline** (`lib/discover/bulk-actions.ts:514`, `pipeline-stage.ts:223`, `app/api/discover/run/route.ts:554`). These already pre-filter.

**Also in lane.** `lib/pitches/angle-advisor.ts:272` (`suggestPitchAnglesAction`) never calls `recordClaudeCall`, ok or failed. Record it (`entity_type: "pitch"`, `metadata.kind: "angle_advice"`, entity_id null if no pitch).

## Brain lessons
- `llm-examples-become-templates.md`: examples in a prompt become templates. Replace a bad example; don't add a rule next to it.
- `anthropic-prompt-caching-mechanics.md`: the composer system prompt is cached. Edit the static text, never move per-call text into it.

## Files
Allowed to edit:
- `lib/pitches/claude-composer.ts`, `lib/pitches/review.ts` (critic prompt: one sentence only; loop only if needed), `lib/pitches/pitch-stage.ts`, `lib/pitches/angle-advisor.ts`
- `lib/autopilot/tick.ts`: ONLY the comment at `:620-622`, which will be stale. No code.
- `tests/*.test.ts` (new tests always allowed; edit existing ones only where your change requires it, and list them in the PR)

Read for context, do not edit: `lib/autopilot/governor.ts`, `lib/pitches/gate.ts`, `lib/pitches/send-gate.ts`, `lib/pitches/decision.ts`, `lib/pitches/exemplars.ts`, `lib/prospects/status.ts`, `lib/anthropic/*`, the callers listed above.

Forbidden: `lib/research/`, `lib/discover/`, `lib/replies/`, `lib/icp/`, `app/api/replies/` (the other worker), `lib/anthropic/`, `lib/supabase/types.ts`, `vercel.json`, `CLAUDE.md`, migrations.

## Must not change (negative set)
- **Reviewer strictness.** All 7 blocking rules, the polish/blocking split, `criticVerdict` (pass = no blocking issue; the score cap at 0.79), `AUTO_MIN_CRITIC_SCORE` 0.8, the lanes and `heldAction`.
- **First drafts compose exactly as today.** No `retryOf`, no revision input; only the prompt text differs.
- **Templates and failed reads.** A held draft that is a template, has no critic, or cannot be read gets today's fresh rewrite.
- **One rewrite per draft.** The rewrite's cost rows keep pointing at the new pitch id.
- **The status re-check fails closed** (read error or missing row refuses) and still runs immediately before any Claude call.
- **Allowed statuses.** A `pitched`, `queued` or `approved` prospect may still get a rewrite. The send gate decides sending.

## Acceptance checks
1. `npm test` passes, with new tests that show:
   - **Revision with notes.** With `retryOf` pointing at a Claude-written held draft, the first composer call carries `revision` with that draft's subject, body and issues, gate details first, max 8.
   - **Fresh fallback.** A template held draft or a read error composes fresh.
   - **Deadline.** Two rewrites in one tick stay inside the 48 s compose deadline each (fake clock).
   - **Missing fields.** An answer missing `pain_id` (and one missing `contact_email`) parses with null. One missing `quality_self_score` still fails.
   - **Guard.** `sent`, `replied`, `bounced` and `ghosted` refuse; `pitched` proceeds.
   - **Angle advice.** It records once, ok or failed.
   - **Prompt.** The composer prompt no longer contains the lines quoted under Cause 1. Pin with a test that fails if "the business consequence, not the symptom" or "every visitor after hours just leaves" comes back.
2. `npm run typecheck` and `npm run lint` clean.
3. Mutation: undo the retryOf read and drop `isSentOrParked`. Name the tests that fail.

## External prerequisites
none

## Prod verification
**3 days after the deploy**, rewrites (`decision->>'retry_of' is not null`) created after deploy:
- Count `auto_rejected_reason like 'still held after one rewrite:%AI review flagged issues%'` against `status in ('sent','approved')`.
- Baseline (7 days before): 20 rejected vs 14 sent or approved.
- Expect fewer rejected per rewrite.

**After the first pitch run:**
- `decision->>'prompt_version'` shows the new version.
- `cost_tracking` composer fallbacks with `pain_id:Required` = 0.

## Out of scope
- Raising the 48 s budget or `MAX_REVISIONS`.
- Changing the governor or lanes.
- A polish pass for passing drafts (Pedro chose option 1 without it).
- Re-scrubbing exemplars that contain old patterns.
- `rewritePitchWithAngleWith`'s own status check.

Write any of these to the lessons inbox if you think they matter.

## Questions already answered
- **Q: Should the rewrite get a second rewrite if still held?** A: No. One rewrite, then drop, as today.
- **Q: Should polish notes go into the revision?** A: Yes. They are already in `decision.critic.issues` (prefixed "(polish) "); hand them over as stored.
- **Q: Can I test against real Claude?** A: No, the sandbox has no key. Pin the prompt text and the inputs. The conductor measures in prod.

## If blocked
Message the conductor with: what you tried, what you need, what you can still do meanwhile. Do not wait idle if any part of the brief is still doable.
