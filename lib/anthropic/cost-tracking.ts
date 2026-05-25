import { createClient } from "@/lib/supabase/server";
import type { ClaudeUsage } from "./client";

export type CostRecordInput = {
  tenantId: string;
  model: string;
  /** What we used Claude for. */
  entity_type: "research" | "scoring" | "pitch" | "reply_classify" | "icp_suggest";
  entity_id: string | null;
  usage: ClaudeUsage;
  /** Free-form metadata — model-specific stuff like prompt_variant_id. */
  metadata?: Record<string, unknown>;
};

const DAILY_USD_CAP_DEFAULT = 5.0;

function getDailyCap(): number {
  const raw = process.env.ANTHROPIC_DAILY_USD_CAP;
  if (!raw) return DAILY_USD_CAP_DEFAULT;
  const n = Number.parseFloat(raw);
  return Number.isFinite(n) && n > 0 ? n : DAILY_USD_CAP_DEFAULT;
}

/**
 * Record a Claude API call to cost_tracking. Best-effort — never throws.
 * Uses a fresh server-bound client so it works inside server actions.
 */
export async function recordClaudeCall(input: CostRecordInput): Promise<void> {
  try {
    const supabase = await createClient();
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
    } as never);
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
    const supabase = await createClient();
    const sinceIso = new Date(Date.now() - 24 * 3600 * 1000).toISOString();
    type Row = { cost_usd: number };
    const { data, error } = await supabase
      .from("cost_tracking")
      .select("cost_usd")
      .eq("tenant_id", tenantId)
      .eq("category", "anthropic")
      .gte("incurred_at", sinceIso)
      .returns<Row[]>();
    if (error) {
      console.warn(`[cost-tracking] daily-cap check failed: ${error.message}`);
      // Fail-open: if we can't read, allow the call. Cost-tracking insert
      // failure on the actual call would be the deeper issue.
      return { under: true, spent_today_usd: 0, cap_usd: cap };
    }
    const spent = (data ?? []).reduce((a, r) => a + Number(r.cost_usd), 0);
    return { under: spent < cap, spent_today_usd: spent, cap_usd: cap };
  } catch (err) {
    console.warn("[cost-tracking] daily-cap check threw:", err);
    return { under: true, spent_today_usd: 0, cap_usd: cap };
  }
}
