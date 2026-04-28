import { z } from "zod";
import {
  ANTHROPIC_HAIKU_MODEL,
  structuredCall,
  type ClaudeUsage,
} from "../anthropic/client.ts";
import type { ClassifyInput, ClassifyResult } from "./classify.ts";

/**
 * Claude-powered reply intent classifier. Drop-in replacement for
 * `classifyReplyHeuristic` — same input/output shape, different brain.
 *
 * Strategy:
 *   - Use Haiku 4.5: classifications are short, frequent, and don't
 *     need Sonnet's reasoning depth. ~$0.0003 per classification.
 *   - System prompt enumerates the 7 intents + the urgency/sentiment
 *     rubric so Claude's output is grounded in our taxonomy, not its
 *     prior beliefs about email intent labels.
 *   - JSON-only response, Zod-validated.
 *
 * On any failure (auth, rate-limit, parse, timeout) returns ok=false
 * so the orchestrator can fall back to heuristic.
 */

const INTENTS = [
  "wants_meeting",
  "wants_info",
  "hard_no",
  "not_now",
  "wrong_person",
  "auto_reply",
  "unclassified",
] as const;

const responseSchema = z.object({
  intent: z.enum(INTENTS),
  // Urgency tracks how soon a human should look. Null is allowed for
  // "unclassified" where we can't tell — heuristic does the same.
  urgency: z.enum(["hot", "warm", "cold"]).nullable(),
  sentiment: z.enum(["positive", "neutral", "negative"]).nullable(),
  // Lenient default — Haiku occasionally drops fields under 0.5%.
  reasoning: z
    .string()
    .trim()
    .max(400)
    .optional()
    .default("(no reasoning provided)"),
});

export type ClaudeClassifyResult = {
  classification: ClassifyResult;
  usage: ClaudeUsage;
  model: string;
  raw: string;
};

export async function classifyReplyWithClaude(
  input: ClassifyInput,
): Promise<
  | { ok: true; result: ClaudeClassifyResult }
  | { ok: false; error: string; reason: string; usage: ClaudeUsage | null }
> {
  // Empty payload — heuristic returns "unclassified", we should too.
  // Don't burn tokens on a no-signal payload.
  const subj = (input.subject ?? "").trim();
  const body = (input.body_text ?? "").trim();
  if (!subj && !body) {
    return {
      ok: false,
      error: "Empty subject and body — nothing to classify.",
      reason: "empty_input",
      usage: null,
    };
  }

  const system = buildSystemPrompt();
  const user = buildUserPrompt(input);

  const call = await structuredCall({
    model: ANTHROPIC_HAIKU_MODEL,
    system,
    user,
    max_tokens: 200,
    schema: responseSchema,
  });

  if (!call.ok) {
    return { ok: false, error: call.error, reason: call.reason, usage: call.usage };
  }

  return {
    ok: true,
    result: {
      classification: {
        intent: call.data.intent,
        urgency: call.data.urgency,
        sentiment: call.data.sentiment,
        reasoning: call.data.reasoning ?? "(no reasoning provided)",
      },
      usage: call.usage,
      model: call.model,
      raw: call.raw,
    },
  };
}

function buildSystemPrompt(): string {
  return `You classify B2B sales-email replies into a fixed taxonomy. Your job is
to read a single inbound reply and tag the sender's intent, urgency, and sentiment.

Intent taxonomy (pick exactly one):
- "wants_meeting" — sender wants to book a call/meeting/demo. Phrases like "let's
  chat", "happy to jump on a call", a Calendly link, "when works for you".
- "wants_info" — sender is curious, asking for a deck, case studies, pricing, or
  more details. They're warm but not yet ready to meet.
- "hard_no" — explicit unsubscribe / not interested / "remove me" / "do not contact".
  Treat "please remove me from your list" as hard_no, NOT wrong_person.
- "not_now" — defer signal. "Not right now", "circle back next quarter", "after
  the holidays", "too busy", "maybe later". Sender isn't saying no, just not yet.
- "wrong_person" — sender is not the right contact, suggests forwarding to someone
  else, or says "please contact X instead". This is a routing signal, not a no.
- "auto_reply" — out-of-office / vacation / parental leave / automatic reply. The
  sender did not actually engage; bot did.
- "unclassified" — genuinely ambiguous, no strong signal. Use sparingly — if
  there's any clear intent, pick the matching category.

Precedence rules (highest wins when multiple signals):
1. auto_reply — if it's an OOO bounce, that wins regardless of body content.
2. hard_no — explicit unsubscribe trumps any meeting language ("not interested,
   please don't contact again, ever" is hard_no even if it ends with "let's chat").
3. wrong_person — only if no hard_no signal.
4. wants_meeting > wants_info > not_now in that order when multiple appear.

Urgency:
- "hot" — wants_meeting (sender is ready to talk now)
- "warm" — wants_info or not_now (engaged but not booked)
- "cold" — auto_reply, wrong_person, hard_no
- null — unclassified

Sentiment:
- "positive" — wants_meeting, wants_info, generally enthusiastic language
- "neutral" — auto_reply, wrong_person, not_now (no emotional charge)
- "negative" — hard_no, frustrated/angry tone
- null — unclassified

Output a JSON object EXACTLY matching this shape:
{
  "intent": "wants_meeting" | "wants_info" | "hard_no" | "not_now" | "wrong_person" | "auto_reply" | "unclassified",
  "urgency": "hot" | "warm" | "cold" | null,
  "sentiment": "positive" | "neutral" | "negative" | null,
  "reasoning": string  // 1 sentence explaining the call. Required.
}

Respond with ONLY the JSON. No prose, no markdown fences.`;
}

function buildUserPrompt(input: ClassifyInput): string {
  const subj = input.subject?.trim() || "(no subject)";
  // Trim long bodies — quoted history doesn't help classification and
  // burns tokens. Keep first 2000 chars; senders usually lead with the
  // intent before the quoted previous email.
  const body = (input.body_text ?? "").trim().slice(0, 2000) || "(no body)";

  return `Classify this reply:

From: ${input.from_email}
Subject: ${subj}

Body:
${body}`;
}
