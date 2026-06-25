/**
 * Hunter.io Domain Search API client.
 *
 * Given a domain, returns personal emails known for that company,
 * sorted by confidence descending. Generic/role-based emails are
 * excluded — the scraper already handles those.
 *
 * Docs: https://hunter.io/api-documentation/v2#domain-search
 */

import pRetry from "p-retry";

const HUNTER_BASE = "https://api.hunter.io/v2";

export type HunterContact = {
  email: string;
  first_name: string | null;
  last_name: string | null;
  position: string | null;
  confidence: number; // 0–100
};

export type HunterDomainResult =
  | { ok: true; contacts: HunterContact[]; pattern: string | null }
  | { ok: false; error: string; status?: number };

/**
 * Search Hunter for personal emails at a given domain.
 * Returns only `type === "personal"` entries with confidence >= 50.
 * Safe to call when HUNTER_API_KEY is not set — returns ok:false cleanly.
 */
export async function hunterDomainSearch(domain: string): Promise<HunterDomainResult> {
  const key = process.env.HUNTER_API_KEY;
  if (!key) return { ok: false, error: "HUNTER_API_KEY not set" };

  const clean = domain.replace(/^https?:\/\//, "").replace(/\/.*$/, "").toLowerCase();
  if (!clean || !clean.includes(".")) return { ok: false, error: "Invalid domain" };

  let res: Response;
  try {
    // Retry up to 2x on transient failures. Hunter quota errors (429) are retried with backoff.
    res = await pRetry(
      async () => {
        const url = new URL(`${HUNTER_BASE}/domain-search`);
        url.searchParams.set("domain", clean);
        url.searchParams.set("type", "personal");
        url.searchParams.set("limit", "10");
        url.searchParams.set("api_key", key);
        const r = await fetch(url.toString(), {
          method: "GET",
          headers: { Accept: "application/json" },
          signal: AbortSignal.timeout(8_000),
        });
        // Retry on rate limit and server errors
        if (r.status === 429 || r.status >= 500) throw new Error(`Hunter HTTP ${r.status}`);
        return r;
      },
      { retries: 1, minTimeout: 1000, factor: 2 },
    );
  } catch (err) {
    return { ok: false, error: `Network error: ${err instanceof Error ? err.message : String(err)}` };
  }

  if (!res.ok) {
    return { ok: false, error: `Hunter returned HTTP ${res.status}`, status: res.status };
  }

  let json: unknown;
  try {
    json = await res.json();
  } catch {
    return { ok: false, error: "Hunter returned non-JSON response" };
  }

  const data = (json as { data?: unknown })?.data;
  if (!data || typeof data !== "object") {
    return { ok: false, error: "Unexpected Hunter response shape" };
  }

  const d = data as {
    pattern?: string | null;
    emails?: {
      value?: string;
      type?: string;
      confidence?: number;
      first_name?: string | null;
      last_name?: string | null;
      position?: string | null;
    }[];
  };

  const contacts: HunterContact[] = (d.emails ?? [])
    .filter((e) => e.type === "personal" && typeof e.value === "string" && (e.confidence ?? 0) >= 50)
    .sort((a, b) => (b.confidence ?? 0) - (a.confidence ?? 0))
    .map((e) => ({
      email: e.value!.toLowerCase(),
      first_name: e.first_name ?? null,
      last_name: e.last_name ?? null,
      position: e.position ?? null,
      confidence: e.confidence ?? 50,
    }));

  return { ok: true, contacts, pattern: d.pattern ?? null };
}
