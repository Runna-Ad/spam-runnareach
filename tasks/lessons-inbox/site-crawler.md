[2026-10-30] A word that means "book" in one sentence is a place name in the next: test detectors on real pages, not on the word list
WHAT HAPPENED: The first booking regex in lib/research/site-crawl/detectors.ts matched "RESERVE" (a development called "Arava Reserve"), "Reserva Real" (a neighbourhood), "Agenda" (a university's event agenda) and "Booking.com*" on a student-housing page linking to airbnb.ca/ and booking.com's home. All four came out as "online booking found" on the 33-site study, i.e. the exact false claim the task exists to stop. Only running the crawler on the real sites showed it.
RULE: A keyword detector that feeds a claim about a prospect is tuned on real pages before it ships: run it on the study set, read every positive's evidence, and turn each false positive into a test. Marketplace/engine links count only on a listing or a tenant subdomain, never the vendor's home page.
TAGS: research, site-crawl, detectors, P4

[2026-10-30] Platform scripts are on every site of that platform: they are not evidence of a feature
WHAT HAPPENED: Wix loads its "wixstores" bundle and Squarespace draws a /cart icon on every site; the first ecommerce detector flagged a treehouse lodge and a hotel as online stores. A translation-tool regex (/wpml/i) matched "wpmL" inside minified code on a Shopify page.
RULE: Fingerprints run on raw HTML match asset URLs or exact tokens (cdn.weglot.com, plugins/sitepress-multilingual-cms), case-sensitive where possible, and a feature counts only with a user-facing signal (add-to-cart text, a Product with offers), not because the platform's bundle is loaded.
TAGS: research, site-crawl, fingerprints

[2026-10-30] cheerio's default parser is 5x the CPU of htmlparser2 on real pages
WHAT HAPPENED: On 200 saved study pages (270 KB average) cheerio.load with parse5 took 7.1 s CPU, with `{ xml: { xmlMode: false, decodeEntities: true } }` (htmlparser2) 1.3 s, same links and text. Per site the crawl dropped from 0.45 s to 0.27 s CPU, which is what fits the Vercel free-plan budget at 700 sites a week.
RULE: Any cron that parses many third-party pages on Vercel measures CPU per item on real pages and uses htmlparser2 unless parse5's spec-exact tree is needed. lib/research/scraper.ts still uses the default (not changed here: it is read-only for this task).
TAGS: vercel, cpu, cheerio, P5

[2026-10-30] Our own User-Agent, honestly named, and robots.txt
WHAT HAPPENED: lib/research/scraper.ts sends a plain Chrome UA. For the crawler the auto-mode classifier refused a UA comparison as bot-check circumvention, which is the right call: the crawler names itself (`Mozilla/5.0 (compatible; RunnaSiteCheck/1.0; +https://runna.com.mx)`) and honours robots.txt. With it, 32/33 study sites answered; one answered 429 on two of four runs and comes out "blocked" = could not see, which is the safe outcome.
RULE: Never dress a crawler up as a browser to get past a bot wall. A refusal is stored as "blocked" (found = null everywhere), never as an absence.
TAGS: research, crawling, ethics

## Out of scope, noticed
- lib/research/scraper.ts:14 sends a browser User-Agent (Chrome 124) to get past bot walls; the new crawler names itself honestly. Worth aligning (conductor/Pedro decision).
- lib/research/scraper.ts parses with cheerio's default parse5 (5x the CPU of htmlparser2 on real pages, see above); research runs inside the tick budget.
- The conductor's prototype saw a Wix lodge (hiddenacrestreehouseresort.com) return 0 links; with this crawler's request the same home page came back server-rendered with 25 links and "Book Now" → secure.webrez.com (WebRezPro). The JS-shell case is covered by a fixture derived from that page with the body removed.
