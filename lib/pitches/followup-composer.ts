/**
 * AI follow-up composer — the smart brain behind emails 2 and 3 of the
 * outreach sequence. Same quality bar as the reply-funnel draft composer:
 * deeply personalised to the prospect (their pain, tech, city, and crucially
 * their ORIGINAL pitch so the follow-up never repeats itself), EN/ES aware,
 * no em dashes, with a distinct angle per step.
 *
 * Goal of every follow-up: get a reply (a 20-minute chat). Email 2 is a
 * fresh-value nudge; email 3 is a graceful breakup.
 *
 * Falls back to the deterministic hand-written templates
 * (lib/pitches/followup-templates.ts) when Claude is unavailable or capped —
 * the sequence always sends something.
 */

import { z } from "zod";
import {
  ANTHROPIC_DEFAULT_MODEL,
  structuredCall,
  type ClaudeUsage,
} from "../anthropic/client.ts";

// Permanent rule: ALL cold-email CTAs point at the Inefficiency Hunter.
const HUNTER_URL = "https://runna-hunter.vercel.app/";

export type FollowupComposerInput = {
  /** 2 = first follow-up (nudge), 3 = final (breakup). */
  step: 2 | 3;
  companyName: string;
  contactFirstName: string | null;
  language: "en" | "es";
  market: "CA" | "MX";
  industry: string | null;
  city: string | null;
  /** Subject of the original pitch thread (we reply Re: this). */
  originalSubject: string;
  /** The original pitch body — so the model writes something DIFFERENT. */
  originalBody: string | null;
  /** One-line pain + optional evidence quote from research. */
  painSummary: string | null;
  evidenceQuote: string | null;
  /** Plain-language description of what they do (from research). */
  whatTheyDo: string | null;
  /** Detected tech stack (from research). */
  techStack: string[];
  /** Recoverable-revenue figure from a hunter scan, if any. */
  hunterValue: number | null;
  senderFirstName: string;
  agencyName: string;
};

export type ComposedFollowup = {
  subject: string;
  body: string;
  reasoning: string;
};

// Clip, don't reject — a hard .max() overrun on any field dumps the follow-up to
// the static template fallback. Generous ceiling, then slice to spec.
const responseSchema = z.object({
  subject: z.string().trim().min(3).max(600).transform((s) => s.slice(0, 140)),
  body: z.string().trim().min(30).max(8000).transform((s) => s.slice(0, 1200)),
  reasoning: z.string().trim().max(4000).transform((s) => s.slice(0, 400)).optional().default("(no reasoning provided)"),
});

export async function composeFollowupWithClaude(
  input: FollowupComposerInput,
): Promise<
  | { ok: true; followup: ComposedFollowup; usage: ClaudeUsage; model: string }
  | { ok: false; error: string; reason: string; usage: ClaudeUsage | null }
> {
  const call = await structuredCall({
    model: ANTHROPIC_DEFAULT_MODEL,
    system: buildSystemPrompt(input.language, input.step),
    user: buildUserPrompt(input),
    max_tokens: 450,
    schema: responseSchema,
  });

  if (!call.ok) {
    return { ok: false, error: call.error, reason: call.reason, usage: call.usage };
  }

  // Hard-strip em dashes — permanent rule shared with the pitch composer.
  const cleanBody = call.data.body
    .replace(/\s*—\s*/g, ", ")
    .replace(/—/g, " ")
    .replace(/ {2,}/g, " ")
    .trim();

  return {
    ok: true,
    followup: {
      subject: ensureReSubject(call.data.subject, input.originalSubject),
      body: cleanBody,
      reasoning: call.data.reasoning ?? "(no reasoning provided)",
    },
    usage: call.usage,
    model: call.model,
  };
}

function ensureReSubject(subject: string, original: string): string {
  const base = (subject || original || "Re:").trim();
  return /^re:/i.test(base) ? base : `Re: ${base}`;
}

function buildSystemPrompt(lang: "en" | "es", step: 2 | 3): string {
  const langName = lang === "es" ? "Spanish (Mexican B2B register)" : "English (Canadian market)";

  const stepRules =
    step === 2
      ? `THIS IS FOLLOW-UP #1 (the nudge), sent ~3 days after the first email got no reply.
- Keep it SHORT: 40-70 words. A busy owner skims it in 5 seconds.
- Do NOT just say "bumping this" or "following up". Add ONE fresh angle the first email
  did not lead with: a new specific observation, a benchmark, a quick proof point, or a
  sharper version of the pain. Give them a NEW reason to reply.
- Light, human, zero guilt-tripping. Acknowledge they're busy.
- End with a low-friction ask: "still worth a quick 20 minutes?" or similar.`
      : `THIS IS FOLLOW-UP #2 (the final / breakup), sent ~5 days after #1 got no reply.
- Keep it SHORT: 45-80 words. This is the LAST email in the sequence.
- Be honest that it's the last note. No desperation, no guilt. Confident and warm.
- Restate the core value/opportunity in one crisp line (use the dollar figure if available).
- Offer an easy out + a sweetener: e.g. "if a 20-min call isn't worth it, coffee's on me,
  and I'll leave you alone after this." Leave the door open for the future.`;

  return `You write a FOLLOW-UP email in an ongoing cold-outreach thread to a prospect who has
not replied yet. You are Runna, a creative + design agency (brand, web/ecommerce, email flows,
paid social, AI automation, custom apps, UX, content, packaging).

THE GOAL: get a reply. Specifically, a short 20-minute chat. Every follow-up nudges toward that.

${stepRules}

ABSOLUTE FORMAT RULES (violations fail QA):
- NO em dashes. Use commas or periods.
- NO jargon (funnel, ROAS, retargeting, nurture, LTV, CRO). Plain business language only.
- NO "Hi there" / "Hola there". Use the contact's first name; if unknown, "Hi {company} team," /
  "Hola equipo de {company},".
- Do NOT repeat the original email's opening line or phrasing. The reader has seen it. Say
  something genuinely different. You are given the original email precisely so you can avoid it.
- Write the ENTIRE email in ${langName}. Never mix languages.
- One soft CTA only. If you reference a free check/audit, use the Inefficiency Hunter link
  provided (a free 30-second audit, no signup), on its own line starting with 👉. No call-booking
  links, no Loom, no attachments.
- Sign off: sender's first name on one line, agency name on the next.

Output JSON EXACTLY:
{
  "subject": string,   // keep the original thread subject, prefixed "Re:" if not already
  "body": string,      // plain text, \\n line breaks, no markdown
  "reasoning": string  // 1 sentence on the angle you chose. Required.
}`;
}

function buildUserPrompt(input: FollowupComposerInput): string {
  const payload = {
    step: input.step,
    prospect: {
      company_name: input.companyName,
      contact_first_name: input.contactFirstName,
      industry: input.industry,
      city: input.city,
      market: input.market,
      what_they_do: input.whatTheyDo,
      tech_stack: input.techStack,
    },
    pain: {
      summary: input.painSummary,
      evidence_quote: input.evidenceQuote,
    },
    recoverable_revenue: input.hunterValue,
    original_thread_subject: input.originalSubject,
    // The first email we sent — write something DIFFERENT from this.
    original_email_body: (input.originalBody ?? "").slice(0, 1200) || null,
    sender: { first_name: input.senderFirstName, agency: input.agencyName },
    hunter_url: HUNTER_URL,
  };

  return `Write follow-up #${input.step} for this prospect. It must read as a natural next message
in the same thread, take a fresh angle (do NOT echo original_email_body), and push gently toward
a 20-minute chat.

\`\`\`json
${JSON.stringify(payload, null, 2)}
\`\`\``;
}
