/**
 * lib/pitches/followup-templates.ts
 *
 * Deterministic follow-up emails — the fallback when the AI follow-up composer
 * fails or the daily cap is hit. Steps 2 and 3 reply in the original thread
 * (Re: [subject]).
 *
 * Sequence:
 *   Step 1 — initial pitch          (send-queue / send-action)
 *   Step 2 — soft check-in          (follow_up_step = 1, day ~3)
 *   Step 3 — final + coffee offer   (follow_up_step = 2, day ~8)
 *
 * Both languages, signed by the per-language sender (lib/pitches/sender-identity),
 * no em dashes (the pitch voice bans them), no numbers (nothing here is sourced).
 * These used to be English-only and signed "— Pedro", so a Spanish prospect got
 * English whenever the AI composer failed.
 */

export type FollowupContext = {
  /** Company name (e.g. "Tienda Norte") */
  prospectName: string;
  /** Contact first name if known — otherwise the greeting addresses the team. */
  contactName: string | null;
  /** Subject line from the original pitch — used to form "Re: [subject]" */
  originalSubject: string;
  /** Short pain label, e.g. "online booking" — a noun phrase, never a raw quote. */
  painLabel: string | null;
  lang: "en" | "es";
  /** Sign-off block, e.g. "Henry\nRunna Advertising". */
  signature: string;
};

export type FollowupEmail = {
  subject: string;
  body: string;
};

// ── Helpers ──────────────────────────────────────────────────────────────────

function greeting(ctx: FollowupContext): string {
  if (ctx.lang === "es") return ctx.contactName ? `Hola ${ctx.contactName}` : `Hola, equipo de ${ctx.prospectName}`;
  return ctx.contactName ? `Hi ${ctx.contactName}` : `Hi ${ctx.prospectName} team`;
}

function reSubject(originalSubject: string): string {
  // Avoid double "Re:" if the subject already starts with it
  if (originalSubject.trim().toLowerCase().startsWith("re:")) {
    return originalSubject.trim();
  }
  return `Re: ${originalSubject.trim()}`;
}

// ── Follow-up #1 — Soft check-in (day ~3) ───────────────────────────────────

/** Step 2 (follow_up_step = 1): short, human, no pressure. */
export function buildFollowup1(ctx: FollowupContext): FollowupEmail {
  const subject = reSubject(ctx.originalSubject);
  const es = ctx.lang === "es";
  const hook = es
    ? ctx.painLabel
      ? `Solo quería asegurarme de que mi correo sobre ${ctx.painLabel} en ${ctx.prospectName} no se perdiera.`
      : `Solo quería asegurarme de que mi correo sobre ${ctx.prospectName} no se perdiera.`
    : ctx.painLabel
      ? `Just making sure my note about ${ctx.painLabel} at ${ctx.prospectName} didn't get buried.`
      : `Just making sure my note about ${ctx.prospectName} didn't get buried.`;
  const ask = es ? "¿Vale la pena una llamada de 20 minutos?" : "Worth a 20-minute chat?";
  return { subject, body: `${greeting(ctx)},\n\n${hook}\n\n${ask}\n\n${ctx.signature}` };
}

// ── Follow-up #2 — Final + coffee offer (day ~8) ────────────────────────────

/** Step 3 (follow_up_step = 2): the last touch, and it says so. */
export function buildFollowup2(ctx: FollowupContext): FollowupEmail {
  const subject = reSubject(ctx.originalSubject);
  const es = ctx.lang === "es";
  const intro = es
    ? ctx.painLabel
      ? `Cuando revisamos ${ctx.prospectName}, vimos un hueco en ${ctx.painLabel}, de esos que cuestan ventas cada mes sin que se note.`
      : `Cuando revisamos ${ctx.prospectName}, encontramos un par de cosas que creo valen 20 minutos.`
    : ctx.painLabel
      ? `When we looked at ${ctx.prospectName}, we spotted a gap around ${ctx.painLabel}, the kind that quietly costs revenue every month.`
      : `When we looked at ${ctx.prospectName}, we found a couple of things I think are worth 20 minutes.`;
  const body = es
    ? `${greeting(ctx)},\n\nÚltimo correo, lo prometo.\n\n${intro}\n\nSi la llamada no te sirve, el café va por mi cuenta. Después de esto no te escribo más.\n\n${ctx.signature}`
    : `${greeting(ctx)},\n\nLast note, I promise.\n\n${intro}\n\nIf the call isn't worth your time, coffee's on me. After this I'll leave you alone.\n\n${ctx.signature}`;
  return { subject, body };
}
