# Brief: contact-source-url

| | |
|---|---|
| Module | `lib/research/` (scraper + stages) and the contact insert sites in `lib/discover/` |
| Model / effort | opus-5.5 / medium |
| Branch | `claude/contact-source-url` from `claude/gallant-gauss-gly093` |
| PR target | `claude/gallant-gauss-gly093` (phase 3 integration branch) |
| Reserved migration | none (0043 on the integration branch adds `prospect_contacts.source_url`) |
| Depends on | none |
| Conductor session | `session_012bGmp5nHP9Lx5ke69JkaBk` |
| Size | M |

## Goal
A scraped address is a snapshot. The audit's "just-in-time freshness check" (re-read the
page an address came from right before sending) is impossible today because nothing
records which page an address was mined from. Record it. A good solution threads the
page URL from the extractor to every insert site without changing which addresses are
found, their ranks, or the dedupe behaviour.

## Context the worker needs
- `lib/research/scraper.ts` fetches the home page plus key sub-pages (`KEY_PAGE_PATHS`,
  Shopify variants) and mines `mailto:` and plaintext emails at fetch time
  (`textWithBoundaries`). It currently returns emails without the page they came from.
  Extend the result so each email carries the URL of the page it was first seen on
  (first page in fetch order wins).
- Insert sites that must set `source_url` (grep `from("prospect_contacts").insert`):
  `lib/research/scrape-stage.ts:321`, `lib/research/deep-research-stage.ts:338`,
  `lib/discover/enrich-contacts.ts` (4 sites: provider results; set `null`, the provider
  is already named in `selected_by`), `lib/discover/pipeline-stage.ts:457`,
  `lib/prospects/detail-actions.ts:361` (manual entry; `null`).
- Column is in `lib/supabase/types.ts` already (`source_url: string | null`). Where an
  insert uses `as never`, keep that pattern.
- The unique index on `(tenant_id, email)` and the `23505` handling stay as they are: an
  existing contact is not updated by this task.

## Files
Allowed to edit:
- `lib/research/scraper.ts`
- `lib/research/scrape-stage.ts`
- `lib/research/deep-research-stage.ts`
- `lib/discover/enrich-contacts.ts`
- `lib/discover/pipeline-stage.ts`
- `lib/prospects/detail-actions.ts`
- `tests/scraper-source-url.test.ts` (new); existing scraper tests may gain cases, never
  lose them.

Read, do not edit: `lib/research/snap-contact.ts`, `lib/research/email-utils.ts`,
`tests/scraper-*.test.ts`, `supabase/migrations/0043_*.sql`.

Forbidden: `lib/supabase/types.ts`, `lib/research/verify-recipient.ts`, anything in
`lib/pitches/`, migrations.

## Must not change (negative set)
- The set of emails the scraper returns for a given page set, and their order.
- `priority_rank`, `email_is_role_based`, `selected_by` values at every insert site.
- The regulator and placeholder exclusions (privacy commissioners must still never be
  mined; see the "Closed, do not re-open" section of `_core-context.md`).
- All existing scraper tests pass unchanged.

## Acceptance checks
1. Test: an email found on `/contact` and again on `/about` records `/contact` as its
   source URL (full absolute URL).
2. Test: emails mined from `mailto:` and from plaintext both carry a source URL.
3. Every listed insert site sets `source_url` (grep in the PR body shows each line).
4. `npm run typecheck && npm run lint && npm test` green; report the test count.

## Out of scope
The freshness check itself, backfilling existing rows, showing the URL in the UI.
