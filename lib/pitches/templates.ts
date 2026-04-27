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
  /** Standard body — uses {case_client} and {case_metric}. */
  body: (vars: TemplateVars) => string;
  /**
   * No-case-fit body — used when no case study clearly addresses the
   * prospect's pain. Skips the "we helped X" bridge entirely and leans
   * on a generic agency-level claim. Better than fabricating a fake fit.
   */
  bodyNoCase: (vars: TemplateVars) => string;
};

export type TemplateVars = {
  first_name: string;
  company_name: string;
  industry: string;
  evidence_quote: string;
  pain_label: string;
  case_client: string;
  case_metric: string;
  sender_first_name: string;
  sender_signature: string;
  deep_pitch_link_block: string;
};

const EN: PitchTemplate = {
  subject: ({ company_name, pain_label }) =>
    `Quick thought on ${pain_label} at ${company_name}`,
  body: (v) => `Hi ${v.first_name},

Saw "${v.evidence_quote}" — most ${v.industry} brands at your stage hit a wall on ${lowercaseFirst(v.pain_label)}.

We helped ${v.case_client} (${v.case_metric}). Same shape as what we're seeing on your end.

Worth a 15-min look next week?${v.deep_pitch_link_block}

— ${v.sender_first_name}
${v.sender_signature}`,
  bodyNoCase: (v) => `Hi ${v.first_name},

Saw "${v.evidence_quote}" — most ${v.industry} brands at your stage hit a wall on ${lowercaseFirst(v.pain_label)}.

This is the kind of work we do for ${v.industry} teams — diagnosing the specific pattern, then shipping a fix that holds up under real customer behavior.

Worth a 15-min look next week?${v.deep_pitch_link_block}

— ${v.sender_first_name}
${v.sender_signature}`,
};

const ES: PitchTemplate = {
  subject: ({ company_name, pain_label }) =>
    `Una idea sobre ${lowercaseFirst(pain_label)} en ${company_name}`,
  body: (v) => `Hola ${v.first_name},

Vi "${v.evidence_quote}" — la mayoría de marcas ${v.industry} a tu escala chocan con ${lowercaseFirst(v.pain_label)}.

Trabajamos con ${v.case_client} (${v.case_metric}). Misma forma que lo que vemos en su caso.

¿Vale la pena una llamada de 15 min la próxima semana?${v.deep_pitch_link_block}

— ${v.sender_first_name}
${v.sender_signature}`,
  bodyNoCase: (v) => `Hola ${v.first_name},

Vi "${v.evidence_quote}" — la mayoría de marcas ${v.industry} a tu escala chocan con ${lowercaseFirst(v.pain_label)}.

Este es el tipo de trabajo que hacemos para equipos ${v.industry} — diagnosticando el patrón específico y enviando un fix que aguante bajo comportamiento real de clientes.

¿Vale la pena una llamada de 15 min la próxima semana?${v.deep_pitch_link_block}

— ${v.sender_first_name}
${v.sender_signature}`,
};

export function getTemplate(language: "en" | "es"): PitchTemplate {
  return language === "es" ? ES : EN;
}

function lowercaseFirst(s: string): string {
  if (!s) return s;
  return s.charAt(0).toLowerCase() + s.slice(1);
}
