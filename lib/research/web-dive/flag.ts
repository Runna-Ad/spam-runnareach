/**
 * The web dive is switched OFF unless WEB_DIVE_ENABLED is exactly "1".
 *
 * Pedro, 2026-11-09, after a real sample run (kept facts were employee
 * reviews, auto-generated summaries and dead job posts): ship with the web
 * search off and tighten it in a later task. Off:
 *   - /api/research/web-dive answers { ok: true, skipped: "disabled" } inside its
 *     heartbeat: no claim, no Claude call, no cost;
 *   - the tick's first-draft step counts the web look as done, so a prospect is
 *     drafted once its SITE look is finished (or after the look timeout).
 * One predicate: the route and the tick both ask this. Pure: no imports.
 */

export function webDiveEnabled(env: Readonly<Record<string, string | undefined>> = process.env): boolean {
  return env.WEB_DIVE_ENABLED === "1";
}
