import { promises as dns } from "node:dns";

/**
 * Verify a domain has at least one MX record. Used during manual upload to
 * flag entries whose domains can't receive email — we still accept them
 * (the pipeline may discover an alternate email later) but mark a red_flag.
 *
 * Returns:
 *   - { ok: true, mx: [...] }    — domain has MX records
 *   - { ok: false, reason: ... } — no MX, or DNS lookup failed
 *
 * Wraps Node's `dns.resolveMx` so callers don't need to handle ENOTFOUND vs
 * ENODATA vs malformed-domain separately.
 */
export type MxResult =
  | { ok: true; mx: string[] }
  | { ok: false; reason: "no_mx" | "nxdomain" | "lookup_failed"; detail?: string };

export async function verifyDomainHasMx(domain: string): Promise<MxResult> {
  if (!/^[a-z0-9.-]+\.[a-z]{2,}$/i.test(domain)) {
    return { ok: false, reason: "lookup_failed", detail: "malformed domain" };
  }

  try {
    const records = await dns.resolveMx(domain);
    if (!records || records.length === 0) return { ok: false, reason: "no_mx" };
    return { ok: true, mx: records.map((r) => r.exchange).filter(Boolean) };
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOTFOUND") return { ok: false, reason: "nxdomain" };
    if (code === "ENODATA") return { ok: false, reason: "no_mx" };
    return {
      ok: false,
      reason: "lookup_failed",
      detail: err instanceof Error ? err.message : String(err),
    };
  }
}
