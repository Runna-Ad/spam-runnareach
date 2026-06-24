# Lessons — S.P.A.M. / Runna CA Opportunity Engine

Running log of mistakes, root causes, and rules to prevent recurrence. Newest at top.

---

[2026-06-24] BUG/FIX: Gary built an ICP that targeted Runna's OWN OFFERING instead of the buyer (buyer/offering inversion)
SYMPTOM (Pedro): ICP "MX - Mid-Market B2B Software & Automation" had search_keywords = software development, custom dashboard, business intelligence, workflow automation, data visualization, crm integration, analytics dashboard — and industry_tags incl. saas_b2b. Those are the SERVICES RUNNA SELLS, so Discovery (which queries directories by search_keywords + google_places_types) would find software/BI vendors = our COMPETITORS, the exact opposite of the law firms / clinics / manufacturers who would BUY those services.
ROOT CAUSE: Gary's prompt defined google_places_types in detail but NEVER defined search_keywords and never stated the buyer-vs-offering distinction. When an ICP is themed around what Runna sells ("Software & Automation"), the model fills the targeting fields with offering terms.
FIX ROUND 1 (prompt only) — NOT ENOUGH: added a "TARGET THE BUYER, NOT THE OFFERING" rule + worked example + search_keywords/excluded_keywords definitions. Re-ran Gary: industry_tags + rationale + excluded improved, BUT search_keywords STILL inverted (automatización, dashboard, herramientas internas, software personalizado, inteligencia artificial, optimización de procesos, panel de control, reportes automatizados). The theme keeps dragging the model back. LESSON: for a constraint the model has a strong prior to violate, prompting alone is unreliable — add a deterministic guard.
FIX ROUND 2 (deterministic guard) — enforceBuyerTargeting() in lib/icp/gary-action.ts, applied to every proposal before return: (1) strip any search_keyword / google_places_type whose lowercased form contains an OFFERING_NEEDLE (automation/dashboard/software/AI/BI/CRM/ERP/analytics/optimization/internal tools/workflow/… in en+es); (2) if search_keywords drops below 2, BACKFILL buyer-vertical phrases from the (already buyer-correct) industry_tags/business_types via a bilingual BUYER_PHRASES map (es for MX/LATAM: law_firm→despacho de abogados, healthcare→clínica privada, real_estate→inmobiliaria, manufacturer→empresa de manufactura, …); (3) force PROVIDER_EXCLUSIONS (software, saas, desarrollo de software, business intelligence, data analytics, agencies) into excluded_keywords. Verified deterministically on the exact inverted input → search_keywords became despacho profesional / agencia automotriz / clínica privada / inmobiliaria / colegio privado; "software company" stripped from places; provider terms added to excluded.
RULE: Discovery targeting fields (industry_tags, business_types, google_places_types, search_keywords) describe WHO YOU SELL TO (the buyer's own business category, in-language), NEVER what you sell. The offering belongs in the rationale/pitch. When an LLM must honor a rule that fights its prior, back the prompt with a deterministic post-filter — don't trust the prompt alone.
TAGS: #bug #gary #icp #discovery #buyer-vs-offering #deterministic-guard #llm-reliability #spanish
STATUS: prompt + guard built, typecheck+lint clean, guard self-tested; committing + deploying now.
---

[2026-06-24] BUILD/FIX: full discovery died when the tab closed + 504 crashed to Sentry — moved orchestration server-side (background job)
SYMPTOM (Pedro): ran a full discovery, clicked elsewhere, the tab/window closed and the run stopped. Also a Sentry "An unexpected response was received from the server" at fetchServerAction (server-action-reducer) on /discover.
ROOT CAUSE: components/discover/run-all-modal.tsx `handleRun` orchestrated the ENTIRE pipeline IN THE BROWSER — call runAllSources(), then loop processSingleProspect() in batches of 5 client-side. Close the tab → the loop dies. Separately, on a big run runAllSources() exceeds the 60s function budget → the gateway returns an HTML 504 page instead of the RSC payload, so `await runAllSources()` THROWS (it does not return {ok:false}) and escaped the existing ok:false fallback → uncaught → Sentry.
FIX (approved direction: proper background job): new discovery_jobs table (migration 0023) + a SELF-CHAINING worker route app/api/discover/run/route.ts. Each POST does ONE bounded slice (discovering | one pipeline batch of 5 | pruning), advances cursor, updates stats jsonb + heartbeat_at, then re-triggers the next slice via next/server `after(() => fetch(self))`. startDiscoveryJob (server action) creates the row + kicks slice 1 and returns instantly; the browser is free to close. cancelDiscoveryJob sets status=cancelled → the next slice's top-of-handler guard halts the chain. getActiveJobForIcp resumes the live view on reopen; the client just POLLS getDiscoveryJob every 3s. A daily janitor cron fails jobs with a stale heartbeat (>5min = dead chain). The worker wraps runAllSources in try/catch so the 504 throw is treated like a timeout (fall back to getRawProspectIds).
KEY INSIGHT (the non-obvious bit): the whole pipeline (runAllSources/processSingleProspect/pruneRunToTop30 and their scrape/score/research sub-actions) authenticates via cookie-based requireUser(). A bare server-to-server fetch has no session, which would have forced a huge session-less refactor of the core pipeline. AVOIDED IT by FORWARDING the user's session cookie on every self-invocation (read cookies() in the start action, pass as the `cookie` header; the worker forwards req.headers.get("cookie") onward). requireUser()/auth.uid() RLS then work unchanged across the entire chain. Only the janitor (no user) uses the service-role key.
GOTCHA: fire-and-forget fetch in serverless can be dropped if the function returns before the request is sent — use next/server `after()` (Next 16, stable) to guarantee the trigger fires post-response. Self-address via VERCEL_URL (preview chains to preview, prod to prod), fall back to NEXT_PUBLIC_APP_URL / localhost:3100 in dev. This project is on the DAILY-cron tier, so a cron-drained queue would stall until the next day — self-chaining is the right pattern here, the cron is only a janitor.
RULE: long multi-step work that must survive the tab MUST be orchestrated server-side, not in a React handler. On Vercel without sub-daily crons, self-chain bounded slices via after()+fetch, persist progress + a heartbeat, guard each slice on a cancellable status, and forward the session cookie to keep cookie-auth pipelines working without a session-less rewrite.
TAGS: #build #discovery #background-job #self-chaining #after #cookie-forwarding #vercel #sentry #504 #rls
VERIFIED LOCALLY (2026-06-24, dev :3100, migration 0023 applied): start returns instantly; worker authed via forwarded cookie (200, not 401); self-chain confirmed in logs — discovery slice (POST /api/discover/run 200 in ~36s) → pipeline batch (200 in ~67s for 5 prospects) → next batch, no browser involvement; Stop (cancelDiscoveryJob) halted the chain on the next slice's guard; origin stayed on :3100 (request-derived, NOT NEXT_PUBLIC_APP_URL which was the wrong :3000). NOTE: a 5-prospect batch took 67s — comfortably under the 120s maxDuration, but if research slows, drop BATCH from 5→3.
FOLLOW-UP (Pedro): stopping a run keeps the inserted raw prospects + offers "Run pipeline" — good — but he also wanted the option to DISCARD them. Added discardRawProspects(icpId) (deletes only status='raw', tenant-scoped) + a Discard button beside Run pipeline in the recovery banner.
DISCARD GOTCHA + lesson: Pedro reported "Discard just hid the banner, prospects still on /companies." Looked like a broken delete; it WASN'T. Diagnostic logging proved the delete works (status breakdown {raw:147} → deleted 147). Root cause was a WRONG-ICP confusion: his first two Discard clicks were on ICPs with 0 raw prospects (the dropdown was on a different ICP than the one whose companies he was viewing), and handleDiscard cleared the banner regardless of deleted count → looked like it "worked" but deleted nothing. The companies he saw belonged to a third ICP; discarding THAT one removed all 147. FIX: surface the deleted count in the UI ("Discarded N raw prospects." / "No raw prospects to discard for this ICP.") so a 0-delete is never mistaken for success. LESSON: a mutation that clears UI state unconditionally on ok:true hides a 0-row no-op — always echo the affected-row count back to the user. Also: /companies has NO default status filter, so it shows raw+pipelined together — "still showing" ≠ "delete failed".
STATUS: built + fully verified locally (self-chain, stop, resume, discard with count feedback); diagnostics removed; typecheck+lint clean. Pending deploy approval.

---

[2026-06-24] BUILD/FIX: Gary now fills google_places_types + the reachable-pool preview is wired (was a stub since inception)
(1) GARY: left google_places_types empty for a B2B/services ICP. The prompt said "only when physical/local; leave [] for online/DTC" — Gary read "B2B services" as non-local. Broadened the guidance: FILL places types for any business findable on Maps (professional services lawyer/accounting/real_estate; health gym/spa/dentist; trades plumber/electrician; food; retail), mapping business_types→canonical GOOGLE_PLACES_TYPES; leave [] only for pure online/DTC. Verified: Gary returned gym/spa/beauty_salon/hair_care.
(2) PREVIEW POOL: the "Preview pool" button in components/icp/icp-edit-drawer.tsx had been a stub (`/* wired when Places key lands */`) even though GOOGLE_PLACES_API_KEY is set. Wired it: new lib/icp/places-preview.ts previewIcpReachablePool(icpId) reuses the existing Google Places text-search client (lib/discover/sources/google-places.ts), runs a CAPPED sample (≤9 queries = ≤3 types × ≤3 regions, ~$0.03/call) across the ICP's places-types × geo-regions, dedupes by domain, persists reachable_pool_count + reachable_pool_computed_at, and the button shows "~N found in a quick sample". Google Places Text Search returns no true total, so it's an honest SAMPLE estimate, labelled as such. Verified live: ~118 found.
RULE: when a prompt enumerates an exclusion ("leave [] for X"), make sure it doesn't accidentally swallow valid cases (B2B services ARE local) — give positive inclusion examples, not just the exclusion. And: a stubbed button is a silent dead-end — when an integration's key lands, grep for `/* wired when ... */`-style placeholders and finish them. Label estimates as estimates when the API can't give a true total.
TAGS: #build #icp #gary #google-places #preview #prompt

---

[2026-06-24] LESSON: drawer scroll needed min-h-0 (moving content to the body wasn't enough); and Gary chip de-dup must be comma-safe
SCROLL: moving the AI panels from DrawerHeader into DrawerBody (prior fix) did NOT make it scroll — the real root cause was the classic flex trap: DrawerBody was `flex-1 overflow-y-auto` WITHOUT `min-h-0`, so the flex child grew to its content height and overflow-y-auto never engaged. Added `min-h-0` to DrawerBody (components/ui/drawer.tsx) → genuinely scrollable (verified: scrollHeight 2117 > clientHeight 606). My earlier scrollIntoViewIfNeeded() test was a FALSE POSITIVE — it can scroll an outer container / report success even when the user can't wheel-scroll the intended one. Verify scroll by measuring scrollHeight vs clientHeight + setting scrollTop, not scrollIntoViewIfNeeded.
DUPLICATE: clicking a Gary suggestion twice duplicated it. My first toggle de-duped by splitting the answer on "," — but suggestions CONTAIN commas (e.g. "Ontario (Toronto/Ottawa) — …hub, underserved…"), so the split shredded the label and the containment check failed → re-added. Fixed with SUBSTRING containment (answer.includes(s)) + remove via replace, comma-safe. Verified: click→len 84, click→0, click→84 (not 168).
RULE: (1) any `overflow-y-auto` flex child needs `min-h-0` or it won't scroll — and don't trust scrollIntoViewIfNeeded to prove scrollability. (2) Never use a delimiter to join/split user-facing strings that can themselves contain that delimiter — match by containment, or track selections in separate state.
TAGS: #lesson #ux #drawer #scroll #flexbox #min-h-0 #gary #toggle

---

[2026-06-24] LESSON: Gary's questions were unreachable — the AI panel lived in the drawer's fixed (non-scrolling) header
SYMPTOM (Pedro): testing Gary, couldn't scroll to see the rest of the questions / the "Send to Gary" button.
ROOT CAUSE: in components/icp/icp-edit-drawer.tsx the describe box + Gary wizard + refine panel were rendered inside <DrawerHeader>. DrawerHeader is a plain div with no overflow handling; only <DrawerBody> is `flex-1 overflow-y-auto`. A long Gary conversation expanded the header past the viewport and its overflow was simply clipped — no scroll.
FIX: moved all the AI helper blocks (describe/suggest, GaryWizard, suggestNote, RefinePanel) out of DrawerHeader into the top of DrawerBody, above the form. Header keeps only title + description. Verified live: the Send-to-Gary button scrolls into view.
RULE: only put fixed, short content in a drawer/modal HEADER — anything that can grow (a conversation, a dynamic list, an expanding panel) belongs in the scrollable body, or it gets clipped with no way to reach it. When adding dynamic UI to a drawer, test it at its TALLEST state in a short viewport.
TAGS: #lesson #ux #drawer #scroll #gary #icp

---

[2026-06-24] LESSON: pitch showed "no contact email" though the prospect had one — stale pitch.contact_id FK
SYMPTOM (Pedro): a queued pitch (Inside Out Total Wellness) showed "no contact email — pick one on the prospect page" even though the prospect has a contact.
ROOT CAUSE: a pitch freezes contact_id at GENERATION time. Both the display (lib/pitches/queries.ts) and the send (lib/pitches/send-action.ts) resolved the recipient via `prospect_contacts:contact_id(email)` — the frozen FK. If the contact was found AFTER generation (re-enrich, the masking fix) or the frozen row was name-only/placeholder, the FK is stale → reads as "no contact" while the prospect actually has one. generatePitch also picked contact_id via priority_rank LIMIT 1 with no usability filter, so it could freeze a null-email row.
FIX: resolve the prospect's CURRENT top usable contact, not the frozen FK. New lib/pitches/contacts.ts: pickTopUsableContact(list) (pure) + fetchTopUsableContact(supabase,...). listPitches/getPitch now embed prospects→prospect_contacts and show the top usable; send-action uses the FK only if usable, else falls back to fetchTopUsableContact and re-links contact_id on send; generatePitch links contact_id to the top usable. Verified live: the warning is gone, pitch shows the real email.
RULE: a foreign key captured at creation time is a SNAPSHOT, not live truth — if the referenced thing can change afterward (a prospect gaining/losing contacts), resolve it live at read/use time (with the FK as a hint), or you'll show/act on stale data. Especially for anything that gates an action (sending) or a UI state (reachability).
TAGS: #lesson #pitches #contacts #stale-fk #send #queries

---

[2026-06-24] LESSON: /companies kept showing "approved" + cluttering the main view for pitches already queued/sent
SYMPTOM (Pedro): rows whose pitches were queued-to-send or already sent still showed the "approved" chip and stayed in the default /companies list — main view should be PENDING only, with sent/queued in their own filters.
ROOT CAUSE: derivePitchStatus (prospects-queries.ts) had no scheduled_send_at awareness, so a queued pitch (approved + scheduled) derived as "approved"; and its priority returned approved/queued-for-approval before "sent". The /companies default view excluded only pitch_status==="sent", not queued-to-send. There were no filters for queued/sent.
FIX: derivePitchStatus now selects the MOST-ADVANCED state (sent > queued_to_send > approved > queued_for_approval) and reads scheduled_send_at (added to the pitches select). pitch_status type gained "queued_to_send". /companies: ALL view now also excludes pitch_status "queued_to_send"; added "Queued to send" + "Sent" filter options (pitch-derived, handled before the prospect.status check); added a blue "queued to send" chip and relabeled the approval-queue chip to "queued for approval" to disambiguate. Verified live: ALL=5 pending, Sent=9, Queued-to-send=6.
RULE: a derived "pitch stage" must reflect the FURTHEST state a prospect has reached (don't return an earlier stage when a later one exists), and any "active working list" default view must exclude every terminal/in-flight stage (sent AND queued), not just one — give each excluded stage its own filter so nothing is hidden, just relocated. Two different "queued" concepts (queued-for-approval vs queued-to-send) need distinct labels.
TAGS: #lesson #companies #pitches #pitch-status #filters #ux

---

[2026-06-24] BUILD: dashboard "Pipeline at a glance" now includes Queued-to-send + Sent
WHAT (Pedro): the glance strip only had prospect-status stages (raw→researched→pitched→replied→booked→won→lost); add Queued-to-send + Sent so sending progress is visible. Added getSendStageCounts (lib/today/queries.ts) — PITCH-derived (sending never changes prospect.status), counting DISTINCT prospects: queued_to_send = approved+scheduled & not sent; sent = has a sent pitch. Strip now 9 stages (raw, researched, pitched, queued, sent, replied, booked, won, lost); the two send stages link to /pitches (the prospect-status filter doesn't cover them).
KEY: kept send counts in a SEPARATE `stageCounts` object, NOT merged into `statusCounts` — because totalProspects = sum(statusCounts) drives "N prospects in pipeline" + the In-Pipeline stat card, and adding pitch-derived keys there would double-count.
RULE: when a UI strip mixes counts from two sources (prospect.status + pitch-derived), keep the source used for a TOTAL separate from the display-only superset, or the total inflates. Send/queue stages are pitch-level facts, not prospect statuses — derive them from pitches, count distinct prospects to match the strip's unit.
TAGS: #build #dashboard #pipeline #pitches #sending #counts

---

[2026-06-23] LESSON: "Queue N for send" button still said "Queue 10" after queuing — queued state had no representation + no visibility
SYMPTOM (Pedro): queued 10, toast said queued, but the button still read "Queue 10 for send" (confusing, double-send risk); also no way to SEE queued emails or watch them move queued→sent.
ROOT CAUSE: queueApprovedForSend sets scheduled_send_at (+ sender_inbox_id, queued_at) but leaves status='approved' (the drip cron flips it to 'sent' later). There is NO distinct "queued for send" status. The button counted counts.approved = all status='approved' (ignoring scheduled_send_at), so queued pitches kept counting → button never changed even after router.refresh(). And the list had no view for them.
FIX: model "queued for send" as a DERIVED state = status 'approved' AND scheduled_send_at set. getPitchCounts now splits: approved = approved & NOT scheduled (ready to queue, what the button acts on), queuedForSend = approved & scheduled. Added scheduled_send_at to PitchListRow/PitchDetail. The button uses the ready count → drops to 0 after queuing → hides. Added a "Queued to send" header count, a filter view, and a derived "Queued to send" chip (pitchMeta) so they're visually distinct; when the cron sends, status→sent and they move to the Sent view. Verified live: header "0 approved · 10 queued to send", button gone, filter shows the 10 with chips.
RULE: when an action moves an item into an intermediate state, that state needs (a) a representation the UI can query (a status OR a derived predicate on a column), and (b) a place to SEE it. A button whose count includes items it already acted on will always look like it did nothing. If you can't add an enum value cheaply, derive the state from an existing column (scheduled_send_at) and split your counts/filters on it consistently.
TAGS: #lesson #pitches #sending #queue #ux #state-modeling

---

[2026-06-23] LESSON: pitch generated for a no-contact prospect — no gate in generatePitch + inconsistent "has contact" definitions
SYMPTOM (Pedro): a pitch got generated for a prospect with no contact; it also should have shown the "no contact" tag but didn't.
ROOT CAUSE (two): (1) generatePitch had NO contact gate — it looked up the top contact, set contact_id=null if none, and inserted the pitch anyway. The pipeline pre-gated, but the manual "Generate pitch" button (and any direct caller) bypassed it → unsendable drafts. (2) "has a contact" was defined THREE different ways: the badge used `some(c => !!c.email)` (a whitespace/placeholder email counts), bulk used `c.email && c.email.trim()`, getTopContact filtered only null/"". So a junk/placeholder contact row hid the no-contact badge AND passed as a contact.
FIX: one shared predicate `hasUsableEmail(email)` in lib/research/email-utils.ts (non-empty + well-formed + not a known placeholder local/domain). Now used by: the no-contact badge (prospects-queries has_contact), the bulk pre-filter, getTopContact (returns first USABLE of the top-8 by priority), AND a new GATE in generatePitch that returns ok:false "No contact email — find or add a contact before generating a pitch." before any Claude call. The detail handler already surfaces res.error as a warn toast. role-based info@ is still USABLE (sends with the forward ask) — only null/empty/placeholder is blocked. Verified hasUsableEmail unit-wise (info@…→usable; ""/null/whitespace/user@domain.com/test@example.com/a@b→blocked).
RULE: a gate and its corresponding UI signal MUST share one predicate, or the UI says "ok to act" while the action shouldn't (or vice-versa). When several places ask "does X qualify?", extract ONE function and call it everywhere. And: an action that produces something un-actionable downstream (an unsendable pitch) must refuse at the source, not just rely on callers pre-filtering — defense in depth.
TAGS: #lesson #pitches #contacts #gate #consistency #has-contact

---

[2026-06-23] LESSON: re-enrich reported "Found info@…" but the Overview showed no contact — getTopContact lacked the null-email filter the report had
SYMPTOM (Pedro, Bedrock Construction): clicked re-enrich → toast "Found: info@bedrockconstructionltd.com (scraper)", but the Overview contact-email line stayed empty → "wasting research". (The "(scraper)" tells you it was a PRE-EXISTING scraped contact, not a new find — the waterfall inserts as snapverify/anymail/hunter, never "scraper".)
ROOT CAUSE: asymmetric queries. The re-enrich report (reEnrichProspectContacts) selected the top contact with `.not("email","is",null)`, so it skipped any name-only row and surfaced the real info@. But getTopContact (detail-queries.ts — what the Overview reads) ordered by priority_rank LIMIT 1 with NO null filter, so a higher-priority name-only contact (email null, e.g. from people-intel) masked the deliverable info@ below it → returned null → "no contact". Report found it, Overview didn't.
FIX: getTopContact now filters `.not("email","is",null").neq("email","")` so it returns the top row that actually HAS an email — aligned with the report. Verified live: Bedrock's Overview now shows info@bedrockconstructionltd.com, no-contact warning gone. Also re-derive is_role_based from the address there (like the composer's pitch-time net) so the role warning is honest even on legacy/scraper rows with a stale flag.
RULE: when two code paths answer the same question ("what's this prospect's contact?"), they must use the SAME filters or they diverge — one says "found", the other says "none". A LIMIT 1 ordered query must filter out rows missing the very field you're selecting, or a higher-priority empty row masks a real one. This likely un-masks contacts across MANY prospects, not just Bedrock.
TAGS: #lesson #contacts #overview #query-asymmetry #enrichment #masking

---

[2026-06-23] BUILD: bulk "Generate pitches" on /companies + fixed a hidden bulk-toast bug
WHAT: new bulkGeneratePitches action (lib/discover/bulk-actions.ts) + a "Generate pitches" button on the /companies bulk bar — draft pitches for several selected prospects at once instead of 1-by-1. Pre-filters the selection: skips no-contact prospects (can't send) and ones already past drafting (sent/replied/booked/won/lost/ghosted/bounced), with per-reason counts in the toast. Composes in concurrent chunks of 5, capped at 10/batch to fit the 60s Vercel function budget. Reuses generatePitch(id, {user, supabase}) with the injected user+client so it doesn't re-auth inside the nested server-action chain.
BUG FOUND + FIXED (pre-existing, affected ALL bulk actions): the success toast was rendered INSIDE the `{selected.size > 0 ? (...bar...) : null}` block. On success every bulk handler calls setSelected(new Set()), which unmounts the bar — and the toast with it — so success toasts were never visible (only failures, which don't clear the selection, showed). Moved the toast OUTSIDE the selection-gated bar so it persists its full timeout. Verified: "Drafted 4 pitches. Review on /pitches." now shows.
RULE: never render a transient status/toast inside a block that the same action conditionally unmounts. A toast must outlive the UI that triggered it — render it at a stable level, gated only on its own state. When adding a bulk action, test the SUCCESS path's toast, not just the failure path (failure often doesn't clear selection, masking the bug).
TAGS: #build #pitches #bulk #companies #toast #ux #server-actions

---

[2026-06-23] LESSON: role-based contacts (info@…) weren't flagged → pitch skipped the "please forward" line
SYMPTOM (Pedro): researched contacts like info@greenstoneconstruction.ca were stored but very few tripped the role-based alert, so the composer didn't add the "if you're not the right person, I'd appreciate a forward" line.
ROOT CAUSE (two bugs): (1) MULTIPLE contact-insert paths hardcoded `email_is_role_based: false` and never ran the detector — lib/discover/enrich-contacts.ts (Anymail + Hunter + SnapVerify + catch-all), lib/discover/pipeline-action.ts (SnapVerify), lib/prospects/detail-actions.ts (manual). Hunter's domain sweep in particular returns info@/contact@ constantly, all stored as NOT role-based. (2) lib/research/structured-research-action.ts had a DUPLICATE local copy of isRoleBasedEmail (drift risk) instead of the canonical lib/research/email-utils.ts. The canonical detector DID include "info", so the flag would have been correct IF it had been called — the bug was the call sites bypassing it, not the list.
FIX: (a) broadened + hardened the canonical isRoleBasedEmail — more EN tokens + Spanish (ventas/contacto/informacion/soporte… for MX) + separator-prefix forms (info.calgary@, ventas-mx@, contact_us@) + compact normalization (customer.service → customerservice). (b) Every insert path now calls it and sets priority_rank=5 for role inboxes so a personal address always outranks them. (c) Deleted the duplicate detector; structured-research now imports the canonical one. (d) SAFETY NET: generatePitch + rewritePitchWithAngle re-derive role-based from the email at pitch-build time (`stored || isRoleBasedEmail(email)`), so EXISTING contacts with a stale false flag still get the forward line without re-enrichment. Verified: info@greenstoneconstruction.ca → ROLE; darren@bvsfitness.ca → personal.
RULE: a derived boolean (role-based) must be computed at EVERY insertion site or it silently defaults wrong — centralize the helper and call it everywhere; never hardcode the default. When the value drives downstream behavior (the forward line), also re-derive defensively at consumption time so legacy rows self-heal. And: one canonical detector — grep for duplicate local copies (they drift).
TAGS: #lesson #contacts #role-based #pitches #enrichment #hunter #dedup

---

[2026-06-23] LESSON: pitch fell back to heuristic — "Unterminated string in JSON" — Claude's output was TRUNCATED at max_tokens
SYMPTOM (Pedro, Wildcard Fitness): "Draft pitch ready (self-score 35%, heuristic). ... parse: JSON parse failed: Unterminated string in JSON at position 2165". The raw response was a valid-looking ```json {...} that just stopped mid-string.
ROOT CAUSE: the Stage-2 composer call (lib/pitches/claude-composer.ts) had `max_tokens: 600`. Position ~2165 chars ≈ 600 tokens — the model hit the output cap and the JSON string was cut off before its closing quote → JSON.parse throws "Unterminated string" → structuredCall returns reason:"parse" → generatePitch falls back to the industry template. The earlier capability/CTA prompt work made the email body + the reasoning field longer, so 600 tokens (fine before) now overflows intermittently — depends on how verbose Claude is for a given prospect (Wildcard hit it, others didn't).
FIX: raised max_tokens 600 → 1200 (body ≤2000 chars + preview + reasoning ≤800 + CTA easily exceed 600 tokens) and added timeoutMs: 35_000 to the composer call (a larger response takes longer; the 20s default risked a timeout→heuristic fallback). Both stay well under the 60s app/** Vercel budget. Verified live: rewrite composed a clean 1201-char body, ends cleanly, 👉 intact.
RULE: when an LLM returns JSON, max_tokens must comfortably exceed the WORST-CASE serialized size of ALL fields (sum the schema's string maxes), not the typical case — an under-cap is a silent, intermittent truncation that looks like a parse bug. Re-check max_tokens whenever you make a structured-output prompt produce longer fields. Pair a bigger max_tokens with a bigger timeout (more tokens = more wall-clock).
TAGS: #lesson #pitches #claude #max-tokens #json #truncation #fallback

---

[2026-06-23] LESSON: the pitch daily-send counter never reset — yesterday's sends carried over forever
SYMPTOM (Pedro): "sent 3 yesterday, the send panel still shows 3/30 today — shouldn't it reset?"
ROOT CAUSE: `sender_inboxes.sends_today` is incremented on every send in THREE places (lib/pitches/send-action.ts manual send, app/api/pitches/send-queue drip cron, app/api/pitches/follow-up cron) but was NEVER reset. The table has had a `last_reset_date` column since migration 0001 — clearly intended for a daily reset — but nothing ever read or wrote it. So the counter just accumulated since inbox creation.
FIX (no migration, no reset cron — self-healing): new pure helper lib/pitches/daily-cap.ts — `effectiveSendsToday(sends_today, last_reset_date)` returns 0 when last_reset_date isn't today (UTC, matching the send crons), and `bumpSendsTodayPayload(...)` returns {sends_today: effective+1, last_reset_date: today, last_send_at: now}. Wired into all FOUR sites: the display query (lib/settings/sending-queries.ts listSenderInboxes), the manual send cap+increment, the drip cron, and the follow-up cron. The stale DB row self-corrects on the first read/send of a new day — no backfill needed. Verified live: panel now shows 0/30.
WHY UTC: the send crons in vercel.json run on UTC, so the day boundary matches them. (Trade-off: resets ~6pm local for MX/CA — acceptable and consistent; revisit if Pedro wants local-midnight.)
RULE: any "X today" counter MUST ship with its reset logic in the same change — a bare incrementing counter with no reset is a latent bug that only surfaces on day 2. Prefer self-healing (date-stamped effective count) over a reset cron (which can misfire). If a `last_reset_date`-style column already exists, it's a signal the reset was designed but never wired — wire it. And: N separate increment sites must share ONE reset helper or they drift.
TAGS: #lesson #pitches #sending #daily-cap #counter #reset #warmup

---

[2026-06-23] LESSON: changing the CTA copy broke the email button — the 👉→button parser assumed the URL was at the END of the line
SYMPTOM (Pedro): after the new conversational CTA shipped, the email button disappeared and showed a raw URL instead.
ROOT CAUSE: both CTA renderers — `buildHtmlBody` (lib/gmail/client.ts, the SENT email) and `EmailBodyPreview` (components/pitches/pitches-page.tsx, the on-screen preview) — extracted the link with an END-ANCHORED regex `/https?:\/\/\S+$/`. The old CTA put the URL last ("...audit, no signup: {url}"). The new conversational CTA puts the URL MID-sentence with text after it ("...no strings: {url}. See something worth fixing? Reach out..."), so the `$` match failed → no URL → fell through to rendering the raw line.
FIX: match the URL ANYWHERE (`/https?:\/\/\S+/`), strip trailing sentence punctuation the greedy `\S+` swallows (the "." after "?market=ca"), then SPLIT the line at the URL into before/after and render: lead-in <p> → button → closer <p> (the "reach out / no harm done" line now sits under the button — nicer layout). Applied to BOTH renderers + synced the button-label helper (deriveButtonText / deriveButtonLabel) and the preview button colour to brand purple #775cbf.
RULE: when you change a copy/prompt FORMAT, grep for every downstream parser that relied on the old shape. A 👉/URL→button convention had TWO implementations (sent email + preview) that must stay in sync — a format assumption (URL-at-end) silently breaks rendering when the copy evolves. Prefer "extract from anywhere + split" over end-anchored matches for human-authored lines.
TAGS: #lesson #pitches #cta #email #html #parser #gmail #preview

---

[2026-06-23] LESSON: every pitch ended with the SAME CTA line — LLM was copying the first example format verbatim
SYMPTOM (Pedro): every email closed with "See exactly where {company} is losing revenue, free 30-second audit, no signup" — identical, salesy, generic. He wanted it low-pressure + self-serve ("don't sell fluff — run the audit yourself, see for yourself, reach out only if you want, no harm done") AND tailored to what each specific pitch is about.
ROOT CAUSE: the CTA section of claude-composer.ts gave 2-3 concrete "use a format like" examples. The model anchored hard on example #1 and reproduced it nearly verbatim every time — example formats in a prompt become de-facto templates.
FIX: replaced the example formats with (1) a PHILOSOPHY (low-pressure, self-serve, "run it yourself and see", reply only if useful, no harm if not), (2) a mandate to WRITE FRESH and tailor the CTA to THE SPECIFIC PAIN this email leads with (so it varies by angle), (3) tone DIRECTIONS explicitly labelled "show the vibe, do NOT copy verbatim", and (4) an explicit "vary the OPENING — don't start every CTA the same way" nudge. Kept the mandatory leading 👉 (it's the marker lib/gmail/client.ts uses to render the CTA as the HTML email button — do NOT remove it). Applied to both EN + ES voice rules. Verified live: two rewrites produced different openings + pain-specific bodies.
RULE: To get VARIED LLM copy, give philosophy + constraints + explicitly-labelled "directions", never concrete "use a format like X" examples — the model treats examples as templates and reproduces them. If a fixed token must stay for downstream parsing (like 👉 for the email-button renderer), say so in the prompt so creativity doesn't drop it.
TAGS: #lesson #pitches #cta #llm-prompting #variety #claude

---

[2026-06-23] BUILD: Pitch angle advisor → POST-generation rewrite tool + composer formula fixed (capability-led, cases not forced)
PEDRO'S DIRECTION: (1) the angle advisor was pre-generation + purely informational (did nothing) — it should fire AFTER the pitch exists, suggest angles, and on click REWRITE the pitch with the chosen angle. (2) Fix the generate-pitch formula to lead with Runna's strengths (AI, design, dashboards, automation, video) and stop forcing success cases.
BUILT:
- Removed the advisor from prospect-detail (pre-gen slot). On /pitches PitchDetail each suggested angle now has a "Rewrite with this angle" button → new action `rewritePitchWithAngle` (lib/pitches/actions.ts): re-composes the EXISTING pitch led by the chosen angle (its pain + that case ONLY if chosen, else capability-led), writes to body_edited (preserves body_original), refreshes the body via a reloadKey on the fetch effect. Claude-only (a template can't honor a specific angle).
- `forced_angle` added to GeneratorInputs; composePitchWithClaude bypasses Stage-1 case selection when forced and injects a REWRITE DIRECTIVE into the Stage-2 prompt.
- Composer system prompt reframed: injects RUNNA_CAPABILITIES; explicit PROOF POLICY — lead with capability + expertise + real in-house builds; cite a case study ONLY when it genuinely fits; capability-proof (option b) is a first-class path, not a weak fallback; never fabricate a specific client/metric/geo. Structure step 5 now offers (a) case bridge OR (b) capability proof.
VERIFIED LIVE: existing pitch rewrote from a booking/conversion angle → an AI-automation capability-led angle ("turn manual admin work into automated systems that run themselves"), no forced case, no fabricated metric. body changed, "✓ Rewrote" confirmation shown.
GOTCHA: supabase-js 2.47 narrowed the new `.update()` payload to `never` again — cast `as never` at the call site (documented quirk). And the advisor's footer copy ("composer is unchanged") went stale the moment behavior changed.
RULE: An "advisor" that can act should act where the artifact lives (the pitch on /pitches), not pre-creation. When you change what a feature DOES, grep its user-facing copy for now-false claims. The pitch composer's proof must be capability-first; case studies are optional evidence, never a required scaffold.
TAGS: #build #pitches #rewrite #composer #capabilities #positioning #supabase-never

---

[2026-06-23] BUILD: Learning Loop PHASE 2a — outcome-learning dashboard (observation only, NO auto-tune)
WHAT: Split Phase 2 (statistical learning) into 2a (build now, no volume needed) + 2b (later, needs volume) — Pedro's call. Built 2a: lib/analytics/outcomes.ts `getOutcomeInsights(tenantId)` aggregates real outcomes BY DIMENSION (ICP, industry, discovery source, city, pain, case study) from prospects + pitches(sent) + active scores(best_pain_id/best_case_study_id). Surfaced as a new "Outcome learning" section on the EXISTING /analytics page (extended it, didn't make a new route — /learning was already taken by the prompt-champion system, /analytics already had lib/analytics/queries.ts with an ICP leaderboard).
KEY DESIGN — honesty via sample-size gating: each row gets a confidence label by SENT count — actionable (≥20), emerging (≥5), insufficient (<5). Reply/book RATES show as "—" until a segment clears 5 sends, so we never display a rate computed from n=1. A gold "Phase 2a · observation only" banner states plainly that nothing changes targeting/scoring and that Phase 2b reweighting is gated on this volume. Verified live: real data showed 3 sent / 1 replied, every segment correctly "—" + N<5.
WHY THE SPLIT MATTERS: reply funnel shipped the same day → ~0 outcomes. Building statistical reweighting now would fit noise and could silently degrade scoring (the exact guardrail in learning-loop-spec). 2a starts the flywheel + makes volume visible so 2b switches on only when the numbers are real.
RULE: For any "learning from outcomes" feature, gate every displayed rate on sample size and label confidence explicitly — a rate from n=1 reads as signal and is a lie. Observation-only dashboards must SAY they're observation-only (capturing data ≠ learning). Don't auto-tune scoring/targeting on thin outcome data. Extend the existing analytics surface rather than spawning a parallel route.
TAGS: #build #learning-loop #phase2 #analytics #outcomes #confidence #guardrails

---

[2026-06-23] BUILD: In-house DMARC aggregate-report ingestion (low-volume deliverability layer)
WHAT: New layer that reads RFC 7489 DMARC aggregate reports straight out of pedro@runnareach.com (where they ALREADY arrive — _dmarc.runnareach.com publishes rua=mailto:pedro@runnareach.com) via the SAME Gmail OAuth token we use for the reply funnel. No DNS change, no external account (Postmaster shows nothing until high volume; this works from email #1). Files:
- Migration 0022_dmarc_reports.sql — dmarc_reports (UNIQUE (tenant_id, report_id) dedupe) + dmarc_report_records (per-source rows, dmarc_pass = (dkim eval=pass) OR (spf eval=pass)). MUST be applied by hand to ybbrpqzbedaxsmotgtkh (MCP points at SnapPad).
- lib/warmup/dmarc-reports.ts — Gmail messages.list (has:attachment + subject/filename filter) -> attachments.get -> decompress (node:zlib for .gz; a minimal central-directory reader for the zip case, NO new dep) -> parse with fast-xml-parser (added dep; asArray() coerces single-vs-many <record>) -> upsert deduped by report_id.
- lib/warmup/dmarc-summary.ts — read-side: % messages aligned + TWO separate abuse lists (Pedro's call): failed-BOTH-alignment IPs (spoofing) and non-Google IPs. Google ranges resolved LIVE from _spf.google.com (include: recursion -> ip4/ip6 CIDRs, BigInt mask compare, 6h module cache) so no hand-maintained CIDR list drifts; if resolution fails we SKIP the non-Google list rather than false-flag.
- app/api/warmup/dmarc-sync/route.ts — daily cron (0 9 * * *), CRON_SECRET auth + Sentry withMonitor (checkinMargin 30 per the Hobby-cron lesson), dedupes mailbox by (tenant,email). vercel.json maxDuration 120.
- warmup-dashboard.tsx DmarcPanel inside the existing Deliverability Health card; warmup/page.tsx sources getDmarcSummary best-effort (never blocks the page).
VERIFY-THEN-BUILD held: parsed a real RFC 7489 sample (spoof source -> dmarc_pass:false) AND ran getDmarcSummary against live _spf.google.com — Google IP 209.85.220.41 correctly authorized, spoof IP 45.137.22.10 correctly in BOTH lists, 72.7% pass. tsc + eslint + build all clean.
RULE: Reports that arrive as compressed XML email attachments are ingestable with zero new infra when we already hold the mailbox's OAuth token — list+get+attachments.get+zlib+fast-xml-parser. Never regex nested XML; coerce single-child to array. When flagging "unauthorized sender" against a provider's IP ranges, resolve the ranges live from their SPF record (cached) instead of hardcoding CIDRs, and fail OPEN (skip the flag) if resolution fails so you never false-accuse. Reuses the same Gmail-OAuth-mailbox pattern as lib/gmail/read.ts; complements (does not duplicate) the pure-DNS lib/warmup/deliverability.ts.
TAGS: #build #warmup #dmarc #deliverability #gmail #cron #xml #spf #migration

---

[2026-06-23] PEDRO_DIRECTIVE: "All of Pedro's doings are Runna's doings" — his in-house builds ARE Runna's citeable AI portfolio; fold them into the capability grounding
WHAT: Pedro's own products are Runna proof points usable as examples/references on pitches + as knowledge for Gary. Logged into lib/runna/capabilities.ts (single source of truth feeding Gary + the pitch angle advisor):
- AI PRODUCTS: Daily Briefings (crawls email/Slack → AM brief "what's up today" + PM brief "what to prep tomorrow"); Barcode Studio; S.P.A.M (this self-learning prospecting platform); SnapPad Command Center + its tools (dealer heatmap, analytics dashboard, project tracker, MatchBot).
- UNLIMITED DESIGN: strong in-house graphic design dept groomed across outdoors, automotive, food delivery, food & beverage, retail, fitness, manufacturing & more.
- CONTENT PRODUCTION: 2 dedicated studios + 100+ talents (actors) for video ads / content at scale.
WHY IT MATTERS: these real builds prove the AI/automation/dashboard capability without needing an external client case study — directly supports the 2026-06-23 "capability + expertise as proof, not caged to case studies" override.
RULE: Runna's portfolio for grounding lives in lib/runna/capabilities.ts. When Pedro ships a new product or the design/content dept gains a vertical, ADD it there — it propagates to every LLM advisor at once. Still never fabricate specific metrics for these builds; name them + describe the capability they prove.
TAGS: #directive #runna #capabilities #portfolio #gary #pitches #positioning

---

[2026-06-23] PEDRO_OVERRIDE: Gary + the pitch advisor were over-anchored to specific case studies — Runna's pitch is the whole CAPABILITY (AI, optimization, dashboards, asset/video production), with case studies as bonus proof, not a requirement
PEDRO'S INSIGHT: "Although using Runna's success stories is good when they apply, I don't want Gary constrained to them. We're pushing the whole AI side, optimizations, dashboards, ways to improve companies, asset creation, video ad production — that applies to anyone — and use our years of expertise as proof of concept; not always needs a specific success case tied in."
WHY HE WAS RIGHT: My v1 grounding rule for Gary said "use ONLY the services + case studies provided", and the pitch angle advisor labelled any case-less angle "no proven case — pitch carefully / pair with a stronger angle". Both conflated "we have a case study for this" with "Runna can credibly help here". That artificially caged targeting to a handful of case-study industries and made strong capability-led angles (AI automation, custom dashboards, video production) read as weak — the opposite of the actual go-to-market.
FIX: (1) New single source of truth lib/runna/capabilities.ts (RUNNA_CAPABILITIES) describing the full toolkit + the framing "expertise IS proof; a case study is a bonus when it fits". (2) Gary's system prompt reframed: reason freely about capabilities, NOT limited to case-study industries; case studies are proof points used WHEN they fit. (3) Pitch angle advisor: a case-less angle with decent pain confidence is now "moderate" (capability-led), not "exploratory"; deterministic + Haiku rationales frame it via capability + expertise; Haiku also returns a `capability` to surface; UI chip changed from "no proven case" → "capability + expertise". Verified live: Gary confidently proposed "US Manufacturing & Industrial B2B – AI + Ops Automation" (zero case-study coverage) and the advisor reframed a case-less fitness-retention angle as moderate/capability-led.
THE ONE HARD LINE STAYS: never fabricate a SPECIFIC client name, metric, or geography (the El Club lesson). "Speak to general capability + years of expertise" = encouraged; "invent a fake proof point" = forbidden. These are different things — don't over-correct the El Club lesson into "never mention anything without a case study".
RULE: When grounding an LLM for outbound/strategy, ground it in CAPABILITIES + expertise, not just the catalog of proof artifacts. Proof artifacts (case studies, metrics) are deployed when they fit; their absence is not a reason to weaken or omit a legitimate angle. Only fabrication of specific named proof is off-limits.
TAGS: #override #gary #pitches #grounding #capabilities #positioning #claude

---

[2026-06-22] BUILD: "Gary" — guided ICP-building wizard (expert ICP/market-research agent, grounded in Runna data)
WHAT: New conversational ICP builder for CREATE mode. Gary (Sonnet) is grounded in real Runna context — services, case_studies (client/industry/tier/metric), and existing ICP coverage (to avoid duplicating) — asks ≤3 rounds of the highest-leverage questions (clickable suggestion chips), then proposes a complete ICP that POPULATES the drawer form for human review + Save. Never auto-saves. Files: lib/icp/gary-types.ts (client-safe), lib/icp/gary-action.ts (`garyBuildIcpAction`, stateless — client sends the Q&A transcript each turn), components/icp/gary-wizard.tsx, wired into components/icp/icp-edit-drawer.tsx (create mode only).
TWO BUGS HIT DURING BUILD (both already in this file as rules — re-learned by re-living them):
1. Hard Zod `.max()` on LLM output rejected the WHOLE parse. First Gary's `suggestions` strings ran >60 chars → parse fail → infinite "thinking". Then the proposal's `excluded_keywords` array ran >16 items → parse fail. FIX: clip-not-reject everywhere LLM free-text lands — `clipped(n)` = `z.string().max(n*6).transform(s=>s.slice(0,n))` for strings, `clippedArr(len)` = `z.array(...).transform(a=>a.slice(0,len))` for array LENGTH. This is the 2026-05-29 preview_text lesson — applies to array length too, not just string length.
2. structuredCall's client timeout is a hard 20s; Gary's single Sonnet call with a large grounding prompt blew past it → "Request timed out". FIX: added an optional `timeoutMs` to StructuredCallInput + `getClient(timeoutMs)` (lib/anthropic/client.ts); Gary uses 50s (app/** maxDuration is 60s in vercel.json, so 10s headroom). A one-shot call with a big prompt needs its own timeout budget — the 20s default is tuned for the 3-call pitch path, not a single large call.
RULE: When adding any new Claude call, size its timeout to ITS shape (one big call ≠ three small calls) and clip every LLM-authored string AND array to length with `.transform`, never hard `.max`. Verified live: Gary referenced real case studies (Ford, DiDi, El Club, Blues Real, SnapPad) + existing ICP coverage, asked grounded questions, proposed "Canada – Prairie & Atlantic Service Businesses", and the form populated for review (Create ICP still manual).
TAGS: #build #icp #gary #claude #zod #timeout #llm-output #guardrails

---

[2026-06-22] BUILD: Learning Loop PHASE 1 (advisory layer) — ICP Refinement Advisor + Pitch Angle Advisor
WHAT: Built the two PHASE-1 advisors from learning-loop-spec.md (the no-outcome-data half). Both are SUGGEST-ONLY, human-approved, and synthesize data we ALREADY have — zero reply/conversion volume needed.
- ICP Refinement Advisor: `refineIcpFromEvidenceAction(icpId)` added to the EXISTING lib/icp/suggest-action.ts (extends it, per spec — "improve an existing ICP from evidence" vs the old "suggest from a name"). Aggregates prospect_research (pains/tech/what_they_do) + active scores (composite + Claude reasoning) across prospects assigned to the ICP via new read-only module lib/icp/refine-evidence.ts, cross-references Runna strength (case_studies pain_tags + services), and proposes sharper field values via Haiku (structuredCall + Zod) with a deterministic frequency fallback. Surfaced as a "Refine from evidence" panel in components/icp/icp-edit-drawer.tsx (edit mode only) with per-field "Add"/"Set" buttons — never auto-applies; Pedro still hits Save. Gated: needs ≥3 researched prospects or it returns an honest "insufficient data" note.
- Pitch Angle Advisor: lib/pitches/angle-advisor.ts `suggestPitchAnglesAction(prospectId)` ranks pain→case-study→service combos grounded in DB rows; Haiku ONLY phrases/orders pre-resolved combos so it cannot invent a client/metric/service. Read-only card components/pitches/pitch-angle-advisor.tsx surfaced on BOTH prospect detail + pitches page. generatePitch/composePitchWithClaude UNTOUCHED.
GUARDRAILS HELD: hypothesis not validated learning (explicit ⚠ note in every output); suggest-only, no auto-apply; scoring rubric (lib/research/scoring/) NOT tuned on no-outcome data; no new tables/migration (on-demand compute); Haiku for cheap synthesis.
RULE: When extending an advisory/AI feature, keep the SHARED types in a client-safe file with zero server imports (lib/icp/refine-types.ts, lib/pitches/angle-types.ts) — server modules use createClient and would bleed next/headers into the client bundle if a client component imported their types (reinforces the 2026-04-24 RSC-bleed lesson). And: when an LLM references real third-party facts (case studies, metrics), hand it ALREADY-RESOLVED DB values and restrict it to phrasing/ordering — it structurally can't hallucinate what it isn't asked to generate (reinforces the El Club fabrication lesson). PHASE 2 (statistical reweighting by real reply/conversion rates) stays OUT until the reply funnel + volume exist.
TAGS: #build #learning-loop #icp #pitches #advisory #rsc #claude #guardrails

---

[2026-06-22] SESSION RETROSPECTIVE — meta-patterns to carry into future work (long pipeline-hardening + first-real-run session)
1. STATUS/TRIAGE CONSISTENCY IS THE #1 RECURRING BUG (hit 4× this session). Manual buttons, the pipeline, bulk actions, and crons each re-derived state and silently drifted: deep-research didn't suppress, generatePitch didn't set "pitched", bulk re-score didn't enrich, re-score paths didn't un-park suppressed. RULE: an action's defining side-effects (status transition, gate flags, triage) belong INSIDE the action and must be SYMMETRIC (every park has an un-park) and SHARED across callers. When you add a state-changing path, immediately grep sibling paths for the same gap. Orphan status values not in the canonical enum (e.g. "no_match") are a smell — they dodge tone maps, filters, and triage.
2. DIAGNOSE AGAINST LIVE DATA/LOGS BEFORE ASSUMING A BUG OR A FIX. Querying the real DB and pulling `vercel logs --json` repeatedly turned mysteries into one-line fixes (warmup "deadline reached after 0/50" formula went negative at full ramp; "Pitch not found" was a stale `body` column, not a missing row; "no contact" was scraper junk + a role-email gate, not a finding failure). A "{data:null, error}" from a bad column LOOKS identical to "no row" — read error.message.
3. PEDRO IS FREQUENTLY RIGHT ON DOMAIN/STRATEGY CALLS — weight his pushback above first-instinct reasoning, and LEAD with challenge-mode evaluation. His overrides this session were all correct: rubric over-gated service businesses; SnapVerify should keep logical guesses — but then never SEND unverified guesses (deliverability). Hold the deliverability line hard for cold email: a hard bounce on a warmed domain hurts more than a missing contact helps; "no contact" is an honest, safe outcome.
4. VERIFY-THEN-BUILD. Read the real code/markup first (the YP scraper fix needed the live HTML, not a guess); write a throwaway script to validate behavior against real data before claiming a fix (the rubric reframe was proven with a real Claude call: fitness studio 28→82, agency→0).
5. PHASE BIG FEATURES + PIN SPECS. Reply funnel and learning loop were pinned to memory and spawned as dedicated sessions; the learning loop was split (advisory-now / statistical-later) — qualitative synthesis needs no outcome data, statistical optimization needs volume. Don't claim a system "learns" when it only captures data.

---

[2026-06-22] LESSON: Apple Mail overrode the email CTA button's text color (forced blue + underline) despite inline color on the <a>
ROOT CAUSE: The CTA button (buildHtmlBody in lib/gmail/client.ts) set `color:#ffffff; text-decoration:none` on the <a>, but Apple Mail (macOS/iOS) overrides link text color with its accent blue and adds an underline — so the button rendered blue-on-dark, looking broken. Inline color on the anchor itself is NOT respected by Apple Mail for detected links.
FIX: wrap the label in a nested <span> with its own `color:#ffffff; text-decoration:none`. Apple Mail respects the span's color even when it overrides the <a>. Also switched to brand purple (#775cbf) + bigger padding for a polished, intentional look.
RULE: For HTML email buttons, always put the visible text in an inner <span> with explicit color + text-decoration:none — never rely on color set only on the <a>. Test real sends in Apple Mail specifically; it's the strictest about link restyling. (A real cold email to a fitness studio landed in the inbox, not spam — deliverability validated.)
TAGS: #lesson #email #html #apple-mail #cta

[2026-06-22] LESSON: ⛔ Send was 100% broken — send-action selected a `body` column that doesn't exist (it's body_original)
ROOT CAUSE: lib/pitches/send-action.ts selected `id, status, subject, body, body_edited, ...` from `pitches`, but the table has body_original/body_edited/body_sent — NO plain `body` (renamed/split in an earlier migration; send-action never updated). PostgREST errors on a non-existent column, so `pitchErr` was always truthy and EVERY send returned the misleading "Pitch not found." The pitch genuinely existed and was approved — the error message pointed at the wrong thing. Pitch preview/list worked because those queries used the correct columns; only send was stale.
FIX: body → body_original in the PitchRow type, the select string, and the `pitch.body_edited ?? pitch.body_original` fallback.
RULE: After any column rename/split migration, grep ALL queries for the old name — a stale column only errors on the code path that selects it, so it hides until that exact feature is used (here: the actual send, the most important action). And: a "not found" error after a .select() can actually be a bad-column error — the `{ data: null, error }` from a column typo looks identical to "no row". Log/inspect error.message before assuming the row is missing.
TAGS: #lesson #bigfail #pitches #send #supabase #migration

[2026-06-22] PEDRO_OVERRIDE: SnapVerify discarded logical email guesses — its whole point is "owner name + domain → darren@domain, worth a shot"
PEDRO'S INSIGHT: Deep research found owner "Darren Thomson" + domain bvsfitness.ca, but no contact was produced. Pedro: isn't guessing darren@bvsfitness.ca and testing it behind the scenes the WHOLE POINT of SnapVerify? Yes.
WHY HE WAS RIGHT: snap-contact.ts generated the right guesses (firstname@, f.last@, …) and SMTP-verified them, but only KEPT a result if the verdict was a clean "valid" (≥70) OR the domain was Google/Microsoft. Port 25 is very often blocked, and small-biz domains are frequently catch-all — in both cases SMTP can't confirm, so SnapVerify hit its final `found:false` and threw the perfectly logical guess away. So it produced nothing exactly when it should have produced its best guess.
FIX (revised — Pedro tightened the policy: deliverability beats coverage): the final waterfall is SnapVerify SMTP (3 PASSES, rides out greylisting) → defer to Anymail → Hunter (verified finders) → if all fail AND domain is CATCH-ALL, keep firstname@domain flagged (selected_by='snapverify_catchall_guess', priority 4) since catch-all servers accept all mail = it physically can't hard-bounce → else "no contact". REMOVED the old google_workspace_guess / mx_heuristic inserts — those were unverified guesses on NORMAL domains that could hard-bounce and injure the warmed sender. Added a "guess" chip on /companies (contact_is_guess) so a human knows.
WHY NOT REPLICATE ZEROBOUNCE: real SMTP RCPT verification needs outbound port 25, which Vercel + Supabase/Deno edge functions BLOCK (anti-spam). Replicating needs a dedicated VPS with port 25 unblocked + IP-reputation upkeep — not worth it vs ~$0.004/check. 3-pass free probe + verified finders + catch-all-only guess is the pragmatic max.
RULE: never insert an unverified email on a non-catch-all domain — a hard bounce hurts the warmed domain more than a missing contact helps. Inconclusive → defer to verified finders → keep a guess ONLY where it can't bounce (catch-all), flagged. "No contact" is an honest, safe outcome.
TAGS: #override #snapverify #contacts #enrichment #deliverability

[2026-06-22] LESSON: Scraper-sourced junk contacts (placeholder + role-based emails) masked the real "no contact" problem and blocked enrichment
ROOT CAUSE: The website scraper inserts any on-page email as a contact (selected_by="scraper"). Two failure modes surfaced: (1) template placeholder addresses like "user@domain.com" passed isValidEmail (it only checked shape + image extensions) → stored as a real contact → has_contact=true → no "no contact" badge, but useless. (2) Role-based scraper emails (info@, support@, bvsinfo@livunltd.com) satisfied the contact gate, so the paid enrichment waterfall NEVER fired to find a real decision-maker. Net: high scorers looked "reachable" but had garbage or role-only contacts, and enrichment "didn't fire" because a junk contact already existed. Small local gyms also genuinely return nothing from Anymail/Hunter — that's a data limit, not a bug.
FIX: (1) isValidEmail (lib/research/scraper.ts) now rejects placeholder domains (domain.com, example.com, yourdomain.com, …) + placeholder locals. (2) bulk re-score enrichment now triggers when a prospect lacks a PERSONAL (non-role-based) email — a role-only contact still gets an enrichment attempt to upgrade to a decision-maker; pitch-readiness still accepts any deliverable email. Backfilled: deleted 3 user@domain.com contacts + deduped duplicate rows.
RULE: a "contact exists" gate must require a USABLE contact — reject placeholders, and don't let a weak role-based email block the search for a real decision-maker. Validate emails against a placeholder blocklist at the point of insertion, not just shape.
TAGS: #lesson #contacts #scraper #enrichment #email-validation

[2026-06-22] LESSON: (4th occurrence) re-score paths didn't REACTIVATE parked prospects — 82-scorers stuck at "suppressed"/"no_match"
ROOT CAUSE: Same family as the prior status bugs. The triage was asymmetric: paths that score a prospect would SUPPRESS on <40, but the needs_review (40-69) and ≥70-no-contact branches in processSingleProspect only set pitch_gate_passed — they never cleared a stale "suppressed"/"no_match" status. So a prospect auto-suppressed at 32 under the old rubric, re-scored to 82, stayed suppressed/out-of-view. The un-suppress logic existed ONLY in bulkScoreProspects, not the full pipeline. Separately, lib/research/scrape-action.ts sets an ORPHAN status "no_match" (auto-archive when no contact) that isn't in the funnel enum or tone map — and that scrape path also runs PAID Anymail/Hunter during scrape, violating the ≥70-gated-enrichment override. [[needs follow-up: remove/neuter the scrape-action enrichment + no_match path]]
FIX: every needs_review/pitch-failed branch in processSingleProspect now reactivates parked prospects (suppressed/no_match → researched, clearing suppressed fields), guarded so it never downgrades pitched/replied/won. bulkScoreProspects restore now also covers no_match. Backfilled 11 stuck prospects via SQL.
RULE: triage must be SYMMETRIC and SHARED — every path that (re)scores must be able to both park AND un-park, using one set of rules. When you add a "park" transition (suppress/archive), add the inverse in the same change. Orphan status values (not in the canonical enum) are a smell — they slip past tone maps, filters, and triage.
TAGS: #lesson #pipeline #status #triage #consistency

[2026-06-22] LESSON: (3rd occurrence) status transitions lived in the ORCHESTRATOR, not the action — manual buttons skipped them
ROOT CAUSE: generatePitch() inserted the pitch row but never set prospects.status="pitched". The PIPELINE (processSingleProspect) set it as a separate step right after calling generatePitch. So the automated path worked, but the manual "Generate pitch" button on the prospect detail page left Moveology at "researched" with a pitch attached. This is the SAME shape as: (a) deep-research re-scored but didn't suppress <40, (b) bulk re-score didn't enrich/gate. Each time, the side-effect that "completes" an action was written in the orchestrator instead of the action, so non-pipeline callers silently diverged.
FIX: generatePitch now sets status="pitched" + pitch_gate_passed=true itself, guarded by `.in("status", ["raw","researched"])` so regenerating never downgrades a replied/booked/won/lost prospect. Pipeline's own set is now redundant-but-idempotent.
RULE: An action's defining side-effects (status transition, gate flags) belong INSIDE the action, so every caller — pipeline, manual button, bulk, cron — gets identical end-state. The orchestrator should sequence actions, not own their post-conditions. When you find one of these, grep for sibling actions with the same gap (scoreProspect/deepResearch/generatePitch all needed it).
TAGS: #lesson #pipeline #status #consistency #pitches

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

[2026-06-22] LESSON: Standalone "Deep Research" re-scored but never applied the <40 suppress gate
ROOT CAUSE: Two code paths re-score a prospect. processSingleProspect (full pipeline) applies triage: score<40 → status=suppressed. But the standalone deepResearchProspect (the per-prospect "Deep Research" button) re-scored and only computed an `outcome` label ("low_score") — it never wrote status. So a prospect deep-researched in isolation that dropped to 28 stayed "researched" and visible, while the same prospect via the pipeline would have been suppressed. Two paths that should converge on the same end-state diverged.
FIX: deepResearchProspect now applies the same <40 → suppress triage (guarded to only suppress from raw/researched/needs_review, so it never yanks a manually-advanced replied/booked/won prospect).
SEPARATE INSIGHT (not a bug — the scoring is correct): scores "dropping hard" after deep research is by design. The Pass-1 gate score is STRUCTURAL ONLY (industry/geo/size/tech, threshold 10) and optimistic; the Pass-2 final score adds pain signal, contact, red-flag penalties, and a service-vs-product judgment. Fitness studios scored 28–62 because they SELL SERVICES (memberships/classes), not DTC products — service_match_pts=0 by rubric — and several had "already has a marketing agency" penalties (−20). The real lever is targeting: "fitness studio" keyword vs a "DTC" ICP is a mismatch; the rubric is correctly rejecting service businesses.
RULE: When two code paths produce the same kind of state change (here: re-score → triage), they must share the triage logic or one will silently drift. And: a score that drops after enrichment is usually the system working (gate score is optimistic-structural; final score is the real verdict) — diagnose by reading the score breakdown + reasoning before assuming a bug.
TAGS: #lesson #pipeline #scoring #deep-research #triage

[2026-06-22] LESSON: Pitch CTA hardcoded one market — English prospects sent to the Mexican audit tool
ROOT CAUSE: Every pitch's CTA used a single constant `HUNTER_URL = "https://runna-hunter.vercel.app/"`. The Inefficiency Hunter is ONE app that toggles CA/MX via in-page buttons and defaults to `currentMarket = 'mx'` — and it had NO URL-param support, so an English (CA) prospect clicking the link landed on the Spanish/Mexican version. Cross-repo issue: the audit app lives in /Users/work/Projects/runna-hunter (vanilla HTML/JS), separate from S.P.A.M.
FIX: (1) runna-hunter init() now reads `?market=ca|mx` (also accepts lang/country, en→ca) and calls switchMarket on load — toggle still works, param just sets initial state. (2) S.P.A.M builds the CTA via hunterUrlForLanguage(prospect.language): en→`?market=ca`, es→`?market=mx`. Default stays MX if no param, so old links degrade gracefully → deploy order doesn't matter.
RULE: Any outbound link that targets a multi-market/multi-locale destination must carry the market/locale as a URL param derived from the prospect's language — never a single hardcoded URL. And when the fix spans two repos, make the receiving end ignore unknown params gracefully so the two deploys aren't order-coupled. Note: pitch CTAs route by prospect LANGUAGE (en/es), consistent with [[pipeline-architecture]].
TAGS: #lesson #pitches #i18n #cta #cross-repo

[2026-06-22] LESSON: ⛔ BIG FAIL — Claude pitch fabricated a case study's nationality ("El Club, a Canadian fitness studio")
ROOT CAUSE: The pitch composer (Claude Sonnet) was told to write a relevant pitch and to bridge in a case study as "Did this for {client}, {metric}." But the prompt never forbade adding descriptive framing. For a Calgary prospect, Claude "localized" the El Club case — a MEXICAN studio — by calling it "a Canadian fitness studio in a saturated market." The case_studies table has NO country/geo column at all, so Claude invented it to make the case feel relevant. An outbound email stating a verifiable lie — torches credibility if the prospect knows the client. Two compounding issues: (1) the lie itself, (2) the UI's "How was this composed?" text was stale hardcoded copy claiming a heuristic generated it with "Phase 2 swaps in Claude" — but Claude WAS used (cost $0.0289, 6976 in/532 out tokens). The label lied about the method, which nearly sent me down the wrong diagnostic path.
FIX: (1) Added an explicit FACTUAL INTEGRITY block to the case-study bridge rule in claude-composer.ts — never invent client country/nationality/city/location; use only client_name + industry word + metric + descriptors literally present in result_description. (2) Rewrote the stale UI explainer to truthfully describe the Claude-composes-with-template-fallback flow.
RULE: Any LLM that writes outbound-facing copy referencing real third parties (case studies, clients, testimonials) MUST be explicitly constrained to facts present in the payload, with an enumerated list of attributes it may NOT invent (geography is the sneaky one — models localize to flatter the reader). "Be honest" is not enough; spell out the specific lies to avoid. Also: never let a UI describe HOW something was made with hardcoded copy — drive it from the actual record or the truthful flow, or it will eventually lie.
TAGS: #lesson #bigfail #pitches #claude #hallucination #factual-integrity

[2026-06-22] LESSON: Warmup sent 0/50 — a per-send deadline reservation went negative at full ramp
ROOT CAUSE: The send-loop deadline was `tickStart + 115_000 - target * 5_000` (reserve 5s per remaining send). At the 50/day ramp cap that reserved 250s against a 115s budget → deadline = tickStart − 135_000, i.e. 135s in the PAST → `Date.now() > deadline` was true on iteration 0 → loop broke before the first send. It silently "worked" at ≤20/day only because 115k − (20×5k) = 15k stayed positive (a 15s window). The failure surfaced only once the ramp hit week 4 (day 22+, target 50). Vercel log "Send deadline reached after 0/50 sends" was the smoking gun.
FIX: Replaced with a FIXED wall-clock budget `tickStart + 105_000` (105s of a 120s maxDuration, leaving headroom for the in-flight send + step 8 replies). A time budget must never scale DOWN as the amount of work scales UP.
SECONDARY FIX: "Run now" only ever showed `sent N` and threw away each config's `skipped_reason`, so "sent 0" was an undiagnosable mystery for two sessions. Now surfaces reasons in the toast (e.g. "pedro@runna.io: No active Gmail inbox found").
RULE: (1) Any wall-clock/deadline math must be sanity-checked at the EXTREMES of its inputs (here: max target) — a formula that's fine at 20 can be catastrophic at 50. (2) When an engine reports a no-op ("sent 0", "processed 0"), the per-item reason MUST reach the user/log — never collapse a result to a single number that hides why. (3) Pull Vercel runtime logs (`vercel logs --json | grep`) early when prod behavior contradicts the DB state.
TAGS: #lesson #warmup #serverless #deadline #diagnostics

[2026-06-19] LESSON: YP CA scraper returned 0 domains — site changed link format AND I almost double-counted listings fixing it
ROOT CAUSE (the bug): YellowPages.ca changed its website-link markup. The redirect param went from `websiteUrl=`/`/goto/` to `/gourl/{hash}?redirect=<url-encoded>`, and the href became RELATIVE ("/gourl/...") so `new URL(raw)` threw and returned null for all 120 results → every prospect filtered out by the no-domain gate (0/120). Fix: read the `redirect` param, resolve relative hrefs with `new URL(raw, "https://www.yellowpages.ca")`, target `li.mlr__item--website a`.
ROOT CAUSE (the near-miss): While fixing, I added multiple container selectors that NESTED — `div.listing__content` is the parent of `div.listing__content__wrapper`, so a combined selector matched each listing twice (80 instead of 40). Name and website also live in SEPARATE sibling subtrees, so the container must be their common ancestor (`listing__content__wrapper`), not the narrower `listing__mlr__root` (website only) or `listing__title--wrap` (name only).
RULE: (1) When a scraper silently returns 0 of a field, fetch a LIVE page and diff the real markup before editing selectors — never guess. (2) Verify the parser against the saved HTML with a throwaway script and assert the COUNT (containers === expected N), not just "it returns something" — duplication hides behind a downstream dedupe and looks fine until it inflates stats/cost. (3) Container selectors must never nest; pick the single common-ancestor element. Validated: 40 containers / 40 names / 17 sites on a real Alberta fitness page.
TAGS: #lesson #scraper #yellowpages #cheerio #discovery

[2026-06-19] LESSON: Adding a discovery source requires a Postgres enum migration — code alone fails silently at runtime
ROOT CAUSE: `discovery_runs.source` is a Postgres enum (`discovery_source`), not a free-text column. Wiring a new source ("claude_search") through the TS enum, source-meta, crawl-action dispatch, and UI all passed `tsc` + ESLint + `npm run build` — but the very first run would have errored at INSERT time because the DB enum didn't know the new value. tsc can't catch this; the enum constraint lives in the DB, not the types.
RULE: When adding a new discovery source (or any value to a column backed by a Postgres enum), the checklist is: (1) add to TS string unions + z.enum, (2) source-meta + UI, (3) crawl-action dispatch, AND (4) a migration `alter type <enum> add value if not exists '<x>';` that MUST be applied to the live DB before deploy. Pattern lives in migrations 0007/0008/0019. Grep `create type .* as enum` to confirm whether a column is enum-backed before assuming it's text.
TAGS: #lesson #supabase #enum #discovery #migration

[2026-06-19] LESSON: Yelp Fusion free tier is a time-limited TRIAL, not a perpetual free quota — it expired and failed every run
ROOT CAUSE: Yelp Fusion's "500 free calls/day" is a 30-day trial that expires and then returns HTTP 400 TRIAL_EXPIRED on every call, requiring a paid upgrade (credit card) to continue. The source had been advertised in-app as "500 free calls/day" with no mention of trial expiry. Pedro doesn't want to pay, so the whole source was dead weight cluttering the discover UI.
RULE: Don't trust "free tier" labels on third-party APIs without checking whether it's a perpetual free quota vs a time-limited trial. When a source's free access expires and the user won't pay, remove it from the user-facing list (drop from CRAWLABLE_SOURCES + UI branches) rather than leaving a permanently-failing card. Keep the code if cheap to retain, but make it unreachable so it generates no failed runs.
TAGS: #lesson #yelp #discovery #api-limits

[2026-06-03] LESSON: sendPitch never saved gmail_thread_id to pitches table
ROOT CAUSE: sendGmailMessage returned threadId but sendPitch only wrote it to audit_log metadata, never to the pitches row. Without thread_id persisted, follow-up emails couldn't reply in the same Gmail thread.
RULE: Whenever a Gmail send succeeds, always persist gmail_thread_id AND gmail_message_id to the pitch row immediately. Thread context is required for any downstream sequence/follow-up logic.
TAGS: #bug #gmail #sequence #pitches

[2026-06-03] LESSON: Follow-up email templates should be template-based, not Claude-generated
ROOT CAUSE: N/A — proactive design decision.
RULE: Follow-up emails (#2 and #3 in a sequence) should use string templates with variable substitution, not Claude. Reasons: (1) follow-ups must be SHORT (3-5 sentences), (2) Claude adds latency + cost where brevity wins, (3) templates are predictable and easily A/B tested. Only use Claude for the initial pitch where personalization depth matters.
TAGS: #architecture #pitches #sequence

[2026-06-03] LESSON: Sentry cron monitor timeout — no AbortSignal on external API fetch calls
ROOT CAUSE: postmaster-sync and warmup-engine both had fetch() calls with no timeout. If Google/Gmail API hung, the Vercel function hit its 60s hard kill AFTER withMonitor sent in_progress but BEFORE it could send ok. Sentry saw: in_progress → silence → timeout.
RULE: Every external fetch() call must have AbortSignal.timeout(N). postmaster: 10s. IMAP connections: connectionTimeout 8s, greetingTimeout 5s, socketTimeout 12s. Also cap unbounded loops (IMAP checks) at a per-tick max.
TAGS: #bug #sentry #cron #imap #timeout

[2026-06-03] LESSON: Sentry checkinMargin too tight for Vercel Hobby crons
ROOT CAUSE: checkinMargin: 5 min caused false "missed" alerts — Vercel Hobby crons can fire 20-30 min late.
RULE: Always set checkinMargin: 30 for Vercel Hobby cron monitors. maxRuntime should match what the function SHOULD take, not the Vercel timeout ceiling.
TAGS: #sentry #cron #vercel

[2026-06-03] LESSON: GitHub Actions CI failed on first push — pre-existing lint errors + wrong Node.js version
ROOT CAUSE 1: Lefthook only lints staged files ({staged_files}), so pre-existing unused imports and type errors across the whole codebase were never caught locally. CI runs `eslint .` on everything — 12 errors appeared on first push.
RULE: Before connecting any project to GitHub for the first time, run `npm run lint` and `npm test` on the FULL codebase and fix all errors first. Don't rely on Lefthook alone — it only sees staged files.
TAGS: #ci #github #lint

[2026-06-03] LESSON: Node.js 20 in GitHub Actions can't run TypeScript test files
ROOT CAUSE: `node --test` on Node.js 20 can't resolve glob patterns for `.ts` files and has no built-in TypeScript support. Tests pass locally because dev machine runs Node.js 22+.
RULE: Always use `node-version: 22` in GitHub Actions workflows for TypeScript projects. Add `--experimental-strip-types` to the node test command: `node --experimental-strip-types --test --test-reporter=spec 'tests/**/*.test.ts'`
TAGS: #ci #github #nodejs #typescript

[2026-06-03] LESSON: ESLint flags `process`/`console`/`fetch` as undefined in scripts/ directory
ROOT CAUSE: ESLint treats .mjs files as browser environment by default. Node.js globals need to be explicitly declared.
RULE: In eslint.config.mjs, add an override for `scripts/**/*.mjs` with `languageOptions: { globals: { process, console, URL, fetch } }`. Also add `.claude/**` to ignores to stop ESLint scanning Claude worktree files.
TAGS: #ci #eslint #scripts

---

[2026-05-29] LESSON: ⛔ generatePitch silently failed when called from nested server action
ROOT CAUSE: generatePitch called requireUser() → createClient() → cookies(). In Next.js,
cookies() can be restricted inside nested server action chains (bulkRunPipeline → processSingleProspect → generatePitch). getUser() returned null, requireUser() called redirect('/sign-in') which throws a non-standard error — not instanceof Error. Our catch swallowed it, writeAuditLog also failed (no session), leaving pitch_gate_passed=false with zero trace.
RULE: Never call requireUser() inside a function that will be called from within another server action. Accept user+supabase as optional parameters and use the caller's already-authenticated instances. Pattern: `async function generatePitch(id, injected?: { user, supabase })`.
TAGS: #bug #nextjs #server-actions #auth #pitch

[2026-05-29] LESSON: Claude composer Zod validation failed on preview_text length
ROOT CAUSE: Zod schema had `max(150)` on preview_text. Claude occasionally returns longer strings. Hard max caused parse failure → full heuristic fallback for all pitches.
RULE: For LLM output validation, use `.transform()` to clip rather than hard `.max()` that fails. Pattern: `z.string().max(500).transform(s => s.slice(0, 150))`. Hard max is only appropriate for DB constraints where the field will be truncated at insert anyway.
TAGS: #bug #claude #zod #pitch

[2026-05-29] LESSON: Em dash violation detector penalized score but didn't remove the dash
ROOT CAUSE: detectViolations() counted em dashes and lowered quality_self_score but the dash was still in the final body string passed to the DB and sent to the prospect.
RULE: For banned characters/patterns in LLM output, STRIP them at output time, not just penalize the score. Detection ≠ removal. Pattern: replace em dashes in finalBody before returning. Score penalty is secondary signal; the output must be clean regardless.
TAGS: #bug #pitch #output-quality

[2026-05-29] LESSON: Supabase MCP was connected to SnapPad project, not S.P.A.M
ROOT CAUSE: MCP configured in Claude desktop app with SnapPad project ID. Every execute_sql attempt returned permission denied.
RULE: Supabase MCP project is configured in Claude desktop app settings (not settings.json). When switching projects, update it there. S.P.A.M = ybbrpqzbedaxsmotgtkh, SnapPad = brofoxamdozserkamudf.
TAGS: #supabase #mcp #project-confusion

[2026-05-29] LESSON: Pipeline gate scored on structural signals only before pain extraction
ROOT CAUSE: Pain extraction was running before deep research, giving Claude Haiku incomplete data. Pain points extracted from homepage-only content were generic and low-confidence.
RULE: Pipeline order matters: scrape → gate score (structural only, threshold=10) → deep research → SnapVerify → pain extraction (ONCE, on all data) → final score. Never extract pain points before you have maximum data.
TAGS: #pipeline #architecture #quality

[2026-05-29] LESSON: SnapVerify couldn't find founders because scraper missed About page
ROOT CAUSE: Shopify stores use /pages/our-story, /pages/about-us — not /about. KEY_PAGE_PATHS only matched /about pattern. The About page with founder bios was never scraped, SnapVerify had no names to work with.
RULE: KEY_PAGE_PATHS must include Shopify /pages/* variants. Always check both standard (/about) and platform-specific (/pages/about-us, /pages/our-story) patterns. When adding a new platform, audit its URL conventions first.
TAGS: #scraper #shopify #snapverify #contacts

[2026-05-29] LESSON: IMAP "not found" was treated as spam
ROOT CAUSE: checkMessageInbox returned {foundInInbox:false, foundInSpam:false} when email wasn't found. Engine wrote landed_in_inbox=false, counting it as spam. Warmup auto-paused at 100% spam rate on Day 1 even though emails actually landed in inbox (Pedro confirmed).
RULE: IMAP "not found in inbox or spam" must return null (pending), not false (spam). Also check Gmail category folders (Promotions, Updates, Social) before declaring not found — warmup emails from cold domains land there first.
TAGS: #warmup #imap #bug

---

[2026-05-28] LESSON: Handwritten Supabase types were missing fields causing widespread `as never` casts
ROOT CAUSE: `lib/supabase/types.ts` was manually maintained and lagged behind actual schema. Missing fields: `sender_inboxes.Update` lacked all gmail token fields and sends_today; `pitches.Insert` lacked preview_text; `discovery_source`/`source` enums lacked `denue` and `yelp`; `prospect_research.Update` lacked `updated_at`; `pitches.Update` lacked sender/contact foreign keys.
RULE: After any migration, immediately update `lib/supabase/types.ts` with new columns. Run `supabase gen types typescript` in a worktree to auto-generate. The `as never` cast is a red flag that a type gap exists — always fix the type, never paper over it.
TAGS: #types #supabase #typescript #architecture

[2026-05-28] LESSON: React hooks (useState, useEffect) cannot be imported from files used by Server Components
ROOT CAUSE: Added `useDebounce` hook to `lib/utils.ts` which is imported by Server Components. This caused "Ecmascript file had an error" at build time because hooks are client-only.
RULE: Client-side React hooks must live in a file marked "use client" or in a dedicated `lib/hooks.ts` that is only imported from client components. Never put hooks in shared utility files.
TAGS: #nextjs #react #server-components #bug

[2026-05-28] LESSON: `} as never)` replacement pattern requires careful regex — '}' closes object, ')' closes method call
ROOT CAUSE: When doing bulk replacement of `as never` casts, replacing `} as never)` with `}` dropped the `)` needed to close the Supabase method chain (`.insert()`/`.update()`).
RULE: When removing `as never` casts from Supabase chains, replace `} as never)` with `})` — the `)` belongs to the builder method, not the cast.
TAGS: #typescript #supabase #refactoring

---

[2026-05-28] LESSON: Generating pitches for prospects with no contact email is wasteful
ROOT CAUSE: The pipeline was generating full pitches (Haiku + Sonnet call) even when all three enrichment tiers (SnapVerify → Anymail → Hunter) came back empty. The pitch would land in `status=pitched` but the UI would show "no contact — pick one manually". An unsendable pitch is a wasted credit and a misleading pipeline outcome.
RULE: After contact enrichment, always gate on `prospect_contacts` having at least one non-null email before calling `generatePitch()`. If no email: `pitch_gate_passed=false`, return `needs_review`. Never auto-generate a pitch you can't send.
TAGS: #pipeline #contacts #gate #credits

[2026-05-28] LESSON: Brave people-intel queries can return wrong business (name collision)
ROOT CAUSE: In Test A, Brave query `"Adorn Boutique" CEO OR founder` returned Nicole Whitesell — CEO of a Portland OR boutique also named "Adorn", not the Calgary one. Generic boutique names are common enough to collide. This means SnapVerify can insert a wrong person's first name as the email guess.
RULE: Brave people-intel queries in snapVerifyEnrich should be scoped with the city/region when available. Improve query to: `"${companyName}" "${city}" CEO OR founder OR owner` and `"${companyName}" "${domain}" owner`. Also: when Haiku extracts people, it should cross-reference that the person is associated with THIS domain (not a homonym company). Short-term fix: add domain to the Brave query to narrow results.
TAGS: #snapverify #brave #data-quality #false-positive

[2026-05-28] LESSON: Old scraper inserted 7 garbage emails into prospect_contacts
ROOT CAUSE: The original scraper blindly extracted any string matching an email pattern from scraped HTML — including placeholder emails (`example@email.com`, `john.doe@email.com`), phone-numbers concatenated with emails (`922-2281intheknow@...`), and href garbage (`0j1780-709-8242hello@bougierougeboutique.comfirst`). These are useless and pollute the contact table.
RULE: The scraper email extraction regex must validate: (1) no leading digits/special chars in local part, (2) domain part matches a real TLD pattern, (3) not a known placeholder (example@, test@, john.doe@, abuse@). SnapVerify avoids this entirely by generating structured guesses (firstname@domain) rather than scraping raw strings. Consider a one-time cleanup migration to delete scraper contacts with malformed emails.
TAGS: #scraper #data-quality #contacts #bug

[2026-05-28] LESSON: Deno edge functions don't share tsconfig with Next.js
ROOT CAUSE: `supabase/functions/` directory was included in the root tsconfig, so Deno-specific globals (Deno.connect, Deno.resolveDns, Deno.TcpConn) and Deno URL imports caused TS errors in `npx tsc --noEmit`.
RULE: Always exclude `supabase/functions` from the root tsconfig.json `exclude` array. Deno edge functions have their own runtime types — they cannot be type-checked with Next.js tsconfig.
TAGS: #supabase #deno #typescript #edgefunctions

[2026-05-28] LESSON: Supabase CLI deploy requires `supabase login` first
ROOT CAUSE: `supabase functions deploy` returned 403 because the CLI wasn't linked/authenticated. The Supabase MCP also lacks deploy permissions.
RULE: Before any `supabase functions deploy` call, run `supabase login` and `supabase link --project-ref <ID>` first. Deploy edge functions manually — don't assume CLI auth persists across machines or sessions.
TAGS: #supabase #deploy #cli

[2026-05-28] LESSON: Email enrichment should be free-first, paid-last
ROOT CAUSE: Previous architecture ran Anymail+Hunter for every ≥70 prospect, burning API credits even when named people were already visible in scraped site content.
RULE: Three-tier waterfall for contact enrichment: (1) SnapVerify — free, uses scraped notes + Claude Haiku + SMTP edge function; (2) Anymail Finder — paid, verified decision-maker; (3) Hunter.io — paid, domain sweep. Short-circuit on first success. SnapVerify alone handles Google Workspace + Microsoft + SMTP-reachable domains.
TAGS: #contacts #enrichment #cost #architecture

[2026-05-26] LESSON: Pain points must be evidence-backed, not AI-inferred
ROOT CAUSE: Structured research generates pain points (e.g. "no email capture", "cart abandonment") for most prospects regardless of whether the scraped content actually showed that signal. The AI infers from industry pattern rather than real source data — so every boutique ends up with the same 3 pains. This dilutes the pitch: if the pain isn't real and specific, the email reads generic.
RULE: Every pain point in prospect_research MUST have a non-null, non-empty evidence_quote pulled from actual scraped content (website copy, about page, product page, etc.). Pains with no quote = AI assumption = should be filtered out before scoring or pitch generation. When auditing: check if evidence_quote is just a rephrased version of the pain label (that's also fabrication). Real evidence sounds like "Free shipping on orders over $75" or "Sign up for our newsletter" — not "likely uses email marketing."
TAGS: #quality #research #pain-points #pitch

---

[2026-05-29] LESSON: ⛔ BIG FAIL — Code reaper removed active Hunter/Anymail logic by assuming "no API key"
ROOT CAUSE: The code reaper found Hunter and Anymail imports and calls, and judged them "dead code" because it didn't check `.env.local`. Both `HUNTER_API_KEY` and `ANYMAIL_FINDER_API_KEY` were set and working. The reaper removed the entire enrichment blocks from `scrape-action.ts` and `crawl-action.ts` without verifying env var existence first.
WHY IT'S COSTLY: Pedro caught this in code review — the entire contact enrichment pipeline would have been silently broken in production. Score-gated enrichment at ≥70 (the core monetisation-preserving mechanism) would have fired nothing.
RULE: Before removing ANY integration code, ALWAYS run `grep -r "ENV_VAR_NAME" .env.local .env* 2>/dev/null` to confirm whether keys exist. "I don't see it being used" is NOT the same as "it isn't configured". Dead-code determination requires verifying the full runtime context, not just static imports.
TAGS: #big-fail #reaper #hunter #anymail #contacts #pipeline

[2026-05-29] LESSON: ⛔ BIG FAIL — Crawl-time Anymail/Hunter was burning credits on ALL prospects (wrong design)
ROOT CAUSE: `crawl-action.ts` had a block that ran Anymail → Hunter for EVERY newly discovered prospect immediately at crawl time, before any scoring. Score doesn't exist at crawl time so there was no gate. This meant every Yelp, DENUE, or Brave result (even ones that would score 20 and get suppressed) spent paid API credits on contact lookup.
WHY IT'S COSTLY: Anymail and Hunter have credit-based billing. Running them on 100 raw prospects to keep 15 is ~85% credit waste. The correct design is SnapVerify (free) at Pass 1, then Anymail → Hunter only for score ≥70 in the pipeline.
RULE: Paid enrichment APIs (Anymail, Hunter) must ONLY fire inside `enrichContactsForProspect()` which is called from `processSingleProspect()` after the score ≥70 gate is confirmed. SnapVerify (free) runs earlier. No paid tier runs at crawl time or before scoring. If you see Anymail/Hunter imports in crawl-action.ts — that's a bug.
TAGS: #big-fail #credits #anymail #hunter #pipeline #architecture

[2026-05-29] LESSON: ⛔ BIG FAIL — Ran Supabase migration against wrong project (SnapPad instead of S.P.A.M)
ROOT CAUSE: The Supabase MCP was connected to `brofoxamdozserkamudf` (SnapPad) but S.P.A.M uses `ybbrpqzbedaxsmotgtkh`. Ran the full 0016_warmup_system.sql migration — 5 tables + 52 seed rows — into SnapPad. Had to manually drop all created tables from SnapPad and re-run in the correct project.
WHY IT'S COSTLY: SnapPad is a live production app. Injecting warmup tables into it polluted the schema. Could have corrupted data if any table names collided.
RULE: Before ANY Supabase SQL execution, confirm the active project ref matches the current task's project. Check `mission-control_3.html` or `.env.local` for `NEXT_PUBLIC_SUPABASE_URL` and verify it contains the correct project ID. S.P.A.M = `ybbrpqzbedaxsmotgtkh`. SnapPad = `brofoxamdozserkamudf`. These must never be swapped.
TAGS: #big-fail #supabase #wrong-project #migration

[2026-05-29] LESSON: Pipeline diagram presented incorrect Stage 1 enrichment as correct design
ROOT CAUSE: When asked to map the full pipeline, described crawl-time Anymail/Hunter as intentional architecture ("runs immediately for every new prospect with a domain"). This was actually a bug in the code — not intentional design. The diagram normalised the bug rather than flagging it.
RULE: When documenting pipeline logic, READ the actual code first and flag anything that looks architecturally wrong. "The code does X" is not the same as "X is correct". If a pipeline step fires paid APIs without a quality gate, that must be called out as a suspected bug, not documented as intended.
TAGS: #pipeline #diagnosis #documentation

[2026-05-29] PEDRO_OVERRIDE: SnapVerify should run in Pass 1 for all prospects, not just ≥70
PEDRO'S APPROACH: Move SnapVerify to run right after Structured Research (Pass 1), before initial score. It's free, uses already-scraped data, and gives the score a contact signal.
WHY IT WAS BETTER: SnapVerify is zero-cost. Running it early means: (1) the initial score reflects contact availability, (2) by the time a prospect reaches ≥70, we already know if free enrichment worked and can skip straight to Anymail/Hunter. No downside to running it early.
RULE: Free enrichment (SnapVerify) runs in Pass 1 for every prospect with a domain. Paid enrichment (Anymail, Hunter) runs only at ≥70. Never conflate "runs early" with "runs expensively". Cheap things run eagerly; expensive things are gated.
TAGS: #override #pipeline #snapverify #architecture

[2026-05-26] LESSON: ⛔ BIG FAIL — Assumed API keys weren't configured without checking
ROOT CAUSE: The discovery run returned results from Google Places only. Rather than verifying the actual Vercel env vars first, Claude assumed Yelp and Brave "weren't configured" and told Pedro so. In reality all keys (YELP_API_KEY, BRAVE_SEARCH_API_KEY, DENUE_API_KEY, HUNTER_API_KEY) had been set for 4+ days. The real root cause was sequential execution in runAllSources: each runCrawl call was doing Anymail+Hunter enrichment per prospect (~80s per source), so 3 keywords × 3 sources = 720s+ → Vercel 504 cut the run after only Google Places completed. Yelp and Brave never got their turn.
WHY IT'S COSTLY: Pedro had to correct this explicitly. It wasted trust and time — he'd set up those keys himself and the false diagnosis implied his work was wrong.
RULE: BEFORE stating any integration "isn't configured" or "isn't set up", run `vercel env ls` (or equivalent) first. Never assume from symptoms alone. Always check the actual state.
FIX APPLIED: Moved Anymail+Hunter from runCrawl (per-discovery) to processSingleProspect (per-pipeline, score-gated at ≥70). Each runCrawl is now ~5s instead of ~80s. Sequential execution now completes in ~50-100s for a typical run — well under 300s Vercel limit.
TAGS: #bug #api #discovery #diagnosis #big-fail

---

[2026-05-25] LESSON: Playwright screenshots hit the login wall when using `npx playwright screenshot <url>` directly against a deployed app with auth.
ROOT CAUSE: Playwright CLI has no session state — it starts a fresh unauthenticated browser every time.
RULE: Always use the project's `scripts/screenshot-*.mjs` auth pattern (create Supabase session → inject cookie via `context.addCookies` or sign-in form fill → then navigate). Never use bare `npx playwright screenshot <url>` for authenticated pages.
TAGS: #bug #playwright #auth #screenshot

[2026-05-25] LESSON: Supabase MCP `execute_sql` and `apply_migration` tools silently require elevated permissions — they return "You do not have permission" for DDL and even SELECT on user tables.
ROOT CAUSE: The connected MCP token may be scoped read-only or the project-level MCP config doesn't include the management API scope.
RULE: Don't assume the Supabase MCP can run arbitrary SQL. For DDL migrations, write the SQL file locally and ask Pedro to paste into the Supabase Dashboard SQL Editor. For verification queries, try `execute_sql` but have a fallback (TypeScript compile check, or ask Pedro to confirm in the dashboard).
TAGS: #supabase #mcp #permissions #migrations

[2026-05-25] LESSON: Design God Mode and huashu-design are different passes with different outputs — don't conflate them.
ROOT CAUSE: Design God Mode = systematic polish (token consistency, component states, hover/focus, accessibility). huashu-design = philosophical audit (anti-AI-slop, information density for AI tools, the one "120% detail", empty state quality, typography expressiveness).
RULE: Run Design God Mode first (it fixes the broken stuff), then huashu-design as a second pass (it elevates what's working into something with character). The two complement; neither replaces the other.
TAGS: #design #workflow #huashu #process

[2026-05-25] LESSON: Empty states with only plain text and no visual weight communicate "broken app" not "no data yet."
ROOT CAUSE: Default EmptyState renders title + description as centered text — honest but passive. Users scan, not read. Without icon + CTA button, the page feels abandoned.
RULE: Every empty state needs three things: (1) an icon or visual element that reinforces *what* is empty, (2) a one-line title that's honest about the state, (3) a primary or secondary CTA button that takes the user to the next step. Never leave them with just text and a URL in prose.
TAGS: #design #ux #empty-states

[2026-05-25] LESSON: "plan already written" doesn't mean "already implemented" — always verify before assuming done.
ROOT CAUSE: The notable_clients tier plan was fully written (migration SQL, type, filter code) but the DB migration had not been applied. Code compiled cleanly because the type was declared manually in queries.ts, masking the missing column.
RULE: When a plan file exists and code looks complete, always verify DB state independently (check migrations list, query the column, or ask Pedro). TypeScript compiling ≠ schema applied.
TAGS: #migrations #schema #verification #supabase

[2026-05-23] LESSON: `import type` from a server-only module still bleeds into the client bundle in Next.js/Turbopack.
ROOT CAUSE: Even `export type { X } from "./server-module"` in a re-exporting file causes Turbopack to trace the dependency graph through the server module, pulling in `next/headers` into the client bundle.
RULE: Always split server-only types into a separate `types.ts` file with zero server imports. Client components import from `types.ts`; queries/actions import from `types.ts` too. Never re-export types from a file that also imports server-only modules.
TAGS: #bug #architecture #nextjs #server-client-boundary

[2026-05-23] LESSON: Inserting new table types into types.ts outside the `Tables` object causes `Property 'x' does not exist` errors.
ROOT CAUSE: Miscounted closing braces — the `Tables: {` block was closed one `};` early, so new table definitions were at the top-level `public` object instead of inside `Tables`.
RULE: When extending types.ts, always grep for `Tables:\|Views:\|icps:` to confirm nesting before adding. New tables go BEFORE the `Views` line.
TAGS: #bug #typescript

---

## [2026-04-25] LESSON: TypeScript status arrays drifted from the prospect_status enum

**What went wrong:** Six files (`STATUS_OPTIONS` arrays in detail-actions schema, prospect-detail, companies-page; `ColStatus` union + `COLUMNS` config + grouped `Record` keys in funnel-board; pipeline strip in dashboard) all referenced `"meeting_booked"`. The `prospect_status` enum in `0001_initial_schema.sql` actually has `"booked"` — `meeting_booked` is the value of a *different* enum (`opportunity_stage`). Anyone trying to mark a prospect as that stage would hit `invalid input value for enum prospect_status: meeting_booked` at runtime. Caught only when seeding screenshot fixtures.

**Root cause:** Two enums with overlapping but different value sets, and no single source of truth from DB → TS. The TS arrays were hand-typed from memory of the spec doc.

**RULE:** When TypeScript code references DB enum values, generate the union from `supabase gen types` (or at minimum, copy from the migration file with the path noted in a code comment). Add a Zod enum validator at the action boundary that lists every allowed value — typecheck won't help with strings, but Zod throws at request time so we hear about it before users do. For multi-enum domains (status vs opportunity_stage), name the TS unions explicitly to match: `ProspectStatus` and `OpportunityStage`, never share.

**TAGS:** #bug #schema #enum #drift

---

## [2026-04-24] LESSON: Splitting server-only queries from client-safe constants in the same module poisons the client bundle

**What went wrong:** `lib/discover/runs-queries.ts` exported both `listDiscoveryRuns` (server-only — imports `next/headers` via `createClient`) and `SOURCE_META` (a plain constant). The client `<DiscoverPage>` imported just `SOURCE_META` from that file. Next dragged the *whole module* into the client bundle, and Turbopack crashed because `next/headers` can't run in the browser.

The visible symptom: clicking the "Upload CSV" button in the smoke test timed out because the page never finished rendering — the topbar button never mounted.

**Root cause:** ESM module barrels are bundle-level, not symbol-level. A client component that imports `{ SOURCE_META }` from a file that also exports server code still pulls the server code into the bundle. Tree-shaking doesn't help — `createClient`'s top-level `import { cookies } from "next/headers"` runs at module-eval time.

**RULE:** Any `lib/<domain>/` module needs ONE of:
1. Server-only (uses `next/headers`, service role, etc.) — only server components or `"use server"` actions may import.
2. Client-safe (pure types + constants + helpers) — both server and client components may import.

Never mix in the same file. When in doubt, split into `queries.ts` (server) + `source-meta.ts` / `types.ts` / `helpers.ts` (client-safe).

**How to apply:** Before exporting a constant from a server module, ask: "will any client component want this?" If yes, move it to a sibling client-safe file. The split is cheap; the bundle bleed is annoying to diagnose.

**TAGS:** #bug #rsc #bundling #lesson

---

## [2026-04-24] LESSON: Don't pass Lucide icon components across the Server→Client component boundary

**What went wrong:** `/settings/layout.tsx` (server component) passed a TABS array with `icon: User` / `icon: Send` / `icon: Users` — the LucideIcon function references — down to `<SettingsTabs tabs={TABS} />` (client component). React 19 threw "Functions cannot be passed directly to Client Components", returning 500s on every /settings subroute. Sign-in kept re-rendering because the unsigned-in fallback was the only code path that didn't try to hydrate the crashing layout.

**Root cause:** Lucide icons are forward-ref React components — i.e. functions with `$$typeof: Symbol(react.forward_ref)`. React 19 + RSC serialization only passes plain JSON-compatible props across the boundary; functions get rejected unless annotated with `"use server"`.

**RULE:** When a client component needs React components as props, either:
1. Inline the list inside the client component (the fix here — moved TABS into `SettingsTabs`), or
2. Pass a string/enum id and resolve to a component inside the client component's own registry.

Do NOT pass React element types (including lucide-react icons) across the RSC boundary.

**How to apply:** Before writing a server component that forwards `children` / a config array to a client component, check every prop field — if any value is a function reference, either move the whole structure inside the client component or map by string id. The 500 error message is clear ("Only plain objects can be passed to Client Components"), but the symptom was a downstream redirect to /sign-in which obscured the root cause — always check dev logs first, not just screenshots.

**TAGS:** #bug #react-19 #rsc #server-components #lesson

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

---

[2026-05-23] SESSION WRAP — key decisions + state for next session:

SHIPPED THIS SESSION:
- Connection error root cause was trailing \n in Vercel API key → fixed with .trim()
- No-keepalive agent (https.Agent keepAlive:false) prevents stale TCP on Vercel warm starts
- Collapsed 3-stage to 2-stage Claude pipeline (Stage 1 deterministic + Stage 2 Sonnet)
- Pedro's 5 subject line engines wired into system prompt (Named+Numbered, Leak, Niche Mirror, Reframe, Peer Pressure)
- 8 industry fallback templates (Pedro-authored) replacing heuristic slop
- 3 hospitality sub-type templates: hotel, beach_club, villa_rental (from Templates_Cancun_LosCabos_Hospitality.docx)
- Hospitality calculator is LIVE at https://runna-hunter.vercel.app/ (same URL, hospitality mode built)
- All pitches now CTA to Hunter URL (hunter_url in payload) — Loom offer removed everywhere
- ICP "Suggest from name" wired to Claude Haiku (getClient() + full field coverage including excluded_keywords + size/revenue ranges)
- placesKeyConfigured passed from server → grid → drawer (no longer hardcoded false)
- 6 strategic ICPs created in DB: Alberta, Western CA, Eastern CA, CDMX, Norte MX, Sur MX/Destinos
- GOOGLE_PLACES_API_KEY confirmed set in Vercel — Places preview now active in /icp

RULE: ALL cold email CTAs → https://runna-hunter.vercel.app/ — no Loom, no call ask, no video offer. Hunter self-qualifies the prospect. This is permanent.

RULE: Hospitality prospects (hotel, resort, villa, beach club) get English templates by default — they market to North American travellers, English is the right language regardless of MX market setting.

OPEN ITEMS FOR NEXT SESSION:
- New sender inbox setup (Gmail OAuth + runnareach.com SPF/DKIM/DMARC warm-up)
- Clean DELETE of all test prospect rows in /companies
- Full UX/UI audit (screen by screen)
- Code reaper (dead imports, stubs, as never casts)
- Design God Mode + Huashu Designs (Pedro to clarify "Huashu")
- Learning section (Pedro to define scope)
- Analytics dashboard


[2026-05-23] LESSON: OAuth client secret invalid_client despite correct-looking value
ROOT CAUSE: Reading secrets from screenshots causes character misreads (l vs I, 0 vs O, etc.). The original secret had a lowercase `l` that was misread as uppercase `I`. Even after fixing that, the first creation dialog secret was already gone (Google only shows it once) leaving "Client secrets" section empty.
RULE: NEVER read secrets from screenshots. Always use the copy button, Download JSON, or Reset Secret to get a machine-accurate value. To validate credentials before deploying, curl Google's token endpoint with a dummy code — `invalid_grant` = creds OK, `invalid_client` = creds bad.
TAGS: #bug #api #oauth

[2026-05-23] LESSON: UX audit — calling intentional empty states "bugs"
ROOT CAUSE: Did a screen-by-screen audit without full product context. Flagged Funnel "Empty." columns and disabled discovery source buttons as bugs when they are correct intentional behavior. Pedro called it out.
RULE: Before flagging something as broken in an audit, ask "could this be intentional given the product's state?" Empty states that depend on data (funnel with no prospects) are correct. Disabled buttons on locked features are correct. Only flag things that are unambiguously wrong (404 on a sidebar link, wrong copy, crashes).
TAGS: #ux #audit #overcalling

[2026-05-23] LESSON: vercel env add with echo adds a trailing \\n that breaks OAuth
ROOT CAUSE: `echo "value" | vercel env add KEY production` stores "value\n". Google OAuth rejects credentials with trailing whitespace — returns invalid_client.
RULE: ALWAYS use `printf "value" | vercel env add KEY production` (no -n flag needed — printf has no trailing newline by default). After adding any OAuth credential, verify with the debug-creds pattern (show length + last charCode) and curl Google's token endpoint with a dummy code to confirm invalid_grant (creds OK) vs invalid_client (creds bad).
TAGS: #bug #oauth #vercel #credentials

[2026-05-25] LESSON: noUncheckedIndexedAccess breaks string[0] even after truthiness guard
ROOT CAUSE: tsconfig has `noUncheckedIndexedAccess: true` — means `string[0]` returns `string | undefined` even when the string is confirmed truthy (TS doesn't narrow string to "non-empty" based on truthiness).
RULE: Use `.charAt(0)` instead of `[0]` for string character access. For array first-element access, use `arr.find(Boolean)` or destructuring with defaults. Always check tsconfig for noUncheckedIndexedAccess when debugging TS2532 errors.
TAGS: #bug #typescript #config

[2026-05-25] LESSON: .returns<T>() before .maybeSingle() doesn't fix never — maybeSingle() overwrites the type
ROOT CAUSE: In supabase-js, `.returns<T>()` overrides SELECT row type but `.maybeSingle()` wraps the result in its own narrowing. When the base table type is `never` (table not in schema types), `.returns<T>().maybeSingle()` still resolves data as `never`.
RULE: For single-row queries on tables missing from types.ts, cast the raw result directly: `const r = rawData as unknown as MyType`. For list queries, `.returns<Row[]>()` at the END of the chain (before `.eq()` calls are already processed) works. Don't put `.returns<T>()` before terminal calls like `.maybeSingle()` or `.single()`.
TAGS: #bug #typescript #supabase

[2026-05-26] LESSON: Supabase select("col1, col2") returns `never` without .returns<T[]>()
ROOT CAUSE: When querying columns via string select, TS infers the row shape from the Database type. Partial selects on tables with complex union types sometimes collapse to `never` due to how supabase-js generic inference works with Pick<>.
RULE: Any query that processes `data` rows (not just head/count) needs `.returns<MyLocalType[]>()` as the last chain call. Define the local type inline above the query. This is idempotent — it doesn't affect runtime, only satisfies TS.
TAGS: #bug #typescript #supabase

[2026-06-22] LESSON: Reply funnel built — pull replies via Gmail API (threads.get), NOT IMAP
ROOT CAUSE: The pinned reply-funnel spec suggested "reuse the warmup IMAP pattern." But warmup IMAP authenticates with per-buddy Gmail APP PASSWORDS (env vars). The sender_inboxes that send pitches only have OAuth refresh tokens (gmail_refresh_token_encrypted) — no app passwords. Reusing IMAP would have required provisioning + storing a new secret per inbox.
RULE: For reading replies to SENT pitches, use the Gmail REST API (users.threads.get?format=full) with the SAME OAuth token getAccessToken() already mints for sending. We store gmail_thread_id on every sent pitch, so threads.get gives exact in-thread fidelity with zero new credentials. See lib/gmail/read.ts. IMAP is only the right tool for the warmup buddy accounts, which DO have app passwords.
TAGS: #replyfunnel #gmail #architecture

[2026-06-22] LESSON: Reply funnel — 3-reply cap lives on prospects.reply_attempts; archive needs an enum migration
ROOT CAUSE: Pedro's rule = max 3 funnel replies to book a meeting, then archive WITH a learning. The counter is incremented in approveAndSendReply (our OUTBOUND funnel responses), not by counting inbound rows. Archiving needs prospect_status value 'archived_no_meeting' — prospect_status is a Postgres enum, so it needs `alter type ... add value` in its OWN migration file (0020) committed BEFORE any migration/code uses it (can't add+use a value in one tx).
RULE: New columns/enum values aren't in generated supabase types — cast the service-role client to `any` (matches follow-up/send-queue crons) and use plain `.maybeSingle()` then cast the result (the `any` client rejects `.maybeSingle<T>()` generic args — TS2347). MIGRATIONS 0020 + 0021 MUST be applied to live DB (ybbrpqzbedaxsmotgtkh) before the funnel works.
TAGS: #replyfunnel #supabase #enum #migration

[2026-06-23] LESSON: The 3-email push sequence already existed — upgraded its brain, didn't rebuild
ROOT CAUSE: Pedro asked for a "3-try push flow" (email 2 + email 3 if no reply). The follow-up cron app/api/pitches/follow-up/route.ts already did exactly this (step1 initial → FU1 +3d → FU2 +5d, auto-pauses on reply via sequence_paused_at). What was missing: FU1/FU2 were STATIC templates (lib/pitches/followup-templates.ts) with em-dashes, "Hi there", English-only — all violations of Pedro's own pitch rules.
RULE: Before building a "new" feature, grep the codebase for the cron/flow — outreach sequencing was already there. The fix was a composer swap (new lib/pitches/followup-composer.ts, Claude Sonnet, personalised from research/pain/tech/city + the ORIGINAL pitch body so it never repeats; EN/ES; template kept as deterministic fallback), wired into the existing cron. Cadence 3d/5d kept (textbook). Auto-send kept (Pedro chose it over human-in-the-loop).
TAGS: #followup #replyfunnel #dontrebuild

[2026-06-23] LESSON: "The learning loop is built" = prompt-variant data model + UI, NOT runtime learning
ROOT CAUSE: Memory said the learning loop wasn't built; Pedro said it was. Both half-right. lib/prompts + /learning + /settings/prompts implement a real prompt-optimization system: versioned prompts per `prompt_purpose`, champion/challenger variants, per-variant outcome counters (hit_count/reply_count/booked_count), and AI "learning_proposal" suggestions you approve to promote. BUT the runtime composers (pitch, reply-draft, and now follow-up) all HARDCODE their system prompts — none read the champion variant or write back the outcome counters. So the loop's plumbing + UI exist; live generation isn't plugged in yet.
RULE: Don't claim follow-ups/pitches "learn" until composers (a) fetch the champion variant for their purpose and (b) feed reply_count/booked_count back (needs a variant-attribution column on pitches + a `followup` prompt_purpose enum value). Recommended as a dedicated task: wire ALL composers to the variant system uniformly — half-wiring one composer creates an inconsistent loop. Update [[learning-loop-spec]].
TAGS: #learningloop #prompts #honesty
