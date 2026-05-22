/**
 * Cold-email pitch templates — Pedro's bar style.
 *
 * Structure: specific observation → one pain → concrete fix → one-line proof → soft ask.
 * Target: 70-100 words. Conversational. No jargon. No em dashes. No corporate speak.
 *
 * Language rules:
 *   - ES: "Hola {name}," — if no name, just "Hola," (never "Hola there,")
 *   - EN: "Hi {name}," — if no name, just "Hi,"
 *   - first_name is "" (empty string) when no contact name is available
 */

export type PitchTemplate = {
  subject: (vars: TemplateVars) => string;
  /**
   * 1-2 sentence inbox preview teaser (<=150 chars).
   * Extends the subject — never repeats it.
   */
  previewText: (vars: TemplateVars) => string;
  /** Tier 1: case study with measurable result. */
  body: (vars: TemplateVars) => string;
  /** Tier 2: notable client with industry match. */
  bodyTier2: (vars: TemplateVars) => string;
  /** Tier 3 / no match: capability claim, no name-drop. */
  bodyNoCase: (vars: TemplateVars) => string;
};

export type TemplateVars = {
  /** Contact first name, or "" if unknown. */
  first_name: string;
  company_name: string;
  industry: string;
  evidence_quote: string;
  pain_label: string;
  /**
   * One-line proposed solution for this pain.
   * Falls back to generic when null.
   */
  solution_hint: string | null;
  /** Tier 1 vars */
  case_client: string;
  case_metric: string;
  /** Tier 2 vars */
  tier2_client_name: string;
  tier2_relationship: string | null;
  tier2_key_result: string | null;
  /** Tier 3 vars */
  tier3_names: string[];
  sender_first_name: string;
  sender_signature: string;
  deep_pitch_link_block: string;
};

// ── Shared helpers ────────────────────────────────────────────────────────────

function greet(first_name: string, lang: "en" | "es"): string {
  if (first_name) return lang === "es" ? `Hola ${first_name},` : `Hi ${first_name},`;
  return lang === "es" ? "Hola," : "Hi,";
}

function opener(v: TemplateVars, lang: "en" | "es"): string {
  if (v.evidence_quote) {
    const q = v.evidence_quote.endsWith(".") ? v.evidence_quote : v.evidence_quote + ".";
    return lang === "es"
      ? `Revisé ${v.company_name} — ${q}`
      : `Checked ${v.company_name} — ${q}`;
  }
  return lang === "es"
    ? `Vi que ${v.company_name} está dejando dinero sobre la mesa con ${lowercaseFirst(v.pain_label)}.`
    : `Noticed ${v.company_name} is losing revenue to ${lowercaseFirst(v.pain_label)}.`;
}

function lowercaseFirst(s: string): string {
  if (!s) return s;
  return s.charAt(0).toLowerCase() + s.slice(1);
}

// ── English template ──────────────────────────────────────────────────────────

const EN: PitchTemplate = {
  subject: ({ company_name, pain_label, evidence_quote }) => {
    if (evidence_quote) return `checked ${company_name} — noticed something`;
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
      return `one thing i'd change on ${company_name}.com`;
    if (pl.includes("brand"))
      return `quick thought on ${company_name}'s brand`;
    return `quick thought on ${lowercaseFirst(pain_label)} at ${company_name}`;
  },

  previewText: ({ company_name, pain_label, evidence_quote, solution_hint }) => {
    if (evidence_quote) {
      const trimmed = evidence_quote.length > 80
        ? evidence_quote.slice(0, 77) + "..."
        : evidence_quote;
      return `${trimmed} Here's the fix.`;
    }
    const hint = solution_hint
      ? solution_hint.slice(0, 80).replace(/\s+\S*$/, "") + "..."
      : null;
    return hint
      ? `Most ${company_name}-stage brands fix this with ${hint}`
      : `There's a specific fix for ${lowercaseFirst(pain_label)} — takes 5 min to show you.`;
  },

  body: (v) => {
    const solution = v.solution_hint
      ?? `a targeted fix built specifically for your setup`;
    return `${greet(v.first_name, "en")}

${opener(v, "en")}

Here's what moves the needle: ${solution}.

We did this for ${v.case_client} — ${v.case_metric}. Same situation as yours.

Want me to send a 5-min video showing exactly what we'd build? No call, no commitment.${v.deep_pitch_link_block}

— ${v.sender_first_name}
${v.sender_signature}`;
  },

  bodyTier2: (v) => {
    const solution = v.solution_hint
      ?? `a targeted fix built for your stack and market`;
    const result = v.tier2_key_result ? ` (${v.tier2_key_result})` : "";
    return `${greet(v.first_name, "en")}

${opener(v, "en")}

Here's what moves the needle: ${solution}.

We've done similar work with ${v.tier2_client_name}${result} — your situation has the same shape.

Want me to send a 5-min video showing exactly what we'd build? No call, no commitment.${v.deep_pitch_link_block}

— ${v.sender_first_name}
${v.sender_signature}`;
  },

  bodyNoCase: (v) => {
    const solution = v.solution_hint
      ?? `a targeted approach built for your specific stack and market`;
    return `${greet(v.first_name, "en")}

${opener(v, "en")}

Here's what moves the needle: ${solution}.

We've solved this for brands like yours across DTC, ${v.industry} and professional services.

Want me to send a 5-min video showing exactly what we'd build? No call, no commitment.${v.deep_pitch_link_block}

— ${v.sender_first_name}
${v.sender_signature}`;
  },
};

// ── Spanish template ──────────────────────────────────────────────────────────

const ES: PitchTemplate = {
  subject: ({ company_name, pain_label, evidence_quote }) => {
    if (evidence_quote) return `revisé ${company_name} — encontré algo`;
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
      return `algo que cambiaría en ${company_name}.com`;
    if (pl.includes("marca"))
      return `una idea sobre la marca de ${company_name}`;
    return `una idea sobre ${lowercaseFirst(pain_label)} en ${company_name}`;
  },

  previewText: ({ company_name, pain_label, evidence_quote, solution_hint }) => {
    if (evidence_quote) {
      const trimmed = evidence_quote.length > 80
        ? evidence_quote.slice(0, 77) + "..."
        : evidence_quote;
      return `${trimmed} Aqui te cuento el fix.`;
    }
    const hint = solution_hint
      ? solution_hint.slice(0, 80).replace(/\s+\S*$/, "") + "..."
      : null;
    return hint
      ? `La mayoria de marcas como ${company_name} resuelven esto con ${hint}`
      : `Hay un fix especifico para ${lowercaseFirst(pain_label)} — te lo explico en 5 min.`;
  },

  body: (v) => {
    const solution = v.solution_hint
      ?? `un fix especifico para tu tipo de negocio`;
    return `${greet(v.first_name, "es")}

${opener(v, "es")}

Lo que mueve la aguja aqui: ${solution}.

Lo hicimos para ${v.case_client} — ${v.case_metric}. Mismo perfil que el tuyo.

Te mando un video de 5 min mostrándote exactamente qué construiríamos. Sin compromiso, sin llamada.${v.deep_pitch_link_block}

— ${v.sender_first_name}
${v.sender_signature}`;
  },

  bodyTier2: (v) => {
    const solution = v.solution_hint
      ?? `un fix especifico para tu negocio y mercado`;
    const result = v.tier2_key_result ? ` (${v.tier2_key_result})` : "";
    return `${greet(v.first_name, "es")}

${opener(v, "es")}

Lo que mueve la aguja aqui: ${solution}.

Hicimos algo similar con ${v.tier2_client_name}${result}. Lo que veo en tu caso tiene la misma forma.

Te mando un video de 5 min mostrándote exactamente qué construiríamos. Sin compromiso, sin llamada.${v.deep_pitch_link_block}

— ${v.sender_first_name}
${v.sender_signature}`;
  },

  bodyNoCase: (v) => {
    const solution = v.solution_hint
      ?? `un fix especifico para tu stack y mercado`;
    return `${greet(v.first_name, "es")}

${opener(v, "es")}

Lo que mueve la aguja aqui: ${solution}.

Lo hemos resuelto para marcas como la tuya en DTC, ${v.industry} y servicios profesionales en Mexico y Canada.

Te mando un video de 5 min mostrándote exactamente qué construiríamos. Sin compromiso, sin llamada.${v.deep_pitch_link_block}

— ${v.sender_first_name}
${v.sender_signature}`;
  },
};

export function getTemplate(language: "en" | "es"): PitchTemplate {
  return language === "es" ? ES : EN;
}
