[2026-10-22] Build a reason-string classifier's test inputs with the code that writes the reasons, plus a fixture-is-clean check
WHAT HAPPENED: The pre-send guardrail (lib/learning/presend.ts heldForWriting) reads auto_rejected_reason strings that governor laneFor + heldAction write. The tests build every reason by calling those two functions on a clean LaneInput with one field changed. A first test asserting the clean fixture is lane "auto" failed at once: I had guessed the trusted address source as "website_scrape" (the real list says "scraper"), so every "writing-only" case also carried an untrusted-source reason and the exclusion tests would have passed for the wrong reason.
RULE: When a module classifies strings another module writes, generate the test inputs by calling the writer, and add one assertion that the base fixture produces no reasons at all. Each case then changes exactly one thing, and a wrong guess about the fixture fails loudly instead of making every negative case pass vacuously.
TAGS: learning, autopilot, testing

[2026-10-22] A Bayesian "P(A worse than B)" with integer counts has an exact closed form; prefer it over Monte Carlo for an autonomous retire rule
WHAT HAPPENED: The brief asked for Beta posteriors with a seeded RNG. With Monte Carlo, a challenger near the 0.9 line could flip between retire and keep tick to tick on the same counts. lib/learning/presend.ts probabilityWorse uses the exact sum for integer Beta parameters (lnGamma, ~n terms), and the test checks it against a seeded Monte Carlo (within 0.006) and that P(A>B)+P(B>A)=1.
RULE: For a threshold rule that acts without a person, make the statistic deterministic in its inputs (exact or fixed-seed), so the same evidence always gives the same decision and the boundary tests are exact.
TAGS: learning, bandit

## Out of scope, noticed
- lib/prompts/queries.ts still reads prompt_change_proposals for `pending_proposals` / `proposals` (nothing shows them on /learning now); components/settings/prompts-page.tsx still shows a "pending" count and calls reviewProposal. Same dead-end path, outside this brief's allow-list.
- lib/autopilot/tick.ts dropDraft writes the governor's reason text into auto_rejected_reason with no shared constants (governor's reason strings are inline literals). presend.ts matches their exact shapes and the test builds them from laneFor/heldAction, but a shared constants export in governor.ts would be sturdier.
- A rewrite draws its writer arms afresh (chooseWriterArms in generatePitch), so a draft "still held after one rewrite" counts against the arm the REWRITE drew, which may differ from the original's. Fine for the guardrail (it judges the drafts each arm wrote), but worth knowing when reading per-arm numbers.
