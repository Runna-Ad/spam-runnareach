/**
 * 2-stage pitch composer (collapsed from 3 stages to reduce Vercel timeout risk).
 *
 * Stage 1 — Credibility Match (deterministic / Haiku only when 3+ candidates tied)
 * Stage 2 — Pitch Assembly   (Sonnet): translate pain + write the email in one pass
 *
 * The pain-translation step was previously a separate Haiku call (Stage 1 old).
 * It's now embedded in the Stage 2 Sonnet prompt — Sonnet handles it natively and
 * we save a full network round-trip (~3-5s on Vercel cold starts).
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
  // pain_id can be a text slug like "abandoned_cart_loss" or a UUID — accept both.
  pain_id: z.string().nullable(),
  // case_study_id is always a UUID from the DB.
  case_study_id: z.string().uuid().nullable(),
  // contact_email may be missing from Claude response — coerce null gracefully.
  contact_email: z.union([z.string().email(), z.literal(""), z.null()]).transform(v => v || null),
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

  // ── Stage 1: pick case studies by tier + industry (deterministic / Haiku tie-breaker) ─
  const stage1 = await stage1MatchCredibility(input, size);
  totalUsage = addUsage(totalUsage, stage1.usage);

  // ── Stage 2: translate pain + assemble pitch in one Sonnet pass ───────────
  const lang = input.prospect.language;
  const system =
    buildSystemPrompt(lang, size) +
    buildNotableClientsTierContext(input.notable_clients, lang);
  const user = buildStage2UserPrompt(input, stage1.cases);

  const call = await structuredCall({
    model: ANTHROPIC_DEFAULT_MODEL,
    system,
    user,
    max_tokens: 600,
    schema: responseSchema,
  });

  if (!call.ok) {
    // If stage1 had no API calls (totalUsage all-zero) and the Sonnet call failed
    // before returning any token counts (call.usage=null), return null usage so
    // callers know no credits were spent. Otherwise combine what we have.
    const combined = call.usage !== null
      ? addUsage(totalUsage, call.usage)
      : totalUsage.input_tokens > 0 ? totalUsage : null;
    return {
      ok: false,
      error: call.error,
      reason: call.reason,
      usage: combined,
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

  // Violation detector — drop score per forbidden term found in body or subject.
  // Subject violations get the same penalty — an em-dash subject is still a violation.
  const violations =
    detectViolations(call.data.body, lang) +
    detectViolations(call.data.subject, lang);
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

// ── Stage 1: Credibility Match ───────────────────────────────────────────────

async function stage1MatchCredibility(
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
- NO marketing/tech jargon. Write for a business owner who has never heard of: retargeting,
  funnel, LTV, ROAS, nurture sequence, drip campaign, attribution, segmentation, CRM, UTM,
  dynamic ads, lookalike audiences, win-back, churn, conversion rate optimization, UX audit.
  Instead: describe what changes for them in plain language. "People who almost bought come
  back and buy" not "cart recovery retargeting." "Your ads make more per peso" not "improved ROAS."
- NO corporate labels: no "El fix aqui", no "Lo que mueve la aguja", no "diagnosticar el patron".
- NO language mixing: the entire email must be in one language.
- NO greeting with "there" in Spanish: "Hola there" is a critical failure.
${voiceRules}

CRITICAL — pain translation handling:
pain_candidates contains raw audit findings. Your FIRST internal step is to translate the
best pain into how a real business owner would describe it to a friend. No jargon. No quotes
from the audit. Describe the BUSINESS CONSEQUENCE in plain language.

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
5. CTA — Inefficiency Hunter link (see voice rules)
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

SUBJECT LINE — there are exactly 5 engines that get cold emails opened. Use one:

ABSOLUTE RULES (no exceptions):
- ≤50 chars. ALL lower case. ZERO em dashes (—). Use comma or colon instead.
- NEVER "[company] + pain label" — "studio f: carritos abandonados" reads like a spam report.
  The prospect shouldn't know what the email is about until they open it.

THE 5 ENGINES — pick the one that best fits the evidence you have:

1. NAMED + NUMBERED (default — highest reply rate)
   Formula: [company] + a number, timeframe, or dollar-implied loss
   EN: "[company]'s marketing math doesn't add up"
   EN: "30 seconds: what [company] loses monthly"
   EN: "[company]: 3 things I'd fix this week"
   ES: "[empresa] reparte presupuesto a ciegas"
   ES: "30 segundos: lo que pierde [empresa] al mes"
   ES: "3 fugas de marketing en [empresa]"

2. LEAK STATEMENT (state their loss as fact, no question mark)
   Formula: name the exact place where money/leads/time disappears
   EN: "[company]'s leads are dying in the follow-up"
   EN: "what [company]'s ad budget is quietly losing"
   EN: "Calgary Coffee's checkout is losing mobile sales"
   ES: "[empresa] gasta en ads que no venden"
   ES: "lo que le cuesta a [empresa] no tener seguimiento"
   ES: "los carritos de [empresa] se van sin comprar"
   A statement already implies you know — they open to find out how much.

3. NICHE MIRROR (name their exact segment + geography)
   Formula: [city/region] + [their niche] + [pain implied]
   EN: "Calgary brokerages: your lead leak, in dollars"
   EN: "Banff brewers are quietly losing taproom traffic"
   ES: "lo que tu competencia en CDMX ya sabe"
   ES: "marcas D2C en México están quemando presupuesto"
   Reads like industry intel, not a pitch. Strong in MX markets.

4. THE REFRAME (take something they think is fine and call it a cost)
   Formula: "how much is [X] costing you?" — reframes a tool or process as a leak
   EN: "how much is [company]'s CRM costing you?"
   EN: "[company] — money stuck between floor and digital"
   ES: "¿cuánto le cuesta a [empresa] el marketing improvisado?"
   ES: "el número que [empresa] no ha calculado"

5. PEER PRESSURE (use sparingly — weakest engine, gimmicky if overused)
   EN: "what [company]'s competitors already know"
   ES: "lo que tu competencia en CDMX ya sabe"
   Only use this when you have no specific evidence and other engines won't fit.

PICK ENGINE BASED ON EVIDENCE:
- Have evidence_quote with specific numbers → Engine 2 (Leak Statement) using those specifics
- Have company name + industry + city → Engine 3 (Niche Mirror)
- Have company name + clear pain → Engine 1 (Named + Numbered)
- Have no specific evidence → Engine 4 (Reframe) or Engine 1 generic

PREVIEW TEXT — the 1–2 lines shown under the subject in Gmail/Outlook:
- ≤150 chars. Second thing read. Must answer "why should I open this?"
- NEVER repeat the subject. Subject = curiosity; preview = the hook that justifies opening.
- Subject is curiosity gap → preview names the specific observation
  ("no cart recovery running, that's daily revenue walking out" /
   "sin flujo de recuperación activo, eso son ventas que se van cada día")
- Subject names the pain → preview names the fix + benchmark
  ("3-email Klaviyo sequence, DTC brands recover 15-25% of those carts" /
   "secuencia de 3 correos, las marcas D2C recuperan 15-25% de esos carritos")
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
- CTA: link to the Inefficiency Hunter — 30-second diagnostic, zero friction, no email required.
  Use the hunter_url from the payload. Format:
  "👉 Tu número aquí: {hunter_url}"
  or "👉 Ve el número de {company}: {hunter_url}"
  or "👉 {hunter_url}" (if the sentence before already names the tool)
  Always place the 👉 emoji before the link. No video offer, no call ask, no commitment language.
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
- CTA: link to the Inefficiency Hunter — 30-second diagnostic, zero friction, no email required.
  Use the hunter_url from the payload. Format:
  "👉 See {company}'s number: {hunter_url}"
  or "👉 Your number is here: {hunter_url}"
  or "👉 {hunter_url}" (if the sentence before already names the tool)
  Always place the 👉 emoji before the link. No Loom, no video offer, no call ask.
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

function buildStage2UserPrompt(
  input: GeneratorInputs,
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
    hunter_url: input.deep_pitch_url ?? null,
  };

  return `Compose the cold-email pitch from this payload:

\`\`\`json
${JSON.stringify(payload, null, 2)}
\`\`\`

PAIN TRANSLATION — do this first internally before writing the email:
Pick the best pain from pain_candidates (prefer one with both pain_id + evidence_quote).
Translate it from technical audit language into how a business owner would describe it to
a friend over coffee — one concrete sentence, no jargon, business consequence not symptom.
Use this translation as your opening hook.

Good: "Estás perdiendo ventas de gente que llena el carrito y se va sin comprar"
Bad: "No cart abandonment flow visible; WooCommerce default setup"

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

hunter_url is the Inefficiency Hunter link — use it as the primary CTA (per voice rules above).
One line with 👉 emoji, placed after the case-study bridge (or solution if no case), before sign-off.
Do NOT add any other links or video offers.

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
  ["abandoned_cart", "automatically reaching back out to everyone who added things and left without buying — most stores get 15-25% of those sales back"],
  ["cart", "automatic reminders that follow up with people who added things and left — showing them exactly what they left behind"],
  ["mobile conversion", "fixing the parts of your site where phone shoppers give up — most brands get 20-30% more sales from the same traffic once those are fixed"],
  ["email", "automatic emails that follow your customers through every stage — so the right message reaches them at the right moment without you lifting a finger"],
  ["paid media", "refreshing your ads and who they reach — when those two are dialed in, brands in your category often double what they make per dollar spent"],
  ["roas", "fixing your ads so you make more for every dollar you spend — better creative, better audiences, and actually knowing what's working"],
  ["social engagement", "a content plan you can actually stick to — the brands that post consistently win, and most don't"],
  ["content velocity", "a simple system to post 4-5 times a week without it taking over your life"],
  ["retention", "automatic messages after every purchase — a thank you, helpful tips, a reminder when they're running low — the brands that do this well make 20-40% more from each customer"],
  ["website", "making your site faster, easier to use on a phone, and easier to actually buy from"],
  ["outdated", "rebuilding your site so it loads fast, looks great on any phone, and makes buying simple"],
  ["brand", "cleaning up how your brand looks everywhere — so it feels intentional, not like five different people made it"],
  ["packaging", "redesigning your packaging to stand out in 3 seconds and tell the story clearly"],
  ["value prop", "getting crystal clear on your one best reason to buy, then saying that same thing everywhere consistently"],
  ["launch", "coordinating your ads, social posts, emails and landing page to go live together — so nothing falls flat on its own"],
  ["competitor", "standing for something specific so people choose you for reasons other than price"],
  ["sales process", "automating the follow-up so no interested buyer gets forgotten and you stop chasing manually"],
  ["event", "turning your event into content and a campaign — before, during and after — not just showing up"],
  ["proof", "putting your best customer stories in exactly the spots where people hesitate before buying"],
  ["ai", "automating the repetitive stuff — follow-ups, capturing leads, reporting — so your team focuses on what actually matters"],
];

const SOLUTION_HINTS_ES: [string, string][] = [
  ["abandoned_cart", "mandarle un mensaje automático a cada persona que llenó su carrito y se fue sin comprar — la mayoría de tiendas recupera entre 15 y 25% de esas ventas"],
  ["carrito", "recordatorios automáticos para quien agregó cosas y se fue sin comprar — mostrándoles exactamente lo que dejaron"],
  ["mobile", "arreglar las partes de tu sitio donde la gente se rinde desde el celular — la mayoría de tiendas recupera 20-30% más ventas del mismo tráfico una vez que se arregla eso"],
  ["email", "mensajes automáticos que acompañan a tu cliente en cada momento — para que el mensaje correcto llegue solo, sin que tú tengas que hacer nada"],
  ["paid media", "renovar tus anuncios y a quién les llegan — cuando esos dos están bien alineados, las marcas en tu categoría suelen duplicar lo que ganan por cada peso invertido"],
  ["roas", "hacer que tus anuncios rindan más por cada peso que gastas — mejor creatividad, mejor selección de quién los ve y saber de verdad qué está funcionando"],
  ["engagement", "un plan de contenido que puedas mantener — las marcas que publican seguido ganan seguidores, las que publican cuando se acuerdan no"],
  ["contenido", "un sistema sencillo para publicar 4-5 veces a la semana sin que te consuma la vida"],
  ["retención", "mensajes automáticos después de cada compra — agradecimiento, tips útiles, recordatorio cuando ya se les acabó — las tiendas que lo hacen bien ganan 20-40% más de cada cliente"],
  ["sitio", "hacer tu sitio más rápido, más fácil de usar desde el celular y más fácil para comprar"],
  ["página", "reconstruir tu sitio para que cargue rápido, se vea bien en cualquier celular y comprar sea simple"],
  ["marca", "limpiar cómo se ve tu marca en todos lados — para que se sienta intencional y consistente, no como si la hubieran hecho cinco personas distintas"],
  ["empaque", "rediseñar tu empaque para que se destaque en 3 segundos y cuente la historia de forma clara"],
  ["propuesta de valor", "encontrar tu razón número uno para que te compren a ti, y decirla igual en todos lados"],
  ["lanzamiento", "coordinar tus anuncios, redes sociales, correos y página de destino para que todo salga junto y con fuerza"],
  ["competencia", "definir por qué te eligen a ti y no al de precio más bajo"],
  ["ventas", "automatizar el seguimiento para que ningún interesado quede en el olvido y dejes de perseguir a mano"],
  ["evento", "convertir tu evento en contenido y campaña — antes, durante y después — no solo aparecer"],
  ["prueba social", "poner las historias de tus mejores clientes justo en los momentos donde la gente duda antes de comprar"],
  ["ai", "automatizar lo repetitivo — seguimientos, captura de interesados, reportes — para que tu equipo se enfoque en lo que realmente importa"],
];

export function getSolutionHint(painLabel: string | null, lang: "en" | "es"): string | null {
  if (!painLabel) return null;
  const lower = painLabel.toLowerCase();
  // Pain labels are stored in English regardless of prospect language.
  // Always check EN keywords first, then ES keywords as a fallback.
  // This ensures "Cart abandonment" matches for an ES-language prospect.
  const primary = lang === "es" ? SOLUTION_HINTS_ES : SOLUTION_HINTS_EN;
  const fallback = lang === "es" ? SOLUTION_HINTS_EN : SOLUTION_HINTS_ES;
  for (const [keyword, hint] of primary) {
    if (lower.includes(keyword)) return hint;
  }
  // EN pain label on an ES prospect — find the EN match, then return the ES equivalent.
  if (lang === "es") {
    for (const [keyword, _hint] of fallback) {
      if (lower.includes(keyword)) {
        // Find the matching ES hint by index position (EN and ES lists are parallel).
        const idx = SOLUTION_HINTS_EN.findIndex(([k]) => k === keyword);
        if (idx >= 0 && idx < SOLUTION_HINTS_ES.length) return SOLUTION_HINTS_ES[idx]?.[1] ?? null;
      }
    }
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
