/**
 * Site facts: what the writer may state as SEEN on the prospect's website, and
 * what the critic judges every site claim against (brief site-facts-writer).
 *
 * Built in code from the newest `ok` site observation (0054,
 * lib/research/site-crawl/types.ts), no AI call. Pure: zero server imports.
 *
 * The rules every entry follows:
 *   - Only from found: true (kind "seen") or found: false (kind "absence").
 *     found: null is "could not see": never a fact, never an absence.
 *   - Each fact carries the URL of the page that shows it. A fact with no URL
 *     is not a fact and is dropped.
 *   - An absence says what the false means and no more: tel false is "no
 *     tap-to-call link", never "no phone"; no structured hours is never "no
 *     hours". Its URL is the home page, its text names the pages we read.
 *   - Booking weak (only an on-page anchor or a booking word on an ordinary
 *     link) is worded softly and carries strength "weak".
 *   - PageSpeed only when psi_status = 'ok'.
 *   - Plain English; the writer translates.
 *
 * Every text taken from the site (link text, a host) is clipped and stripped
 * of quotes and line breaks: it is data inside our sentence, never a
 * sentence of its own.
 */

import { bareHost } from "../research/site-crawl/select-pages.ts";

export type SiteFactKind = "seen" | "absence";

export type SiteFact = {
  /** The check it comes from (booking, contact_form, psi…). One fact per check. */
  id: string;
  /** "seen": the crawler saw it. "absence": every page it could be on was read and it was not there. */
  kind: SiteFactKind;
  fact: string;
  /** The page that shows it (for an absence: the home page; `fact` names every page read). */
  url: string;
  /** "weak": say it softly ("it looks like…"). Only booking is ever weak. */
  strength: "strong" | "weak";
};

/** The columns of a site_observations row this reads. */
export type SiteObservationRow = {
  url?: unknown;
  final_url?: unknown;
  status?: unknown;
  pages?: unknown;
  checks?: unknown;
  psi?: unknown;
  psi_status?: unknown;
};

/** The read runs beside the prospect and research reads; past this it is [] (the draft goes on). */
export const SITE_FACTS_READ_TIMEOUT_MS = 5_000;

/** An observation older than this is not "what their site shows" any more. */
export const SITE_FACTS_MAX_AGE_DAYS = 60;

// ── Reading the jsonb defensively ─────────────────────────────────────────────

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);
const str = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v.trim() : null);
const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
const strings = (v: unknown): string[] => (Array.isArray(v) ? v.flatMap((x) => (typeof x === "string" && x.trim() ? [x.trim()] : [])) : []);
const httpUrl = (v: unknown): string | null => {
  const s = str(v);
  return s && /^https?:\/\//i.test(s) ? s : null;
};

type Ev = { url: string; text: string | null; href: string | null };

/** Evidence entries with a real page URL; the rest are dropped (no URL, no fact). */
function evidenceOf(check: Obj): Ev[] {
  const list = Array.isArray(check.evidence) ? check.evidence : [];
  return list.flatMap((e) => {
    if (!isObj(e)) return [];
    const url = httpUrl(e.url);
    return url ? [{ url, text: str(e.text), href: str(e.href) }] : [];
  });
}

/** Site text inside our sentence: one line, no quotes, clipped. */
function quoteable(s: string | null, max = 60): string | null {
  if (!s) return null;
  const t = s
    .replace(/[\u200b-\u200d\ufeff]/g, "")
    .replace(/["'“”‘’`«»]/g, "")
    .replace(/\s+/g, " ")
    .trim();
  if (!t) return null;
  return t.length > max ? `${t.slice(0, max - 1).trimEnd()}…` : t;
}

function hostOf(href: string | null): string | null {
  if (!href || !/^https?:/i.test(href)) return null;
  try {
    return new URL(href).hostname.replace(/^www\./, "") || null;
  } catch {
    return null;
  }
}

/** The pages an absence covers, by role ("home, rooms, contact"). */
function pagesRead(pages: unknown): string {
  const roles = (Array.isArray(pages) ? pages : []).flatMap((p) => (isObj(p) && str(p.role) ? [str(p.role) as string] : []));
  const unique = [...new Set(roles.map((r) => r.replace(/_/g, " ").toLowerCase()))].slice(0, 8);
  return unique.length > 0 ? unique.join(", ") : "home";
}

/** Platform names as people say them. */
const SOCIAL_NAMES: Record<string, string> = {
  facebook: "Facebook", instagram: "Instagram", x: "X (Twitter)", twitter: "X (Twitter)", linkedin: "LinkedIn",
  tiktok: "TikTok", youtube: "YouTube", pinterest: "Pinterest", whatsapp: "WhatsApp", yelp: "Yelp",
};
const LANGUAGE_NAMES: Record<string, string> = { en: "English", es: "Spanish", fr: "French", pt: "Portuguese", de: "German", zh: "Chinese", it: "Italian" };
const languageName = (code: string) => LANGUAGE_NAMES[code.slice(0, 2).toLowerCase()] ?? code;
const list = (xs: string[]) => (xs.length <= 1 ? (xs[0] ?? "") : `${xs.slice(0, -1).join(", ")} and ${xs[xs.length - 1]}`);

// ── One fact per check ────────────────────────────────────────────────────────

type Ctx = { home: string; pages: string };
type Mapper = (check: Obj, ctx: Ctx) => SiteFact | null;

const seen = (id: string, fact: string, url: string, strength: "strong" | "weak" = "strong"): SiteFact => ({ id, kind: "seen", fact, url, strength });
/** `note` says what the absence does NOT mean ("this says nothing about…"). */
const absence = (id: string, fact: string, ctx: Ctx, note?: string): SiteFact => ({
  id,
  kind: "absence",
  fact: `${fact} on the pages we read (${ctx.pages})${note ? `; ${note}` : ""}`,
  url: ctx.home,
  strength: "strong",
});

function bookingFact(check: Obj, ctx: Ctx): SiteFact | null {
  const online = check.online === true || check.online === false ? check.online : check.found === true || check.found === false ? check.found : null;
  const channel = str(check.channel);
  const ev = evidenceOf(check);
  const first = ev[0];
  // The detector writes a form as `form "Book Now"` and a script as "booking widget".
  const formText = /^form\s+"([^"]*)"$/i.exec(first?.text ?? "")?.[1] ?? null;
  const widget = /^booking widget$/i.test(first?.text ?? "");
  const label = widget ? null : quoteable(formText ?? first?.text ?? null);
  const noun = (fallback: string) => (formText !== null ? "form" : widget ? "booking widget" : fallback);
  const named = (fallback: string) => (label ? `Their '${label}' ${noun(fallback)}` : `A ${noun(fallback)} on their site`);
  if (online === true) {
    if (!first) return null;
    const host = hostOf(first.href);
    if (check.strength === "weak") {
      const onPage = first.href?.startsWith("#") ? " (it opens something on the same page)" : "";
      return seen("booking", `${named("link")} looks like a way to book, but we could not see where it leads${onPage}`, first.url, "weak");
    }
    if (channel === "external_engine") return seen("booking", `${named("button")} goes to an outside booking engine${host ? ` (${host})` : ""}`, first.url);
    if (channel === "marketplace") return seen("booking", `${named("link")} goes to a booking listing${host ? ` on ${host}` : ""}`, first.url);
    if (channel === "on_site") return seen("booking", `${named("link")} goes to a booking page or form on their own site`, first.url);
    return null;
  }
  // No online path resolved. WhatsApp / phone are the only paths seen; "only" needs online = false.
  if (channel === "whatsapp" || channel === "phone") {
    if (!first) return null;
    const how = channel === "whatsapp" ? "opens a WhatsApp chat" : "starts a phone call";
    const ask = label ? `'${label}' ${how}` : `the booking link ${how}`;
    // "only" is the absence here (online false: every page read, no online path); never "no booking".
    return online === false
      ? seen("booking", `The only way to book we saw is by ${channel === "whatsapp" ? "WhatsApp" : "phone"} (${ask}), on the pages we read (${ctx.pages})`, first.url)
      : seen("booking", `${label ? `Their '${label}' link` : "A booking link"} ${how}`, first.url);
  }
  if (online === false) return absence("booking", "No way to book online was found", ctx);
  return null;
}

const MAPPERS: Record<string, Mapper> = {
  booking: bookingFact,
  ecommerce: (c, ctx) => {
    const first = evidenceOf(c)[0];
    if (c.found === true) return first ? seen("ecommerce", "Their site sells online (a shop, cart or checkout)", first.url) : null;
    if (c.found === false) return absence("ecommerce", "No online shop, cart or checkout was found", ctx);
    return null;
  },
  chat: (c, ctx) => {
    const first = evidenceOf(c)[0];
    const values = strings(c.values);
    if (c.found === true) {
      if (!first) return null;
      const wa = values.some((v) => /whatsapp/i.test(v));
      const widgets = values.filter((v) => !/whatsapp/i.test(v)).map((v) => quoteable(v, 30)).filter((v): v is string => Boolean(v));
      const what = widgets.length > 0 ? `a live chat (${list(widgets)})${wa ? " and a WhatsApp chat link" : ""}` : wa ? "a WhatsApp chat link" : "a live chat";
      return seen("chat", `Their site has ${what}`, first.url);
    }
    if (c.found === false) return absence("chat", "No live chat or WhatsApp chat link was found", ctx);
    return null;
  },
  contact_form: (c, ctx) => {
    const ev = evidenceOf(c);
    const first = ev[0];
    if (c.found === true) {
      if (!first) return null;
      const box = ev.some((e) => /message box/i.test(e.text ?? ""));
      const embedded = ev.every((e) => /embedded form/i.test(e.text ?? ""));
      const fields = num(c.fields);
      const where = first.url === ctx.home ? "The home page" : "Their site";
      const detail = embedded ? " (an embedded form)" : fields ? ` (${fields} fields${box ? ", with a message box" : ""})` : box ? " with a message box" : "";
      return seen("contact_form", `${where} has a contact form${detail}`, first.url);
    }
    if (c.found === false) return absence("contact_form", "No contact form was found", ctx);
    return null;
  },
  tel: (c, ctx) => {
    const first = evidenceOf(c)[0];
    if (c.found === true) return first ? seen("tel", "Their phone number is a tap-to-call link", first.url) : null;
    if (c.found === false) return absence("tel", "No tap-to-call phone link was found", ctx, "a number written as plain text may still be there, so this says nothing about whether they list a phone number");
    return null;
  },
  mailto: (c, ctx) => {
    const first = evidenceOf(c)[0];
    if (c.found === true) return first ? seen("mailto", "There is a clickable email link", first.url) : null;
    if (c.found === false) return absence("mailto", "No clickable email link was found", ctx, "an address written as plain text may still be there, so this says nothing about whether they list an email");
    return null;
  },
  social: (c, ctx) => {
    const first = evidenceOf(c)[0];
    const names = [...new Set(strings(c.values).map((v) => SOCIAL_NAMES[v.toLowerCase()] ?? quoteable(v, 20)).filter((v): v is string => Boolean(v)))];
    if (c.found === true) return first ? seen("social", names.length > 0 ? `Their site links to their ${list(names)}` : "Their site links to their social media", first.url) : null;
    if (c.found === false) return absence("social", "No links to social media were found", ctx);
    return null;
  },
  mobile_viewport: (c, ctx) => {
    const first = evidenceOf(c)[0];
    if (c.found === true) return first ? seen("mobile_viewport", "The home page has the setting that makes it fit a phone screen (a mobile viewport tag)", first.url) : null;
    // The home page's <head> is enough for this one: its URL is the home page.
    if (c.found === false) return { id: "mobile_viewport", kind: "absence", fact: "The home page has no phone-friendly viewport setting (the setting that makes a page fit a phone screen)", url: first?.url ?? ctx.home, strength: "strong" };
    return null;
  },
  jsonld: (c, ctx) => {
    const first = evidenceOf(c)[0];
    if (c.found === true) return first ? seen("jsonld", "Their site has structured data for search engines (schema.org)", first.url) : null;
    if (c.found === false) return absence("jsonld", "No structured data for search engines (schema.org) was found", ctx);
    return null;
  },
  jsonld_opening_hours: (c, ctx) => {
    const first = evidenceOf(c)[0];
    if (c.found === true) return first ? seen("jsonld_opening_hours", "Their opening hours are in the site's structured data, so search engines can read them as hours", first.url) : null;
    if (c.found === false) return absence("jsonld_opening_hours", "Their opening hours are not in the site's structured data for search engines", ctx, "hours written on the page may still be there, so this never means the hours are missing");
    return null;
  },
  jsonld_rating: (c, ctx) => {
    const first = evidenceOf(c)[0];
    if (c.found === true) {
      const value = num(c.value);
      const count = num(c.count);
      if (!first) return null;
      return seen("jsonld_rating", `Their site's own structured data shows a review rating${value !== null ? ` of ${value}` : ""}${count !== null ? ` from ${count} reviews` : ""}`, first.url);
    }
    if (c.found === false) return absence("jsonld_rating", "No review rating was found in the site's structured data", ctx, "this says nothing about their reviews on Google or elsewhere");
    return null;
  },
  copyright_year: (c) => {
    // false (no copyright line) is not worth a sentence: no fact.
    const first = evidenceOf(c)[0];
    const year = num(c.year);
    if (c.found === true && first && year !== null) return seen("copyright_year", `The copyright line on their site says ${year}`, first.url);
    return null;
  },
  builder: (c) => {
    // false = no builder we recognise (custom or unknown): nothing to say.
    const first = evidenceOf(c)[0];
    const value = quoteable(str(c.value), 40);
    if (c.found === true && first && value) return seen("builder", `Their site is built on ${value}`, first.url);
    return null;
  },
  languages: (c, ctx) => {
    const first = evidenceOf(c)[0];
    const langs = [...new Set(strings(c.values).map(languageName))];
    if (c.found === true) return first ? seen("languages", langs.length > 1 ? `Their site comes in more than one language (${list(langs)})` : "Their site comes in more than one language", first.url) : null;
    if (c.found === false) return absence("languages", "No version of the site in another language was found", ctx, langs.length === 1 ? `the pages are in ${langs[0]}` : undefined);
    return null;
  },
  analytics: (c, ctx) => {
    const first = evidenceOf(c)[0];
    const tools = strings(c.values).map((v) => quoteable(v, 30)).filter((v): v is string => Boolean(v));
    if (c.found === true) return first ? seen("analytics", tools.length > 0 ? `Their site loads visitor tracking or ad tools (${list(tools)})` : "Their site loads visitor tracking or ad tools", first.url) : null;
    if (c.found === false) return absence("analytics", "No visitor tracking or ad tools (Google Analytics, Meta Pixel and the like) were found", ctx);
    return null;
  },
};

/** The order facts are listed in: the ones a pitch leans on first. */
export const SITE_FACT_CHECKS = Object.keys(MAPPERS);

/** Google's own bands for a Lighthouse score. */
function psiBand(score: number): string {
  if (score >= 90) return "good";
  if (score >= 50) return "needs improvement";
  return "poor";
}

function psiFact(row: SiteObservationRow, ctx: Ctx): SiteFact | null {
  if (row.psi_status !== "ok" || !isObj(row.psi) || !isObj(row.psi.scores)) return null;
  const raw = num(row.psi.scores.performance);
  if (raw === null) return null;
  // Stored 0-100; a 0-1 Lighthouse fraction is scaled.
  const score = Math.round(raw <= 1 ? raw * 100 : raw);
  if (score < 0 || score > 100) return null;
  const url = httpUrl(row.psi.final_url) ?? ctx.home;
  return seen("psi", `Google's mobile speed test (PageSpeed Insights) scored the home page ${score}/100 for performance, which Google rates as ${psiBand(score)}`, url);
}

/**
 * The site facts for one observation row. Anything but status 'ok' (pending,
 * abandoned, unreachable…) gives none: those rows hold no real values.
 */
export function siteFactsFrom(row: SiteObservationRow | null | undefined): SiteFact[] {
  if (!row || row.status !== "ok" || !isObj(row.checks)) return [];
  const home = httpUrl(row.final_url) ?? httpUrl(row.url);
  if (!home) return [];
  const ctx: Ctx = { home, pages: pagesRead(row.pages) };
  const out: SiteFact[] = [];
  for (const id of SITE_FACT_CHECKS) {
    const check = row.checks[id];
    if (!isObj(check)) continue;
    const fact = MAPPERS[id]!(check, ctx);
    if (fact && httpUrl(fact.url)) out.push(fact);
  }
  const psi = psiFact(row, ctx);
  if (psi) out.push(psi);
  return out;
}

/** The oldest crawl time a loader accepts. */
export function siteFactsCutoff(now: Date = new Date()): string {
  return new Date(now.getTime() - SITE_FACTS_MAX_AGE_DAYS * 86_400_000).toISOString();
}

/**
 * Statuses of a finished crawl (0054). pending / abandoned keep checks = '{}'
 * and say nothing about the site; every other status is a real read of it.
 */
export const FINISHED_STATUSES = ["ok", "unreachable", "blocked", "not_html", "too_large", "offsite"] as const;

/** The prospect's site as we know it now (prospects.website_url, prospects.domain). */
export type ProspectSite = { website_url?: string | null; domain?: string | null };

/** host without www, from a URL or a bare domain; null when unparseable. */
function siteHost(v: string | null | undefined): string | null {
  const s = (v ?? "").trim();
  if (!s) return null;
  try {
    return bareHost(new URL(/^https?:\/\//i.test(s) ? s : `https://${s}`)) || null;
  } catch {
    return null;
  }
}

/**
 * The observation is about the prospect's CURRENT site: its home URL (where
 * the crawl landed, or the URL it was asked to read) has the host of the
 * prospect's website_url or domain, www ignored (the crawler's bareHost). A
 * prospect whose site was corrected after the crawl (the 30-day re-crawl wait
 * is keyed on prospect_id) otherwise gets another business's facts.
 */
export function observationMatchesSite(row: Pick<SiteObservationRow, "url" | "final_url">, site: ProspectSite | null | undefined): boolean {
  const known = [siteHost(site?.website_url), siteHost(site?.domain)].filter((h): h is string => Boolean(h));
  if (known.length === 0) return false;
  const seen = [siteHost(str(row.final_url)), siteHost(str(row.url))].filter((h): h is string => Boolean(h));
  return seen.some((h) => known.includes(h));
}

/**
 * The site facts for the prospect as it stands: the newest finished crawl,
 * only when it is ok and about the prospect's current site; otherwise [].
 */
export function siteFactsFor(row: SiteObservationRow | null | undefined, site: ProspectSite | null | undefined): SiteFact[] {
  if (!row || !observationMatchesSite(row, site)) return [];
  return siteFactsFrom(row);
}

/** The slice of the Supabase client the loader uses. */
export type SiteObservationsDb = {
  from: (table: "site_observations") => {
    select: (cols: string) => {
      eq: (col: string, v: string) => {
        eq: (col: string, v: string) => {
          in: (col: string, v: readonly string[]) => {
            gte: (col: string, v: string) => {
              order: (col: string, o: { ascending: boolean }) => {
                limit: (n: number) => {
                  abortSignal: (s: AbortSignal) => {
                    maybeSingle: () => PromiseLike<{ data: unknown; error: { message: string } | null }>;
                  };
                };
              };
            };
          };
        };
      };
    };
  };
};

/**
 * The newest FINISHED observation (≤ 60 days) of one prospect, whatever its
 * status: a newer unreachable / blocked / offsite re-crawl must stop older ok
 * facts, so the ok filter is siteFactsFrom's, after this pick. A read error
 * or no row gives null: the draft never fails on it, and no row is never
 * "nothing on the site" (the writer then makes no site claim at all).
 */
export async function loadSiteObservation(db: SiteObservationsDb, tenantId: string, prospectId: string, now: Date = new Date()): Promise<SiteObservationRow | null> {
  try {
    const { data, error } = await db
      .from("site_observations")
      .select("url, final_url, status, pages, checks, psi, psi_status")
      .eq("tenant_id", tenantId)
      .eq("prospect_id", prospectId)
      .in("status", FINISHED_STATUSES)
      .gte("crawled_at", siteFactsCutoff(now))
      .order("crawled_at", { ascending: false })
      .limit(1)
      .abortSignal(AbortSignal.timeout(SITE_FACTS_READ_TIMEOUT_MS))
      .maybeSingle();
    if (error) {
      console.warn("[site-facts] read failed:", error.message || "empty error");
      return null;
    }
    return isObj(data) ? (data as SiteObservationRow) : null;
  } catch (e) {
    console.warn("[site-facts] read failed:", e instanceof Error ? e.message : String(e));
    return null;
  }
}
