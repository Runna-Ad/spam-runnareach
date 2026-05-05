/**
 * 3-stage pitch composer.
 *
 * Stage 1 — Pain Translation  (Haiku): audit jargon → one human sentence
 * Stage 2 — Credibility Match (Haiku/deterministic): tier + industry filter
 * Stage 3 — Pitch Assembly   (Sonnet): write the email with strict rules
 *
 * External signature is identical to v1 — the rest of the pipeline is unchanged.
 */

import { z } from "zod";
import {
  ANTHROPIC_DEFAULT_MODEL,
  ANTHROPIC_HAIKU_MODEL,
  structuredCall,
  computeCostUsd,
  getClient,
  type ClaudeUsage,
} from "../anthropic/client.ts";
import type {
  ComposedPitch,
  GeneratorInputCaseStudy,
  GeneratorInputNotableClient,
  GeneratorInputs,
} from "./generator.ts";

// ── Zod schema (unchanged from v1) ───────────────────────────────────────────

const responseSchema = z.object({
  subject: z.string().trim().min(8).max(200),
  body: z.string().trim().min(80).max(2000),
  pain_id: z.string().uuid().nullable(),
  case_study_id: z.string().uuid().nullable(),
  contact_email: z.string().email().nullable(),
  measurable_result_included: z.boolean(),
  quality_self_score: z.number().min(0).max(1),
  reasoning: z.string().trim().max(800).optional().default("(no reasoning provided)"),
});

export type ClaudeComposeResult = {
  composed: ComposedPitch;
  usage: ClaudeUsage;
  model: string;
  raw: string;
};

// ── Helpers ───────────────────────────────────────────────────────────────────

type SizeSignal = "smb" | "mid_market" | "enterprise";

function deriveSize(estimate: number | null | undefined): SizeSignal {
  if (!estimate) return "smb";
  if (estimate >= 500) return "enterprise";
  if (estimate >= 50) return "mid_market";
  return "smb";
}

const ZERO_USAGE: ClaudeUsage = {
  input_tokens: 0,
  output_tokens: 0,
  cache_read_input_tokens: 0,
  cache_creation_input_tokens: 0,
  cost_usd: 0,
};

function addUsage(a: ClaudeUsage, b: ClaudeUsage): ClaudeUsage {
  return {
    input_tokens: a.input_tokens + b.input_tokens,
    output_tokens: a.output_tokens + b.output_tokens,
    cache_read_input_tokens: a.cache_read_input_tokens + b.cache_read_input_tokens,
    cache_creation_input_tokens: a.cache_creation_input_tokens + b.cache_creation_input_tokens,
    cost_usd: Math.round((a.cost_usd + b.cost_usd) * 1_000_000) / 1_000_000,
  };
}

function usageFromResponse(
  model: string,
  u: { input_tokens: number; output_tokens: number; cache_read_input_tokens?: number | null; cache_creation_input_tokens?: number | null },
): ClaudeUsage {
  const input = u.input_tokens;
  const output = u.output_tokens;
  return {
    input_tokens: input,
    output_tokens: output,
    cache_read_input_tokens: u.cache_read_input_tokens ?? 0,
    cache_creation_input_tokens: u.cache_creation_input_tokens ?? 0,
    cost_usd: computeCostUsd(model, input, output),
  };
}

// ── Main entry point (same signature as v1) ───────────────────────────────────

export async function composePitchWithClaude(
  input: GeneratorInputs,
): Promise<
  | { ok: true; result: ClaudeComposeResult }
  | { ok: false; error: string; reason: string; usage: ClaudeUsage | null }
> {
  if (input.case_studies.length === 0 && input.pains.length === 0) {
    return {
      ok: false,
      error: "No case studies and no pains — nothing to compose.",
      reason: "no_case_studies",
      usage: null,
    };
  }

  const size = deriveSize(input.prospect.employee_size_estimate);
  let totalUsage: ClaudeUsage = { ...ZERO_USAGE };

  // ── Stage 1: translate top pain into human language ───────────────────────
  const stage1 = await translateTopPain(input);
  totalUsage = addUsage(totalUsage, stage1.usage);

  // ── Stage 2: pick case studies by tier + industry ─────────────────────────
  const stage2 = await matchCredibility(input, size);
  totalUsage = addUsage(totalUsage, stage2.usage);

  // ── Stage 3: assemble the pitch ───────────────────────────────────────────
  const lang = input.prospect.language;
  const system =
    buildSystemPrompt(lang, size) +
    buildNotableClientsTierContext(input.notable_clients, lang);
  const user = buildStage3UserPrompt(input, stage1.text, stage2.cases);

  const call = await structuredCall({
    model: ANTHROPIC_DEFAULT_MODEL,
    system,
    user,
    max_tokens: 800,
    schema: responseSchema,
  });

  if (!call.ok) {
    return {
      ok: false,
      error: call.error,
      reason: call.reason,
      usage: addUsage(totalUsage, call.usage ?? ZERO_USAGE),
    };
  }

  totalUsage = addUsage(totalUsage, call.usage);

  // UUID hallucination guard
  const validCaseIds = new Set(input.case_studies.map((c) => c.id));
  if (call.data.case_study_id !== null && !validCaseIds.has(call.data.case_study_id)) {
    return {
      ok: false,
      error: `Claude returned unknown case_study_id ${call.data.case_study_id}`,
      reason: "hallucinated_case",
      usage: totalUsage,
    };
  }
  const validPainIds = new Set(
    input.pains.map((p) => p.pain_id).filter(Boolean) as string[],
  );
  if (call.data.pain_id !== null && !validPainIds.has(call.data.pain_id)) {
    return {
      ok: false,
      error: `Claude returned unknown pain_id ${call.data.pain_id}`,
      reason: "hallucinated_pain",
      usage: totalUsage,
    };
  }

  // Violation detector — drop score per forbidden term found
  const violations = detectViolations(call.data.body, lang);
  const adjustedScore = Math.max(
    0,
    Math.round((call.data.quality_self_score - violations * 0.15) * 100) / 100,
  );

  // If the primary contact is a role-based inbox (contact@, info@, hello@, etc.),
  // append a one-line forwarding ask so the gatekeeper has an easy action.
  const primaryContact =
    input.contacts.find((c) => !c.email_is_role_based && c.full_name) ??
    input.contacts.find((c) => !c.email_is_role_based) ??
    input.contacts[0];
  const forwardingLine =
    primaryContact?.email_is_role_based
      ? lang === "es"
        ? "\n\nSi no eres la persona indicada para esto, te agradecería mucho que puedas reenviarle este mensaje a quien corresponda."
        : "\n\nIf you're not the right person for this, I'd really appreciate it if you could pass this along to whoever handles it."
      : "";
  const finalBody = call.data.body + forwardingLine;

  return {
    ok: true,
    result: {
      composed: {
        subject: call.data.subject,
        body: finalBody,
        pain_id: call.data.pain_id,
        case_study_id: call.data.case_study_id,
        contact_used: call.data.contact_email,
        measurable_result_included: call.data.measurable_result_included,
        quality_self_score: adjustedScore,
        reasoning: call.data.reasoning ?? "(no reasoning provided)",
      },
      usage: totalUsage,
      model: call.model,
      raw: call.raw,
    },
  };
}

// ── Stage 1: Pain Translation ─────────────────────────────────────────────────

async function translateTopPain(
  input: GeneratorInputs,
): Promise<{ text: string; usage: ClaudeUsage }> {
  // Best pain: one with both pain_id AND evidence_quote → just evidence_quote → any labeled
  const topPain =
    input.pains.find((p) => p.pain_id && p.evidence_quote) ??
    input.pains.find((p) => p.evidence_quote) ??
    input.pains.find((p) => p.pain_label) ??
    null;

  if (!topPain) {
    const fallback =
      input.prospect.language === "es"
        ? "Hay oportunidades claras de mejora en su operación actual."
        : "There are clear opportunities to improve their current setup.";
    return { text: fallback, usage: { ...ZERO_USAGE } };
  }

  const lang = input.prospect.language;
  const langInstruction =
    lang === "es"
      ? "Responde SOLO en español mexicano natural. Nada de inglés, nada de jerga técnica."
      : "Respond ONLY in natural English. No technical jargon.";

  const systemPrompt = `You translate technical marketing audit findings into how a real business owner would describe the problem to a friend over coffee.

RULES:
- Output exactly ONE sentence. No more.
- ${langInstruction}
- No technical terms: no "abandonment flow", "retention automation", "Meta Pixel", "WooCommerce", "Shopify", platform names, or marketing jargon.
- Describe the BUSINESS CONSEQUENCE, not the technical symptom.
- Plain language. Short words. Sound human, not SaaS.
- Do NOT mention the prospect's name. No greetings. Just the sentence.

GOOD EXAMPLE (es):
Input: "No cart abandonment flow visible; WooCommerce default setup"
Output: "Estás perdiendo ventas de gente que llena el carrito y se va sin comprar — y no hay nada que las traiga de regreso."

GOOD EXAMPLE (en):
Input: "No cart abandonment flow visible; WooCommerce default setup"
Output: "You're losing sales from shoppers who add to cart and leave — and nothing is bringing them back."

BAD EXAMPLE (never):
"Vi que no tienes cart abandonment flow visible..." ← mixing languages, using jargon. NEVER.`;

  const userPrompt = `Technical pain: ${topPain.pain_label ?? "(unlabeled)"}
${topPain.evidence_quote ? `Evidence: ${topPain.evidence_quote}` : ""}

Translate to one human sentence in ${lang === "es" ? "Mexican Spanish" : "English"}.`;

  const client = getClient();
  let response: Awaited<ReturnType<typeof client.messages.create>>;
  try {
    response = await client.messages.create({
      model: ANTHROPIC_HAIKU_MODEL,
      max_tokens: 200,
      system: systemPrompt,
      messages: [{ role: "user", content: userPrompt }],
    });
  } catch (err) {
    // Non-fatal: fall back to generic pain label
    const fallback =
      topPain.pain_label ??
      (lang === "es"
        ? "Hay oportunidades claras de mejora en su operación actual."
        : "There are clear opportunities to improve their current setup.");
    return { text: fallback, usage: { ...ZERO_USAGE } };
  }

  const textBlock = response.content.find((b) => b.type === "text");
  const text = textBlock?.type === "text" ? textBlock.text.trim() : (topPain.pain_label ?? "");
  const usage = usageFromResponse(ANTHROPIC_HAIKU_MODEL, response.usage);
  return { text, usage };
}

// ── Stage 2: Credibility Match ────────────────────────────────────────────────

async function matchCredibility(
  input: GeneratorInputs,
  size: SizeSignal,
): Promise<{ cases: GeneratorInputCaseStudy[]; usage: ClaudeUsage }> {
  // Filter 1: tier — SMBs only see SMB cases; no enterprise flex on boutiques
  let eligible: GeneratorInputCaseStudy[];
  if (size === "smb") {
    eligible = input.case_studies.filter((c) => c.tier === "smb");
  } else if (size === "mid_market") {
    eligible = input.case_studies.filter(
      (c) => c.tier === "smb" || c.tier === "mid_market",
    );
  } else {
    eligible = [...input.case_studies];
  }

  // Filter 2: prefer industry match when available
  if (input.prospect.industry && eligible.length > 0) {
    const industryMatches = eligible.filter((c) =>
      industryMatch(c.industry, input.prospect.industry),
    );
    if (industryMatches.length > 0) eligible = industryMatches;
  }

  if (eligible.length === 0) return { cases: [], usage: { ...ZERO_USAGE } };
  if (eligible.length <= 2) return { cases: eligible, usage: { ...ZERO_USAGE } };

  // 3+ candidates — LLM tie-breaker via Haiku
  const systemPrompt = `You pick the best 1-2 case studies for a cold pitch.

RULES:
- Pick case studies that match the prospect's SCALE and INDUSTRY.
- Smaller / more relatable wins over bigger / more impressive.
- Output ONLY a JSON array of case study IDs: ["id1", "id2"]
- Maximum 2 IDs. Minimum 1. No explanation.`;

  const userPrompt = `Prospect: ${input.prospect.company_name}
Industry: ${input.prospect.industry ?? "unknown"}
Size: ${size}

Available case studies:
${eligible.map((c) => `- ${c.id}: ${c.client_name} (${c.tier}, ${c.industry ?? "n/a"})`).join("\n")}

Pick the best 1-2 IDs as JSON array.`;

  const client = getClient();
  let response: Awaited<ReturnType<typeof client.messages.create>>;
  try {
    response = await client.messages.create({
      model: ANTHROPIC_HAIKU_MODEL,
      max_tokens: 100,
      system: systemPrompt,
      messages: [{ role: "user", content: userPrompt }],
    });
  } catch {
    return { cases: eligible.slice(0, 2), usage: { ...ZERO_USAGE } };
  }

  const textBlock = response.content.find((b) => b.type === "text");
  const usage = usageFromResponse(ANTHROPIC_HAIKU_MODEL, response.usage);

  if (!textBlock || textBlock.type !== "text") {
    return { cases: eligible.slice(0, 2), usage };
  }

  try {
    const raw = textBlock.text.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "");
    const ids = JSON.parse(raw) as string[];
    const picked = eligible.filter((c) => ids.includes(c.id));
    return { cases: picked.length > 0 ? picked.slice(0, 2) : eligible.slice(0, 2), usage };
  } catch {
    return { cases: eligible.slice(0, 2), usage };
  }
}

// ── Stage 3 helpers ───────────────────────────────────────────────────────────

function buildSystemPrompt(lang: "en" | "es", size: SizeSignal): string {
  const langName = lang === "es" ? "Spanish — Mexican B2B register" : "English — Canadian market";
  const voiceRules = lang === "es" ? buildSpanishVoiceRules(size) : buildEnglishVoiceRules();

  return `You are a B2B cold-email copywriter for Runna CA, a Canadian creative + design agency
working with DTC ecommerce brands and professional services.

Your job: compose a 5-line elevator-pitch email opener (~120-160 words). The email must
fit in a recipient's inbox preview, get them curious, and earn a reply — not close a deal.
${voiceRules}

CRITICAL — evidence_quote and translated_pain handling:
The "translated_pain" field in the payload is the ALREADY-TRANSLATED human-language version
of the pain. Use it directly as the core of the email. Do NOT re-jargonize it.
The raw evidence_quote (if shown) is background context only — NEVER quote it verbatim.

Wrong: 'Vi "Outdated website — no e-commerce functionality..."'
Right (ES): "Revisé [company].com — sin checkout, sin ficha de producto real."
Right (EN): "Checked [company].com — no product pages, no checkout path."

Required structure (when a case study fits):
1. Salutation (see voice rules)
2. Opening hook — one concrete observation about the prospect's business drawn from the
   translated_pain, written as a natural statement — NOT a quotation
3. Pain framing — name the pattern in industry context
4. Bridge to ONE case study: "Ayudamos a {client} ({metric}). Misma forma..." or equivalent
5. Soft CTA (see voice rules — Loom offer)
6. Sign off: sender's first name, then full signature

Structure when case_study_id=null (no good fit):
1. Salutation
2. Opening hook (same — must be specific since it's your only anchor)
3. Pain framing
4. (skip the "we helped" bridge entirely — NO client names)
5. Agency-level social proof only ("This is the shape of work we do for {industry} brands")
6. Soft CTA
7. Sign off

Language: ${langName}.
IMPORTANT: Write the ENTIRE email in ${langName}. Do not mix languages.

Case-study selection rules — be honest, don't force a connection:
1. The chosen_cases payload already pre-filtered by prospect size — only pick from those.
2. A packaging-design case is NOT a match for a social-media pain. Activity must match.
3. If no chosen_case clearly addresses the prospect's pain, set case_study_id=null.
4. pain_id and case_study_id MUST come from the candidates in the payload. No invented UUIDs.

Output the final pitch as a JSON object with EXACTLY these fields:
{
  "subject": string,                    // 8–200 chars, plain text
  "body": string,                       // 80–2000 chars, plain text with \\n line breaks, no markdown
  "pain_id": string | null,             // UUID from pain_candidates[].pain_id, or null
  "case_study_id": string | null,       // UUID from chosen_cases[].id, or null if no case fits
  "contact_email": string | null,       // email of the contact addressed, or null
  "measurable_result_included": boolean,// true ONLY if you cited a specific number/% in body
  "quality_self_score": number,         // 0..1 — honest grade of personalization + evidence
  "reasoning": string                   // 1–3 sentences explaining picks. REQUIRED.
}

ALL fields required (null only where type allows). Do not omit "reasoning".`;
}

function buildSpanishVoiceRules(size: SizeSignal): string {
  const register = size === "smb"
    ? `- Tuteo (tú-form, informal). "Hola {nombre}," — direct and warm.
- "Estás perdiendo ventas" not "hay oportunidades de conversión".`
    : `- Usted-form, professional. "Estimado/a {nombre}," — or with title if clear.
- If title visible: "Lic.", "Ing.", "Dr./Dra." before surname.`;

  return `
Voice rules (Mexican B2B — sin excepción):
${register}
- Register: professional Mexican — direct and respectful. No anglicised hype words.
  No template openers ("me permito contactarle para ofrecerle nuestros servicios").
- Concise. Cut every adverb. One pain, one case, one ask. No feature dump.
- Use the translated_pain as-is. Do NOT re-translate or re-jargonize it.
- Plain text only. No markdown, no links other than what we provide.
- FORBIDDEN words: "abandonment", "funnel", "lead", "Meta Pixel", "WooCommerce",
  "Shopify", "retention automation", "default setup", any English anglicism.
- CTA (exact): "te mando un video de 5 min mostrándote exactamente qué cambiar — sin compromiso, sin llamada."
  (or usted-form for enterprise: "le mando un video de 5 min mostrándole exactamente qué cambiar — sin compromiso, sin llamada.")
- Sign off: sender's first name + agency name.`;
}

function buildEnglishVoiceRules(): string {
  return `
Voice rules (Canadian market):
- Direct, understated, confident — no American marketing energy. Let evidence do the work.
- No hype verbs: "transform", "unlock", "supercharge", "game-changer", "leverage" (as verb).
- FORBIDDEN: "synergy", "best-in-class", "solutions", "thought leader", "circle back".
- FORBIDDEN openings: "I hope this finds you well", "Quick question", "Just reaching out".
- Use direct phrasing: "You're losing sales" not "There are conversion optimization opportunities".
- Salutation: "Hi {first_name},"
- CTA (exact): "I can send a 5-min Loom walking through exactly what I'd change — no call, no commitment."
- If the selected case study is a Canadian client (SnapPad, Niki, or DevFest Calgary),
  open the bridge with "We worked with {client}, a Canadian {category}..." — local proof lands harder.
- Sign off: sender's first name + agency name.`;
}

function buildNotableClientsTierContext(
  notableClients: GeneratorInputNotableClient[],
  lang: "en" | "es",
): string {
  if (notableClients.length === 0) return "";

  const tier2Candidates = notableClients.map((nc) => ({
    name: nc.name,
    industry_tags: nc.industry_tags,
    relationship: nc.relationship_description,
    key_result: nc.key_result,
    description: lang === "es" ? (nc.description_es ?? nc.description_en) : nc.description_en,
  }));
  const tier3Names = notableClients.slice(0, 4).map((nc) => nc.name);

  return `

CREDIBILITY FALLBACK (use only when chosen_cases is empty):

TIER 2 — Notable client with industry match:
Use one if their industry_tags overlap with the prospect's industry.
Anchor with: "Hemos trabajado con {name} — {relationship}" or similar.
Do NOT invent metrics — use key_result if provided, else state relationship only.

Candidates:
${JSON.stringify(tier2Candidates, null, 2)}

TIER 3 — Name-drop (use only if no Tier 2 match):
  EN: "...including work with ${tier3Names.join(", ")}"
  ES: "...incluyendo trabajo con ${tier3Names.join(", ")}"

Never invent clients not in these lists.`;
}

function buildStage3UserPrompt(
  input: GeneratorInputs,
  translatedPain: string,
  chosenCases: GeneratorInputCaseStudy[],
): string {
  const lang = input.prospect.language;
  const payload = {
    prospect: {
      company_name: input.prospect.company_name,
      industry: input.prospect.industry ?? null,
      language: lang,
    },
    translated_pain: translatedPain,
    pain_candidates: input.pains.map((p) => ({
      pain_id: p.pain_id,
      pain_label: p.pain_label,
      evidence_quote: p.evidence_quote,
    })),
    contacts: input.contacts.map((c) => ({
      full_name: c.full_name,
      email: c.email,
      role_based: c.email_is_role_based,
    })),
    chosen_cases: chosenCases.map((cs) => ({
      id: cs.id,
      client_name: cs.client_name,
      industry: cs.industry,
      hero_metric:
        lang === "es"
          ? cs.hero_metric_es ?? cs.hero_metric_en ?? "(metric pending)"
          : cs.hero_metric_en ?? cs.hero_metric_es ?? "(metric pending)",
      result_description:
        lang === "es"
          ? cs.result_description_es ?? cs.result_description_en ?? null
          : cs.result_description_en ?? cs.result_description_es ?? null,
      testimonial_quote:
        lang === "es"
          ? cs.testimonial_quote_es ?? cs.testimonial_quote_en ?? null
          : cs.testimonial_quote_en ?? cs.testimonial_quote_es ?? null,
      measurable_results: cs.measurable_results,
      pain_strength: cs.pain_strength,
    })),
    sender: {
      full_name: input.sender.full_name,
      agency_name: input.sender.tenant_display_name,
    },
    notable_clients_for_fallback: input.notable_clients.map((nc) => ({
      name: nc.name,
      industry_tags: nc.industry_tags,
      relationship_description: nc.relationship_description,
      key_result: nc.key_result,
    })),
    deep_pitch_url: input.deep_pitch_url ?? null,
  };

  return `Compose the cold-email pitch from this payload:

\`\`\`json
${JSON.stringify(payload, null, 2)}
\`\`\`

The "translated_pain" is already in the correct language — use it as the core of the email.
Do NOT re-jargonize or re-translate it. Write the body around it, not from scratch.

If deep_pitch_url is provided, append one line before sign-off:
  EN: "More context if useful: {deep_pitch_url}"
  ES: "Más contexto si te sirve: {deep_pitch_url}"

Set contact_email to the non-role-based named contact's email; otherwise best fallback; null if none.
Set measurable_result_included=true only if the chosen case's hero_metric is a real number/%.`;
}

// ── Violation detector ────────────────────────────────────────────────────────

function detectViolations(body: string, lang: "en" | "es"): number {
  let count = 0;
  const lower = body.toLowerCase();

  if (lang === "es") {
    const forbidden = [
      "hola there",
      "abandonment",
      "retention automation",
      "default setup",
      "meta pixel",
      "woocommerce",
      "shopify",
      "funnel",
      "performance",
      "i hope",
      "best regards",
      "dear ",
    ];
    for (const term of forbidden) {
      if (lower.includes(term)) count++;
    }
  } else {
    const forbidden = [
      "hola",
      "vale la pena",
      "marca",
      "tienda",
      "synergy",
      "leverage the",
      "best-in-class",
      "circle back",
      "i hope this finds you",
      "just reaching out",
    ];
    for (const term of forbidden) {
      if (lower.includes(term)) count++;
    }
  }

  return count;
}

// Re-used from generator.ts logic — avoids import cycle.
function industryMatch(a: string | null | undefined, b: string | null | undefined): boolean {
  if (!a || !b) return false;
  const al = a.toLowerCase();
  const bl = b.toLowerCase();
  return al === bl || al.includes(bl) || bl.includes(al);
}
