[2026-10-17] A brief's mechanism and its acceptance check can disagree. Satisfy the check and say how
WHAT HAPPENED: The contact-source-url brief said "first page in fetch order wins" and also required that an address on /contact and /about record /contact. But `scrapeSubPages` fetches in SUBPAGE_PRIORITY order (About, Team, Contact…), so About comes first. `lib/research/scraper.ts` `attributeEmailSources` ranks a Contact page first, then fetch order. The emails' order and set are unchanged.
RULE: Before writing a brief's acceptance check about "first/last/order", check the real iteration order in code (`SUBPAGE_PRIORITY`, not `KEY_PAGE_PATHS`). A worker that hits the contradiction keeps the testable check, writes the rule in the PR, and gives the one-line switch.
TAGS: research, scraper, briefs

[2026-10-17] Scraper end-to-end tests can stub global fetch
WHAT HAPPENED: `tests/scraper-source-url.test.ts` runs the real `scrapeSite` against a fake site by replacing `globalThis.fetch` and setting `Response.url` with `Object.defineProperty`. A constructed Response has `url === ""`, which silently empties key-page discovery. Each case takes about 1 s because of SUBPAGE_RATE_LIMIT_MS sleeps.
RULE: To test network-loop code in the scraper, stub fetch rather than exporting internals. Always set `res.url`. Use real-looking mailboxes: `privacy@` is filtered by the extractor and makes a test fail for the wrong reason.
TAGS: research, testing

## Out of scope, noticed
- `lib/research/structured-research-stage.ts:257` also inserts into `prospect_contacts` (decision-maker email, `selected_by: "engine"`). It was not in the brief's list or allow-list, so it leaves `source_url` unset (column default). Its email can come from scraped notes, so a later brief could thread a source there.
