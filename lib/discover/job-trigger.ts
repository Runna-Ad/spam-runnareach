import "server-only";

/**
 * Self-invocation helper for the background discovery worker.
 *
 * The worker (/api/discover/run) drives a job one slice at a time and re-triggers
 * the next slice by calling itself. Two things make that work:
 *
 * 1. ORIGIN is derived from the ACTUAL incoming request (host header / req.url),
 *    never guessed from env — so it's correct in dev (whatever port), preview,
 *    and prod without configuration. (NEXT_PUBLIC_APP_URL can be stale/wrong
 *    port in dev, so we don't trust it here.)
 * 2. There is no user session on a bare server-to-server fetch, so we FORWARD
 *    the caller's session cookie — keeping the pipeline's cookie-based
 *    requireUser() working across the whole chain with no session-less refactor.
 */

/** Build an absolute origin from a Headers object (host + forwarded proto). */
export function originFromHeaders(h: Headers): string | null {
  const host = h.get("x-forwarded-host") ?? h.get("host");
  if (!host) return null;
  const proto = h.get("x-forwarded-proto") ?? (host.startsWith("localhost") ? "http" : "https");
  return `${proto}://${host}`;
}

/**
 * Fire-and-forget the next worker slice. Caller should schedule this via
 * next/server `after()` so the platform keeps the function alive long enough to
 * send the request after the response returns.
 */
export async function triggerNextSlice(
  jobId: string,
  cookieHeader: string,
  origin: string,
): Promise<void> {
  try {
    await fetch(`${origin}/api/discover/run`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        cookie: cookieHeader,
      },
      body: JSON.stringify({ jobId }),
      // Don't wait on the slice itself — it re-triggers its own successor.
      cache: "no-store",
    });
  } catch {
    // A dropped trigger leaves the job mid-run; the janitor cron's stale-heartbeat
    // sweep will mark it failed so the user can re-run. Nothing to do here.
  }
}
