/**
 * The link-only address. Cold emails carry two links on it: the tracked free
 * check (/r/<code>) and the unsubscribe page (/api/unsubscribe). It is an alias
 * of this whole app, so before this lock it also served the S.P.A.M. sign-in
 * page to anyone who opened its main page.
 *
 * On 2026-11-10 Google Safe Browsing listed runna-check.vercel.app as a site
 * that "tries to trick visitors into sharing personal info": a cold-email link
 * that leads to a password box is the phishing pattern. On 2026-11-11 Gmail
 * refused to send all 4 first emails carrying it, the inbox_bounces breaker
 * paused the inbox, and the same app at spam-runnareach.vercel.app (never in an
 * email) stayed clean.
 *
 * So on a link-only host the proxy serves the paths below and answers 404 to
 * everything else, before any auth work. The app's own host is untouched.
 */

/** Hosts that serve email links only, never the app. */
export const LINK_ONLY_HOSTS: readonly string[] = ["runna-check.vercel.app"];

/**
 * Google Search Console's ownership file for https://runna-check.vercel.app/
 * (public/<this>). Search Console re-checks it from time to time, so it stays.
 */
export const SEARCH_CONSOLE_FILE = "/googlef5439ad9e6d54e3a.html";

/** Is this host link-only? Case and a trailing port do not matter. */
export function isLinkOnlyHost(host: string | null | undefined): boolean {
  if (!host) return false;
  const bare = host.toLowerCase().replace(/:\d+$/, "").replace(/\.$/, "");
  return LINK_ONLY_HOSTS.includes(bare);
}

/** May a link-only host serve this path? */
export function allowedOnLinkHost(pathname: string): boolean {
  if (pathname === SEARCH_CONSOLE_FILE) return true;
  if (pathname === "/api/unsubscribe") return true;
  // /r/<code>: one segment after /r/, any characters (the route itself decides
  // what an unknown code does: it still redirects to the free check).
  return /^\/r\/[^/]+$/.test(pathname);
}
