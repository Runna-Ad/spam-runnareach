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

/** Online booking: found = a way to book online (engine, marketplace or on-site). */
export type BookingKind =
  | "external_engine" // link to a booking/scheduling tool on another domain (travelclick, calendly…)
  | "marketplace" // link to a listing that takes bookings (booking.com, airbnb, opentable…)
  | "on_site" // a booking link or anchor on their own site (#booknow, /reservations)
  | "whatsapp" // the only booking path is a WhatsApp chat ("Agendar cita" → wa.me)
  | "phone"; // the only booking path is a phone call ("Book now" → tel:)

export type BookingCheck = Check & { kind: BookingKind | null };
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
  tel: Check;
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

export type ObservationStatus = "ok" | "unreachable" | "blocked" | "not_html" | "offsite";

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
