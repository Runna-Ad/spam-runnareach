import "server-only";
import { systemAuthHeaders } from "@/lib/actor";

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
 *    either the caller's session cookie, or, for a job the autopilot runs, the
 *    cron secret + tenant (the worker then builds the system actor, see
 *    lib/actor.ts).
 */

/** How the next slice proves who it runs for. */
export type SliceAuth = { kind: "cookie"; cookie: string } | { kind: "system"; tenantId: string };

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
  auth: SliceAuth,
  origin: string,
): Promise<void> {
  try {
    await fetch(`${origin}/api/discover/run`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(auth.kind === "system" ? systemAuthHeaders(auth.tenantId) : { cookie: auth.cookie }),
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
