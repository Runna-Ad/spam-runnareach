import { z } from "zod";
import {
  ANTHROPIC_DEFAULT_MODEL,
  structuredCall,
  type ClaudeUsage,
} from "../anthropic/client.ts";
import type {
  ComposedPitch,
  GeneratorInputs,
} from "./generator.ts";

/**
 * Claude-powered pitch composer. Drop-in replacement for
 * `composePitchHeuristic` — same input/output shape, different brain.
 *
 * Strategy:
 *   - System prompt frames Claude as a B2B cold-email copywriter who
 *     writes for Runna CA's tone (concise, evidence-led, no fluff).
 *   - User prompt structures the prospect's situation as JSON so
 *     Claude has a clean grounding without prose ambiguity.
 *   - Response is JSON conforming to a Zod schema covering subject,
 *     body, chosen pain_id + case_study_id (must come from the input
 *     candidate lists — Claude can't invent them), reasoning, and
 *     a self-grade.
 *
 * On any failure (auth, rate-limit, parse, timeout) returns null so
 * the orchestrator can fall back to heuristic.
 */

const responseSchema = z.object({
  subject: z.string().trim().min(8).max(200),
  body: z.string().trim().min(80).max(2000),
  pain_id: z.string().uuid().nullable(),
  // Nullable: Claude is told to set this to null when no case study
  // clearly addresses the prospect's pain. Better to omit a weak case
  // than fabricate a strong one. The body must NOT name a client when
  // case_study_id is null.
  case_study_id: z.string().uuid().nullable(),
  contact_email: z.string().email().nullable(),
  measurable_result_included: z.boolean(),
  quality_self_score: z.number().min(0).max(1),
  // Be lenient: Claude sometimes drops this even when asked. Default to
  // "(no reasoning provided)" rather than failing the whole call.
  reasoning: z.string().trim().max(800).optional().default("(no reasoning provided)"),
});

export type ClaudeComposeResult = {
  composed: ComposedPitch;
  usage: ClaudeUsage;
  model: string;
  raw: string;
};

export async function composePitchWithClaude(
  input: GeneratorInputs,
): Promise<
  | { ok: true; result: ClaudeComposeResult }
  | { ok: false; error: string; reason: string; usage: ClaudeUsage | null }
> {
  // Note: empty case_studies is now legal — case_study_id is nullable,
  // so we let Claude produce a no-case pitch (the system prompt has a
  // "Structure when case_study_id=null" branch). The bail-out only
  // matters in tests that explicitly check the legacy behaviour; we keep
  // the option but gate it on a zero-pain-zero-case payload (truly nothing to say).
  if (input.case_studies.length === 0 && input.pains.length === 0) {
    return {
      ok: false,
      error: "No case studies and no pains — nothing to compose.",
      reason: "no_case_studies",
      usage: null,
    };
  }

  const lang = input.prospect.language;
  const system = buildSystemPrompt(lang);
  const user = buildUserPrompt(input);

  const call = await structuredCall({
    model: ANTHROPIC_DEFAULT_MODEL,
    system,
    user,
    max_tokens: 800,
    schema: responseSchema,
  });

  if (!call.ok) {
    return { ok: false, error: call.error, reason: call.reason, usage: call.usage };
  }

  // Validate that pain_id and case_study_id Claude returned were in our
  // candidate lists — protects against hallucinated UUIDs. case_study_id
  // is allowed to be null when no case fits (Claude is instructed to do
  // so rather than force a bad bridge).
  const validCaseIds = new Set(input.case_studies.map((c) => c.id));
  if (
    call.data.case_study_id !== null &&
    !validCaseIds.has(call.data.case_study_id)
  ) {
    return {
      ok: false,
      error: `Claude returned unknown case_study_id ${call.data.case_study_id}`,
      reason: "hallucinated_case",
      usage: call.usage,
    };
  }
  const validPainIds = new Set(input.pains.map((p) => p.pain_id).filter(Boolean));
  if (call.data.pain_id !== null && !validPainIds.has(call.data.pain_id)) {
    return {
      ok: false,
      error: `Claude returned unknown pain_id ${call.data.pain_id}`,
      reason: "hallucinated_pain",
      usage: call.usage,
    };
  }

  return {
    ok: true,
    result: {
      composed: {
        subject: call.data.subject,
        body: call.data.body,
        pain_id: call.data.pain_id,
        case_study_id: call.data.case_study_id,
        contact_used: call.data.contact_email,
        measurable_result_included: call.data.measurable_result_included,
        quality_self_score: call.data.quality_self_score,
        reasoning: call.data.reasoning ?? "(no reasoning provided)",
      },
      usage: call.usage,
      model: call.model,
      raw: call.raw,
    },
  };
}

function buildSystemPrompt(language: "en" | "es"): string {
  const langName = language === "es" ? "Spanish (neutral, business-friendly)" : "English";
  return `You are a B2B cold-email copywriter for Runna CA, a Canadian creative + design agency
working with DTC ecommerce brands and professional services.

Your job: compose a 5-line elevator-pitch email opener (~120-160 words). The email must
fit in a recipient's inbox preview, get them curious, and earn a reply — not close a deal.

Voice rules:
- Concise. Cut every adverb. No "I hope this email finds you well."
- Evidence-led. Reference one specific thing about the prospect (their evidence_quote).
- One pain, one case, one ask. No feature dump.
- Plain text only. No markdown, no images, no links other than what we provide.
- Soft, curiosity-driven CTA: "Worth a 15-min look next week?" / "¿Vale la pena una llamada?"
- Sign off with sender's first name + agency name.

Required structure (when a case study fits):
1. Salutation ("Hi {first_name}," / "Hola {first_name},")
2. Opening hook citing the evidence_quote in context
3. Pain framing in industry context — name the pattern, not the pain abstractly
4. Bridge to ONE case study: "We helped {case_client} ({case_metric}). Same shape as ..."
5. Soft 15-min CTA
6. Sign off: sender's first name on its own line, then full signature

Structure when case_study_id=null (no good fit):
1. Salutation
2. Opening hook citing evidence_quote
3. Pain framing in industry context
4. (skip the "we helped" bridge entirely — do NOT mention any client name)
5. Generic capability claim ("This is the shape of work we do for {industry}
   teams" or similar — lean on the agency-level claim, not a specific client)
6. Soft 15-min CTA
7. Sign off

Language: ${langName}.

You will be given a JSON payload with prospect, contacts, candidate pains, candidate case
studies (each with client_name, industry, hero_metric, result_description, testimonial,
measurable_results, and a pain_strength score), and the sender.

Case-study selection rules — be honest, don't force fit:
1. READ each case study's result_description carefully. The case study must clearly
   address THE SAME KIND OF PROBLEM as the prospect's pain.
2. A packaging-design case is NOT a match for a checkout-flow pain even if both are
   "design work." A brand-refresh case is NOT a match for an email-deliverability pain.
3. Prefer (in order): (a) result_description directly addresses the pain pattern,
   (b) industry match with prospect, (c) highest pain_strength.
4. If NO case_study clearly addresses the prospect's pain, set case_study_id=null and
   write a pitch WITHOUT a "we helped X" bridge. Better to omit a weak case than to
   fake a strong one.
5. The pain_id and case_study_id you choose (when not null) MUST come from the
   candidates_pains[].pain_id and candidates_cases[].id lists. Do not invent UUIDs.
6. If no pain has evidence_quote, set pain_id=null and produce a less-personalized opener.

Output the final pitch as a JSON object with EXACTLY these fields:
{
  "subject": string,                    // 8–200 chars, plain text
  "body": string,                       // 80–2000 chars, plain text with \\n line breaks (no \\r), no markdown
  "pain_id": string | null,             // UUID from candidates_pains[].pain_id, or null if no pain matches
  "case_study_id": string | null,       // UUID from candidates_cases[].id, OR null if no case fits the pain
  "contact_email": string | null,       // email of the contact you addressed, or null
  "measurable_result_included": boolean,// true ONLY if you cited a specific number/percentage in body
  "quality_self_score": number,         // 0..1, your honest grade of personalization + evidence
  "reasoning": string                   // 1–3 sentences explaining your pain + case picks (or why you set case_study_id=null). REQUIRED.
}

ALL fields are required (use null only where the type allows). Do not omit "reasoning".
Body must be plain text with \\n line breaks. quality_self_score (0..1) is your own grade
of how personalized + evidenced the email is — be honest.`;
}

function buildUserPrompt(input: GeneratorInputs): string {
  // We pass a clean JSON payload so Claude grounds on facts, not prose.
  // The candidates lists carry the IDs Claude must pick from.
  const payload = {
    prospect: {
      company_name: input.prospect.company_name,
      industry: input.prospect.industry ?? null,
      language: input.prospect.language,
    },
    candidates_pains: input.pains.map((p) => ({
      pain_id: p.pain_id,
      pain_label: p.pain_label,
      evidence_quote: p.evidence_quote,
    })),
    candidates_contacts: input.contacts.map((c) => ({
      full_name: c.full_name,
      email: c.email,
      role_based: c.email_is_role_based,
    })),
    candidates_cases: input.case_studies.map((cs) => ({
      id: cs.id,
      client_name: cs.client_name,
      industry: cs.industry,
      hero_metric: input.prospect.language === "es"
        ? cs.hero_metric_es ?? cs.hero_metric_en ?? "(metric pending)"
        : cs.hero_metric_en ?? cs.hero_metric_es ?? "(metric pending)",
      result_description: input.prospect.language === "es"
        ? cs.result_description_es ?? cs.result_description_en ?? null
        : cs.result_description_en ?? cs.result_description_es ?? null,
      testimonial_quote: input.prospect.language === "es"
        ? cs.testimonial_quote_es ?? cs.testimonial_quote_en ?? null
        : cs.testimonial_quote_en ?? cs.testimonial_quote_es ?? null,
      measurable_results: cs.measurable_results,
      pain_strength: cs.pain_strength,
    })),
    sender: {
      full_name: input.sender.full_name,
      agency_name: input.sender.tenant_display_name,
    },
    deep_pitch_url: input.deep_pitch_url ?? null,
  };

  return `Compose the cold-email pitch from this payload:

\`\`\`json
${JSON.stringify(payload, null, 2)}
\`\`\`

If deep_pitch_url is provided, append a single line at the end of the body before the
sign-off: "More context if useful: {deep_pitch_url}" (or in Spanish:
"Más contexto si te sirve: {deep_pitch_url}").

Set contact_email to the email of the contact you addressed (the named non-role-based one
if available; otherwise the best fallback; null if no contact at all).

Set measurable_result_included=true only if the chosen case study's hero_metric is a real
measurable number/percentage (not "(metric pending)").`;
}
