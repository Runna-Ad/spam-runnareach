/**
 * Site observations (migration 0054): what we SAW on a prospect's website, each
 * fact with the page or link that shows it, and an explicit "could not see".
 *
 * Zero server imports: the dossier, the writer and tests read these types.
 *
 * The one rule every reader relies on:
 *   found: true   we saw it; `evidence` names the page and the text/href.
 *   found: false  we looked everywhere it could be and it was not there. Only
 *                 written when every page the check depends on was readable
 *                 (lib/research/site-crawl/detectors.ts `absent`).
 *   found: null   we could not see: a page did not load, or it renders its
 *                 text/links with JavaScript (plain fetch gets an empty shell).
 *                 Never state an absence from a null.
 */

export const CRAWLER_VERSION = "site-crawl-1";

export type Evidence = {
  /** The page the evidence was on. */
  url: string;
  /** Visible text (link text, a matched line), clipped. */
  text?: string;
  /** The link target, or the script/asset URL that shows it. */
  href?: string;
};

export type Check = {
  found: boolean | null;
  evidence: Evidence[];
};

/** How a visitor books, when we saw a way. */
export type BookingChannel =
  | "external_engine" // a booking/scheduling tool on another domain (travelclick, calendly, reservations.<them>.com form…)
  | "marketplace" // a listing that takes bookings (booking.com/hotel/…, airbnb.ca/rooms/…)
  | "on_site" // a booking page, form or anchor on their own site
  | "whatsapp" // the only booking path seen is a WhatsApp chat ("Agendar cita" → wa.me)
  | "phone"; // the only booking path seen is a call ("Book now" → tel:)

/**
 * Booking, with its meaning spelled out:
 *   online    true  = a way to book online was seen (engine, marketplace listing, on-site page/form/anchor)
 *             false = every page was readable, no online path, and no booking word we could not resolve
 *             null  = could not see (a page unreadable, or a "Book" button/text that leads nowhere we can follow)
 *   channel   how they take bookings: an online channel when online = true; "whatsapp" / "phone"
 *             when that is the only path seen (online false or null); null when none was seen.
 *   strength  "strong" = an engine link, booking form, widget or booking page; "weak" = only an
 *             on-page anchor (#booknow) or a booking word on an ordinary page link. Phrase weak softly.
 *   found     = online (every check has `found`).
 */
export type BookingCheck = Check & {
  online: boolean | null;
  channel: BookingChannel | null;
  strength: "strong" | "weak" | null;
};
export type FormCheck = Check & { fields: number | null };
export type ValuesCheck = Check & { values: string[] };
export type RatingCheck = Check & { value: number | null; count: number | null };
export type YearCheck = Check & { year: number | null };
export type BuilderCheck = Check & { value: string | null };

export type SiteChecks = {
  booking: BookingCheck;
  ecommerce: Check;
  /** Live-chat widget or a WhatsApp chat link. */
  chat: ValuesCheck;
  contact_form: FormCheck;
  /** A clickable tel: link exists. false says nothing about a phone number written as text. */
  tel: Check;
  /** A mailto: link (or a Cloudflare-protected email link) exists. false says nothing about an address written as text. */
  mailto: Check;
  /** values = platforms (facebook, instagram…). */
  social: ValuesCheck;
  mobile_viewport: Check;
  /** values = schema.org types from JSON-LD. */
  jsonld: ValuesCheck;
  /** Opening hours in the site's JSON-LD (structured data). false says nothing about hours written as text. */
  jsonld_opening_hours: Check;
  /** aggregateRating in the site's JSON-LD (their own markup, not a review site). */
  jsonld_rating: RatingCheck;
  /** The newest year in a copyright line. */
  copyright_year: YearCheck;
  /** Site builder / CMS; found false = none we recognise (custom or unknown). */
  builder: BuilderCheck;
  /** values = language codes seen (html lang, hreflang, switcher links); found = more than one. */
  languages: ValuesCheck;
  /** values = analytics / ad pixels (Google Analytics, Meta Pixel…). */
  analytics: ValuesCheck;
};

export type PageReadable = {
  /** We got HTML back (2xx, text/html). */
  html: boolean;
  /** Enough visible text that the page is not a JavaScript shell. */
  text: boolean;
  /** Enough links that the navigation is in the HTML, not drawn by JavaScript. */
  links: boolean;
};

export type PageObservation = {
  url: string;
  /** Why this page was chosen ("home", "contact", "booking"…). */
  role: string;
  http_status: number | null;
  title: string | null;
  text_chars: number;
  links_seen: number;
  readable: PageReadable;
  /** Set when the page could not be read (timeout, 404, not_html, too_large, budget). */
  error?: string;
};

export type ObservationStatus = "ok" | "unreachable" | "blocked" | "not_html" | "too_large" | "offsite";

export type PsiStatus = "ok" | "no_key" | "timeout" | "error" | "skipped";

export type PsiResult = {
  /** 0-100 per Lighthouse category. */
  scores: { performance: number | null; seo: number | null; accessibility: number | null; best_practices: number | null };
  /** Largest Contentful Paint, ms. */
  lcp_ms: number | null;
  /** Cumulative Layout Shift. */
  cls: number | null;
  /** Total Blocking Time, ms. */
  tbt_ms: number | null;
  /** Hosts of third-party requests the page made (tool evidence), sorted. */
  third_party_domains: string[];
  /** The URL PSI actually measured. */
  final_url: string | null;
  fetched_at: string;
};

export type SiteObservation = {
  url: string;
  final_url: string | null;
  crawled_at: string;
  crawler_version: string;
  status: ObservationStatus;
  /** Every page fetched had readable HTML, text and links. */
  readable: PageReadable;
  pages: PageObservation[];
  checks: SiteChecks;
  /** Wall time of the crawl, ms (budget evidence). */
  duration_ms: number;
};
