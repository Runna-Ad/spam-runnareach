import Anthropic from "@anthropic-ai/sdk";
import type { z } from "zod";

/**
 * Single shared Anthropic client. Pinned to a specific Sonnet 4.5
 * snapshot so behavior changes are explicit (and we can decide when to
 * upgrade). Per-call timeout 15s — research/score/pitch are interactive
 * and shouldn't block longer than that.
 *
 * For cost-sensitive simple classifications (reply intent, ICP suggest)
 * callers can pass `model: "claude-haiku-4-5"` to override per call.
 */
export const ANTHROPIC_DEFAULT_MODEL = "claude-sonnet-4-5-20250929";
export const ANTHROPIC_HAIKU_MODEL = "claude-haiku-4-5";
const DEFAULT_TIMEOUT_MS = 15_000;
const DEFAULT_MAX_RETRIES = 2;

let _client: Anthropic | null = null;
function getClient(): Anthropic {
  if (_client) return _client;
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error("ANTHROPIC_API_KEY not set");
  _client = new Anthropic({
    apiKey,
    timeout: DEFAULT_TIMEOUT_MS,
    maxRetries: DEFAULT_MAX_RETRIES,
  });
  return _client;
}

/**
 * True if Claude is configured. Use this to gate code paths instead of
 * calling claudeIsAvailable() and catching — keeps the heuristic
 * fallback decision explicit.
 */
export function claudeIsAvailable(): boolean {
  return Boolean(process.env.ANTHROPIC_API_KEY);
}

export type ClaudeUsage = {
  input_tokens: number;
  output_tokens: number;
  cache_read_input_tokens: number;
  cache_creation_input_tokens: number;
  cost_usd: number;
};

/**
 * Token pricing as of 2026-04 (per 1M tokens).
 * Source: anthropic.com/pricing — update when this drifts.
 */
const PRICING: Record<string, { input_per_mtok: number; output_per_mtok: number }> = {
  "claude-sonnet-4-5-20250929": { input_per_mtok: 3, output_per_mtok: 15 },
  "claude-haiku-4-5": { input_per_mtok: 1, output_per_mtok: 5 },
};

export function computeCostUsd(
  model: string,
  input_tokens: number,
  output_tokens: number,
): number {
  const p = PRICING[model] ?? PRICING[ANTHROPIC_DEFAULT_MODEL]!;
  const cost = (input_tokens / 1_000_000) * p.input_per_mtok +
    (output_tokens / 1_000_000) * p.output_per_mtok;
  // 6 decimal places matches the cost_tracking column precision (numeric(10,6)).
  return Math.round(cost * 1_000_000) / 1_000_000;
}

export type StructuredCallInput<T> = {
  /** Optional model override; defaults to Sonnet 4.5. */
  model?: string;
  /** System prompt — domain-level instructions. */
  system: string;
  /** User prompt — task-specific request, fully resolved. */
  user: string;
  /** Max output tokens. Pitch ~600. Score/research ~1200. */
  max_tokens: number;
  /** Zod schema the JSON response must conform to. */
  schema: z.ZodType<T>;
};

export type StructuredCallResult<T> =
  | { ok: true; data: T; usage: ClaudeUsage; raw: string; model: string }
  | { ok: false; error: string; usage: ClaudeUsage | null; reason: "auth" | "rate_limit" | "timeout" | "parse" | "unknown" };

/**
 * One-shot call that asks Claude for JSON conforming to a Zod schema.
 *
 * Strategy:
 *   - Append a strict JSON-only instruction to the system prompt.
 *   - Parse the assistant's text response as JSON.
 *   - Run it through Zod. If parse fails, the call returns ok=false
 *     with reason="parse" so the orchestrator can fall back to the
 *     heuristic.
 *
 * Doesn't write to cost_tracking — caller does that with the returned
 * usage so it can also write entity_id/entity_type.
 */
export async function structuredCall<T>(
  input: StructuredCallInput<T>,
): Promise<StructuredCallResult<T>> {
  const model = input.model ?? ANTHROPIC_DEFAULT_MODEL;
  const client = getClient();

  const system =
    input.system +
    "\n\nRespond ONLY with valid JSON matching the requested schema. " +
    "No prose, no markdown fences, no leading or trailing text.";

  let response: Awaited<ReturnType<typeof client.messages.create>>;
  try {
    response = await client.messages.create({
      model,
      max_tokens: input.max_tokens,
      system,
      messages: [{ role: "user", content: input.user }],
    });
  } catch (err) {
    const reason = classifyErr(err);
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
      usage: null,
      reason,
    };
  }

  const text = response.content
    .map((b) => (b.type === "text" ? b.text : ""))
    .join("")
    .trim();
  const usage: ClaudeUsage = {
    input_tokens: response.usage.input_tokens,
    output_tokens: response.usage.output_tokens,
    cache_read_input_tokens: response.usage.cache_read_input_tokens ?? 0,
    cache_creation_input_tokens: response.usage.cache_creation_input_tokens ?? 0,
    cost_usd: computeCostUsd(
      model,
      response.usage.input_tokens,
      response.usage.output_tokens,
    ),
  };

  let parsedJson: unknown;
  try {
    // Be lenient — trim accidental code fences if Claude slips up.
    const cleaned = text
      .replace(/^```(?:json)?\s*/i, "")
      .replace(/\s*```$/i, "");
    parsedJson = JSON.parse(cleaned);
  } catch (err) {
    return {
      ok: false,
      error: `JSON parse failed: ${err instanceof Error ? err.message : String(err)}. Raw: ${text.slice(0, 200)}`,
      usage,
      reason: "parse",
    };
  }

  const zodResult = input.schema.safeParse(parsedJson);
  if (!zodResult.success) {
    return {
      ok: false,
      error: `Schema validation failed: ${zodResult.error.issues.map((i) => `${i.path.join(".")}:${i.message}`).join("; ")}`,
      usage,
      reason: "parse",
    };
  }

  return {
    ok: true,
    data: zodResult.data,
    usage,
    raw: text,
    model,
  };
}

function classifyErr(err: unknown): "auth" | "rate_limit" | "timeout" | "unknown" {
  if (!(err instanceof Error)) return "unknown";
  const m = err.message.toLowerCase();
  if (m.includes("401") || m.includes("authentication") || m.includes("invalid api key")) {
    return "auth";
  }
  if (m.includes("429") || m.includes("rate limit") || m.includes("overloaded")) {
    return "rate_limit";
  }
  if (m.includes("timeout") || m.includes("aborted")) return "timeout";
  return "unknown";
}

// Test seam — let unit tests inject a mock SDK. Production code never
// calls these; tests do via lib/anthropic/client.ts dynamic import.
export const __test__ = {
  reset() {
    _client = null;
  },
  setClient(c: Anthropic | null) {
    _client = c;
  },
};
