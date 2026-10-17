nothing new

## Out of scope, noticed
- `lib/autopilot/learn.ts` uses learner names `writer.evidence`, `writer.guidance`, `scout.cell`, `icp`; the labels in `lib/learning/report.ts` are keyed on those strings and unknown learners fall back to the raw name.
