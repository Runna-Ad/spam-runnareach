/**
 * Deterministic detectors over the pages one crawl read. No AI, no guessing.
 *
 * Each check is { found, evidence }:
 *   true   seen; evidence names the page and the link/text/script that shows it.
 *   false  looked and not there, written ONLY when every page the check depends
 *          on was readable (`absent` below). A page that failed to load, or that
 *          draws its links/text with JavaScript (plain fetch gets an empty shell;
 *          study 2026-10-30: a Wix lodge returned 0 links), makes it null.
 *   null   could not see. Never state an absence from it.
 *
 * Booking is found by LINKS first (study: link text/href found a hotel's
 * "BOOK NOW" → reservations.travelclick.com that script matching missed).
 */

import type { ParsedPage, PageLink } from "./parse.ts";
import { bareHost, sameSite } from "./select-pages.ts";
import type {
  BookingCheck,
  BookingChannel,
  BuilderCheck,
  Check,
  Evidence,
  FormCheck,
  PageReadable,
  RatingCheck,
  SiteChecks,
  ValuesCheck,
  YearCheck,
} from "./types.ts";

/** A page the crawl tried: parsed when it loaded, null when it did not. */
export type CrawledPage = { url: string; readable: PageReadable; parsed: ParsedPage | null };

const MAX_EVIDENCE = 5;
const clip = (s: string, n = 120) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

type Need = keyof PageReadable;

/**
 * An absence is a fact only when every page tried was readable for what the
 * check reads. One unreadable page (failed, JS-drawn, cut by the budget) and
 * the answer is "could not see".
 */
export function absent(pages: CrawledPage[], needs: Need[]): boolean {
  return pages.length > 0 && pages.every((p) => needs.every((n) => p.readable[n]));
}

const parsedPages = (pages: CrawledPage[]) => pages.flatMap((p) => (p.parsed ? [p.parsed] : []));

const TRACKING_PARAM = /^(utm_[a-z_]+|_ga|_gac|_gl|fbclid|gclid|gbraid|wbraid|msclkid|mc_[a-z]+|hsa_[a-z]+|_hs[a-z]+|ksprof_id|k_clickid|ds_[a-z]+|semcid|ktarget|ksdevice|klocf|kloct|ha_t)$/i;

/** Evidence URLs without click/ad tracking parameters (they are noise and can identify a visit). */
export function cleanHref(href: string): string {
  if (!/^https?:/i.test(href) || !href.includes("?")) return href;
  try {
    const u = new URL(href);
    for (const k of [...u.searchParams.keys()]) if (TRACKING_PARAM.test(k)) u.searchParams.delete(k);
    return u.toString();
  } catch {
    return href;
  }
}

class EvidenceList {
  private items: Evidence[] = [];
  private keys = new Set<string>();
  add(raw: Evidence) {
    const e = raw.href ? { ...raw, href: cleanHref(raw.href) } : raw;
    const key = `${e.href ?? ""}|${e.text ?? ""}`;
    if (this.keys.has(key) || this.items.length >= MAX_EVIDENCE) return;
    this.keys.add(key);
    this.items.push({ url: e.url, ...(e.text ? { text: clip(e.text) } : {}), ...(e.href ? { href: clip(e.href, 300) } : {}) });
  }
  get list() {
    return this.items;
  }
  get size() {
    return this.items.length;
  }
}

function hostOf(href: string): string | null {
  try {
    return bareHost(new URL(href));
  } catch {
    return null;
  }
}

const hostMatches = (host: string, domains: string[]) => domains.some((d) => host === d || host.endsWith(`.${d}`));

// ── Booking ──────────────────────────────────────────────────────────────────

/** Booking / scheduling engines (a link here = online booking exists). */
export const BOOKING_ENGINES = [
  "travelclick.com", "synxis.com", "cloudbeds.com", "resnexus.com", "checkfront.com", "fareharbor.com", "peek.com",
  "bookeo.com", "rezdy.com", "opentable.com", "opentable.ca", "resy.com", "exploretock.com", "sevenrooms.com",
  "calendly.com", "acuityscheduling.com", "as.me", "square.site", "vagaro.com", "mindbodyonline.com", "mindbody.io",
  "fresha.com", "booksy.com", "janeapp.com", "setmore.com", "simplybook.me", "simplybook.it", "doctoralia.com.mx",
  "doctoralia.com", "agendapro.com", "reservio.com", "littlehotelier.com", "thebookingbutton.com", "direct-book.com",
  "siteminder.com", "webrezpro.com", "innroad.com", "newbook.cloud", "campspot.com", "reserveamerica.com",
  "ipms247.com", "eviivo.com", "hotelrunner.com", "asiwebres.com", "roomkeypms.com", "mews.com", "mews.li",
  "beds24.com", "lodgify.com", "ownerrez.com", "guesty.com", "smoobu.com", "resova.com", "xola.com", "trekksoft.com",
  "zaui.net", "bokun.io", "regiondo.com", "tripleseat.com", "clinicsense.com", "noterro.com", "zocdoc.com",
  "localmed.com", "nexhealth.com", "dentalhub.online", "flexbooker.com", "appointy.com", "youcanbook.me",
  "picktime.com", "10to8.com", "zenoti.com", "phorest.com", "glossgenius.com", "schedulicity.com", "styleseat.com",
  "gettimely.com", "tidycal.com", "hubspot.com/meetings", "meetings.hubspot.com", "bookings.cloud.microsoft",
  "outlook.office365.com/owa/calendar", "reservations.travelclick.com", "be.synxis.com", "hotels.cloudbeds.com",
  "secure.webrez.com", "book-directonline.com", "bookonlinenow.net", "secure-hotel-booking.com", "yourbooking.ca",
];
/**
 * Marketplaces/OTAs that take a booking for them, only on a LISTING url (a
 * student-housing page linking to airbnb.ca/ is not their listing).
 */
export const BOOKING_MARKETPLACES: Array<{ host: string; listing: RegExp }> = [
  { host: "booking.com", listing: /\/hotel\// },
  { host: "airbnb.com", listing: /\/(rooms|h)\// },
  { host: "airbnb.ca", listing: /\/(rooms|h)\// },
  { host: "airbnb.mx", listing: /\/(rooms|h)\// },
  { host: "vrbo.com", listing: /\/\d{5,}/ },
  { host: "expedia.com", listing: /Hotel-Information|\.h\d+\./ },
  { host: "expedia.ca", listing: /Hotel-Information|\.h\d+\./ },
  { host: "expedia.mx", listing: /Hotel-Information|\.h\d+\./ },
  { host: "hotels.com", listing: /\/ho\d+|\/h\d+/ },
  { host: "hipcamp.com", listing: /\/land\// },
  { host: "getyourguide.com", listing: /-t\d+/ },
  { host: "viator.com", listing: /\/tours\// },
  { host: "tripadvisor.com", listing: /Hotel_Review|AttractionProductReview/ },
  { host: "tripadvisor.ca", listing: /Hotel_Review|AttractionProductReview/ },
  { host: "agoda.com", listing: /\/hotel\// },
];
const ENGINE_SUBDOMAIN = /^(book|booking|bookings|reservations?|reserve|reservas?|citas|agenda|appointments?)\./i;

/** Link text (or WhatsApp prefill) that asks to book. "Derechos reservados" is not a booking. */
export const BOOK_TEXT =
  /\bbook(ing|ings)?\b|\breserv(ar|ation|ations|aciones|aci[oó]n)\b|\breserva\s+(ahora|ya|tu|su|aqu[ií]|en l[ií]nea|hoy)\b|\breserve (now|a|an|your|online|today|here)\b|\br[ée]serv(er|ez|ation|ations)\b|\bagendar\b|\bagenda\s+(tu|una|su|ya|aqu[ií]|ahora|hoy|cita|visita|consulta|en l[ií]nea|por)\b|\bcitas?\b|\bappointments?\b|\bschedule (a|an|your|now)\b|check availability|disponibilidad/i;
const BOOK_PATH = /\/(book|booking|bookings|reserv[a-z]*|r[ée]serv[a-z]*|appointments?|citas?|agendar?|agenda-?cita)(\/|$|[-_?#])/i;
const CONTACT_PATH = /\/(contact|contacto|contactanos|cont[aá]ctenos|contact-us|nous-joindre|joindre)(\/|$|[-_.])/i;
const NOT_BOOKING = /derechos reservados|all rights reserved|tous droits r[ée]serv[ée]s|\bbook(s)? (store|club|keeping)|facebook/i;

const isWhatsApp = (href: string) => /^(https?:\/\/)?(wa\.me|api\.whatsapp\.com|web\.whatsapp\.com|wa\.link)\b|^whatsapp:/i.test(href);
const whatsappText = (href: string) => {
  try {
    return decodeURIComponent(new URL(href).searchParams.get("text") ?? "");
  } catch {
    return "";
  }
};

function engineHost(href: string): "external_engine" | "marketplace" | null {
  let u: URL;
  try {
    u = new URL(href);
  } catch {
    return null;
  }
  const host = bareHost(u);
  const path = `${u.pathname}${u.search}${u.hash}`;
  const market = BOOKING_MARKETPLACES.find((m) => hostMatches(host, [m.host]));
  if (market) return market.listing.test(path) ? "marketplace" : null;
  const hostPath = `${host}${u.pathname}`.toLowerCase();
  const engine = BOOKING_ENGINES.some((d) => (d.includes("/") ? hostPath.startsWith(d.toLowerCase()) : hostMatches(host, [d])));
  // The engine's own home page ("Powered by Checkfront") is not their booking page.
  const own = u.hostname.split(".").length > 2 && !/^www\./i.test(u.hostname);
  return engine && (path.length > 1 || own) ? "external_engine" : null;
}

type Channel = BookingChannel;
type Hit = { channel: Channel; strong: boolean; ev: Evidence };

/**
 * Where one link, button or form target goes, for booking. null = not a booking path.
 * `text` is the link/button/submit text; `bookingForm` marks a form with stay
 * dates or a booking submit ("Check availability").
 */
function classifyTarget(href: string, text: string, siteUrl: string, bookingForm = false): { channel: Channel; strong: boolean } | null {
  const wantsBooking = (BOOK_TEXT.test(text) && !NOT_BOOKING.test(text)) || bookingForm;
  if (isWhatsApp(href)) return wantsBooking || BOOK_TEXT.test(whatsappText(href)) ? { channel: "whatsapp", strong: true } : null;
  if (/^tel:/i.test(href)) return wantsBooking ? { channel: "phone", strong: true } : null;
  if (!/^https?:/i.test(href)) return null;
  const engine = engineHost(href);
  if (engine) return { channel: engine, strong: true };
  const host = hostOf(href) ?? "";
  if (sameSite(href, siteUrl)) {
    let path = "";
    try {
      path = new URL(href).pathname;
    } catch {
      // unparseable: text only
    }
    // "Book a consultation" → /contact is a request form, not booking online.
    if (CONTACT_PATH.test(path)) return null;
    if (bookingForm) return { channel: "on_site", strong: true };
    if (BOOK_PATH.test(path)) return { channel: "on_site", strong: true };
    return wantsBooking ? { channel: "on_site", strong: false } : null;
  }
  // reservations.hotelgroup.com / book.someengine.com behind a "Book" link or a booking form.
  if (wantsBooking && (bookingForm || (host.split(".").length > 2 && ENGINE_SUBDOMAIN.test(host)))) return { channel: "external_engine", strong: true };
  return null;
}

/**
 * The fail-closed side of booking (P6): its own, coarser matching, on folded
 * letters. Any booking word on a button, a submit or a link we did not resolve
 * to a booking path (or in the page text when nothing was resolved at all)
 * means "could not see", never "no online booking".
 */
const fold = (s: string) => s.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
const COARSE_CONTROL = ["book", "reserv", "agend", "cita", "appoint", "availab", "disponib", "schedule"];
const COARSE_TEXT = ["book now", "book online", "book your", "book a ", "booking", "reservation", "reservacion", "reservar", "agendar", "appointment", "check availability", "disponibilidad", "schedule a "];
const coarseControl = (t: string) => {
  // Words that only contain "book": a guestbook, Facebook, a lookbook are not a booking ask.
  const f = fold(t).replace(/booking\.com|guestbook|facebook|lookbook|notebook|bookkeep\w*|bookstore|ebooks?\b|yearbook|bookmark/g, "");
  return COARSE_CONTROL.some((w) => f.includes(w));
};
const coarseText = (t: string) => {
  const f = fold(t).replace(/booking\.com/g, "");
  return COARSE_TEXT.some((w) => f.includes(w));
};

export function detectBooking(pages: CrawledPage[], siteUrl: string): BookingCheck {
  const hits: Hit[] = [];
  let unexplained: Evidence | null = null;

  for (const p of parsedPages(pages)) {
    const add = (h: { channel: Channel; strong: boolean } | null, ev: Evidence, controlText: string) => {
      if (h) hits.push({ ...h, ev });
      else if (!unexplained && controlText && coarseControl(controlText)) unexplained = ev;
    };
    for (const l of p.links) {
      if (l.fragment) {
        const wants = BOOK_TEXT.test(l.text) && !NOT_BOOKING.test(l.text);
        // An on-page anchor (#booknow) opens something we cannot see: weak.
        add(wants || BOOK_PATH.test(`/${l.href.slice(1)}`) ? { channel: "on_site", strong: false } : null, { url: p.url, text: l.text, href: l.href }, l.text);
        continue;
      }
      // A link to an unrelated page whose text mentions booking ("Facebook", "Our booking policy") is still unresolved.
      add(classifyTarget(l.href, l.text, siteUrl), { url: p.url, text: l.text || whatsappText(l.href), href: l.href }, /^(mailto|tel):/i.test(l.href) ? "" : l.text);
    }
    for (const f of p.forms) {
      if (f.search) continue;
      if (!isBookingForm(f)) continue;
      const target = f.actionUrl ?? p.url;
      add(classifyTarget(target, f.submitText, siteUrl, true), { url: p.url, text: `form "${f.submitText || "submit"}"`, href: target }, f.submitText);
    }
    for (const b of p.buttons) {
      if (!b.text && !b.href) continue;
      // A button inside a form was handled with its form; here only the ones that go somewhere, or unresolved booking words.
      add(b.href ? classifyTarget(b.href, b.text, siteUrl) : null, { url: p.url, text: b.text, ...(b.href ? { href: b.href } : {}) }, b.text);
    }
    // Booking widgets loaded as a script or iframe from a known engine.
    for (const src of [...p.scriptSrcs, ...p.iframeSrcs]) {
      const abs = src.startsWith("//") ? `https:${src}` : src;
      if (/^https?:/i.test(abs) && engineHost(abs) === "external_engine") hits.push({ channel: "external_engine", strong: true, ev: { url: p.url, href: abs, text: "booking widget" } });
    }
  }

  const pick = (channel: Channel) => {
    const of = hits.filter((h) => h.channel === channel);
    const ev = new EvidenceList();
    for (const h of [...of.filter((x) => x.strong), ...of.filter((x) => !x.strong)]) ev.add(h.ev);
    return { any: of.length > 0, strong: of.some((h) => h.strong), evidence: ev.list };
  };
  for (const channel of ["external_engine", "marketplace", "on_site"] as const) {
    const c = pick(channel);
    if (c.any) return { found: true, online: true, channel, strength: c.strong ? "strong" : "weak", evidence: c.evidence };
  }

  // No online booking path resolved. "No online booking" is an absence: it needs
  // every page readable AND no booking word we could not resolve.
  const offline = (["whatsapp", "phone"] as const).find((ch) => pick(ch).any) ?? null;
  const textMention = !offline ? parsedPages(pages).find((p) => coarseText(p.text)) : undefined;
  const unresolved: Evidence | null = unexplained ?? (textMention ? { url: textMention.url, text: "booking mentioned in the page text, no booking link found" } : null);
  const online = absent(pages, ["html", "text", "links"]) && !unresolved ? false : null;
  const evidence = offline ? pick(offline).evidence : unresolved ? [unresolved] : [];
  return { found: online, online, channel: offline, strength: offline ? "strong" : null, evidence };
}

// ── Fingerprints (scripts / html) ────────────────────────────────────────────

type Fingerprint = { name: string; re: RegExp };

export const BUILDERS: Fingerprint[] = [
  { name: "Shopify", re: /cdn\.shopify\.com|\.myshopify\.com|Shopify\.theme/i },
  { name: "Wix", re: /static\.parastorage\.com|static\.wixstatic\.com|_wixCIDX|wix-warmup-data/i },
  { name: "Squarespace", re: /static1?\.squarespace\.com|Static\.SQUARESPACE_CONTEXT/i },
  { name: "Webflow", re: /assets-global\.website-files\.com|cdn\.prod\.website-files\.com|data-wf-page/i },
  { name: "GoDaddy", re: /img1\.wsimg\.com|godaddy website builder|websites\.godaddy\.com/i },
  { name: "Weebly", re: /editmysite\.com|weebly\.com\/weebly/i },
  { name: "Duda", re: /multiscreensite\.com|dudamobile|irp\.cdn-website\.com|dmAPI/i },
  { name: "Framer", re: /framerusercontent\.com|framer-app/i },
  { name: "BigCommerce", re: /cdn\d*\.bigcommerce\.com/i },
  { name: "Jimdo", re: /jimdo(cdn|static)?\.com/i },
  { name: "Webnode", re: /webnode\.(com|page)/i },
  { name: "Tilda", re: /tildacdn\.com/i },
  { name: "Hostinger", re: /zyrosite\.com|zyro\.com|hostinger website builder/i },
  { name: "Site123", re: /site123\.(com|me)/i },
  { name: "Strikingly", re: /strikingly\.com|strikinglycdn/i },
  { name: "HubSpot CMS", re: /hubspotusercontent|hs-sites\.com/i },
  { name: "Joomla", re: /\/media\/jui\/|\/components\/com_|content="joomla/i },
  { name: "Drupal", re: /drupal-settings-json|\/sites\/default\/files\/|content="drupal/i },
  { name: "Ghost", re: /content="ghost /i },
  { name: "WordPress", re: /\/wp-content\/|\/wp-includes\/|content="wordpress/i },
];

export const ANALYTICS: Fingerprint[] = [
  { name: "Google Tag Manager", re: /googletagmanager\.com\/gtm\.js|\bGTM-[A-Z0-9]{4,}/ },
  { name: "Google Analytics", re: /googletagmanager\.com\/gtag\/js\?id=(G|UA)-|google-analytics\.com\/(analytics|ga)\.js|gtag\(\s*['"]config['"]\s*,\s*['"](G|UA)-/ },
  { name: "Google Ads", re: /googleadservices\.com|gtag\/js\?id=AW-|['"]AW-\d{6,}/ },
  { name: "Meta Pixel", re: /connect\.facebook\.net\/[^"']*\/fbevents\.js|fbq\(\s*['"]init['"]/ },
  { name: "TikTok Pixel", re: /analytics\.tiktok\.com/ },
  { name: "LinkedIn Insight", re: /snap\.licdn\.com|_linkedin_partner_id/ },
  { name: "Pinterest Tag", re: /s\.pinimg\.com\/ct\/core\.js|pintrk\(/ },
  { name: "Snap Pixel", re: /sc-static\.net\/scevent/ },
  { name: "Microsoft UET", re: /bat\.bing\.com/ },
  { name: "Microsoft Clarity", re: /clarity\.ms\/tag/ },
  { name: "Hotjar", re: /static\.hotjar\.com|hotjar\.com\/c\/hotjar/ },
  { name: "Matomo", re: /matomo\.js|piwik\.js/ },
  { name: "Plausible", re: /plausible\.io\/js/ },
];
const TAG_MANAGER = /googletagmanager\.com\/gtm\.js|\bGTM-[A-Z0-9]{4,}|segment\.(com|io)\/analytics\.js|tealium/;

export const CHAT_WIDGETS: Fingerprint[] = [
  { name: "Tawk.to", re: /embed\.tawk\.to/i },
  { name: "Intercom", re: /widget\.intercom\.io|intercomcdn\.com/i },
  { name: "Drift", re: /js\.driftt\.com|drift\.com\/include/i },
  { name: "Crisp", re: /client\.crisp\.chat/i },
  { name: "LiveChat", re: /cdn\.livechatinc\.com/i },
  { name: "Zendesk Chat", re: /static\.zdassets\.com\/ekr|zopim/i },
  { name: "HubSpot Chat", re: /js\.usemessages\.com/i },
  { name: "Tidio", re: /code\.tidio\.co/i },
  { name: "Gorgias", re: /gorgias\.chat|config\.gorgias/i },
  { name: "Messenger chat", re: /fb-customerchat|customerchat\.js/i },
  { name: "Olark", re: /static\.olark\.com/i },
  { name: "Smartsupp", re: /smartsuppchat\.com/i },
  { name: "JivoChat", re: /code\.jivosite\.com|jivochat/i },
  { name: "Callbell", re: /dash\.callbell\.eu/i },
  { name: "WhatsApp widget", re: /getbutton\.io|joinchat|wa-widget|elfsight[^"']*whatsapp/i },
  { name: "Wix Chat", re: /wix-chat|chat\.wix/i },
];

function fingerprints(pages: CrawledPage[], list: Fingerprint[]): Map<string, Evidence> {
  const out = new Map<string, Evidence>();
  for (const p of parsedPages(pages)) {
    for (const fp of list) {
      if (out.has(fp.name)) continue;
      const m = fp.re.exec(p.html);
      if (m) out.set(fp.name, { url: p.url, text: fp.name, href: clip(m[0], 200) });
    }
  }
  return out;
}

const valuesCheck = (found: Map<string, Evidence>, canBeAbsent: boolean): ValuesCheck => ({
  found: found.size > 0 ? true : canBeAbsent ? false : null,
  values: [...found.keys()],
  evidence: [...found.values()].slice(0, MAX_EVIDENCE),
});

export function detectBuilder(pages: CrawledPage[]): BuilderCheck {
  const home = pages[0]?.parsed;
  const seen = new Map<string, Evidence>();
  for (const p of parsedPages(pages)) {
    const gen = p.generator ?? "";
    for (const fp of BUILDERS) {
      if (seen.has(fp.name)) continue;
      const m = fp.re.exec(p.html) ?? (gen && fp.re.exec(`content="${gen}`));
      if (m) seen.set(fp.name, { url: p.url, text: fp.name, href: clip(m[0], 200) });
    }
    // One template serves the whole site: the first page that names a builder decides (saves CPU).
    if (seen.size > 0) break;
  }
  // First in BUILDERS order wins: a Shopify store with a WordPress blog is Shopify.
  const first = BUILDERS.find((b) => seen.has(b.name));
  if (first) {
    const woo = first.name === "WordPress" && /wp-content\/plugins\/woocommerce/i.test(home?.html ?? "");
    return { found: true, value: woo ? "WordPress (WooCommerce)" : first.name, evidence: [seen.get(first.name) as Evidence] };
  }
  return { found: absent(pages, ["html"]) ? false : null, value: null, evidence: [] };
}

export function detectAnalytics(pages: CrawledPage[]): ValuesCheck {
  return valuesCheck(fingerprints(pages, ANALYTICS), absent(pages, ["html", "text"]));
}

export function detectChat(pages: CrawledPage[]): ValuesCheck {
  const found = fingerprints(pages, CHAT_WIDGETS);
  for (const p of parsedPages(pages)) {
    const wa = p.links.find((l) => isWhatsApp(l.href));
    if (wa && !found.has("WhatsApp")) found.set("WhatsApp", { url: p.url, text: wa.text || "WhatsApp", href: wa.href });
  }
  // A tag manager can load a chat widget we never see in the HTML.
  const tagManager = parsedPages(pages).some((p) => TAG_MANAGER.test(p.html));
  return valuesCheck(found, absent(pages, ["html", "text", "links"]) && !tagManager);
}

// ── Links ────────────────────────────────────────────────────────────────────

function linkCheck(pages: CrawledPage[], match: (l: PageLink) => boolean): Check {
  const ev = new EvidenceList();
  for (const p of parsedPages(pages)) for (const l of p.links) if (match(l)) ev.add({ url: p.url, text: l.text, href: l.href });
  return { found: ev.size > 0 ? true : absent(pages, ["html", "links"]) ? false : null, evidence: ev.list };
}

export const detectTel = (pages: CrawledPage[]) => linkCheck(pages, (l) => /^tel:\s*\+?[\d(]/i.test(l.href));
/** Cloudflare hides published addresses behind /cdn-cgi/l/email-protection: still a mailto link. */
export const detectMailto = (pages: CrawledPage[]) =>
  linkCheck(pages, (l) => /^mailto:[^@\s]+@/i.test(l.href) || /\/cdn-cgi\/l\/email-protection/i.test(l.href));

export const SOCIAL: Array<{ name: string; hosts: string[]; skip?: RegExp }> = [
  { name: "facebook", hosts: ["facebook.com", "fb.com", "fb.me"], skip: /sharer|\/share|\/dialog\/|\/plugins\/|\/tr\?/i },
  { name: "instagram", hosts: ["instagram.com"] },
  { name: "x", hosts: ["twitter.com", "x.com"], skip: /\/intent\/|\/share/i },
  { name: "linkedin", hosts: ["linkedin.com"], skip: /shareArticle|\/sharing\//i },
  { name: "tiktok", hosts: ["tiktok.com"] },
  { name: "youtube", hosts: ["youtube.com", "youtu.be"], skip: /\/embed\//i },
  { name: "pinterest", hosts: ["pinterest.com", "pinterest.ca", "pinterest.com.mx"], skip: /pin\/create/i },
  { name: "threads", hosts: ["threads.net", "threads.com"] },
];

export function detectSocial(pages: CrawledPage[]): ValuesCheck {
  const found = new Map<string, Evidence>();
  for (const p of parsedPages(pages)) {
    for (const l of p.links) {
      if (!/^https?:/i.test(l.href)) continue;
      const host = hostOf(l.href);
      if (!host) continue;
      const s = SOCIAL.find((x) => hostMatches(host, x.hosts) && !(x.skip && x.skip.test(l.href)));
      if (s && !found.has(s.name)) found.set(s.name, { url: p.url, text: l.text, href: l.href });
    }
  }
  return valuesCheck(found, absent(pages, ["html", "links"]));
}

// ── Commerce, forms ──────────────────────────────────────────────────────────

const CART_TEXT = /add to (cart|bag)|agregar al carrito|a[ñn]adir al carrito|ajouter au panier|buy now|comprar ahora|shop now|compra en l[ií]nea|tienda en l[ií]nea|online store/i;
/**
 * Platforms that exist to sell online. Wix and Squarespace load their store
 * bundle and draw a /cart icon on every site, lodges included (study
 * 2026-10-30), so for them only a shopping signal below counts.
 */
const STORE_ENGINES = /cdn\.shopify\.com|wp-content\/plugins\/woocommerce|cdn\d*\.bigcommerce\.com|app\.ecwid\.com|cdn\.tiendanube|mitiendanube\.com|jumpseller/i;
const isProductNode = (n: JsonNode) => typesOf(n).some((t) => t === "Product") && Boolean(n.offers);

/** A control that buys: on a link, button or submit (free page text alone is not enough: "gift shop now open"). */
const BUY_CONTROL = /add to (cart|bag|basket)|agregar al carrito|a[ñn]adir al carrito|ajouter au panier|buy now|comprar ahora|\bcheckout\b|proceed to checkout/i;
const CART_LINK = /\/(cart|checkout|carrito|panier|basket)(\/|$)/i;
const CART_WORD = /\bcart\b|carrito|panier|basket|checkout|\bbag\b/i;

export function detectEcommerce(pages: CrawledPage[], siteUrl: string): Check {
  const signals = new EvidenceList();
  const support = new EvidenceList();
  for (const p of parsedPages(pages)) {
    const m = STORE_ENGINES.exec(p.html);
    if (m) signals.add({ url: p.url, text: "store platform", href: m[0] });
    if (p.jsonld.some((b) => jsonNodes(b).some(isProductNode))) signals.add({ url: p.url, text: "JSON-LD Product with offers" });
    for (const l of p.links) {
      if (!/^https?:/i.test(l.href)) continue;
      if (BUY_CONTROL.test(l.text)) signals.add({ url: p.url, text: l.text, href: l.href });
      // A cart link that says so ("Cart", "Carrito"); a bare cart icon ("0") is drawn by Squarespace on every site.
      else if (sameSite(l.href, siteUrl) && CART_LINK.test(l.href) && CART_WORD.test(l.text)) signals.add({ url: p.url, text: l.text, href: l.href });
    }
    for (const b of p.buttons) if (BUY_CONTROL.test(b.text)) signals.add({ url: p.url, text: b.text, ...(b.href ? { href: b.href } : {}) });
    for (const f of p.forms) if (BUY_CONTROL.test(f.submitText)) signals.add({ url: p.url, text: f.submitText, ...(f.actionUrl ? { href: f.actionUrl } : {}) });
    const t = CART_TEXT.exec(p.text);
    if (t) support.add({ url: p.url, text: t[0] });
  }
  if (signals.size > 0) {
    for (const e of support.list) signals.add(e);
    return { found: true, evidence: signals.list };
  }
  return { found: absent(pages, ["html", "text", "links"]) ? false : null, evidence: [] };
}

/** A form with stay dates or a booking submit is a booking form (detectBooking), not a contact form. */
export const isBookingForm = (f: { submitText: string; hasDate: boolean; hasTextarea: boolean }) =>
  (BOOK_TEXT.test(f.submitText) && !NOT_BOOKING.test(f.submitText)) || (f.hasDate && !f.hasTextarea);

const EMBED_FORMS = /jotform\.com|typeform\.com|docs\.google\.com\/forms|forms\.gle|js\.hsforms\.net|hsforms\.com|formstack\.com|cognitoforms\.com|wufoo\.com|123formbuilder\.com|forms\.office\.com|tally\.so|paperform\.co|formsite\.com/i;

export function detectContactForm(pages: CrawledPage[]): FormCheck {
  const ev = new EvidenceList();
  let fields: number | null = null;
  for (const p of parsedPages(pages)) {
    for (const f of p.forms) {
      if (f.search || isBookingForm(f)) continue;
      const contact = (f.fields >= 2 && (f.hasEmailOrTel || f.hasTextarea)) || f.fields >= 3;
      if (!contact) continue;
      fields = Math.max(fields ?? 0, f.fields);
      ev.add({ url: p.url, text: `form with ${f.fields} fields${f.hasTextarea ? " incl. a message box" : ""}`, ...(f.action ? { href: f.action } : {}) });
    }
    for (const src of [...p.iframeSrcs, ...p.scriptSrcs]) {
      if (EMBED_FORMS.test(src)) ev.add({ url: p.url, text: "embedded form", href: src });
    }
  }
  return {
    found: ev.size > 0 ? true : absent(pages, ["html", "text", "links"]) ? false : null,
    fields,
    evidence: ev.list,
  };
}

// ── Head / structured data / text ────────────────────────────────────────────

export function detectViewport(pages: CrawledPage[]): Check {
  const home = pages[0];
  const vp = home?.parsed?.viewport ?? null;
  if (home?.parsed && vp && /width\s*=\s*device-width/i.test(vp)) return { found: true, evidence: [{ url: home.url, text: `viewport: ${vp}` }] };
  // The <head> is server-sent even on JavaScript sites: the home's HTML is enough.
  return { found: home?.readable.html ? false : null, evidence: home?.parsed && vp ? [{ url: home.url, text: `viewport: ${vp}` }] : [] };
}

type JsonNode = Record<string, unknown>;

function jsonNodes(data: unknown, out: JsonNode[] = [], depth = 0): JsonNode[] {
  if (depth > 6 || data === null || typeof data !== "object") return out;
  if (Array.isArray(data)) {
    for (const d of data) jsonNodes(d, out, depth + 1);
    return out;
  }
  const node = data as JsonNode;
  out.push(node);
  for (const v of Object.values(node)) if (v && typeof v === "object") jsonNodes(v, out, depth + 1);
  return out;
}

const typesOf = (n: JsonNode): string[] => {
  const t = n["@type"];
  return (Array.isArray(t) ? t : [t]).filter((x): x is string => typeof x === "string");
};

export function detectJsonLd(pages: CrawledPage[]): { jsonld: ValuesCheck; hours: Check; rating: RatingCheck } {
  const types = new Map<string, Evidence>();
  const hours = new EvidenceList();
  let rating: { value: number | null; count: number | null; ev: Evidence } | null = null;
  for (const p of parsedPages(pages)) {
    for (const block of p.jsonld) {
      for (const n of jsonNodes(block)) {
        for (const t of typesOf(n)) if (!types.has(t)) types.set(t, { url: p.url, text: t });
        const h = n.openingHoursSpecification ?? n.openingHours;
        if (h) hours.add({ url: p.url, text: clip(JSON.stringify(h), 200) });
        const r = n.aggregateRating;
        if (!rating && r && typeof r === "object" && !Array.isArray(r)) {
          const ar = r as JsonNode;
          const num = (x: unknown) => {
            const v = typeof x === "number" ? x : typeof x === "string" ? Number.parseFloat(x) : Number.NaN;
            return Number.isFinite(v) ? v : null;
          };
          const value = num(ar.ratingValue);
          const count = num(ar.reviewCount ?? ar.ratingCount);
          if (value !== null) rating = { value, count, ev: { url: p.url, text: clip(`${value}${count !== null ? ` from ${count} reviews` : ""} (${typesOf(n).join("/") || "item"})`) } };
        }
      }
    }
  }
  // Structured data can be injected by JavaScript: absence needs readable text too.
  const canBeAbsent = absent(pages, ["html", "text"]);
  return {
    jsonld: valuesCheck(types, canBeAbsent),
    hours: { found: hours.size > 0 ? true : canBeAbsent ? false : null, evidence: hours.list },
    rating: rating
      ? { found: true, value: rating.value, count: rating.count, evidence: [rating.ev] }
      : { found: canBeAbsent ? false : null, value: null, count: null, evidence: [] },
  };
}

const COPYRIGHT = /©|&copy;|\(c\)|copyright|derechos reservados|todos los derechos|all rights reserved|tous droits/gi;
const YEAR = /\b(19[89]\d|20\d\d)\b/g;

export function detectCopyrightYear(pages: CrawledPage[], now = new Date()): YearCheck {
  const maxYear = now.getUTCFullYear() + 1;
  let best: { year: number; ev: Evidence } | null = null;
  let markerWithoutYear: Evidence | null = null;
  for (const p of parsedPages(pages)) {
    for (const m of p.text.matchAll(COPYRIGHT)) {
      const at = m.index ?? 0;
      // "2024 © Acme" puts the year right before the mark; anything further back is other text ("since 1998").
      const window = p.text.slice(Math.max(0, at - 12), at + 60);
      const years = [...window.matchAll(YEAR)].map((y) => Number(y[1])).filter((y) => y <= maxYear);
      if (years.length === 0) {
        markerWithoutYear ??= { url: p.url, text: window.trim() };
        continue;
      }
      const year = Math.max(...years);
      if (!best || year > best.year) best = { year, ev: { url: p.url, text: window.trim() } };
    }
  }
  if (best) return { found: true, year: best.year, evidence: [best.ev] };
  // A "©" with no year: the year is drawn by a script (new Date()). Could not see it.
  if (markerWithoutYear) return { found: null, year: null, evidence: [markerWithoutYear] };
  return { found: absent(pages, ["html", "text"]) ? false : null, year: null, evidence: [] };
}

const LANG_SWITCH_TEXT: Record<string, RegExp> = {
  en: /^(en|eng|english|in english)$/i,
  es: /^(es|esp|español|espanol|spanish|en español)$/i,
  fr: /^(fr|fra|français|francais|french|en français)$/i,
};
const TRANSLATE_TOOLS =
  /cdn\.weglot\.com|weglot\.com\/weglot|gtranslate\.(io|net)|translate\.google\.com\/translate_a|plugins\/sitepress-multilingual-cms|plugins\/polylang|conveythis\.com|transifex\.com\/live|localizejs\.com|langify-v2|langshop\.app/;

export function detectLanguages(pages: CrawledPage[], siteUrl: string): ValuesCheck {
  const langs = new Map<string, Evidence>();
  const add = (code: string, ev: Evidence) => {
    const c = code.toLowerCase().slice(0, 2);
    if (/^[a-z]{2}$/.test(c) && !langs.has(c)) langs.set(c, ev);
  };
  let tool: Evidence | null = null;
  for (const p of parsedPages(pages)) {
    if (p.htmlLang) add(p.htmlLang, { url: p.url, text: `html lang="${p.htmlLang}"` });
    for (const h of p.hreflangs) if (h !== "x-default") add(h, { url: p.url, text: `hreflang="${h}"` });
    for (const l of p.links) {
      for (const [code, re] of Object.entries(LANG_SWITCH_TEXT)) if (re.test(l.text)) add(code, { url: p.url, text: l.text, href: l.href });
      if (/^https?:/i.test(l.href) && sameSite(l.href, siteUrl)) {
        try {
          const u = new URL(l.href);
          const seg = /^\/(en|es|fr)(\/|$)/i.exec(u.pathname)?.[1] ?? u.searchParams.get("lang");
          if (seg && /^(en|es|fr)$/i.test(seg)) add(seg, { url: p.url, text: l.text, href: l.href });
        } catch {
          // skip
        }
      }
    }
    const m = TRANSLATE_TOOLS.exec(p.html);
    if (m && !tool) tool = { url: p.url, text: "translation tool", href: m[0] };
  }
  const evidence = [...langs.values(), ...(tool ? [tool] : [])].slice(0, MAX_EVIDENCE);
  const multi = langs.size > 1 || tool !== null;
  return { found: multi ? true : absent(pages, ["html", "text", "links"]) ? false : null, values: [...langs.keys()], evidence };
}

// ── All of them ──────────────────────────────────────────────────────────────

export function runDetectors(pages: CrawledPage[], siteUrl: string, now = new Date()): SiteChecks {
  const { jsonld, hours, rating } = detectJsonLd(pages);
  const checks: SiteChecks = {
    booking: detectBooking(pages, siteUrl),
    ecommerce: detectEcommerce(pages, siteUrl),
    chat: detectChat(pages),
    contact_form: detectContactForm(pages),
    tel: detectTel(pages),
    mailto: detectMailto(pages),
    social: detectSocial(pages),
    mobile_viewport: detectViewport(pages),
    jsonld,
    jsonld_opening_hours: hours,
    jsonld_rating: rating,
    copyright_year: detectCopyrightYear(pages, now),
    builder: detectBuilder(pages),
    languages: detectLanguages(pages, siteUrl),
    analytics: detectAnalytics(pages),
  };
  // One place strips tracking parameters from every stored href, whichever detector wrote it.
  for (const c of Object.values(checks) as Check[]) {
    for (const e of c.evidence) if (e.href) e.href = cleanHref(e.href);
  }
  return checks;
}

/** Every check "could not see": an unreachable site. */
export function unseenChecks(): SiteChecks {
  return runDetectors([], "https://invalid.invalid");
}
