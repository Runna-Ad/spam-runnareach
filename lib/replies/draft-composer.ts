/**
 * Reply-funnel draft composer.
 *
 * Given a classified inbound reply, drafts the response WE should send back.
 * The single goal of every draft is to book a meeting (the end goal of the
 * platform). Human-in-the-loop: the draft is reviewed + approved by Pedro
 * before it sends — this never auto-sends.
 *
 * Mirrors lib/pitches/claude-composer.ts: Sonnet 4.5, Zod-validated JSON,
 * em-dash stripping, and a deterministic heuristic fallback so the funnel
 * still produces a draft when Claude is unavailable or capped.
 */

import { z } from "zod";
import {
  ANTHROPIC_DEFAULT_MODEL,
  structuredCall,
  type ClaudeUsage,
} from "../anthropic/client.ts";
import type { ReplyIntent } from "./queries.ts";

export type DraftComposerInput = {
  /** First name of the person who replied, if known. */
  contactFirstName: string | null;
  companyName: string;
  language: "en" | "es";
  /** Classified intent of THEIR reply. */
  intent: ReplyIntent;
  /** The reply we're responding to. */
  replySubject: string | null;
  replyBody: string | null;
  /** Subject of the original pitch thread (for Re: continuity). */
  threadSubject: string | null;
  /** The pitch we originally sent — so the reply can SPEAK TO what they asked about. */
  originalPitchBody: string | null;
  /** Plain-language description of what the prospect does (from research). */
  whatTheyDo: string | null;
  /** One-line pain from research, for substance. */
  painSummary: string | null;
  /** Sender identity for the sign-off. */
  senderFirstName: string;
  agencyName: string;
};

export type ComposedDraft = {
  subject: string;
  body: string;
  reasoning: string;
};

const responseSchema = z.object({
  subject: z.string().trim().min(3).max(140),
  body: z.string().trim().min(40).max(1600),
  reasoning: z.string().trim().max(400).optional().default("(no reasoning provided)"),
});

export async function composeReplyDraftWithClaude(
  input: DraftComposerInput,
): Promise<
  | { ok: true; draft: ComposedDraft; usage: ClaudeUsage; model: string }
  | { ok: false; error: string; reason: string; usage: ClaudeUsage | null }
> {
  const call = await structuredCall({
    model: ANTHROPIC_DEFAULT_MODEL,
    system: buildSystemPrompt(input.language),
    user: buildUserPrompt(input),
    max_tokens: 800,
    schema: responseSchema,
  });

  if (!call.ok) {
    return { ok: false, error: call.error, reason: call.reason, usage: call.usage };
  }

  // Hard-strip em dashes — same permanent rule as the pitch composer.
  const cleanBody = call.data.body
    .replace(/\s*—\s*/g, ", ")
    .replace(/—/g, " ")
    .replace(/ {2,}/g, " ")
    .trim();

  return {
    ok: true,
    draft: {
      subject: ensureReSubject(call.data.subject, input.threadSubject),
      body: cleanBody,
      reasoning: call.data.reasoning ?? "(no reasoning provided)",
    },
    usage: call.usage,
    model: call.model,
  };
}

/**
 * Deterministic fallback draft when Claude is unavailable / capped / errors.
 * Intent-aware but generic — Pedro edits before sending anyway.
 */
export function composeReplyDraftHeuristic(input: DraftComposerInput): ComposedDraft {
  const greetName = input.contactFirstName?.trim() || input.companyName;
  const es = input.language === "es";
  const hi = es ? `Hola ${greetName},` : `Hi ${greetName},`;
  const signoff = `\n\n${es ? "Saludos" : "Best"},\n${input.senderFirstName}\n${input.agencyName}`;

  let core: string;
  switch (input.intent) {
    case "wants_meeting":
      core = es
        ? "Perfecto, me encantaría platicar. ¿Te queda bien una llamada de 20 minutos esta semana? Mándame un par de horarios que te funcionen y lo agendamos."
        : "Great, I'd love to talk. Would a quick 20-minute call this week work? Send me a couple of times that suit you and I'll lock it in.";
      break;
    case "wants_info":
      core = es
        ? "Claro, con gusto te comparto los detalles. Para no llenarte de correos, ¿te parece si lo vemos en una llamada corta de 15 minutos? Así te muestro justo lo que aplica a tu caso. ¿Qué día te funciona?"
        : "Happy to share the details. Rather than a wall of text, could we do a quick 15-minute call so I can show you exactly what fits your situation? What day works for you?";
      break;
    case "not_now":
      core = es
        ? "Sin problema, gracias por avisar. ¿Te parece si te escribo más adelante? Y si prefieres, dejamos agendada una llamada corta para cuando sea mejor momento."
        : "No problem at all, thanks for letting me know. Happy to circle back later, or we can pencil in a short call for whenever the timing is better. Whatever's easiest for you.";
      break;
    default:
      core = es
        ? "Gracias por tu respuesta. ¿Tendrías 15 minutos esta semana para una llamada rápida? Me ayudaría a entender mejor cómo podemos ayudarte."
        : "Thanks for getting back to me. Would you have 15 minutes this week for a quick call? It'd help me understand how we can best help.";
  }

  return {
    subject: ensureReSubject(input.threadSubject ?? input.replySubject ?? "", input.threadSubject),
    body: `${hi}\n\n${core}${signoff}`,
    reasoning: "(heuristic fallback — Claude unavailable)",
  };
}

function ensureReSubject(subject: string, threadSubject: string | null): string {
  const base = (subject || threadSubject || "Re: your note").trim();
  return /^re:/i.test(base) ? base : `Re: ${base}`;
}

function buildSystemPrompt(lang: "en" | "es"): string {
  const langName = lang === "es" ? "Spanish (Mexican B2B register)" : "English (Canadian market)";
  return `You are the sender (named below), a real person at a creative + AI agency, replying to a
prospect who answered your cold email. Write the reply WE send back. A human reviews it before it sends.

MINDSET (most important): they took the time to reply and asked about something specific. Treat this
like a friendly conversation between two people, NOT a sales sequence. Be genuinely helpful and warm
FIRST. A meeting is where this is heading, but it is the soft close, never the lead.

WHAT GOOD LOOKS LIKE:
1. Open warm and human, by their first name. React like a person who's glad they wrote back.
2. ACTUALLY ANSWER what they asked. You are given original_pitch_body (what we offered them) and
   research. If they asked about a specific thing we mentioned (e.g. "the automated trial-to-member
   nurture system"), engage with it for real: in 1-2 plain sentences, say what it is and the concrete
   benefit for a business like theirs. Make them feel heard and a little more excited about it. NEVER
   dodge their question with "let's hop on a call" as the answer.
3. THEN a soft, low-pressure next step. Friendly and optional, e.g. "want me to walk you through how
   it'd look for your business?" or "happy to show you a quick example if useful." Do NOT demand 2-3
   times or hard-book unless they themselves asked to meet.

VOICE:
- Warm, personable, confident. Sound like a helpful peer, not a bot or a closer. A little personality
  is good. 3 to 6 sentences. Never robotic, never templated, never salesy.
- NO em dashes. NO marketing jargon or corporate filler ("circle back", "touch base", "synergy",
  "leverage", "solutions"). Plain words a busy owner uses.
- Write the ENTIRE reply in ${langName}. Never mix languages.

BY INTENT (still answer their question first in every case):
- wants_info: they're curious. Genuinely answer using original_pitch_body, build a little excitement,
  then a soft offer to show more (a quick walkthrough or example). Booking is optional, not demanded.
- wants_meeting: they're ready. Match their energy, confirm warmly, make booking effortless (offer to
  send a couple of times or ask for theirs).
- not_now: respect it fully, stay warm, leave the door open. No push.
- anything else: be helpful and human, answer what you can, gently leave a soft next step.

Sign off with the sender's first name on one line, then the agency name on the next.

Output a JSON object EXACTLY matching:
{
  "subject": string,   // keep the thread subject, prefixed with "Re:" if not already
  "body": string,      // the reply, plain text with \\n line breaks, no markdown
  "reasoning": string  // 1 sentence on the approach. Required.
}`;
}

function buildUserPrompt(input: DraftComposerInput): string {
  const replyBody = (input.replyBody ?? "").trim().slice(0, 1500) || "(no body)";
  const pitch = (input.originalPitchBody ?? "").trim().slice(0, 1800) || "(not available)";
  return `Draft our reply.

Prospect company: ${input.companyName}
What they do: ${input.whatTheyDo ?? "(unknown)"}
Their main pain (from research): ${input.painSummary ?? "(unknown)"}
Person who replied: ${input.contactFirstName ?? "(unknown first name)"}
Their intent (classified): ${input.intent}
Original thread subject: ${input.threadSubject ?? "(none)"}

THE PITCH WE ORIGINALLY SENT THEM (use this to answer what they're asking about — they are
reacting to something in here):
${pitch}

THEIR REPLY (answer this for real, warmly):
Subject: ${input.replySubject ?? "(no subject)"}
Body:
${replyBody}

Sender (you): ${input.senderFirstName}
Agency: ${input.agencyName}

Write a warm, genuinely helpful reply that answers what they asked using the original pitch as
context, builds a little rapport, and ends with a soft, optional next step. Not robotic, not salesy.`;
}
