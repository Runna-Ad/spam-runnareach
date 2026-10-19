[2026-10-19] A count of "what the pipeline would pick" shares the pipeline's predicate, row mapper and columns
WHAT HAPPENED: The weekly report now counts past pitches that qualify as exemplars. selectExemplars was split into a target-independent `qualifiesAsExemplar` (lib/pitches/exemplars.ts) that the selector itself calls plus a private target match, and fetchExemplars's row mapping (suppressed prospect skipped, critic/override parsing), select columns, switch and do-not-contact normalisation were exported from lib/pitches/exemplar-queries.ts so lib/reports/snapshot.ts reads the same columns and lib/reports/weekly.ts maps them the same way. A property test over random candidates checks both directions (every pick is counted with the same score; every counted pitch is picked for its own segment); it fails when the selector is mutated to be stricter (skip critic_pass null) and when it is looser (ignore bounces).
RULE: When a report answers "how many would stage X pick", do not re-describe X's rules: move the target-independent part of X's filter into one exported function that X calls, and share X's row mapper and select string too (the mapping is where silent drift lives: `typeof critic_pass === "boolean"`, `gate_override.codes`). Guard it with a two-way property test and show it failing under one stricter and one looser mutation of X.
TAGS: pitches, exemplars, reports, one-predicate, property-test

[2026-10-19] A scan window is not an eligibility rule: say which one a count mirrors
WHAT HAPPENED: fetchExemplars reads only the 200 newest settled root sends per language (CANDIDATE_SCAN) and scores at most 100 per target (EXEMPLAR_SHORTLIST). The brief asked the readiness count to cover every settled root send, so it counts every pitch that meets the rules, including ones fetchExemplars cannot reach today. The two agree while a language has at most 200 settled sends (prod: 178 in total) and drift apart after that.
RULE: When a count is meant to match a selector, list the selector's capacity limits (LIMIT, shortlist size, time budget) next to its rules and decide on purpose whether the count mirrors them. Write the decision in the report or line it feeds, not only in the code.
TAGS: reports, exemplars, limits

[2026-10-19] To check that "the HTML shows every number of the text", compare number counts in what the reader sees
WHAT HAPPENED: The weekly report gained a designed HTML part (lib/reports/weekly.ts formatWeeklyReportHtml). Its test strips tags and decodes entities first, then checks that every number token in the text version appears at least as often in the HTML. On the raw source a substring check passes for free, because the inline styles are full of digits (padding:24px, font-size:14px). The same tag-stripping found that the footer legend "n/a = no data." counted as an n/a value.
RULE: Make assertions about rendered email HTML on the visible text (tags dropped, entities decoded), and compare counts of tokens, not just their presence. Assert colours and markup on the one row you mean (split on "<tr>", find the label cell), not on the whole document.
TAGS: reports, html, email, tests

## Out of scope, noticed
- lib/reports/snapshot.ts `all()`: after MAX_PAGES (20 000 rows) it returns the partial list as if it were complete, so a count over it comes out low with no "n/a". Not an issue at today's volumes.
- The Exemplars line prints "off (EXEMPLARS_ENABLED unset)" (the brief's wording) for any value other than "1", including e.g. "true", which fetchExemplars also treats as off.
