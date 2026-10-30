/**
 * Google PageSpeed Insights v5 (free with an API key, PAGESPEED_API_KEY).
 * One mobile run, four categories. Kept small: the 4 scores, LCP, CLS, TBT and
 * the hosts of third-party requests (tool evidence: a booking engine, a chat
 * widget or a pixel loaded by JavaScript shows up here when the HTML hid it).
 *
 * No key → status "no_key", nothing fetched. A run takes 10-40 s: never call
 * it inside research or the tick; the observe route runs it in parallel with
 * the crawl.
 */

import type { PsiResult, PsiStatus } from "./types.ts";

export const PSI_ENDPOINT = "https://www.googleapis.com/pagespeedonline/v5/runPagespeed";
export const MAX_THIRD_PARTY = 40;

export type PsiOutcome = { status: PsiStatus; result: PsiResult | null; error: string | null };
export type RunPsi = (url: string, timeoutMs: number) => Promise<PsiOutcome>;

export function psiRequestUrl(url: string, key: string): string {
  const q = new URLSearchParams({ url, strategy: "mobile", key });
  for (const c of ["performance", "seo", "accessibility", "best-practices"]) q.append("category", c);
  return `${PSI_ENDPOINT}?${q.toString()}`;
}

type Json = Record<string, unknown>;
const obj = (x: unknown): Json => (x && typeof x === "object" && !Array.isArray(x) ? (x as Json) : {});
const num = (x: unknown): number | null => (typeof x === "number" && Number.isFinite(x) ? x : null);
const score = (cat: unknown): number | null => {
  const s = num(obj(cat).score);
  return s === null ? null : Math.round(s * 100);
};

function hostOf(u: string): string | null {
  try {
    return new URL(u).hostname.toLowerCase().replace(/^www\./, "");
  } catch {
    return null;
  }
}

/** Registrable-ish site of a host: the last two labels, three for ccSLDs (com.mx, co.uk). */
function siteOf(host: string): string {
  const parts = host.split(".");
  const n = parts.length >= 3 && /^(com|co|org|net|gob|edu)$/.test(parts[parts.length - 2] ?? "") ? 3 : 2;
  return parts.slice(-n).join(".");
}

/** The PSI response, reduced to what we keep. Pure. */
export function reducePsi(body: unknown, siteUrl: string, fetchedAt = new Date().toISOString()): PsiResult {
  const lh = obj(obj(body).lighthouseResult);
  const cats = obj(lh.categories);
  const audits = obj(lh.audits);
  const audit = (id: string) => num(obj(audits[id]).numericValue);
  const own = siteOf(hostOf(String(lh.finalDisplayedUrl ?? lh.finalUrl ?? siteUrl)) ?? hostOf(siteUrl) ?? "");
  const items = obj(obj(audits["network-requests"]).details).items;
  const third = new Set<string>();
  if (Array.isArray(items)) {
    for (const it of items) {
      const h = hostOf(String(obj(it).url ?? ""));
      if (h && siteOf(h) !== own) third.add(h);
    }
  }
  const cls = audit("cumulative-layout-shift");
  return {
    scores: {
      performance: score(cats.performance),
      seo: score(cats.seo),
      accessibility: score(cats.accessibility),
      best_practices: score(cats["best-practices"]),
    },
    lcp_ms: audit("largest-contentful-paint") === null ? null : Math.round(audit("largest-contentful-paint") as number),
    cls: cls === null ? null : Math.round(cls * 1000) / 1000,
    tbt_ms: audit("total-blocking-time") === null ? null : Math.round(audit("total-blocking-time") as number),
    third_party_domains: [...third].sort().slice(0, MAX_THIRD_PARTY),
    final_url: typeof lh.finalDisplayedUrl === "string" ? lh.finalDisplayedUrl : typeof lh.finalUrl === "string" ? lh.finalUrl : null,
    fetched_at: fetchedAt,
  };
}

/** A runner bound to a key (null = no key: every call answers "no_key" without a request). */
export function makeRunPsi(key: string | null | undefined, fetchImpl: typeof fetch = fetch): RunPsi {
  return async (url, timeoutMs) => {
    if (!key) return { status: "no_key", result: null, error: null };
    if (timeoutMs <= 0) return { status: "timeout", result: null, error: "no time left" };
    try {
      const res = await fetchImpl(psiRequestUrl(url, key), { signal: AbortSignal.timeout(timeoutMs) });
      const body: unknown = await res.json().catch(() => null);
      if (!res.ok) {
        // Google's error text names the problem, never the key.
        const msg = String(obj(obj(body).error).message ?? "").slice(0, 200);
        return { status: "error", result: null, error: `HTTP ${res.status}${msg ? ` ${msg}` : ""}` };
      }
      return { status: "ok", result: reducePsi(body, url), error: null };
    } catch (err) {
      const e = err as Error;
      if (e.name === "TimeoutError" || e.name === "AbortError") return { status: "timeout", result: null, error: `no answer in ${timeoutMs} ms` };
      return { status: "error", result: null, error: e.message.slice(0, 200) };
    }
  };
}
