/**
 * Wanted facts: the statistic the pitch writer or critic wished it had.
 *
 * When neither has a sourced figure for the pain an email leads with, the
 * email goes out without a number and the wish is recorded here
 * (record_wanted_fact, 0050), so the weekly research step can look for a
 * real source. Same wish from many pitches = one row, request_count bumped.
 *
 * Best-effort, always: a wish is never worth a pitch. Nothing here throws,
 * every database call has a time limit, and a failure is one console.warn.
 */

import type { createClient } from "@/lib/supabase/server";

type Client = Awaited<ReturnType<typeof createClient>>;

/** The 0050 CHECK on wanted_facts.fact, applied before the call. */
export const WANTED_FACT_MIN_CHARS = 8;
export const WANTED_FACT_MAX_CHARS = 300;
/** Per RPC call. The whole recording is capped a little above it. */
export const WANTED_FACT_TIMEOUT_MS = 3_000;

export type WantedFactSource = "writer" | "critic";

/** Lower case, accents folded: "Clínica" and "clinica" are the same name. */
function fold(s: string): string {
  return s.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "");
}

/**
 * The fact as it will be recorded, or null when it must be discarded:
 * - not text, or shorter than 8 / longer than 300 characters after trim;
 * - any digit: the wish is the question, not the answer, and a model that
 *   writes "70% of stores…" is guessing the number we lack;
 * - names the prospect (its company_name, 4+ characters, anywhere in it):
 *   the library holds industry facts, never one about a company.
 */
export function cleanWantedFact(raw: unknown, companyName: string | null | undefined): string | null {
  if (typeof raw !== "string") return null;
  const fact = raw.replace(/\s+/g, " ").trim();
  if (fact.length < WANTED_FACT_MIN_CHARS || fact.length > WANTED_FACT_MAX_CHARS) return null;
  if (/\d/.test(fact)) return null;
  const company = fold(companyName?.trim() ?? "");
  if (company.length >= 4 && fold(fact).includes(company)) return null;
  return fact;
}

/** The 0050 dedupe key (record_wanted_fact computes the stored one): one call per key per pitch. */
export function wantedFactKey(fact: string): string {
  return fact.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
}

export type WantedFactsRequest = {
  tenantId: string;
  pitchId: string;
  companyName: string | null;
  industry: string | null;
  market: string | null;
  /** The kept draft's wishes, as the models wrote them (null/absent = none). */
  writer: string | null | undefined;
  critic: string | null | undefined;
  /** The pain_taxonomy code the email led with; only looked up when a fact survives. */
  painCode: () => Promise<string | null>;
};

/**
 * Record at most one writer and one critic wish for one pitch. Resolves with
 * the number of facts recorded; never rejects, and settles within about
 * `timeoutMs` (plus a small margin) however slow the database is.
 */
export async function recordWantedFacts(
  supabase: Pick<Client, "rpc">,
  req: WantedFactsRequest,
  opts: { timeoutMs?: number } = {},
): Promise<number> {
  const timeoutMs = opts.timeoutMs ?? WANTED_FACT_TIMEOUT_MS;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const cap = new Promise<number>((resolve) => {
    timer = setTimeout(() => {
      console.warn("[wanted-facts] not recorded: timed out");
      resolve(0);
    }, timeoutMs + 500);
  });
  try {
    return await Promise.race([record(supabase, req, timeoutMs), cap]);
  } catch (e) {
    console.warn("[wanted-facts] not recorded:", e instanceof Error ? e.message : String(e));
    return 0;
  } finally {
    clearTimeout(timer);
  }
}

async function record(supabase: Pick<Client, "rpc">, req: WantedFactsRequest, timeoutMs: number): Promise<number> {
  const facts: Array<{ source: WantedFactSource; fact: string }> = [];
  const keys = new Set<string>();
  for (const [source, raw] of [["writer", req.writer], ["critic", req.critic]] as const) {
    const fact = cleanWantedFact(raw, req.companyName);
    if (!fact) continue;
    // The writer and critic asking for the same thing is one request from this pitch.
    const key = wantedFactKey(fact);
    if (keys.has(key)) continue;
    keys.add(key);
    facts.push({ source, fact });
  }
  if (facts.length === 0) return 0;

  let painCode: string | null = null;
  try {
    painCode = await req.painCode();
  } catch {
    painCode = null;
  }

  const results = await Promise.all(
    facts.map(async ({ source, fact }) => {
      try {
        const { error } = await supabase
          .rpc("record_wanted_fact", {
            p_tenant_id: req.tenantId,
            p_fact: fact,
            p_source: source,
            p_pain_code: painCode,
            p_industry: req.industry,
            p_market: req.market,
            p_pitch_id: req.pitchId,
          })
          .abortSignal(AbortSignal.timeout(timeoutMs));
        // Presence, not truthiness: an empty-body 5xx is { message: "" }.
        if (error) {
          console.warn(`[wanted-facts] ${source} fact not recorded:`, error.message || "no message");
          return 0;
        }
        return 1;
      } catch (e) {
        console.warn(`[wanted-facts] ${source} fact not recorded:`, e instanceof Error ? e.message : String(e));
        return 0;
      }
    }),
  );
  return results.reduce<number>((a, b) => a + b, 0);
}
