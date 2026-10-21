[2026-10-21] Action tests can load a "use server" file with a loader hook
WHAT HAPPENED: tests/benchmark-review-ui.test.ts imports lib/benchmarks/actions.ts for real, stubbing only next/cache, @/lib/auth and @/lib/supabase/server through a module loader hook, with a fake client that records each query's filters. That let the test assert the WHERE of every write (tenant, unverified, unrejected, allowed from-states), not just the result.
RULE: assert a write's filters, not only its outcome; a fake that applies the filters and records them proves both that the guard exists and that it works. Node's strip-only TypeScript rejects constructor parameter properties in test files.
TAGS: benchmarks, testing

## Out of scope, noticed
- tests/vercel-config.test.ts "every per-route limit names a route file that exists" fails on the integration branch: vercel.json lists app/api/benchmarks/research/route.ts, which the fact-research worker has not added yet. Goes green when that PR merges.
