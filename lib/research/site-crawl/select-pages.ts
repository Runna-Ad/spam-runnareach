/**
 * Which of the home page's links to open: up to MAX_SUBPAGES same-site pages,
 * one per kind first (contact, booking, menu, services, pricing, shop, about,
 * rooms) so a crawl covers the places a fact can live, then the next-best.
 * Matched on link text first, then on the path. EN, ES and a little FR.
 */

import type { PageLink } from "./parse.ts";

export const MAX_SUBPAGES = 7;

export const PAGE_KINDS: Array<{ role: string; re: RegExp }> = [
  { role: "contact", re: /contact|cont[aá]ct[ae]nos|nous joindre|joindre|ubicaci[oó]n|location|find us|visit us|vis[ií]tanos/i },
  { role: "booking", re: /\bbook|reserv|r[ée]serv|agenda|\bcitas?\b|appointment|schedule|availability|disponibilidad/i },
  { role: "menu", re: /\bmen[uú]s?\b|\bcarta\b|food|drinks/i },
  { role: "services", re: /servic|treatment|tratamiento|what we do|qu[ée] hacemos|programs?\b|programas|\btours?\b|activit|actividades|experiences?/i },
  { role: "pricing", re: /pric|\brates?\b|tarif|precio|cotiza|quote|packages?|paquetes/i },
  { role: "shop", re: /\bshop\b|store|tienda|boutique|productos?|products?|cat[aá]log/i },
  { role: "about", re: /about|nosotros|qui[ée]nes somos|[àa] propos|our story|historia|our team|equipo/i },
  { role: "rooms", re: /\brooms?\b|suites?|habitaci|accommodat|alojamiento|cabins?|caba[ñn]as|lodging|chambres?|stay/i },
];

const SKIP_PATH = /\/(wp-admin|wp-login|cart|checkout|account|login|signin|my-account|feed|search)(\/|$)|[?&](s|q|sort_by|filter[^=]*)=|\.(pdf|jpe?g|png|gif|webp|svg|zip|docx?|xlsx?|mp4|mp3)(\?|$)/i;

export const bareHost = (u: URL) => u.hostname.toLowerCase().replace(/^www\./, "");

/** Same site: identical host ignoring www. */
export function sameSite(href: string, base: string): boolean {
  try {
    return bareHost(new URL(href)) === bareHost(new URL(base));
  } catch {
    return false;
  }
}

/** The URL without fragment, trailing slash folded, for dedupe. */
export function pageKey(href: string): string {
  try {
    const u = new URL(href);
    u.hash = "";
    const path = u.pathname.replace(/\/+$/, "") || "/";
    return `${bareHost(u)}${path}${u.search}`;
  } catch {
    return href;
  }
}

/**
 * `allowed` is robots.txt: a page the site asks crawlers to skip is never
 * chosen (the next-best link is). Like every page past the first seven, it is
 * simply not one of the pages read; `pages` on the observation lists the ones that were.
 */
export function selectPages(
  links: PageLink[],
  homeUrl: string,
  max = MAX_SUBPAGES,
  allowed: (url: string) => boolean = () => true,
): Array<{ url: string; role: string }> {
  const homeKey = pageKey(homeUrl);
  const candidates = links.filter((l) => {
    if (l.fragment || !/^https?:/i.test(l.href) || !sameSite(l.href, homeUrl)) return false;
    if (SKIP_PATH.test(l.href) || !allowed(l.href)) return false;
    return pageKey(l.href) !== homeKey;
  });
  const pathOf = (href: string) => {
    try {
      return decodeURIComponent(new URL(href).pathname);
    } catch {
      return href;
    }
  };

  const chosen: Array<{ url: string; role: string }> = [];
  const seen = new Set<string>();
  const take = (href: string, role: string) => {
    const key = pageKey(href);
    if (seen.has(key) || chosen.length >= max) return false;
    seen.add(key);
    const u = new URL(href);
    u.hash = "";
    chosen.push({ url: u.toString(), role });
    return true;
  };

  // Round 1: the best link of each kind (text match beats a path match).
  for (const kind of PAGE_KINDS) {
    const byText = candidates.find((l) => kind.re.test(l.text) && !seen.has(pageKey(l.href)));
    const byPath = byText ?? candidates.find((l) => kind.re.test(pathOf(l.href)) && !seen.has(pageKey(l.href)));
    if (byPath) take(byPath.href, kind.role);
  }
  // Round 2: further matches of any kind, in page order.
  for (const l of candidates) {
    if (chosen.length >= max) break;
    const kind = PAGE_KINDS.find((k) => k.re.test(l.text) || k.re.test(pathOf(l.href)));
    if (kind) take(l.href, kind.role);
  }
  return chosen;
}
