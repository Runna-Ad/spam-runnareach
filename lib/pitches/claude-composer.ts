/**
 * Pitch composer: one Sonnet pass that translates the prospect's pain and
 * writes the email, under a single prompt (PITCH_PROMPT_VERSION).
 *
 * History: this was 3 stages (Haiku pain translation, case-study match, Sonnet
 * assembly), then 2. The case-study stage is gone since prompt v2 (2026-10-16):
 * cold pitches never cite a client, so case studies are no longer sent to the
 * model at all and case_study_id is always null.
 *
 * External signature is identical to v1 — the rest of the pipeline is unchanged.
 */

import { z } from "zod";
import {
  ANTHROPIC_DEFAULT_MODEL,
  structuredCall,
  type ClaudeUsage,
  type SystemBlock,
} from "../anthropic/client.ts";
import { RUNNA_CAPABILITIES_FOR_PITCHES } from "../runna/capabilities.ts";
import { HUNTER_URL } from "./industry-templates.ts";
import { hasUsableEmail } from "../research/email-utils.ts";
import { findBannedTerms } from "./content-rules.ts";
import { senderIdentity } from "./sender-identity.ts";
import { writerExemplarSection } from "./exemplars.ts";
import { greetingName } from "./greeting-name.ts";
import type { ComposedPitch, GeneratorInputs } from "./generator.ts";

// Who the intro line names. Resolved once at module load so each language's
// system prompt stays byte-identical across calls (it is prompt-cached).
const EN_SENDER = senderIdentity("en");
const ES_SENDER = senderIdentity("es");

// ── Zod schema ───────────────────────────────────────────

// CLIP, don't REJECT: a hard .max() fails the WHOLE parse when Claude runs a few
// chars long on any one field, dumping the pitch to the junky heuristic template
// (tasks/lessons.md 2026-05-29 + the REALTY EXPERTS reasoning>800 failure). Use a
// generous ceiling so genuinely-broken output still errors, then slice to spec.
const responseSchema = z.object({
  subject: z.string().trim().min(4).max(600).transform((s) => s.slice(0, 120)),
  preview_text: z.string().trim().min(20).max(2000).transform((s) => s.slice(0, 150)),
  body: z.string().trim().min(80).max(8000).transform((s) => s.slice(0, 2000)),
  // pain_id can be a text slug like "abandoned_cart_loss" or a UUID — accept both.
  // An absent key reads as null: 4 of 5 composer fallbacks in 30 days of prod
  // were "pain_id:Required" on an otherwise good pitch, thrown away for a template.
  // (Normalized to null where it is read.)
  pain_id: z.string().nullable().optional(),
  // No longer requested (prompt v2 sends no case studies); tolerated if present.
  case_study_id: z.unknown().optional(),
  // contact_email may be missing from Claude response — coerce null gracefully
  // (an absent key too, like pain_id).
  contact_email: z.union([z.string().email(), z.literal(""), z.null()]).optional().transform(v => v || null),
  measurable_result_included: z.boolean(),
  quality_self_score: z.number().min(0).max(1),
  reasoning: z.string().trim().max(8000).transform((s) => s.slice(0, 800)).optional().default("(no reasoning provided)"),
  // The statistic it wished payload.benchmarks had (recorded, never sent). Any
  // shape the model returns reads as text or null: a malformed wish must never
  // cost the pitch. Clipped generously; the recorder discards anything over 300.
  wanted_fact: wantedFactField(),
});

/**
 * Optional free-text wish: a string (trimmed, clipped) or null, never a parse
 * failure. Shared with the critic. Typed string | null on both sides because
 * structuredCall infers its result from a schema whose input and output agree;
 * at runtime any value (absent, a number, an object) reads as null.
 */
export function wantedFactField(): z.ZodType<string | null, z.ZodTypeDef, string | null> {
  return z
    .unknown()
    .transform((v) => (typeof v === "string" && v.trim() ? v.trim().slice(0, 1000) : null)) as unknown as z.ZodType<
    string | null,
    z.ZodTypeDef,
    string | null
  >;
}

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

// ── Main entry point (same signature as v1) ───────────────────────────────────

export async function composePitchWithClaude(
  input: GeneratorInputs,
  opts: { timeoutMs?: number } = {},
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

  // ── One Sonnet pass: translate the pain + write the pitch ──────────────────
  const lang = input.prospect.language;
  // The system prompt is byte-identical for a given (lang, size) across every
  // pitch in a run — cache it. First pitch of each variant writes the cache,
  // the rest read it at 0.1× input price. All per-prospect data lives in the
  // user message, so the cached prefix is stable.
  const system: SystemBlock[] = [{ text: buildSystemPrompt(lang, size), cache: true }];
  const user = buildStage2UserPrompt(input);

  const call = await structuredCall({
    model: ANTHROPIC_DEFAULT_MODEL,
    system,
    user,
    // 1600 (was 1200, was 600): the JSON carries body (≤2000 chars) + preview +
    // a reasoning field (≤800) + the conversational CTA. An under-cap is not a
    // soft failure — it truncates mid-string, JSON.parse dies with
    // "Unterminated string", and the prospect silently gets the generic
    // template instead. Two live pitches were lost this way at 1200.
    //
    // Raised specifically because SPANISH is the tight case: Spanish tokenizes
    // roughly 15-20% worse than English for the same content (accents and
    // longer words split into more tokens), so an identical brief that fits in
    // English overflows in Spanish. That asymmetry made truncation look random
    // when it was actually language-correlated. Headroom is cheap; the failure
    // is not.
    // 1700 since v3.2: the wanted_fact field adds up to ~80 tokens.
    max_tokens: 1700,
    // A larger response takes longer to generate — give it more than the 20s
    // default so a slow generation doesn't time out into the heuristic. Stays
    // well under the 60s Vercel function budget (this is the only Sonnet call).
    timeoutMs: opts.timeoutMs ?? 35_000,
    schema: responseSchema,
  });

  if (!call.ok) {
    // The Sonnet call failed before returning token counts (call.usage=null):
    // return null usage so callers know no credits were spent.
    const combined = call.usage !== null ? addUsage(totalUsage, call.usage) : null;
    return {
      ok: false,
      error: call.error,
      reason: call.reason,
      usage: combined,
    };
  }

  totalUsage = addUsage(totalUsage, call.usage);

  const validPainIds = new Set(
    input.pains.map((p) => p.pain_id).filter(Boolean) as string[],
  );
  const painId = call.data.pain_id ?? null;
  if (painId !== null && !validPainIds.has(painId)) {
    return {
      ok: false,
      error: `Claude returned unknown pain_id ${painId}`,
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
  const forwardingLine = primaryContact?.email_is_role_based ? `\n\n${FORWARDING_LINE[lang]}` : "";
  // Hard-strip em dashes regardless of Claude's compliance.
  // Replace "— " with ", " and standalone "—" with " " to preserve flow.
  const cleanBody = (call.data.body + forwardingLine)
    .replace(/\s*—\s*/g, ", ")
    .replace(/—/g, " ")
    .replace(/ {2,}/g, " ")
    .trim();
  const finalBody = resolveCtaLink(cleanBody, input.deep_pitch_url ?? HUNTER_URL);

  return {
    ok: true,
    result: {
      composed: {
        subject: call.data.subject,
        preview_text: call.data.preview_text,
        body: finalBody,
        pain_id: painId,
        // Case studies are no longer sent to the model (see the payload), so a
        // pitch never cites one; anything the model returns here is ignored.
        case_study_id: null,
        contact_used: call.data.contact_email ?? null,
        measurable_result_included: call.data.measurable_result_included,
        quality_self_score: adjustedScore,
        reasoning: call.data.reasoning ?? "(no reasoning provided)",
        wanted_fact: call.data.wanted_fact,
      },
      usage: totalUsage,
      model: call.model,
      raw: call.raw,
    },
  };
}

/** Appended by the composer when the address is a role inbox (never written by the model). */
const FORWARDING_LINE = {
  en: "If you're not the right person for this, I'd really appreciate it if you could pass this along to whoever handles it.",
  es: "Si no eres la persona indicada para esto, te agradecería mucho que puedas reenviarle este mensaje a quien corresponda.",
} as const;

/** A resolved Hunter link: what resolveCtaLink puts where {hunter_url} was (HUNTER_URL + its query). */
const RESOLVED_HUNTER_LINK_RE = new RegExp(`${HUNTER_URL.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&")}\\S*`, "g");

/**
 * A stored body turned back into what the writer produced, for a revision of
 * it: every Hunter link back to the {hunter_url} slot (the stored link carries
 * the OLD pitch's &r= attribution code; kept as is, the rewrite's scans would
 * be credited to a deleted row) and the composer's forwarding line removed (it
 * is appended again after the revision).
 */
export function heldBodyForRevision(body: string): string {
  let out = body.replace(RESOLVED_HUNTER_LINK_RE, (url) => {
    const trail = url.match(/[.,;:!?)\]]+$/)?.[0] ?? "";
    return `{hunter_url}${trail}`;
  });
  for (const line of Object.values(FORWARDING_LINE)) out = out.split(line).join("");
  return out.replace(/\n{3,}/g, "\n\n").trim();
}

// ── Pitch prompt ──────────────────────────────────────────────────────────────

/**
 * Version of the pitch prompt below. Bump it on every wording change so a pitch
 * can be traced to the prompt that wrote it.
 *
 * v2 (2026-10-16) is the one-voice rewrite. v1 had grown by accretion and
 * contradicted itself: "NO NUMBERS" next to "numbers only from benchmarks",
 * "never name a client" next to "Did this for {client}, {metric}", a banned-
 * jargon list next to examples full of that jargon and of em dashes, and a
 * capabilities block offering a client (SnapPad) and S.P.A.M. itself as proof.
 * A model resolves a contradiction by picking a side, differently each time,
 * which is how invented statistics kept reaching live drafts after they were
 * "banned". Every rule now lives in exactly one place:
 *   - facts (numbers, clients, our work) → FACTS
 *   - order and length                   → THE EMAIL
 *   - wording, per language              → WORDS (+ the language pack)
 *
 * v3 (2026-10-20): the writer and the reviewer agree on what is a fact. v2
 * taught the hook as "the business consequence, not the symptom" and its
 * examples stated guesses about the prospect as facts ("every visitor after
 * hours just leaves", "yours wait until morning"); the critic blocks exactly
 * that, and half the autopilot's rewrites were held again for it. Now the
 * observed finding is stated plainly and what it costs is framed as what
 * usually happens.
 *
 * v3.1 (2026-10-22): every benchmark says which of the prospect's pains it is
 * about (for_pains). A prod rewrite led with "no cart recovery" and was offered
 * only retention and video figures; the writer may now cite a benchmark only
 * when one of its for_pains is the pain it leads with.
 *
 * v3.2 (2026-10-22): when no offered benchmark is about the pain it leads with,
 * the writer writes no number and names the statistic it wished it had
 * (wanted_fact, recorded in wanted_facts for research). The rewrite-with-angle
 * directive no longer bans every number: a benchmark tagged with the angle's
 * pain is allowed, as FACTS 2 says, and the directive names that pain_id.
 */
export const PITCH_PROMPT_VERSION = "pitch-v3.2-2026-10-22";

/** Everything that differs by language. The rules themselves do not. */
type LanguagePack = {
  langName: string;
  register: string;
  verbs: string;
  salutation: string;
  intro: [string, string];
  hook: { good: string; bad: string };
  mechanism: string;
  proof: string;
  pain: { wrong: string; right: string; guess: string; usually: string };
  benchmark: { ok: string; not: string; attribution: string };
  jargon: string;
  languageRule: string;
  techStack: string;
  cta: [string, string];
  subjects: string;
  preview: string;
};

function englishPack(): LanguagePack {
  const s = EN_SENDER;
  return {
    langName: "English (Canadian market)",
    register:
      "Direct, understated, confident: Canadian, not American marketing energy. Contractions always (you're, it's, don't).",
    verbs: "answer, reach, fix, lose, miss, book",
    salutation:
      '"Hi [first name]," when address_contact.first_name is set and reads like a real given name. Otherwise "Hi [company] team,". Never "Hi there,".',
    intro: [
      `${s.firstName} from ${s.agency} here. We help independent businesses grow without burning money on ads.`,
      `Quick note from ${s.firstName} at ${s.agency}. We work with [industry] businesses on exactly this.`,
    ],
    hook: {
      good: "Checked your store: nothing follows up when someone leaves without buying",
      bad: "I noticed an opportunity",
    },
    mechanism: "a few emails that go out on their own to everyone who left something in their cart",
    proof:
      "We do this kind of work for clinics that get more calls than the front desk can answer: finding where people slip away, then making sure someone always gets back to them.",
    pain: {
      wrong: 'I saw "Outdated website, no e-commerce functionality".',
      right: "Checked [company]'s site: there's no way to buy anything online.",
      guess: "Your phone shoppers give up and buy somewhere else.",
      usually: "Most people who can't buy on the spot from their phone don't come back to finish.",
    },
    benchmark: {
      ok: "A Harvard Business Review study found firms that reply within the hour are about 7 times more likely to get a real conversation going than firms that wait longer.",
      not: "Businesses like yours see 20-30% more bookings with us.",
      attribution: '"a Harvard Business Review study found", "according to Baymard Institute"',
    },
    jargon: `    lead(s), lead capture, lead-gen, qualified lead, conversion, convert, funnel, pipeline
      -> "people who get in touch", "enquiries", "more of them actually book"
    intake, triage, routing, workflow
      -> say what happens: "someone gets back to them right away", "nothing slips through"
    optimize, optimization, streamline, seamless, robust, solution(s), systems, leverage, bandwidth
      -> cut the word and say the result: "faster", "less manual work", "without hiring anyone"
    CRM, ROI, ROAS, LTV, churn, retargeting, nurture, drip, attribution, segmentation, UX, A/B test
      -> describe the outcome in plain words
    hype and stock lines: transform, unlock, supercharge, game-changer, synergy, best-in-class,
      thought leader, circle back, "I hope this finds you well", "Quick question", "Just reaching out"`,
    languageRule: 'No Spanish words, not even "hola".',
    techStack:
      'you may name the platform they use when it is in tech_stack ("your Shopify store"). Never name a tool they did not mention (Klaviyo, Meta, HubSpot...).',
    cta: [
      "Don't take my word for it, take the data's: run [company] through our free check and see for yourself where [the pain] is costing you. About 30 seconds, no signup, no strings: {hunter_url}. See something worth fixing? Reply. If not, no harm done.",
      "I'd rather the numbers show you than me tell you. {hunter_url} is a free check of [company]'s own [pain], about 30 seconds, no signup. If you want to talk after, I'm here.",
    ],
    subjects: `    - their business + a quiet loss (the default): "where [company] loses online orders", "what [company]'s website isn't doing"
    - what you saw, said plainly (only when the pain evidence shows it): "no online booking at [company]"
    - the reframe, something they think is fine called a cost: "what a slow reply costs [company]"
    - the 30-second check: "30 seconds: where [company] leaks customers"`,
    preview: "no way to book online after hours, only a contact form",
  };
}

function spanishPack(size: SizeSignal): LanguagePack {
  const s = ES_SENDER;
  const usted = size !== "smb";
  return {
    langName: "Spanish (Mexican business register)",
    register: usted
      ? 'Habla de usted en todo el correo, CTA incluido (adapta los ejemplos, que van de tú). Profesional y directo. Si el puesto se ve, "Lic.", "Ing.", "Dr./Dra." con el apellido.'
      : 'Tutea (tú) en todo el correo. Directo y cálido: "tu sitio no tiene forma de agendar", no "hay oportunidades de conversión".',
    verbs: "contestar, llegar, arreglar, perder, agendar, vender",
    salutation: usted
      ? '"Estimado [nombre]," o "Estimada [nombre]," según el nombre (si no estás seguro, "Hola [nombre],") cuando address_contact.first_name existe y parece un nombre real. Si no, "Hola, equipo de [empresa],". Nunca "Hola there,".'
      : '"Hola [nombre]," cuando address_contact.first_name existe y parece un nombre real. Si no, "Hola, equipo de [empresa],". Nunca "Hola there,".',
    intro: [
      `Soy ${s.firstName}, de ${s.agency}. Ayudamos a negocios independientes a crecer sin quemar dinero en anuncios.`,
      `${s.firstName}, de ${s.agency}. Trabajamos con negocios de [industria] justo en esto.`,
    ],
    hook: {
      good: "Revisé tu tienda: nadie le da seguimiento a quien se va sin comprar",
      bad: "Vi una oportunidad",
    },
    mechanism: "unos correos que le llegan solos a quien dejó algo en el carrito",
    proof:
      "Hacemos este trabajo para clínicas que reciben más llamadas de las que la recepción alcanza a contestar: encontrar dónde se pierden los pacientes y asegurar que siempre alguien les responda.",
    pain: {
      wrong: 'Vi "Outdated website, no e-commerce functionality".',
      right: "Revisé el sitio de [empresa]: no hay forma de comprar nada en línea.",
      guess: "Tus clientes se cansan y le compran a otro.",
      usually: "Casi nadie que no puede comprar en el momento desde el celular regresa a terminar.",
    },
    benchmark: {
      ok: "Según un estudio de Harvard Business Review, las empresas que responden en menos de una hora tienen unas 7 veces más probabilidades de lograr una conversación real que las que tardan más.",
      not: "Negocios como el tuyo venden 20-30% más con nosotros.",
      attribution: '"según un estudio de Harvard Business Review", "de acuerdo con Baymard Institute"',
    },
    jargon: `    leads, lead, funnel, pipeline, CRM, ROI, conversión, engagement, workflow, intake, triage, onboarding
      -> "clientes potenciales", "clientes que se te escapan", "solicitudes que no se atienden a tiempo",
         "más personas terminan comprando"
    optimizar, optimización, soluciones, sinergia, potenciar, apalancar
      -> di el resultado: "más rápido", "menos trabajo a mano", "sin contratar a nadie"
    etiquetas de agencia: "el fix aquí", "lo que mueve la aguja", "diagnosticar el patrón"
    muletillas: "me permito contactarle para ofrecerle nuestros servicios", "espero que se encuentre bien"`,
    languageRule:
      'Not one English word, platform names included (no "Shopify", "WooCommerce", "Meta Pixel", "abandonment", "default setup"). Use the everyday words a "dueño" or "tendero" uses, never agency Spanish.',
    techStack:
      'say "tu tienda en línea" or "tu sitio" (or the usted form), never the platform name.',
    cta: [
      "No me creas a mí, créele a los datos: corre [empresa] en nuestra herramienta gratis y mira tú mismo dónde [el dolor] te está costando. Unos 30 segundos, sin registro, sin compromiso: {hunter_url}. ¿Ves algo que arreglar? Escríbeme. ¿No? No pasa nada.",
      "Prefiero que te lo muestren los números a decírtelo yo: {hunter_url} revisa gratis [el dolor] de [empresa] en unos 30 segundos, sin registro. Si quieres hablar después, aquí estoy.",
    ],
    subjects: `    - su negocio + una pérdida silenciosa (por defecto): "dónde pierde clientes [empresa]", "lo que el sitio de [empresa] no está haciendo"
    - lo que viste, dicho tal cual (solo si la evidencia lo muestra): "[empresa] sin reservas en línea"
    - el replanteo, algo que creen que está bien visto como costo: "¿cuánto le cuesta a [empresa] una respuesta tarde?"
    - la revisión de 30 segundos: "30 segundos: dónde [empresa] pierde ventas"`,
    preview: "no hay forma de agendar en línea fuera de horario, solo un formulario",
  };
}

function buildSystemPrompt(lang: "en" | "es", size: SizeSignal): string {
  const s = lang === "es" ? ES_SENDER : EN_SENDER;
  const p = lang === "es" ? spanishPack(size) : englishPack();

  return `You write first-touch cold emails for ${s.agency} (Rünna), a creative and digital agency. Each email is from ${s.firstName}, a real person on the team who reads and answers the replies. Write it the way ${s.firstName} would type it: quickly, to one person, about their business.

${RUNNA_CAPABILITIES_FOR_PITCHES}

WHO YOU ARE WRITING TO
The owner or manager of a clinic, a law firm, a machine shop, a warehouse, a spa, a store. They know their trade cold, know almost nothing about marketing or software, and don't want to. Write like you're explaining it to a smart friend outside the business. If a 60-year-old shop owner would stop to wonder what a word means, it is the wrong word.

THE GOAL
Make them curious enough to run the free check or reply. Not to close a deal. One pain, one fix, one ask.

FACTS: EVERYTHING COMES FROM THE PAYLOAD
1. About the prospect, say only what the payload says (company_name, industry, city, what_they_do, tech_stack, pain_candidates). Never guess their size, revenue, customers, location or tools.
2. Numbers. A real number makes a cold email more believable; an invented one kills it. Allowed:
   - "about 30 seconds" for the free check;
   - facts about THEM that are in the payload (what_they_do, evidence_quote), e.g. how many locations they run;
   - statistics from payload.benchmarks: real, sourced research on what businesses that make this kind of change typically see (more enquiries won, hours saved, sales recovered, fewer no-shows). We don't need numbers of our own; this is how the outcome gets a size. Each benchmark lists for_pains, the pains it is about: cite a benchmark ONLY if one of its for_pains is the pain you lead with (the same pain_id), otherwise use no number at all, because a figure about a different problem is worse than none. When one matches, USE it: it is usually the line that makes the reader stop. Keep the figure exactly as given, say where it comes from in a few words (${p.benchmark.attribution}), and frame it as what businesses like theirs experience, saying exactly what the source measured ("get a real conversation" is not "win the client"). Each benchmark carries a caveat: follow it. One per email; two only if they make the same point.
   If a statistic would make this email stronger and none of payload.benchmarks has the pain you lead with in for_pains, write no number in the email and put the fact you wish you had in wanted_fact, in plain words, as a question or a description, never a number.
   How to frame it matters: in cold-email data, percentage and ROI claims made by the sender LOWER replies (Gong: -15%), while a number that describes the reader's world reads as insight. So a statistic describes what happens out there or sizes their problem ("most firms never reply to a web enquiry at all"); it never promises the reader a result ("you'll get 30% more").
   Never: a figure you remember, estimate, round or combine; a benchmark presented as OUR result; a percentage promised to the reader; any number in the subject line. benchmarks may be empty, and then the email has no statistic: the pain and the fix carry it.
     OK (only when that figure is in benchmarks): "${p.benchmark.ok}"
     NEVER: "${p.benchmark.not}" (our result, a brag, unsourced)
3. Clients. Never name a client or quote a client's result: not as proof, not in passing, not "we worked with X". The payload has no client names, on purpose. Named examples make the email about someone else's win instead of the reader's problem.
4. Our work. Prove it with what we build for businesses like theirs (from WHAT RUNNA DOES), in plain words: their INDUSTRY, the kind of WORK, THEIR situation. Never name an internal product.

THE EMAIL, IN THIS ORDER (nothing added, nothing reordered)
1. Salutation. ${p.salutation}
2. Intro, one sentence: who is writing. Warm, not a pitch. For example:
   "${p.intro[0]}"
   "${p.intro[1]}"
3. Hook: one specific observation about THIS business, from the pain you picked (below) plus what_they_do, tech_stack or city. "${p.hook.good}" beats "${p.hook.bad}".
4. The fix, one or two sentences, the core of the email: what we would do, described by what it does for them, specific to their business and industry. Start from solution_hint and make it theirs. Describe how it works ("${p.mechanism}"), never a tool name or a result figure.
5. Proof, one sentence: the kind of work we do for businesses like theirs. No client, no metric, no boast. For example: "${p.proof}"
6. CTA: one line that starts with 👉 (that marker turns it into the email's button). See CALL TO ACTION.
7. Sign-off: "${s.firstName}" on one line and "${s.agency}" on the next. Nothing after it.
Length: 60 to 100 words from the salutation to the CTA. Past 100, replies drop sharply (Gong, 2026); the best emails run 50 to 100.

SAY WHAT YOU SAW, THEN WHAT IT TENDS TO COST
pain_candidates are raw audit findings in technical, usually English, language. Before writing, pick the best one (prefer one with both pain_id and evidence_quote) and say what was found in the plain words the owner would use with a friend. No jargon, never a quote from the audit. That plain observation is your hook, and it may be stated as fact because the payload shows it.
What it costs them is NOT in the payload: you have not seen their customers, their traffic or their inbox. Say it as what tends to happen to businesses with this gap in general, never as a fact about their own customers, visitors or sales. Word that in your own way each time, not with a stock phrase.
  NOT: ${p.pain.wrong}
  OK:  ${p.pain.right}
  NOT: ${p.pain.guess}
  OK:  ${p.pain.usually}

WORDS
- No em dashes (—) or en dashes (–). Use a comma or a period, or split the sentence.
- ${p.register}
- Short sentences, one idea each, at about a 5th-grade reading level (simple writing gets far more replies). One or two sentences per paragraph: it's read on a phone. Less "we", more "you". Plain verbs: ${p.verbs}.
- Banned, with what to say instead (always say the plain thing, even when pain_label uses the jargon):
${p.jargon}
- No clever consultant lines ("that's not a staffing problem, it's a systems problem"). They sound smart and say nothing.
- One language only: ${p.langName}. ${p.languageRule}
- Their platform: ${p.techStack}
- Read it in your head out loud. If you would never say it to someone's face, rewrite it.

CALL TO ACTION: the Inefficiency Hunter (payload.hunter_url)
It is a FREE check they run on their OWN business: about 30 seconds, no signup. The credibility comes from THE DATA, not from us. We are not the ones making the claim; their own numbers show it to them. They look first, and reach out afterward only if they want to, with zero pressure if they don't. Confident and generous, never salesy.
Write it FRESH every time, in one or two short sentences, tailored to the pain this email leads with, never a stock line; vary the opening especially. An interest-based ask ("worth a look?") books twice as many meetings as asking for a call (Gong), which is exactly what this CTA is. It must land all of: free; on their own business; they'll see for themselves where [this email's pain] is costing them; it's the data saying it, not us; about 30 seconds, no signup, no strings; reply afterward only if they want.
Write the token {hunter_url} exactly, where the link goes. It is a template slot that is replaced with the real link before sending: never invent a URL, never write a bare domain, never leave it out. No other links, no video, no call request.
Tone only, do not copy:
  "${p.cta[0]}"
  "${p.cta[1]}"

SUBJECT LINE
- 2 to 6 plain words, at most 50 characters, all lower case, no em dash, no jargon, no number except "30 seconds" / "30 segundos". It should read like a note from someone they know, about THEIR business.
- Never "[company]: [pain label]" (it reads like a spam report). They should not know exactly what the email is about until they open it.
- Pick the shape that fits the evidence:
${p.subjects}

PREVIEW TEXT (shown under the subject in the inbox)
- 20 to 150 characters, same language, same rules on numbers and jargon. Never repeat the subject: the subject makes them curious, the preview names the specific observation that makes opening worth it. For example: "${p.preview}"
- Never "I'd love to connect", "Let me know if you're interested", "Hope this finds you well".

Brackets like [company] or [the pain] in the examples above are for you to fill in. {hunter_url} is the only token that stays exactly as written.

OUTPUT: one JSON object with exactly these fields, all required (null only where allowed):
{
  "subject": string,                     // see SUBJECT LINE
  "preview_text": string,                // see PREVIEW TEXT
  "body": string,                        // plain text with \\n line breaks, no markdown, salutation through sign-off
  "pain_id": string | null,              // the pain_candidates[].pain_id you led with, or null
  "contact_email": string | null,        // address_contact.email, or null
  "measurable_result_included": boolean, // true ONLY if you quoted a benchmark figure
  "quality_self_score": number,          // 0..1, honest grade of how specific and personal it is
  "reasoning": string,                   // 1 to 3 sentences: the pain and the fix you chose, and why
  "wanted_fact": string | null           // the statistic you wished benchmarks had (see FACTS 2), in words with no digits, or null
}`;
}

/** The greeting's first name: the rule lives in greeting-name.ts, shared with the exemplar scrubber. */
export const firstNameGuess = greetingName;

function buildStage2UserPrompt(input: GeneratorInputs): string {
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
    // The single contact to address, resolved + with a derived first name so the
    // model greets the decision-maker by name instead of defaulting to "team".
    address_contact: (() => {
      // MUST be the contact the email will actually be SENT to. `contacts` is
      // ordered by priority_rank, so the first with a usable email is exactly
      // what pickTopUsableContact (the send path) resolves.
      //
      // This previously preferred "any non-role contact that has a full_name",
      // which on a prospect with several contacts greeted a DIFFERENT person
      // than the recipient — a real pitch went to john.sipos@waglaw.net opening
      // "Hi Mark,". Same class as the Acadian failure: two code paths choosing
      // "the contact" by different rules.
      const c =
        input.contacts.find((x) => hasUsableEmail(x.email)) ??
        input.contacts[0] ??
        null;
      if (!c) return null;
      return {
        first_name: firstNameGuess(c.full_name, c.email, c.email_is_role_based),
        full_name: c.full_name,
        email: c.email,
        role_title: c.role_title ?? null,
        role_based: c.email_is_role_based,
      };
    })(),
    // Sourced benchmarks matching this prospect's pain AND industry: real
    // research on what businesses see after this kind of change (Pedro,
    // 2026-10-16: "base those numbers on facts… even if we personally don't
    // have numbers directly tied to our platforms"). The model may cite these
    // and ONLY these; the send gate holds any other number.
    benchmarks: input.benchmarks.map((b) => ({
      statistic: b.statistic,
      figure: b.figure,
      publisher: b.publisher,
      // What it does and doesn't measure ("qualify ≠ convert", "say 'in
      // clinics'"), so the paraphrase stays true to the source.
      caveat: b.caveat ?? null,
      // The pains (same pain_id as pain_candidates) this figure is about. Cite
      // it only when leading with one of them (FACTS 2).
      for_pains: b.for_pains.map((f) => ({ pain_id: f.pain_id ?? f.code, pain: f.label ?? f.code })),
    })),
    // Deliberately NOT sent: case studies and notable clients. Pedro's override
    // (2026-07-22): never name a client, never quote a client's metric — named
    // examples underperform. Withholding the data is the guard; a prompt rule
    // alone loses to the model's prior toward social proof. (v1 still sent
    // chosen_cases with client names and metrics, and its prompt still offered
    // a "Did this for {client}, {metric}" proof line.)
    hunter_url: input.deep_pitch_url ?? null,
  };

  const rewriteDirective = input.forced_angle
    ? `\n⚑ REWRITE DIRECTIVE: the human chose the angle for this rewrite. Lead with this pain: "${input.forced_angle.pain_label}"${
        input.forced_angle.pain_id ? ` (pain_id ${input.forced_angle.pain_id})` : ""
      }. Prove it with the kind of work that fixes it${
        input.forced_angle.capability ? ` ("${input.forced_angle.capability}")` : ""
      }, under the same FACTS rules: no client; a number only as FACTS 2 allows (a benchmark whose for_pains includes this pain). Everything else stays the same.\n`
    : "";

  // The AI review sent the previous draft back. Name each issue; keep what
  // worked. The rules in the system prompt still apply in full.
  const revisionDirective = input.revision
    ? `\n⚑ REVISION: your previous draft was sent back by a reviewer. Rewrite it so every issue below is fixed, keep what was already good, and follow every rule in the system prompt. Never mention the review.
Issues to fix:
${input.revision.issues.map((i) => `- ${i}`).join("\n")}

Previous draft:
Subject: ${input.revision.subject}
${input.revision.body}
`
    : "";

  // Learned guidance (lib/autopilot/learn.ts): a short instruction the weekly
  // review proposed from real outcomes, under live test as a bandit arm. It can
  // only add to the system prompt's rules, never relax them; the gate and the
  // reviewer still check the result.
  const guidanceDirective = input.guidance?.trim()
    ? `\nAdditional guidance learned from what has worked (follow it only where it fits every rule in the system prompt):\n- ${input.guidance.trim()}\n`
    : "";

  return `Write the pitch from this payload.${rewriteDirective}${revisionDirective}${guidanceDirective}

\`\`\`json
${JSON.stringify(payload, null, 2)}
\`\`\`

Using the payload:
- address_contact is the person who will receive this email. Greet them as the salutation rule says, and set contact_email to address_contact.email.
- prospect.what_they_do: base the hook on what they actually do, not on a generic observation.
- prospect.tech_stack: see "Their platform" under WORDS.
- prospect.city: mention it only if it fits naturally, and never claim anything about their city or market that is not in the payload.
- address_contact.role_title: use it if it fits naturally ("As the owner of [company]...").
- solution_hint: the starting point for the fix. Make it specific to them.
- benchmarks: real, sourced research for this prospect's pains and industry. Use one only if one of its for_pains has the pain_id you lead with (see FACTS); if none does, the email has no statistic.${writerExemplarSection(input.exemplars)}`;
}

// ── Violation detector ────────────────────────────────────────────────────────

/**
 * Any unresolved template token. Matches {hunter_url}, {{hunter_url}},
 * { hunter_url }, [hunter_url] — every shape the model has produced.
 */
const HUNTER_TOKEN_RE = /[{[]{1,2}\s*hunter_url\s*[}\]]{1,2}/gi;

/**
 * Leftover placeholder of ANY name: {company}, [company], [the pain],
 * [el dolor] — used by the violation check. The prompt's examples use brackets,
 * and a copied one must never read as finished text.
 */
export const LEFTOVER_PLACEHOLDER_RE = /[{[]{1,2}\s*[a-záéíóúñü_' ]{1,40}?\s*[}\]]{1,2}/gi;

/**
 * Guarantee the CTA is a working button.
 *
 * Two independent failures shipped a broken CTA to a live draft (the Great
 * Canadian pitch, 2026-07-22): the body contained the literal text
 * "{hunter_url}" instead of a link, AND the line did not start with 👉.
 * buildHtmlBody only renders a button when BOTH hold — a line starting with 👉
 * that contains an http(s) URL — so the reader got a plain sentence with a
 * placeholder in it.
 *
 * The prompt now declares {hunter_url} an intentional template slot rather than
 * something to avoid, because the token cannot be interpolated into the SYSTEM
 * prompt without busting its cache (the URL is per-prospect). So the model is
 * told to emit the token and this function always fills it — the accident is
 * now the design, and it is enforced in code rather than hoped for.
 */
export function resolveCtaLink(body: string, hunterUrl: string): string {
  let out = body.replace(HUNTER_TOKEN_RE, hunterUrl);

  // The model sometimes writes the CTA without the 👉 marker, which silently
  // costs the button. If a line carries the hunter link and lacks the marker,
  // add it. Only the CTA line is touched.
  out = out
    .split("\n")
    .map((line) => {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("👉")) return line;
      if (!trimmed.includes(hunterUrl)) return line;
      return `👉 ${trimmed}`;
    })
    .join("\n");

  return out;
}

export function detectViolations(body: string, lang: "en" | "es"): number {
  // Banned jargon, hype, stock openers and the other language bleeding in, plus
  // the em dash Pedro banned (reads corporate, trips spam filters). Same list
  // the send gate holds on (lib/pitches/content-rules.ts).
  let count = findBannedTerms(body, lang).length;
  if (body.includes("—")) count++;

  // ── Language-independent checks ────────────────────────────────────────────

  // An unresolved template token reached the body. resolveCtaLink fills
  // {hunter_url}, so anything left here ({company}, {client}, a typo'd token)
  // is a placeholder the reader would actually see. Weighted double: this is
  // visibly broken, not merely off-voice.
  const leftovers = body.match(LEFTOVER_PLACEHOLDER_RE);
  if (leftovers) count += 2 * leftovers.length;

  // A CTA link with no 👉 renders as plain text and the button disappears.
  // resolveCtaLink repairs this, so reaching here means a link we did not
  // recognise — still worth flagging, since the button is the whole CTA.
  const hasLink = /https?:\/\//.test(body);
  if (hasLink && !body.includes("👉")) count++;

  return count;
}

// ── Solution hints ────────────────────────────────────────────────────────────
// Baseline solution proposals keyed by pain label substring (lowercased).
// Claude uses these as a starting point and tailors them to the specific prospect.

const SOLUTION_HINTS_EN: [string, string][] = [
  ["abandoned_cart", "automatically reaching back out to everyone who added things and left without buying, so those sales stop quietly disappearing"],
  ["cart", "automatic reminders that follow up with people who added things and left, showing them exactly what they left behind"],
  ["mobile conversion", "fixing the parts of your site where phone shoppers give up, so more of the visitors you already pay for actually buy"],
  ["email", "automatic emails that follow your customers from first visit to repeat order, so the right message reaches them at the right moment without you lifting a finger"],
  ["paid media", "refreshing your ads and who they reach, so the budget stops funding impressions that were never going to buy"],
  ["roas", "fixing your ads so you make more for every dollar you spend: better ads, the right people seeing them, and actually knowing what's working"],
  ["social engagement", "a content plan you can actually stick to, so you show up regularly instead of whenever someone remembers"],
  ["content velocity", "a simple way to post regularly without it taking over your week"],
  ["retention", "automatic messages after every purchase, a thank you, helpful tips, a reminder when they're running low, so a first order turns into a second"],
  ["website", "making your site faster, easier to use on a phone, and easier to actually buy from"],
  ["outdated", "rebuilding your site so it loads fast, looks great on any phone, and makes buying simple"],
  ["brand", "cleaning up how your brand looks everywhere, so it feels intentional, not like five different people made it"],
  ["packaging", "redesigning your packaging so it stands out on the shelf at a glance and tells the story clearly"],
  ["value prop", "getting crystal clear on your one best reason to buy, then saying that same thing everywhere consistently"],
  ["launch", "coordinating your ads, social posts, emails and website to go live together, so nothing falls flat on its own"],
  ["competitor", "standing for something specific so people choose you for reasons other than price"],
  ["sales process", "automating the follow-up so no interested buyer gets forgotten and you stop chasing manually"],
  ["event", "turning your event into content and a campaign before, during and after, not just showing up"],
  ["proof", "putting your best customer stories in exactly the spots where people hesitate before buying"],
  ["ai", "automating the repetitive stuff (follow-ups, answering new enquiries, reporting) so your team focuses on what actually matters"],
];

const SOLUTION_HINTS_ES: [string, string][] = [
  ["abandoned_cart", "mandarle un mensaje automático a cada persona que llenó su carrito y se fue sin comprar, para que esas ventas dejen de perderse solas"],
  ["carrito", "recordatorios automáticos para quien agregó cosas y se fue sin comprar, mostrándoles exactamente lo que dejaron"],
  ["mobile", "arreglar las partes de tu sitio donde la gente se rinde desde el celular, para que el tráfico que ya pagas sí termine comprando"],
  ["email", "mensajes automáticos que acompañan a tu cliente desde la primera visita hasta la siguiente compra, para que el mensaje correcto llegue solo, sin que tú tengas que hacer nada"],
  ["paid media", "renovar tus anuncios y a quién les llegan, para que el presupuesto deje de pagar impresiones que nunca iban a comprar"],
  ["roas", "hacer que tus anuncios rindan más por cada peso que gastas: mejores anuncios, que los vea la gente correcta y saber de verdad qué está funcionando"],
  ["engagement", "un plan de contenido que puedas mantener, para publicar seguido y no solo cuando alguien se acuerda"],
  ["contenido", "una forma sencilla de publicar seguido sin que te consuma la semana"],
  ["retención", "mensajes automáticos después de cada compra, agradecimiento, tips útiles, recordatorio cuando ya se les acabó, para que una primera compra se convierta en la segunda"],
  ["sitio", "hacer tu sitio más rápido, más fácil de usar desde el celular y más fácil para comprar"],
  ["página", "reconstruir tu sitio para que cargue rápido, se vea bien en cualquier celular y comprar sea simple"],
  ["marca", "limpiar cómo se ve tu marca en todos lados, para que se sienta intencional y consistente, no como si la hubieran hecho cinco personas distintas"],
  ["empaque", "rediseñar tu empaque para que destaque en el anaquel de un vistazo y cuente la historia de forma clara"],
  ["propuesta de valor", "encontrar tu razón número uno para que te compren a ti, y decirla igual en todos lados"],
  ["lanzamiento", "coordinar tus anuncios, redes sociales, correos y página de destino para que todo salga junto y con fuerza"],
  ["competencia", "definir por qué te eligen a ti y no al de precio más bajo"],
  ["ventas", "automatizar el seguimiento para que ningún interesado quede en el olvido y dejes de perseguir a mano"],
  ["evento", "convertir tu evento en contenido y campaña antes, durante y después, no solo aparecer"],
  ["prueba social", "poner las historias de tus mejores clientes justo en los momentos donde la gente duda antes de comprar"],
  ["ai", "automatizar lo repetitivo (seguimientos, responder a nuevos interesados, reportes) para que tu equipo se enfoque en lo que realmente importa"],
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
