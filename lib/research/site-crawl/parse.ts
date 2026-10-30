/**
 * One cheerio pass per page: everything the detectors need, copied into plain
 * data so the DOM can be dropped right away (parsing is the CPU cost, so each
 * page is parsed exactly once).
 */

import * as cheerio from "cheerio";
import type { PageReadable } from "./types.ts";

/** Below this much visible text the page is a JavaScript shell, not content. */
export const MIN_TEXT_CHARS = 200;
/** Below this many real links the navigation is drawn by JavaScript. */
export const MIN_LINKS = 3;
/** Visible text kept for the text detectors (copyright, languages). */
const TEXT_KEEP = 30_000;

export type PageLink = {
  /** Absolute URL, or the raw value for tel:/mailto:/whatsapp:. */
  href: string;
  /** Link text, else aria-label/title, collapsed and clipped. */
  text: string;
  /** Same page fragment (#booknow): on-site, not fetched. */
  fragment: boolean;
};

export type PageForm = {
  /** Visible fields a person fills in (text, email, tel, textarea, select…). */
  fields: number;
  hasEmailOrTel: boolean;
  hasTextarea: boolean;
  search: boolean;
  action: string;
};

export type ParsedPage = {
  url: string;
  title: string | null;
  text: string;
  textChars: number;
  links: PageLink[];
  forms: PageForm[];
  scriptSrcs: string[];
  iframeSrcs: string[];
  jsonld: unknown[];
  viewport: string | null;
  htmlLang: string | null;
  hreflangs: string[];
  generator: string | null;
  /** Raw HTML, for the fingerprint regexes (builder, analytics, chat). */
  html: string;
};

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
const squash = (s: string) => s.replace(/\s+/g, " ").trim();

function absolute(raw: string, base: string): string | null {
  const v = raw.trim();
  if (!v || /^javascript:/i.test(v)) return null;
  if (/^(tel|mailto|sms|whatsapp):/i.test(v)) return v;
  try {
    return new URL(v, base).toString();
  } catch {
    return null;
  }
}

/**
 * htmlparser2 instead of cheerio's default parse5: same links and text on the
 * 200 study pages, about 5x less CPU (1.3 s vs 7.1 s), and CPU is the Vercel budget.
 */
const PARSE_OPTIONS = { xml: { xmlMode: false, decodeEntities: true } } as const;

export function parsePage(html: string, url: string): ParsedPage {
  const $ = cheerio.load(html, PARSE_OPTIONS);

  const jsonld: unknown[] = [];
  $('script[type="application/ld+json"]').each((_, el) => {
    const raw = $(el).text().trim();
    if (!raw) return;
    try {
      jsonld.push(JSON.parse(raw));
    } catch {
      // Malformed JSON-LD is common; it is not evidence of anything.
    }
  });
  const scriptSrcs = $("script[src]")
    .map((_, el) => $(el).attr("src") ?? "")
    .get()
    .filter(Boolean);
  const iframeSrcs = $("iframe[src]")
    .map((_, el) => $(el).attr("src") ?? "")
    .get()
    .filter(Boolean);

  const links: PageLink[] = [];
  $("a[href]").each((_, el) => {
    const a = $(el);
    const raw = (a.attr("href") ?? "").trim();
    const fragment = raw.startsWith("#") && raw.length > 1;
    const href = fragment ? raw : absolute(raw, url);
    if (!href || raw === "#") return;
    const text = squash(a.text()) || squash(a.attr("aria-label") ?? "") || squash(a.attr("title") ?? "");
    links.push({ href, text: clip(text, 120), fragment });
  });

  const forms: PageForm[] = [];
  $("form").each((_, el) => {
    const f = $(el);
    const inputs = f.find("input, textarea, select").filter((__, i) => {
      const t = ($(i).attr("type") ?? "text").toLowerCase();
      return !["hidden", "submit", "button", "image", "reset", "checkbox", "radio"].includes(t);
    });
    const types = inputs.map((__, i) => ($(i).attr("type") ?? (i.tagName === "textarea" ? "textarea" : "text")).toLowerCase()).get();
    const names = inputs.map((__, i) => `${$(i).attr("name") ?? ""} ${$(i).attr("id") ?? ""}`.toLowerCase()).get().join(" ");
    const action = f.attr("action") ?? "";
    const search =
      f.attr("role") === "search" ||
      types.includes("search") ||
      /search|buscar|\/\?s=/i.test(action) ||
      (inputs.length === 1 && /(^|\s)(s|q|search|query)(\s|$)/.test(names));
    forms.push({
      fields: inputs.length,
      hasEmailOrTel: types.includes("email") || types.includes("tel") || /mail|correo|phone|tel/.test(names),
      hasTextarea: f.find("textarea").length > 0,
      search,
      action,
    });
  });

  const title = squash($("title").first().text()) || null;
  const viewport = $('meta[name="viewport"]').attr("content") ?? null;
  const htmlLang = ($("html").attr("lang") ?? "").trim() || null;
  const hreflangs = $('link[rel="alternate"][hreflang]')
    .map((_, el) => ($(el).attr("hreflang") ?? "").toLowerCase())
    .get()
    .filter(Boolean);
  const generator = $('meta[name="generator"]').attr("content") ?? null;

  $("script, style, noscript, template, svg, iframe").remove();
  const text = squash($("body").text());

  return {
    url,
    title: title ? clip(title, 200) : null,
    text: text.slice(0, TEXT_KEEP),
    textChars: text.length,
    links,
    forms,
    scriptSrcs,
    iframeSrcs,
    jsonld,
    viewport,
    htmlLang,
    hreflangs,
    generator,
    html,
  };
}

/** Real navigation links: not fragments, not tel/mailto. */
export const navLinkCount = (p: ParsedPage): number => p.links.filter((l) => !l.fragment && /^https?:/i.test(l.href)).length;

export function readableOf(p: ParsedPage): PageReadable {
  return { html: true, text: p.textChars >= MIN_TEXT_CHARS, links: navLinkCount(p) >= MIN_LINKS };
}
