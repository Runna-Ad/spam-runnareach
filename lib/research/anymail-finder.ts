/**
 * Anymail Finder — Decision-Maker Email API client.
 *
 * Given a company domain, finds the email address of a decision-maker
 * (owner/CEO/buyer/marketing) — verified at 97%+ deliverability.
 * Only charges credits when a valid email is found.
 *
 * Docs: https://anymailfinder.com/email-finder-api/docs
 */

import pRetry from "p-retry";

const AMF_BASE = "https://api.anymailfinder.com/v5.1";

// Role categories to try, in priority order.
// For MX SMB retail/e-commerce the owner is usually CEO or buyer.
const DECISION_MAKER_CATEGORIES = ["ceo", "buyer", "operations", "marketing"] as const;

export type AnymailContact = {
  email: string;
  full_name: string | null;
  job_title: string | null;
  linkedin_url: string | null;
  category: string;
  credits_charged: number;
};

export type AnymailResult =
  | { ok: true; contact: AnymailContact }
  | { ok: false; error: string; status?: number };

/**
 * Find a verified decision-maker email at a given domain.
 * Tries role categories in order and returns the first valid result.
 * Safe to call when ANYMAIL_FINDER_API_KEY is not set — returns ok:false cleanly.
 */
export async function anymailFindDecisionMaker(domain: string): Promise<AnymailResult> {
  const key = process.env.ANYMAIL_FINDER_API_KEY;
  if (!key) return { ok: false, error: "ANYMAIL_FINDER_API_KEY not set" };

  const clean = domain.replace(/^https?:\/\//, "").replace(/\/.*$/, "").toLowerCase();
  if (!clean || !clean.includes(".")) return { ok: false, error: "Invalid domain" };

  let res: Response;
  try {
    // Retry up to 2x on transient failures (network, 5xx). Never retry 402/404 — those are
    // definitive "not found" or "no credits" responses, not transient errors.
    res = await pRetry(
      async () => {
        const r = await fetch(`${AMF_BASE}/find-email/decision-maker`, {
          method: "POST",
          headers: {
            "Authorization": `Bearer ${key}`,
            "Content-Type": "application/json",
            "Accept": "application/json",
          },
          body: JSON.stringify({
            domain: clean,
            decision_maker_category: DECISION_MAKER_CATEGORIES,
          }),
          // 12s per attempt (was 30s) — combined with 1 retry this bounds the
          // call to ~25s worst case so it can't blow a pipeline slice's budget.
          signal: AbortSignal.timeout(12_000),
        });
        // Don't retry on definitive soft failures
        if (r.status === 404 || r.status === 402) return r;
        // Retry on server errors
        if (r.status >= 500) throw new Error(`Anymail Finder server error ${r.status}`);
        return r;
      },
      { retries: 1, minTimeout: 800, factor: 2 },
    );
  } catch (err) {
    return {
      ok: false,
      error: `Network error: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  if (!res.ok) {
    // 402 = not enough credits, 404 = no match found — both are soft failures
    if (res.status === 404) return { ok: false, error: "No decision-maker found" };
    if (res.status === 402) return { ok: false, error: "Anymail Finder: insufficient credits" };
    return { ok: false, error: `Anymail Finder returned HTTP ${res.status}`, status: res.status };
  }

  let json: unknown;
  try {
    json = await res.json();
  } catch {
    return { ok: false, error: "Anymail Finder returned non-JSON response" };
  }

  const d = json as {
    email?: string | null;
    valid_email?: string | null;
    email_status?: string;
    person_full_name?: string | null;
    person_job_title?: string | null;
    person_linkedin_url?: string | null;
    decision_maker_category?: string;
    credits_charged?: number;
  };

  const email = d.valid_email ?? d.email ?? null;
  if (!email || d.email_status === "not_found" || d.email_status === "blacklisted") {
    return { ok: false, error: "No valid email found" };
  }

  return {
    ok: true,
    contact: {
      email: email.toLowerCase(),
      full_name: d.person_full_name ?? null,
      job_title: d.person_job_title ?? null,
      linkedin_url: d.person_linkedin_url ?? null,
      category: d.decision_maker_category ?? "unknown",
      credits_charged: d.credits_charged ?? 0,
    },
  };
}
