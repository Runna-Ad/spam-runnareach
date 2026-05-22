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
  subject: z.string().trim().min(4).max(120),
  preview_text: z.string().trim().min(20).max(150),
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
        preview_text: call.data.preview_text,
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

  return `You are a B2B cold-email copywriter for Runna, a creative + design agency.
Runna's full toolkit: brand identity, packaging, web/ecommerce design, email marketing
flows, paid social (Meta/TikTok/Google), AI automation, custom apps and dashboards, content
strategy and production, UX redesign. Any of these may be relevant depending on the prospect.

Your job: write a cold email that reads like a real human wrote it — conversational, specific,
warm. Think of it like introducing yourself to someone at a bar: you notice something about
them, mention it genuinely, show you can help with one specific thing, then ask if they want
to grab a coffee. 70-100 words max. Get them curious enough to reply — not close a deal.

ABSOLUTE FORMAT RULES (violations will fail QA):
- NO em dashes (—). Use commas, periods, or restructure the sentence.
- NO corporate jargon: no "El fix aqui", no "diagnosticar el patron", no "flujos de".
- NO language mixing: the entire email must be in one language.
- NO greeting with "there" in Spanish: "Hola there" is a critical failure.
${voiceRules}

CRITICAL — evidence_quote and translated_pain handling:
The "translated_pain" field is the ALREADY-TRANSLATED human-language version of the pain.
Use it as your hook. Do NOT re-jargonize it or quote it verbatim.

Wrong: 'Vi "Outdated website — no e-commerce functionality..."'
Right (ES): "Revisé [company].com — sin checkout, sin ficha de producto real."
Right (EN): "Checked [company].com — no product pages, no checkout path."

REQUIRED EMAIL STRUCTURE — solution-first, ALWAYS:
1. Salutation (see voice rules)
2. Opening hook — one concrete, specific observation about THIS prospect's situation.
   Pull from: what_they_do, tech_stack, city, translated_pain. Be specific, not generic.
   "Checked your store — no cart recovery flow on Tiendanube" beats "Noticed an opportunity."
3. Proposed solution — THIS is the core of the email. One to two sentences:
   - Name the SPECIFIC fix: "3-email cart recovery sequence + Meta dynamic retargeting",
     not "email marketing." "Mobile checkout redesign with A/B tested CTA placement",
     not "UX improvements."
   - Tailor it to their stack, market, and industry. If they're on Shopify → mention
     Klaviyo flows. If they run paid ads already → mention creative refresh + attribution.
     If MX market → reference MX consumer habits. If CA → Canadian shopper behaviour.
   - Include a real benchmark when confident: "DTC brands recover 15-25% of abandoned carts
     with this setup", "well-run Meta retargeting averages 3-5x ROAS for this category."
   - Use solution_hints in the payload as a starting point, then go further using what
     you know about current trends, platforms, and what actually works for this industry.
4. Case study bridge — ONLY if case_study_id is chosen. It's PROOF, not the pitch:
   ONE sentence after the solution: "Did this for {client} — {metric}. Same profile."
   If no case study fits well: SKIP entirely. The solution IS the credibility.
5. Soft CTA (see voice rules — Loom/video offer)
6. Sign off: sender's first name, then full signature

Quality bar: a prospect should read line 3 and think "that's exactly my problem and that's
exactly what I need." Generic = fail. Specific, data-backed, tailored = win.

Language: ${langName}.
IMPORTANT: Write the ENTIRE email in ${langName}. Do not mix languages.

Case-study selection rules — be honest, don't force a connection:
1. The chosen_cases payload already pre-filtered by prospect size — only pick from those.
2. A packaging-design case is NOT a match for a social-media pain. Activity must match.
3. If no chosen_case clearly addresses the prospect's pain, set case_study_id=null.
4. pain_id and case_study_id MUST come from the candidates in the payload. No invented UUIDs.

SUBJECT LINE — high open rates come from specificity and curiosity, not cleverness:

Rules (apply every time, no exceptions):
- ≤50 chars — gets cut off on mobile beyond that. Shorter is almost always better.
- Lower case wins for cold outreach — "quick thought on their checkout" feels personal,
  "Quick Thought On Their Checkout" feels like a newsletter.
- Lead with what you KNOW, not what you're offering:
  ✓ "Checked troquer.com — noticed something" (they open to find out what)
  ✓ "El Club's cart abandonment" (specific, implies knowledge)
  ✗ "A quick question for you" (lazy opener, mass-email feel)
  ✗ "Opportunity for Calgary Coffee Roasters" (salesy, low-trust)
- If you have evidence_quote: use "Checked [domain] — [short observation]" or
  "Revisé [domain] — [observación breve]"
- If no evidence: use the PAIN as the subject, not your solution:
  "[Company]'s [pain in plain English]" or "[Company].com — [one thing]"
- Avoid: "Free", "Guaranteed", "Re:", "FW:", exclamation marks, ALL CAPS words,
  "Quick question", "Following up", "Just checking in", "Opportunity"

PREVIEW TEXT — the 1–2 lines shown under the subject in Gmail/Outlook:
- ≤150 chars. This is the second thing read after the subject.
- Do NOT repeat the subject. Extend it.
- Should answer "why should I open this?" with a micro-tease.
- If subject is a curiosity gap ("Checked [domain] — noticed something"):
  preview text = the observation itself ("No cart recovery flow, no retargeting pixel — leaving ~25% revenue on the table.")
- If subject names the pain:
  preview text = the specific fix or benchmark ("3-email Klaviyo sequence + Meta dynamic retargeting — DTC brands recover 15–25% of abandoned carts with this.")
- Never use: "I'd love to connect", "Let me know if you're interested", "Hope this finds you well"

Output the final pitch as a JSON object with EXACTLY these fields:
{
  "subject": string,                    // ≤50 chars ideally, max 120, lower case, plain text
  "preview_text": string,               // 20–150 chars, extends subject, never repeats it
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
  // Resolve solution hint for the top pain so Claude has a concrete starting point.
  const topPain = input.pains.find((p) => p.pain_id && p.evidence_quote)
    ?? input.pains.find((p) => p.pain_id)
    ?? input.pains[0]
    ?? null;
  const solutionHint = topPain?.pain_label
    ? getSolutionHint(topPain.pain_label, lang)
    : null;

  const payload = {
    prospect: {
      company_name: input.prospect.company_name,
      industry: input.prospect.industry ?? null,
      language: lang,
      city: input.prospect.city ?? null,
      market: input.prospect.market ?? null,
      what_they_do: input.prospect.what_they_do ?? null,
      tech_stack: input.prospect.tech_stack ?? [],
    },
    translated_pain: translatedPain,
    // Baseline solution to propose — tailor this using what_they_do, tech_stack, and industry.
    solution_hint: solutionHint,
    pain_candidates: input.pains.map((p) => ({
      pain_id: p.pain_id,
      pain_label: p.pain_label,
      evidence_quote: p.evidence_quote,
    })),
    contacts: input.contacts.map((c) => ({
      full_name: c.full_name,
      email: c.email,
      role_based: c.email_is_role_based,
      role_title: c.role_title ?? null,
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

The "translated_pain" is already in the correct language — use it as the opening hook.
The "solution_hint" is your baseline — elaborate on it using the prospect's specific context.
Do NOT re-jargonize translated_pain or copy solution_hint verbatim. Make both feel tailored.

SOLUTION TAILORING — this is the most important part of the email:
- Start from solution_hint, then make it MORE specific using what_they_do + tech_stack + market
- If they're on Shopify → mention Klaviyo; Tiendanube → mention its email integrations
- If they run paid media already → focus on creative refresh + attribution improvement
- If they have no digital presence → website + social strategy as first step
- Cite a real benchmark when you're confident it's accurate for this category
- Runna's full toolkit is available: email flows, Meta/TikTok paid, AI automation, custom apps,
  UX redesign, content systems, packaging, brand — propose whatever actually fits

PERSONALIZATION INSTRUCTIONS — use these fields when present:
- prospect.what_they_do → use as the basis for your opening hook. Reference what they actually do ("veo que venden X", "I see you carry X") instead of a generic observation.
- prospect.city → weave in a geographic reference naturally (e.g., "marcas en Guadalajara como la tuya" / "brands in Vancouver like yours"). Don't force it if it feels awkward.
- prospect.tech_stack → if they're on a platform you recognize (Shopify, WooCommerce, Tiendanube, etc.), reference it in the pain framing: "Vi que usan Tiendanube — sin flujo de recuperación activo, eso se traduce directo en ventas perdidas." / "I saw you're on Shopify — without a recovery flow, those abandoned carts are just gone."
  EXCEPTION: the system-level forbidden words still apply — never write "Shopify" or "WooCommerce" in Spanish emails. In Spanish, say "su plataforma" or "la tienda" instead.
- contacts[].role_title → if a contact has a role_title (e.g. "CEO", "Dueña", "Founder", "Marketing Manager"), use it in the salutation or opening: "Como dueño de {company}..." / "As the founder of {company}..." — only when it fits naturally.
- prospect.market → adapt agency positioning: if market="CA", lean on Canadian portfolio and "Canadian-first" framing; if market="MX", lean on MX portfolio and regional understanding.

If deep_pitch_url is provided, append one line before sign-off:
  EN: "More context if useful: {deep_pitch_url}"
  ES: "Más contexto si te sirve: {deep_pitch_url}"

Set contact_email to the non-role-based named contact's email; otherwise best fallback; null if none.
Set measurable_result_included=true only if the chosen case's hero_metric is a real number/%.`;
}

// ── Violation detector ────────────────────────────────────────────────────────

export function detectViolations(body: string, lang: "en" | "es"): number {
  let count = 0;
  const lower = body.toLowerCase();

  if (lang === "es") {
    const forbidden = [
      // Language mixing / template openers
      "hola there",
      // Em dash — banned per Pedro. Reads corporate, triggers spam filters.
      "—",
      // English jargon in Spanish emails
      "abandonment",
      "retention automation",
      "default setup",
      "meta pixel",
      "woocommerce",
      "shopify",
      "funnel",
      "el fix aquí",
      "el fix aqui",
      "diagnosticar el patrón",
      "i hope",
      "best regards",
      "dear ",
      // Anglicisms that slip through in MX marketing context
      " leads",      // "tus leads", "generar leads" — space prefix avoids matching "liderazgo"
      "engagement",  // no Spanish equivalent so Claude borrows the English word
    ];
    for (const term of forbidden) {
      if (lower.includes(term)) count++;
    }
  } else {
    // "hola" needs word-boundary check — includes("hola") false-positives on
    // company names like "HolaFly", "Shola", "Enholabuena" etc.
    if (/\bhola\b/.test(lower)) count++;

    const forbidden = [
      // Em dash — banned per Pedro. Reads corporate, triggers spam filters.
      "—",
      // Spanish bleed-through
      "vale la pena",
      "marca",
      "tienda",
      // Corporate / American hype — banned in system prompt
      "synergy",
      "leverage the",
      "best-in-class",
      "circle back",
      "thought leader",
      // Hype verbs the system prompt explicitly bans
      "unlock ",
      "supercharge",
      "game-changer",
      "game changer",
      // Forbidden openers
      "i hope this finds you",
      "just reaching out",
      "quick question",
    ];
    for (const term of forbidden) {
      if (lower.includes(term)) count++;
    }
  }

  return count;
}

// ── Solution hints ────────────────────────────────────────────────────────────
// Baseline solution proposals keyed by pain label substring (lowercased).
// Claude uses these as a starting point and tailors them to the specific prospect.

const SOLUTION_HINTS_EN: [string, string][] = [
  ["abandoned_cart", "3-email cart recovery sequence + Meta dynamic retargeting — DTC brands typically recover 15-25% of abandoned carts with this setup"],
  ["cart", "cart recovery email flow (3-step: reminder → urgency → offer) + retargeting with the specific products they left behind"],
  ["mobile conversion", "mobile UX audit + checkout redesign focused on reducing friction — most DTC brands recover 20-30% of mobile dropoff with the right fix"],
  ["email", "full email flow rebuild: welcome series → nurture → cart recovery → win-back — average well-run DTC email generates 30-40% of total revenue"],
  ["paid media", "paid social audit + creative refresh — new ad creative + tighter audience targeting typically doubles ROAS for brands in this category"],
  ["roas", "paid social restructure: creative refresh, audience segmentation, and attribution cleanup — brands in your category see 3-5x ROAS when these are aligned"],
  ["social engagement", "content strategy overhaul + consistent weekly production cadence — engagement follows consistency, and most brands in this space are inconsistent"],
  ["content velocity", "content production system: strategy + reusable templates + batch filming — goes from ad hoc to 4-5 posts/week without adding headcount"],
  ["retention", "post-purchase email + SMS sequence: thank-you → usage tips → replenishment reminder → loyalty offer — increases LTV by 20-40% for consumable DTC brands"],
  ["website", "website redesign focused on conversion: speed, mobile-first layout, clear product pages and frictionless checkout path"],
  ["outdated", "full site rebuild or conversion lift: speed optimization, mobile-first redesign, product page restructure, and streamlined checkout"],
  ["brand", "brand audit + unified visual system across all touchpoints — logo, color, typography, tone of voice — so every asset reinforces the same identity"],
  ["packaging", "packaging redesign engineered for shelf presence: clearer information hierarchy, stronger visual identity, premium subline if relevant"],
  ["value prop", "value proposition clarification + messaging hierarchy — one clear reason to buy, applied consistently across ads, site, and social"],
  ["launch", "full launch campaign: paid social + organic content + email sequence + landing page — all coordinated and timed together"],
  ["competitor", "brand differentiation strategy + content positioning you as the category authority — so price isn't the only differentiator"],
  ["sales process", "digital sales process: automated follow-up sequences, lead capture forms, CRM integration — removes manual steps from the pipeline"],
  ["event", "event activation package: pre-event campaign, live social content, post-event recap — turns attendance into lasting brand equity"],
  ["proof", "social proof architecture: case studies, testimonials, and trust signals placed at the exact points where buyers hesitate"],
  ["ai", "AI-powered automation: chatbot for lead capture, automated follow-ups, or custom dashboard that surfaces the data your team actually needs"],
];

const SOLUTION_HINTS_ES: [string, string][] = [
  ["abandoned_cart", "secuencia de 3 emails de recuperación + retargeting en Meta con los productos que dejaron — marcas DTC típicamente recuperan 15-25% de los carritos abandonados con esta configuración"],
  ["carrito", "flujo de recuperación de carrito (3 pasos: recordatorio → urgencia → oferta) + retargeting con los productos exactos que dejaron"],
  ["mobile", "auditoría UX móvil + rediseño del checkout — la mayoría de marcas DTC recuperan 20-30% del abandono en móvil con el fix correcto"],
  ["email", "reconstrucción completa de flujos de email: bienvenida → nurture → recuperación de carrito → win-back — el email bien ejecutado genera 30-40% de los ingresos de marcas DTC"],
  ["paid media", "auditoría de paid social + refresh creativo — nuevo creativo + segmentación más precisa típicamente duplica el ROAS en esta categoría"],
  ["roas", "reestructura de paid social: refresh creativo, segmentación de audiencias y limpieza de atribución — marcas en tu categoría llegan a 3-5x ROAS cuando estos tres están alineados"],
  ["engagement", "estrategia de contenido renovada + cadencia de producción semanal consistente — el engagement sigue a la consistencia, y la mayoría de marcas en este espacio no son consistentes"],
  ["contenido", "sistema de producción de contenido: estrategia + plantillas reutilizables + grabación en bloque — pasa de publicar ad hoc a 4-5 posts/semana sin agregar headcount"],
  ["retención", "secuencia post-compra de email + SMS: gracias → tips de uso → recordatorio de reabastecimiento → oferta de lealtad — incrementa el LTV 20-40% para marcas DTC de consumibles"],
  ["sitio", "rediseño web orientado a conversión: velocidad, diseño mobile-first, páginas de producto claras y checkout sin fricción"],
  ["página", "construcción o rediseño del sitio: optimización de velocidad, diseño mobile-first, estructura de páginas de producto y checkout simplificado"],
  ["marca", "auditoría de marca + sistema visual unificado en todos los touchpoints — logo, color, tipografía, tono de voz — para que cada pieza refuerce la misma identidad"],
  ["empaque", "rediseño de empaque orientado a presencia en anaquel: jerarquía de información más clara, identidad visual más fuerte, sublínea premium si aplica"],
  ["propuesta de valor", "clarificación de propuesta de valor + jerarquía de mensajes — una razón clara para comprar, aplicada consistentemente en ads, sitio y redes"],
  ["lanzamiento", "campaña de lanzamiento completa: paid social + contenido orgánico + secuencia de email + landing page — todo coordinado y sincronizado"],
  ["competencia", "estrategia de diferenciación de marca + contenido que te posiciona como autoridad en la categoría — para que el precio no sea el único diferenciador"],
  ["ventas", "proceso de ventas digital: secuencias de seguimiento automatizadas, captura de leads, integración con CRM — elimina los pasos manuales del pipeline"],
  ["evento", "paquete de activación de evento: campaña previa, contenido en vivo, recap post-evento — convierte la asistencia en brand equity duradero"],
  ["prueba social", "arquitectura de prueba social: casos de éxito, testimoniales y señales de confianza colocadas exactamente donde el comprador duda"],
  ["ai", "automatización con IA: chatbot para captura de leads, seguimientos automáticos o dashboard personalizado que muestra los datos que tu equipo realmente necesita"],
];

export function getSolutionHint(painLabel: string | null, lang: "en" | "es"): string | null {
  if (!painLabel) return null;
  const lower = painLabel.toLowerCase();
  const hints = lang === "es" ? SOLUTION_HINTS_ES : SOLUTION_HINTS_EN;
  for (const [keyword, hint] of hints) {
    if (lower.includes(keyword)) return hint;
  }
  return null;
}

// Re-used from generator.ts logic — avoids import cycle.
function industryMatch(a: string | null | undefined, b: string | null | undefined): boolean {
  if (!a || !b) return false;
  const al = a.toLowerCase();
  const bl = b.toLowerCase();
  return al === bl || al.includes(bl) || bl.includes(al);
}
