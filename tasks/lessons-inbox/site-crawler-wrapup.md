<!-- conductor: late lessons from the site-crawler WRAP UP (2026-10-30), after the worker's inbox file -->
[2026-10-30] A detector's absence needs every path that hides the thing covered: forms and buttons, not just links
WHAT HAPPENED: Booking only read `<a href>` links. Hotel Zed's "Book Now" is the submit button of an availability form posting to reservations.hotelzed.com, so with every page readable the hotel came out as "no booking" plus a 7-field contact form. The fix resolves form actions, submit text, date fields, onclick and data-href buttons, and adds a coarse fail-closed check.
RULE: Before writing `found:false`, list every HTML way the feature can appear (link, form, button, script, iframe). Resolve each one, or make an unresolved hint give null.
TAGS: research, site-crawl, P4, P6

[2026-10-30] Fail-closed matching misfires too: re-run it on the real study set before pushing
WHAT HAPPENED: The first coarse booking check matched substrings ("Capacitación" holds "cita", "Reservoir" holds "reserv", "Textbook" holds "book"). Six readable sites went to null. Word-start matching, plus explaining a link by the readable page it leads to, fixed it.
RULE: A fail-closed matcher is still a classifier. Run it on the real pages, read every null it creates, and turn each false trigger into a test.
TAGS: research, site-crawl, P6

[2026-10-30] Text extracted by htmlparser2 glues neighbouring elements together
WHAT HAPPENED: `$("body").text()` returned "GalleryReservations", so word-boundary regexes over page text missed real mentions. A space inserted before element boundaries fixed it (~2.5 ms CPU per page).
RULE: Any word match over extracted page text keeps element boundaries as whitespace.
TAGS: parsing, cheerio

[2026-10-30] Form-field words must be whole words
WHAT HAPPENED: The booking-form date check matched "depart" inside "department", so a plain contact form counted as a booking form and contact_form said false.
RULE: Match words in field names with letter boundaries; drop a form from one check only when another check actually resolved it.
TAGS: research, site-crawl, forms

## Out of scope, noticed
- lib/research/scraper.ts:14 sends a Chrome UA (align with the honest crawler UA: Pedro's call); it still parses with parse5 (5x CPU).
- PageSpeed runs in parallel with robots.txt: Google fetches a refusing site once before we drop the result.
