import { z } from "zod";
import {
  ANTHROPIC_DEFAULT_MODEL,
  structuredCall,
  type ClaudeUsage,
  type SystemBlock,
} from "../anthropic/client.ts";

/**
 * Claude-powered structured-research classifier. Drop-in replacement
 * for the substring-matching heuristic in structured-research-action.ts.
 *
 * Strategy:
 *   - Sonnet 4.5: pain classification drives downstream pitch quality,
 *     so we pay for reasoning depth here. Haiku is too literal for
 *     "they have a checkout problem" hidden inside a paragraph about
 *     subscription churn.
 *   - The prompt enumerates the canonical pain options (id + display
 *     name + evidence_phrases). Claude must pick from those IDs — we
 *     reject any UUID it invents.
 *   - JSON-only response, Zod-validated. On any failure (auth,
 *     rate-limit, parse, timeout) the orchestrator falls back to
 *     the substring-matching heuristic.
 */

export type ClaudeResearchInput = {
  /** "what_they_do" paragraph from the scraped site. */
  what_they_do: string | null;
  /** Free-form scraper notes (often holds the contact-email line). */
  notes: string | null;
  /** Canonical pain catalogue Claude must pick from. */
  options: Array<{
    id: string;
    code: string;
    display_name: string;
    evidence_phrases: string[];
  }>;
  /** Pains we've already saved — Claude shouldn't re-add these. */
  existingPainIds: string[];
};

export type ClaudeResearchPain = {
  pain_id: string;
  pain_label: string;
  evidence_quote: string;
  confidence: number;
};

export type ClaudeResearchResult = {
  pain_points: ClaudeResearchPain[];
  decision_maker_email: string | null;
  reasoning: string;
  usage: ClaudeUsage;
  model: string;
  raw: string;
};

const responseSchema = z.object({
  pain_points: z.array(
    z.object({
      pain_id: z.string().uuid(),
      pain_label: z.string().trim().min(1).max(200),
      // Cap at 240 to match the heuristic's quote length contract.
      evidence_quote: z.string().trim().min(1).max(240),
      confidence: z.number().min(0).max(1),
    }),
  ),
  decision_maker_email: z.string().email().nullable(),
  // Lenient default — Sonnet drops it under 0.5%.
  reasoning: z
    .string()
    .trim()
    .max(800)
    .optional()
    .default("(no reasoning provided)"),
});

export async function runResearchWithClaude(
  input: ClaudeResearchInput,
): Promise<
  | { ok: true; result: ClaudeResearchResult }
  | { ok: false; error: string; reason: string; usage: ClaudeUsage | null }
> {
  // Empty haystack → bail. Don't burn tokens on nothing.
  const haystack = [input.what_they_do ?? "", input.notes ?? ""].join("\n").trim();
  if (!haystack) {
    return {
      ok: false,
      error: "No what_they_do or notes — nothing to classify.",
      reason: "empty_input",
      usage: null,
    };
  }
  if (input.options.length === 0) {
    return {
      ok: false,
      error: "Empty pain taxonomy — caller must seed it.",
      reason: "empty_taxonomy",
      usage: null,
    };
  }

  // System = static analyst instructions + the canonical pain taxonomy. Both are
  // identical for every prospect in a run (the taxonomy is per-tenant), so we
  // mark them cacheable and move the taxonomy OUT of the per-prospect user
  // prompt — where it was re-billed on all ~180 prospects/run. The model sees
  // the same information, just relocated user→system.
  const system: SystemBlock[] = [
    { text: buildSystemPrompt(), cache: true },
    { text: buildTaxonomyBlock(input.options), cache: true },
  ];
  const user = buildUserPrompt(input);

  const call = await structuredCall({
    model: ANTHROPIC_DEFAULT_MODEL,
    system,
    user,
    max_tokens: 1500,
    schema: responseSchema,
  });

  if (!call.ok) {
    return { ok: false, error: call.error, reason: call.reason, usage: call.usage };
  }

  // Hallucination guard: every pain_id Claude returns must be in our
  // options list. Otherwise it invented a UUID and the foreign key
  // would explode at insert time.
  const validIds = new Set(input.options.map((o) => o.id));
  const existing = new Set(input.existingPainIds);
  const cleaned: ClaudeResearchPain[] = [];
  for (const p of call.data.pain_points) {
    if (!validIds.has(p.pain_id)) {
      return {
        ok: false,
        error: `Claude returned unknown pain_id ${p.pain_id} — not in taxonomy.`,
        reason: "hallucinated_pain",
        usage: call.usage,
      };
    }
    // Also drop pains we already have — heuristic does the same.
    if (existing.has(p.pain_id)) continue;
    cleaned.push(p);
  }

  return {
    ok: true,
    result: {
      pain_points: cleaned,
      decision_maker_email: call.data.decision_maker_email,
      reasoning: call.data.reasoning ?? "(no reasoning provided)",
      usage: call.usage,
      model: call.model,
      raw: call.raw,
    },
  };
}

function buildSystemPrompt(): string {
  return `You are a B2B sales-research analyst. You read a scraped paragraph about
a prospect company plus free-form scraper notes, and you tag the prospect's
business pains against a fixed taxonomy of canonical pains. You also pick the
best contact email from the notes when one is present.

Your job has two outputs:

1. **pain_points** — every canonical pain that the research clearly evidences.
   - Pick ONLY from the supplied taxonomy. Each pain_id MUST be one of the
     UUIDs in the candidates list. Do not invent UUIDs.
   - For each pain you tag, capture an evidence_quote: the actual sentence
     (or paraphrase ≤ 240 chars) from the source text that supports the call.
     If you can't find a clear evidence sentence, do NOT tag the pain.
   - confidence is your honest 0..1 grade: 0.9+ when the text directly states
     the problem ("our mobile checkout is broken"), 0.6–0.8 when it's
     strongly implied (subscription brand with no SMS flow → low_email_performance
     is plausible at 0.6, not 0.95), <0.5 means too thin — DON'T include it.
   - Be conservative. False positives downstream cause bad pitches. Skip
     pains that are merely possible. Tag only what's evidenced.

2. **decision_maker_email** — the best email address to contact.
   - Look for a line like "Contact emails: a@x, b@y, ..." in notes.
   - Prefer non-role-based (sarah@x beats info@x, hello@x, sales@x).
   - Return null if no usable email is in the notes.

Output as a JSON object EXACTLY matching this shape:
{
  "pain_points": [
    {
      "pain_id": "<UUID from taxonomy>",
      "pain_label": "<display name from taxonomy>",
      "evidence_quote": "<actual sentence, ≤240 chars>",
      "confidence": <number 0..1>
    }
  ],
  "decision_maker_email": "<email>" | null,
  "reasoning": "<1-3 sentences explaining your picks. Required.>"
}

Empty pain_points array is legal — better to skip than to guess. Respond
with ONLY the JSON. No prose, no markdown fences.`;
}

// Static per-run: the canonical pain catalogue. Lives in a cached system block
// so it isn't re-billed on every prospect. Claude must echo pain_id values
// verbatim from here, so it's passed as a clean JSON list (no typos).
function buildTaxonomyBlock(
  options: ClaudeResearchInput["options"],
): string {
  const taxonomy = options.map((o) => ({
    pain_id: o.id,
    code: o.code,
    display_name: o.display_name,
    evidence_phrases: o.evidence_phrases,
  }));
  return `CANONICAL PAIN TAXONOMY — you MUST pick every pain_id from this list.
Do not invent UUIDs; echo the pain_id values below verbatim.

\`\`\`json
${JSON.stringify(taxonomy, null, 2)}
\`\`\``;
}

function buildUserPrompt(input: ClaudeResearchInput): string {
  const payload = {
    research: {
      what_they_do: input.what_they_do ?? "(none)",
      notes: input.notes ?? "(none)",
    },
    already_tagged_pain_ids: input.existingPainIds,
  };

  return `Classify this prospect's pain points and pick the best decision-maker
email. The pain_id you return MUST come from the CANONICAL PAIN TAXONOMY in the
system prompt; do not re-tag anything in already_tagged_pain_ids.

\`\`\`json
${JSON.stringify(payload, null, 2)}
\`\`\``;
}
