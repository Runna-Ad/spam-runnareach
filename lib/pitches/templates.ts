/**
 * Cold-email pitch templates. 5-line elevator-pitch format designed to
 * fit in an email body — opens with a specific evidence hook, names a
 * pain, bridges to one case study with a measurable result, asks for a
 * 15-min look. ~140 words.
 *
 * The English + Spanish versions track each other line-by-line so the
 * Phase-2 swap to Claude can use the same structural prompt regardless
 * of locale.
 *
 * Placeholders:
 *   {first_name}           — decision-maker first name (or "there" fallback)
 *   {company_name}         — prospect.company_name
 *   {industry}             — prospect.industry (or "DTC" fallback)
 *   {evidence_quote}       — pain evidence_quote, trimmed to ≤120 chars
 *   {pain_label}           — pain_taxonomy.display_name (lowercased mid-sentence)
 *   {case_client}          — case_studies.client_name
 *   {case_metric}          — case_studies.hero_metric (en/es per locale)
 *   {sender_first_name}    — sender's first name
 *   {sender_signature}     — full signature (name, title, tenant)
 *   {deep_pitch_link_block} — optional " More context if useful: <url>" or ""
 */

export type PitchTemplate = {
  subject: (vars: TemplateVars) => string;
  /**
   * 1–2 sentence inbox preview teaser (≤150 chars).
   * Shown under the subject in Gmail/Outlook preview pane.
   * Should extend — not repeat — the subject.
   */
  previewText: (vars: TemplateVars) => string;
  /** Tier 1 — case study with measurable result. */
  body: (vars: TemplateVars) => string;
  /**
   * Tier 2 — notable client with industry match.
   * Uses relationship_description + key_result for the credibility hook.
   */
  bodyTier2: (vars: TemplateVars) => string;
  /**
   * Tier 3 / no-match body — generic capability claim + optional name-drop.
   * Used when neither Tier 1 nor Tier 2 has a relevant match.
   */
  bodyNoCase: (vars: TemplateVars) => string;
};

export type TemplateVars = {
  first_name: string;
  company_name: string;
  industry: string;
  evidence_quote: string;
  pain_label: string;
  /**
   * One-line proposed solution for this pain — no case study required.
   * Falls back to generic capability line when null.
   */
  solution_hint: string | null;
  /** Tier 1 vars */
  case_client: string;
  case_metric: string;
  /** Tier 2 vars */
  tier2_client_name: string;
  tier2_relationship: string | null;
  tier2_key_result: string | null;
  /** Tier 3 vars — up to 4 names for name-drop */
  tier3_names: string[];
  sender_first_name: string;
  sender_signature: string;
  deep_pitch_link_block: string;
};

const EN: PitchTemplate = {
  subject: ({ company_name, pain_label, evidence_quote }) => {
    // Evidence-first: tease the observation if we have one (creates curiosity gap).
    // Falls back to pain-specific subject lines by category.
    if (evidence_quote) {
      return `Checked ${company_name} — noticed something`;
    }
    const pl = pain_label.toLowerCase();
    if (pl.includes("cart") || pl.includes("abandon"))
      return `${company_name}'s cart abandonment`;
    if (pl.includes("email") || pl.includes("retention"))
      return `quick thought on ${company_name}'s email`;
    if (pl.includes("paid") || pl.includes("roas") || pl.includes("ads"))
      return `${company_name}'s paid media — one gap`;
    if (pl.includes("mobile") || pl.includes("conversion"))
      return `${company_name}'s mobile checkout`;
    if (pl.includes("social") || pl.includes("content") || pl.includes("engagement"))
      return `${company_name}'s social presence`;
    if (pl.includes("website") || pl.includes("web") || pl.includes("ecommerce"))
      return `${company_name}.com — one thing I'd change`;
    if (pl.includes("brand"))
      return `quick thought on ${company_name}'s brand`;
    return `quick thought on ${lowercaseFirst(pain_label)} at ${company_name}`;
  },
  previewText: ({ company_name, pain_label, evidence_quote, solution_hint }) => {
    if (evidence_quote) {
      const trimmed = evidence_quote.length > 80
        ? evidence_quote.slice(0, 77) + "..."
        : evidence_quote;
      return `${trimmed} — here's the fix.`;
    }
    const hint = solution_hint
      ? `${(solution_hint.split("—")[0] ?? solution_hint).trim().slice(0, 60)}...`
      : null;
    return hint
      ? `Most ${company_name}-stage brands fix ${lowercaseFirst(pain_label)} with ${hint}`
      : `There's a specific fix for ${lowercaseFirst(pain_label)} — takes 5 min to walk through.`;
  },
  body: (v) => {
    const solution = v.solution_hint ?? `diagnosing the exact pattern and shipping a fix built for ${v.industry} brands`;
    return `Hi ${v.first_name},

${v.evidence_quote ? `Checked ${v.company_name} — ${v.evidence_quote.endsWith(".") ? v.evidence_quote : v.evidence_quote + "."}` : `Most ${v.industry} brands at your stage hit a wall on ${lowercaseFirst(v.pain_label)}.`}

The fix here: ${solution}.

We did this for ${v.case_client} (${v.case_metric}) — same profile as yours.

I can send a 5-min Loom walking through exactly what I'd change — no call, no commitment.${v.deep_pitch_link_block}

— ${v.sender_first_name}
${v.sender_signature}`;
  },
  bodyTier2: (v) => {
    const solution = v.solution_hint ?? `diagnosing the specific pattern and shipping a fix built for ${v.industry}`;
    const relationship = v.tier2_relationship ?? "a long-standing partnership";
    const result = v.tier2_key_result ? ` (${v.tier2_key_result})` : "";
    return `Hi ${v.first_name},

${v.evidence_quote ? `Checked ${v.company_name} — ${v.evidence_quote.endsWith(".") ? v.evidence_quote : v.evidence_quote + "."}` : `Most ${v.industry} brands at your stage struggle with ${lowercaseFirst(v.pain_label)}.`}

The fix here: ${solution}.

We've done similar work with ${v.tier2_client_name}${result} through ${relationship} — your situation has the same fingerprints.

I can send a 5-min Loom walking through exactly what I'd change — no call, no commitment.${v.deep_pitch_link_block}

— ${v.sender_first_name}
${v.sender_signature}`;
  },
  bodyNoCase: (v) => {
    const solution = v.solution_hint ?? `diagnosing the specific pattern and building the fix — email flows, paid social, UX, or AI automation depending on where the biggest lever is`;
    return `Hi ${v.first_name},

${v.evidence_quote ? `Checked ${v.company_name} — ${v.evidence_quote.endsWith(".") ? v.evidence_quote : v.evidence_quote + "."}` : `Most ${v.industry} brands at your stage hit a wall on ${lowercaseFirst(v.pain_label)}.`}

The fix here: ${solution}.

This is exactly the kind of work we do — and we've applied it across DTC, professional services, and ${v.industry} specifically.

I can send a 5-min Loom walking through exactly what I'd build for you — no call, no commitment.${v.deep_pitch_link_block}

— ${v.sender_first_name}
${v.sender_signature}`;
  },
};

const ES: PitchTemplate = {
  subject: ({ company_name, pain_label, evidence_quote }) => {
    if (evidence_quote) {
      return `Revisé ${company_name} — encontré algo`;
    }
    const pl = pain_label.toLowerCase();
    if (pl.includes("carrito") || pl.includes("abandon"))
      return `el carrito de ${company_name}`;
    if (pl.includes("email") || pl.includes("retención"))
      return `una idea sobre el email de ${company_name}`;
    if (pl.includes("pagado") || pl.includes("roas") || pl.includes("anunc"))
      return `${company_name} — una brecha en paid media`;
    if (pl.includes("móvil") || pl.includes("conversión"))
      return `el checkout móvil de ${company_name}`;
    if (pl.includes("social") || pl.includes("contenido") || pl.includes("engagement"))
      return `la presencia social de ${company_name}`;
    if (pl.includes("sitio") || pl.includes("web") || pl.includes("ecommerce"))
      return `${company_name}.com — algo que cambiaría`;
    if (pl.includes("marca"))
      return `una idea sobre la marca de ${company_name}`;
    return `una idea sobre ${lowercaseFirst(pain_label)} en ${company_name}`;
  },
  previewText: ({ company_name, pain_label, evidence_quote, solution_hint }) => {
    if (evidence_quote) {
      const trimmed = evidence_quote.length > 80
        ? evidence_quote.slice(0, 77) + "..."
        : evidence_quote;
      return `${trimmed} — aquí está el fix.`;
    }
    const hint = solution_hint
      ? `${(solution_hint.split("—")[0] ?? solution_hint).trim().slice(0, 60)}...`
      : null;
    return hint
      ? `La mayoría de marcas como ${company_name} resuelven ${lowercaseFirst(pain_label)} con ${hint}`
      : `Hay un fix específico para ${lowercaseFirst(pain_label)} — te lo explico en 5 min.`;
  },
  body: (v) => {
    const solution = v.solution_hint ?? `diagnosticar el patrón exacto y construir el fix adecuado para marcas ${v.industry}`;
    return `Hola ${v.first_name},

${v.evidence_quote ? `Revisé ${v.company_name} — ${v.evidence_quote.endsWith(".") ? v.evidence_quote : v.evidence_quote + "."}` : `La mayoría de marcas ${v.industry} a tu escala chocan con ${lowercaseFirst(v.pain_label)}.`}

El fix aquí: ${solution}.

Lo hicimos para ${v.case_client} (${v.case_metric}) — perfil muy similar al tuyo.

Te mando un video de 5 min mostrándote exactamente qué cambiaríamos — sin compromiso, sin llamada.${v.deep_pitch_link_block}

— ${v.sender_first_name}
${v.sender_signature}`;
  },
  bodyTier2: (v) => {
    const solution = v.solution_hint ?? `diagnosticar el patrón específico y construir el fix para tu tipo de negocio`;
    const relationship = v.tier2_relationship ?? "una relación de largo plazo";
    const result = v.tier2_key_result ? ` (${v.tier2_key_result})` : "";
    return `Hola ${v.first_name},

${v.evidence_quote ? `Revisé ${v.company_name} — ${v.evidence_quote.endsWith(".") ? v.evidence_quote : v.evidence_quote + "."}` : `La mayoría de marcas ${v.industry} a tu escala chocan con ${lowercaseFirst(v.pain_label)}.`}

El fix aquí: ${solution}.

Hicimos trabajo similar con ${v.tier2_client_name}${result} en ${relationship} — lo que vemos en tu caso tiene la misma forma.

Te mando un video de 5 min mostrándote exactamente qué cambiaríamos — sin compromiso, sin llamada.${v.deep_pitch_link_block}

— ${v.sender_first_name}
${v.sender_signature}`;
  },
  bodyNoCase: (v) => {
    const solution = v.solution_hint ?? `diagnosticar el patrón específico y construir el fix — flujos de email, paid social, UX o automatización con IA según dónde esté la palanca más grande`;
    return `Hola ${v.first_name},

${v.evidence_quote ? `Revisé ${v.company_name} — ${v.evidence_quote.endsWith(".") ? v.evidence_quote : v.evidence_quote + "."}` : `La mayoría de marcas ${v.industry} a tu escala chocan con ${lowercaseFirst(v.pain_label)}.`}

El fix aquí: ${solution}.

Este es exactamente el tipo de trabajo que hacemos — lo hemos aplicado en DTC, servicios profesionales y marcas ${v.industry} en México y Canadá.

Te mando un video de 5 min mostrándote exactamente qué construiríamos para ti — sin compromiso, sin llamada.${v.deep_pitch_link_block}

— ${v.sender_first_name}
${v.sender_signature}`;
  },
};

export function getTemplate(language: "en" | "es"): PitchTemplate {
  return language === "es" ? ES : EN;
}

function lowercaseFirst(s: string): string {
  if (!s) return s;
  return s.charAt(0).toLowerCase() + s.slice(1);
}
