import { createServiceRoleClient } from "@/lib/supabase/service-role";
import type { ClaudeUsage } from "./client";

/*
 * Service-role client, scoped by the explicit tenantId every caller passes.
 * The cookie client this used to create only works inside a logged-in
 * request: in cron routes (follow-ups, reply poll, nudges) RLS saw no user,
 * so the cap READ returned zero rows (always "under the cap") and the cost
 * INSERT was rejected. Cron AI spend was uncapped and unrecorded.
 */

export type CostRecordInput = {
  tenantId: string;
  model: string;
  /** What we used Claude for. */
  entity_type: "research" | "scoring" | "pitch" | "reply_classify" | "reply_draft" | "icp_suggest";
  entity_id: string | null;
  usage: ClaudeUsage;
  /** Free-form metadata — model-specific stuff like prompt_variant_id. */
  metadata?: Record<string, unknown>;
};

// Safety net, not a run-stopper. Per-lead cost is driven down via prompt
// caching + cutting the redundant score call; this cap only trips on a
// genuine runaway. Override per-tenant via ANTHROPIC_DAILY_USD_CAP.
const DAILY_USD_CAP_DEFAULT = 6.0;

function getDailyCap(): number {
  const raw = process.env.ANTHROPIC_DAILY_USD_CAP;
  if (!raw) return DAILY_USD_CAP_DEFAULT;
  const n = Number.parseFloat(raw);
  return Number.isFinite(n) && n > 0 ? n : DAILY_USD_CAP_DEFAULT;
}

/** Record a Claude API call to cost_tracking. Best-effort — never throws. */
export async function recordClaudeCall(input: CostRecordInput): Promise<void> {
  try {
    const supabase = createServiceRoleClient();
    const { error } = await supabase.from("cost_tracking").insert({
      tenant_id: input.tenantId,
      category: "anthropic",
      sub_category: input.model,
      entity_type: input.entity_type,
      entity_id: input.entity_id,
      cost_usd: input.usage.cost_usd,
      metadata: {
        ...input.metadata,
        input_tokens: input.usage.input_tokens,
        output_tokens: input.usage.output_tokens,
        cache_read_input_tokens: input.usage.cache_read_input_tokens,
        cache_creation_input_tokens: input.usage.cache_creation_input_tokens,
      },
    });
    if (error) {
      console.warn(`[cost-tracking] insert failed: ${error.message}`);
    }
  } catch (err) {
    console.warn("[cost-tracking] record threw:", err);
  }
}

/**
 * Returns true if we're under the daily Anthropic spend cap.
 * Falsy result → caller should fall back to heuristic.
 *
 * Cap is configurable via ANTHROPIC_DAILY_USD_CAP env (default $5).
 * The query uses idx_cost_tenant_category for fast lookup.
 */
export async function isUnderDailyCap(tenantId: string): Promise<{
  under: boolean;
  spent_today_usd: number;
  cap_usd: number;
}> {
  const cap = getDailyCap();
  try {
    const supabase = createServiceRoleClient();
    const sinceIso = new Date(Date.now() - 24 * 3600 * 1000).toISOString();
    type Row = { cost_usd: number };
    // Paged: PostgREST returns at most 1000 rows per request, so one select
    // silently undercounted any day with more calls than that.
    const PAGE = 1000;
    let spent = 0;
    for (let from = 0; ; from += PAGE) {
      const { data, error } = await supabase
        .from("cost_tracking")
        .select("cost_usd")
        .eq("tenant_id", tenantId)
        .eq("category", "anthropic")
        .gte("incurred_at", sinceIso)
        .order("incurred_at", { ascending: true })
        .range(from, from + PAGE - 1)
        .returns<Row[]>();
      if (error) {
        console.warn(`[cost-tracking] daily-cap check failed: ${error.message}`);
        // Fail-open on a transient read error: a DB blip must not halt every
        // AI step. The cap is a runaway guard, not the primary cost control.
        return { under: true, spent_today_usd: spent, cap_usd: cap };
      }
      spent += (data ?? []).reduce((a, r) => a + Number(r.cost_usd), 0);
      if ((data ?? []).length < PAGE) break;
    }
    return { under: spent < cap, spent_today_usd: spent, cap_usd: cap };
  } catch (err) {
    console.warn("[cost-tracking] daily-cap check threw:", err);
    return { under: true, spent_today_usd: 0, cap_usd: cap };
  }
}
