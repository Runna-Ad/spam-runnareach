# Lessons — S.P.A.M. / Runna CA Opportunity Engine

Running log of mistakes, root causes, and rules to prevent recurrence. Newest at top.

---

## [2026-04-23] LESSON: supabase-js 2.47 types `.update()` / `.insert()` payload as `never` when Database type is hand-written

**What went wrong:** Wrote clean server actions for `case_studies` update + `case_study_pain_tags` insert. `npm run typecheck` failed with:
```
Argument of type '{ client_name: string; ... }' is not assignable to parameter of type 'never'.
```
Both calls ended up with `Row = never` in the `update<Row extends Relation['Update']>` generic even though `Relation['Update']` was a valid `Partial<Row>` type.

**Root cause:** `@supabase/supabase-js@^2.47.0` tightened the way `Schema` gets resolved from `Database`:
```ts
Schema extends (Omit<Database, '__InternalSupabase'>[SchemaName] extends GenericSchema
  ? Omit<Database, '__InternalSupabase'>[SchemaName]
  : never)
```
Our hand-written `lib/supabase/types.ts` satisfies `GenericSchema` structurally for `.select()` and `.insert()` on tables it fully describes (users), but when a table uses `Update: Partial<Row>` with a `Row` containing `unknown`-typed columns (case_studies.measurable_results) the inference falls through to `never`. Further, tables the local `Database` type doesn't declare at all (case_study_pain_tags before I added it) fall through the `Views: Record<string, never>` overload and resolve to `never` too. Reading operations worked because SELECT doesn't depend on the Relation['Update'] path.

Spent ~45 min trying to make the Database type satisfy GenericSchema — adding `__InternalSupabase`, rewriting `Insert`/`Update` as explicit non-Partial objects, changing `Views` to `Record<never, never>`. None of it cleared the error. The fix is known: generate types with `supabase gen types typescript`. We haven't run that yet because Phase 0 types.ts is hand-written and `types.ts` even says so.

**RULE (until generated types land):**
1. For any `.update()` / `.insert()` call that TS narrows to `never` with this pattern, cast the payload with `as never` at the call site, and keep a locally-typed variable above it so structural type safety isn't lost. Pattern:
   ```ts
   const payload = { ...fields... } satisfies SomeType;
   await supabase.from("case_studies").update(payload as never).eq(...)
   ```
2. Always add new tables to `lib/supabase/types.ts` the moment you query them — don't rely on "any string key" fallback through Views. A missing table type makes every `.from("unknown_table")` return `never` at runtime-silent typecheck cost.
3. When the Anthropic/Google creds land and we're about to use tables beyond case_studies/pain_tags, run `supabase gen types typescript --project-id ybbrpqzbedaxsmotgtkh > lib/supabase/types.ts` to replace the hand-written stub. That removes every `as never` cast in one stroke.

**How to apply:** If a supabase mutation typecheck fails with "not assignable to parameter of type 'never'", do NOT spend time restructuring the Database type. Cast with `as never`, leave a short comment naming this lesson, add a TODO referencing the generated-types migration, and move on. Document the table you touched in the TODO so the migration knows what to cover.

**TAGS:** #bug #supabase #typescript #lesson #typing-quirks

---

## [2026-04-23] LESSON: Next.js dev server in a git worktree needs its own `.env.local`

**What went wrong:** Started `npm run dev` inside `/Users/work/Projects/S.P.A.M/.claude/worktrees/pensive-wilson-3cc368` to smoke-test /case-studies. Server started but every request 500'd with "Your project's URL and Key are required to create a Supabase client!". Only the parent `/Users/work/Projects/S.P.A.M/` has `.env.local`.

**Root cause:** `next dev` reads `.env.local` from the current working directory, not from anywhere upward. Git worktrees are sibling directories — they don't inherit env from the main checkout. The `.env.local.example` was committed but the real `.env.local` is gitignored (correctly), so a fresh worktree starts dry.

**RULE:** When working in a worktree, copy the parent's `.env.local` into the worktree root before running dev/tests. One-liner:
```
cp ../../../.env.local .env.local
```
(Path depends on worktree depth — ours is `.claude/worktrees/<name>/`.)

Alternative: a `scripts/bootstrap-worktree.sh` that does this + any other worktree-local prep. Skipped for now — low friction to copy manually.

**How to apply:** First action in any worktree session that needs to run the app (not just typecheck / lint): `ls .env.local` — if missing, copy it from the main checkout. Typecheck and lint don't need env, so they work immediately.

**TAGS:** #lesson #dev-workflow #worktrees #env

---

## [2026-04-23] LESSON: Never fabricate metrics in seed data

**What went wrong:** Three of the ten case studies I seeded in the original `seed.sql` contained details I invented when I didn't have the real Rünna portfolio.
- **Niki** was seeded as "AI assistant for Mexican Spanish speakers, full brand + product launch" — the real Niki is a platform that places international students in Canadian institutions.
- **SnapPad** was seeded with a fabricated "+10% sales YoY, +50% email revenue" — those numbers are not in any Rünna source; Rünna actually did packaging design, no revenue claim.
- **DevFest** was seeded as "event brand + content system" — the real work was a Meta + Instagram ad campaign for DevFest Calgary 2024.

Pedro caught it when he handed over the real 2026 ESP deck. Had a pitch generator shipped these stories to real prospects, Rünna would have been caught lying about its own work — the exact opposite of the case-study-grounding moat.

**Root cause:** In early sessions I had partial / indirect information about Rünna's portfolio (the SAGA partner deck, the S.P.A.M. pitch) and filled in plausible-sounding metrics to hit the "10 case studies with measurable results" shape Pedro asked for. I treated "plausible" as sufficient. Plausible is not the same as verified.

**RULE:** Every measurable number that appears in `case_studies.measurable_results`, `hero_metric_en`, or `result_description_en` must be traceable to one of three sources:
1. A Rünna-owned document (deck, portfolio, case-study PDF, client-delivered report)
2. A direct Pedro assertion ("we did X for client Y, here's the number")
3. A client-authored artifact (testimonial, press release, public case study)

If none of those exist, the case study gets a deliverable-scoped entry (e.g. "Canadian retail packaging system") but **no numeric metric**. It's honest and still citeable. A case without numbers just means the Phase 3 pitch validator won't pair it with pitches that require a measurable result — it can still serve as a credibility anchor.

**How to apply:** When seeding any client-facing claim (case studies, testimonials, results, industry metrics), cite the source inline in the SQL comment. If I can't cite, I don't write the claim. When in doubt, ask Pedro rather than invent.

**TAGS:** #lesson #honesty #seed-data #case-studies #fabrication

---

## [2026-04-23] PEDRO_OVERRIDE: Pedro's full name is Pedro De Velasco, not Pedro Torres

**What Claude got wrong:** Every commit, every hardcoded string, every README reference used "Pedro Torres." Source is unclear — possibly I fabricated "Torres" from the very first session and it stuck because nothing ever corrected it, or picked it up from a stale handoff.

**Pedro's correction:** "my names is not Pedro Torres is Pedro De Velasco"

**RULE:** The user's full name is **Pedro De Velasco**. Use this in:
- All git commits (`--author` / `user.name`)
- Any hardcoded defaults in scripts or seed data
- README / docs
- User-facing copy where a real name is needed

**How to apply:** When setting git config or signing commits, use `Pedro De Velasco`. Never invent or assume a last name — if I don't know it from an authoritative source (the user typing it, their email signature, a verified memory), I ask or use "Pedro" alone.

**TAGS:** #override #naming #facts-not-assumptions

---

## [2026-04-22] PEDRO_OVERRIDE: Stop asking me to run things you can run yourself

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

---

## [2026-04-22] PEDRO_OVERRIDE: Trusted hallucinated handoff without verifying disk state

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
