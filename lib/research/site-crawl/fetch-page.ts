/**
 * One page, plain fetch: a hard timeout, a size cap read off the stream (a huge
 * page costs CPU to parse, and CPU is the Vercel budget), and an outcome that
 * says WHY a page could not be read, so the caller can tell "blocked by a bot
 * wall" from "the site is down" from "it is a PDF".
 */

/**
 * Who we are, honestly: the crawler convention ("compatible; <name>; +<url>").
 * A site that refuses this UA comes out "blocked", which the detectors read as
 * "could not see"; we never dress up as a browser to get past a bot wall.
 */
export const CRAWL_USER_AGENT = "Mozilla/5.0 (compatible; RunnaSiteCheck/1.0; +https://runna.com.mx)";
/** The robots.txt token for CRAWL_USER_AGENT. */
export const ROBOTS_AGENT = "runnasitecheck";

/** Pages above this are cut off unread: parsing them is CPU we don't have. */
export const MAX_PAGE_BYTES = 1_500_000;

export type FetchOutcome =
  | { ok: true; status: number; finalUrl: string; html: string }
  | {
      ok: false;
      status: number | null;
      finalUrl: string | null;
      error: "timeout" | "network" | "dns" | "http" | "blocked" | "not_html" | "too_large";
      detail: string;
    };

export type FetchPage = (url: string, timeoutMs: number) => Promise<FetchOutcome>;

const CHALLENGE = /<title>\s*(just a moment|attention required|access denied|un momento)/i;

/** A bot wall rather than the site: Cloudflare/Akamai challenge pages and their headers. */
export function isBlockedResponse(status: number, headers: Headers, head: string): boolean {
  if (headers.get("cf-mitigated") === "challenge") return true;
  // A 403 or 429 is the site refusing us, WAF header or not: the site is up, we may not read it.
  if (status === 403 || status === 429) return true;
  if ((status === 403 || status === 429 || status === 503) && /cloudflare|akamai|sucuri|incapsula/i.test(headers.get("server") ?? ""))
    return true;
  return CHALLENGE.test(head);
}

async function readCapped(res: Response, cap: number): Promise<string | null> {
  if (!res.body) return await res.text();
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > cap) {
      await reader.cancel().catch(() => undefined);
      return null;
    }
    chunks.push(value);
  }
  return new TextDecoder("utf-8").decode(Buffer.concat(chunks));
}

export const fetchPage: FetchPage = async (url, timeoutMs) => {
  if (timeoutMs <= 0) return { ok: false, status: null, finalUrl: null, error: "timeout", detail: "no time left in the site budget" };
  try {
    const res = await fetch(url, {
      headers: {
        "User-Agent": CRAWL_USER_AGENT,
        Accept: "text/html,application/xhtml+xml;q=0.9,*/*;q=0.5",
        "Accept-Language": "en-CA,en;q=0.9,es-MX;q=0.8,es;q=0.7,fr;q=0.5",
      },
      redirect: "follow",
      signal: AbortSignal.timeout(timeoutMs),
    });
    const finalUrl = res.url || url;
    const type = res.headers.get("content-type") ?? "";
    const isHtml = /text\/html|application\/xhtml/i.test(type) || type === "";
    if (!isHtml) {
      await res.body?.cancel().catch(() => undefined);
      return { ok: false, status: res.status, finalUrl, error: "not_html", detail: type };
    }
    const html = await readCapped(res, MAX_PAGE_BYTES);
    if (html === null) return { ok: false, status: res.status, finalUrl, error: "too_large", detail: `over ${MAX_PAGE_BYTES} bytes` };
    if (isBlockedResponse(res.status, res.headers, html.slice(0, 4000)))
      return { ok: false, status: res.status, finalUrl, error: "blocked", detail: `HTTP ${res.status} bot challenge` };
    if (!res.ok) return { ok: false, status: res.status, finalUrl, error: "http", detail: `HTTP ${res.status}` };
    return { ok: true, status: res.status, finalUrl, html };
  } catch (err) {
    const e = err as Error & { cause?: { code?: unknown } };
    if (e.name === "TimeoutError" || e.name === "AbortError")
      return { ok: false, status: null, finalUrl: null, error: "timeout", detail: `no answer in ${timeoutMs} ms` };
    const code = e.cause && typeof e.cause === "object" ? String(e.cause.code ?? "") : "";
    if (code === "ENOTFOUND") return { ok: false, status: null, finalUrl: null, error: "dns", detail: "domain does not resolve" };
    return { ok: false, status: null, finalUrl: null, error: "network", detail: (code || e.message).slice(0, 200) };
  }
};
