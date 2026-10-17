# Brief: pitch-exemplar-memory

| | |
|---|---|
| Module | `lib/pitches/` (THE HUB: writer + critic path) |
| Model / effort | opus-5.5 / high |
| Branch | `claude/pitch-exemplar-memory` from `claude/gallant-gauss-gly093` |
| PR target | `claude/gallant-gauss-gly093` (phase 3 integration branch) |
| Reserved migration | none (0045 stays reserved; do NOT create a table in this task) |
| Depends on | none at runtime; serialized: you are the only worker in `lib/pitches/` |
| Conductor session | `session_012bGmp5nHP9Lx5ke69JkaBk` |
| Size | M |

## Goal
The writer and the critic start from zero on every pitch. The system already knows
which past pitches worked (replies, audit-tool scans) and for which segment. Give the
writer up to two of our own best past pitches for the same segment as reference, and
give the critic the same two as a bar to judge against. This is "exemplar memory"
without vectors: selection by segment match and outcome score. A good solution is a
pure, tested selector plus a minimal, cache-safe prompt injection that cannot leak a
client name, a number, or a prospect's details from one email into another.

## Context the worker needs
- Writer: `composePitchWithClaude(input: GeneratorInputs)` in `lib/pitches/claude-composer.ts`,
  called from `lib/pitches/review.ts` (write → critic → revise loop, `MAX_REVISIONS = 2`,
  deadline-bound). The system prompt is byte-identical per (lang, size) and cached: put
  exemplars in the USER message, never in the system block, or the cache breaks.
- Critic: `critiquePitch()` in `lib/pitches/review.ts`, Haiku, fixed rubric.
- Segments: `segmentOf()` in `lib/learning/segments.ts` (industry, size, market). The
  decision record (`lib/pitches/decision.ts`, built in `lib/pitches/pitch-stage.ts:517`)
  stores `segment` per pitch.
- Outcome score: `scoreOutcome(events)` in `lib/learning/reward.ts` over `pitch_events`
  rows (sent, audit_scan, reply with intent, bounce, unsubscribe; test rows excluded).
- Candidate pool rule (conductor decision): root pitches only (`parent_pitch_id` null),
  `status = 'sent'`, same segment industry AND market, outcome score ≥ 0.5, sent at
  least `ATTRIBUTION_WINDOW_DAYS` ago (so the score is settled), newest first on ties,
  never a pitch to a test address, never a pitch whose `decision.critic.pass` is false.
  At most 2. Fall back to same-industry-any-market, then none. Never cross languages.
- What an exemplar contributes: subject + body ONLY, with the recipient's name, company
  name, domain and any digit sequence replaced by placeholders before injection
  (`[name]`, `[company]`, `[site]`, `[n]`). Write that scrubber as a pure function and
  test it; it is the thing that keeps rule 2 and rule 3 of `_core-context.md` intact.
- Prompt wording to the writer: "two of our own past emails that got a reply from
  businesses like this one; match their shape and restraint, never their facts". To the
  critic: "judge against this bar". Keep both under 60 words.
- Record what was used: add `exemplars_used: Array<{ pitch_id: string; score: number }>`
  to `DecisionRecord` (bump nothing else; `DECISION_VERSION` stays 1, the field is
  additive) and fill it in `pitch-stage.ts` and `website-pitch-stage.ts`.
- Budget: the selector runs one query per pitch (candidates for the segment, limit 20),
  then scores in memory. No new Claude calls. `max_tokens` of the writer is unchanged;
  two scrubbed emails add ~400 tokens of input.

## Files
Allowed to edit:
- `lib/pitches/exemplars.ts` (new, pure: `selectExemplars(candidates, segment, opts)`,
  `scrubExemplar(text, prospect)`)
- `lib/pitches/exemplar-queries.ts` (new: fetch candidates + events; takes the client)
- `lib/pitches/claude-composer.ts` (user-message injection only)
- `lib/pitches/review.ts` (pass exemplars to the critic)
- `lib/pitches/decision.ts` (additive field)
- `lib/pitches/pitch-stage.ts`, `lib/pitches/website-pitch-stage.ts` (wire + record)
- `lib/pitches/generator.ts` (only if `GeneratorInputs` needs an optional `exemplars` field)
- `tests/pitch-exemplars.test.ts` (new)

Read, do not edit: `lib/learning/{reward,segments}.ts`, `lib/pitches/events.ts`,
`lib/pitches/root-pitch.ts`, `lib/pitches/send-gate.ts`, `lib/pitches/queries.ts`.

Forbidden: `lib/pitches/send-gate.ts`, `gate.ts`, `send-*.ts`, `follow-up*`, anything in
`lib/autopilot/`, migrations, `lib/supabase/types.ts`, the system prompt block.

## Must not change (negative set)
- The writer's system prompt bytes (cache). The critic rubric wording.
- Gate behaviour: an exemplar can never introduce a number, a client name, or a URL into
  a draft that the gate would not have allowed; the scrubber guarantees it, the existing
  gate tests still pass unchanged.
- Pitches with no eligible exemplars compose exactly as today (same payload shape, with
  an empty list), so the 499+ existing tests pass unchanged.
- `PITCH_PROMPT_VERSION` stays `pitch-v2-2026-10-16`; add a separate
  `EXEMPLAR_PROMPT_VERSION` constant recorded in the decision instead.

## Acceptance checks
1. Selector tests: segment match beats score; score ≥ 0.5 threshold; max 2; ties newest
   first; excludes follow-ups, unsettled (< 14 days), failed-critic and test-address
   pitches; language never crosses; fallback order industry+market → industry → none.
2. Scrubber tests: name, company, domain and digits replaced; an email with none of
   them is returned unchanged; Spanish accents survive.
3. A composed draft with exemplars present contains no exemplar's company name or digits
   (test by composing with a stub model client if one exists in tests; otherwise test the
   payload builder).
4. Decision record carries `exemplars_used` (empty array when none).
5. `npm run typecheck && npm run lint && npm test` green; report the count.

## Out of scope
pgvector / embeddings (needs a paid embedding API; later), exemplars for follow-ups,
a UI showing which exemplars were used, changing critic or writer models.

## Questions already answered
Q: Store exemplars in a table? A: No. Select at compose time from existing data.
Q: Which model? A: None new. Writer and critic unchanged.
