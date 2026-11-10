[2026-11-09] A name check over folded tokens misses possessives: "CrushCamp's" is not "CrushCamp"
WHAT HAPPENED: Making the web dive require the business name in the quote (lib/research/web-dive/match.ts tieToBusiness), the fold that strips apostrophes turned "CrushCamp's café" into the token "crushcamps", so a real quote about the business failed the name check. Found by the rewritten keep-check test (tests/web-dive-keep.test.ts, "rule 2 fold"), not by reading the code. Fixed by reading the quote twice: as written and with English possessives dropped (quoteNames), so a business really called "O'Neil's" still matches itself.
RULE: When a check tightens from "the name is somewhere on the page" to "the name is in this exact sentence", test it on the forms real sentences use (possessive, plural, the name inside a longer word, accents), both ways, before trusting it. A stricter rule that silently drops true cases is a quiet loss, not a safe default.
TAGS: web-dive, matching, tests

[2026-11-09] Age limits in days: count calendar days, not hours
WHAT HAPPENED: recentEnough first compared milliseconds, so a page dated exactly 180 days before "today" failed at 18:00 UTC and passed at 06:00. The test with a fixed clock caught it. It now counts whole UTC calendar days between the page's day and today's.
RULE: A limit written as "N days old" compares calendar days (both sides truncated to a day), never a timestamp against a date at midnight.
TAGS: web-dive, dates

[2026-11-10] "The URL has their name in it" is not "it is their page": hashtag and search pages carry the name too
WHAT HAPPENED: The first version of the web dive's profile tie (lib/research/web-dive/match.ts) accepted any URL whose path had a segment equal to the business's domain label. The independent reviewer showed youtube.com/hashtag/crushcamp, x.com/hashtag/crushcamp, reddit.com/search/crushcamp and instagram.com/explore/tags/crushcamp all passed, so a job post by anyone ("we are hiring two coaches") would have reached the email as CrushCamp's opening. My own property test used the same "segment equals label" idea, so it could not catch it. Fixed with isOwnProfile: a social site whose path STARTS with the label.
RULE: When a check decides "whose page is this", write down what pages look like that carry the name but belong to nobody (tags, search, explore, directories, lists), and test those first. An independent check in a property test must not reuse the rule it checks.
TAGS: web-dive, matching, review

[2026-11-10] Never put a placeholder in a command Pedro will run: give the full, real command
WHAT HAPPENED: The wrap-up gave `node … scripts/web-dive-samples.ts <the 10 ids>` in a bash block with a Run button. Pedro ran it as is and zsh failed with "parse error near `\n'" (it read `<` as a redirect). The command also pointed at `.env.local` in the worktree, which has none; the file is only in the main checkout, which has the old script.
RULE: A command the person runs is a deliverable: paste the real values (ids, paths), never a <placeholder>; check which folder has the files it needs (env file, the new code) with an existence check, and dry-run it without secrets (no ids → usage) before handing it over.
TAGS: handoff, commands, worktree

## Out of scope, noticed
- The page-loads check fails closed on sites that refuse robots (Yelp 403, LinkedIn 999, Instagram login redirect), so most review and social facts will never reach a draft. That is the rule as asked; the next sample run measures how many facts survive (scripts/web-dive-samples.ts prints "would reach a draft").
- The web search tool is `web_search_20250305`; Sonnet 4.6+ also offers `web_search_20260209` (dynamic filtering). Not changed here: its citation shape may differ, and the keep-check depends on citations.
