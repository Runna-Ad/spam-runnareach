/**
 * lib/pitches/followup-templates.ts
 *
 * Follow-up email templates for the 3-step outreach sequence.
 * No AI generation — hand-crafted with variable substitution.
 * Steps 2 and 3 reply in the original thread (Re: [subject]).
 *
 * Sequence:
 *   Step 1 — initial pitch          (handled by send-action.ts)
 *   Step 2 — soft check-in          (follow_up_step = 1, day ~3-4)
 *   Step 3 — final + coffee offer   (follow_up_step = 2, day ~8-9)
 */

export type FollowupContext = {
  /** Company name (e.g. "Tienda Norte") */
  prospectName: string;
  /** Contact first name if known — falls back to company name salutation */
  contactName: string | null;
  /** Subject line from the original pitch — used to form "Re: [subject]" */
  originalSubject: string;
  /** One-line pain from original pitch notes, e.g. "abandoned cart recovery gaps" */
  painSummary: string | null;
  /** Dollar/peso amount found in hunter scan. null if not available. */
  hunterValue: number | null;
  /** Determines currency label: CAD for CA, MXN for MX */
  market: "CA" | "MX";
};

export type FollowupEmail = {
  subject: string;
  body: string;
};

// ── Helpers ──────────────────────────────────────────────────────────────────

function greeting(ctx: FollowupContext): string {
  return ctx.contactName ? `Hi ${ctx.contactName}` : `Hi there`;
}

function currencyLabel(market: "CA" | "MX"): string {
  return market === "CA" ? "CAD" : "MXN";
}

function formatValue(value: number, market: "CA" | "MX"): string {
  const currency = currencyLabel(market);
  const formatted = new Intl.NumberFormat("en-US", {
    style: "decimal",
    maximumFractionDigits: 0,
  }).format(value);
  return `$${formatted} ${currency}`;
}

function reSubject(originalSubject: string): string {
  // Avoid double "Re:" if the subject already starts with it
  if (originalSubject.trim().toLowerCase().startsWith("re:")) {
    return originalSubject.trim();
  }
  return `Re: ${originalSubject.trim()}`;
}

// ── Follow-up #1 — Soft check-in (day ~3-4) ─────────────────────────────────

/**
 * Step 2 of the sequence (follow_up_step = 1).
 * Short, human, no pressure. References the specific pain or dollar amount if
 * available — makes it feel like you actually looked at their business.
 */
export function buildFollowup1(ctx: FollowupContext): FollowupEmail {
  const hi = greeting(ctx);
  const subject = reSubject(ctx.originalSubject);

  let valueHook = "";
  if (ctx.hunterValue !== null) {
    // hunterValue is currently always null (scan provenance can't be verified —
    // asserting "we found $X" would fabricate an audit we never ran). Kept as a
    // soft reference in case a verified per-prospect scan ever exists.
    valueHook = `The quick self-serve audit for ${ctx.prospectName} pointed at roughly ${formatValue(ctx.hunterValue, ctx.market)} in recoverable inefficiencies — wanted to make sure this landed in the right place.`;
  } else if (ctx.painSummary) {
    valueHook = `Wanted to make sure my note about ${ctx.painSummary} at ${ctx.prospectName} didn't get buried.`;
  } else {
    valueHook = `Wanted to make sure my note about ${ctx.prospectName} didn't get buried.`;
  }

  const body = `${hi},

${valueHook}

Still worth a 20-minute chat?

— Pedro`;

  return { subject, body };
}

// ── Follow-up #2 — Final + coffee offer (day ~8-9) ───────────────────────────

/**
 * Step 3 of the sequence (follow_up_step = 2).
 * Last touch. References the dollar amount prominently. Coffee-on-me offer.
 * Explicitly acknowledges it's the final email — no desperation, just honesty.
 */
export function buildFollowup2(ctx: FollowupContext): FollowupEmail {
  const hi = greeting(ctx);
  const subject = reSubject(ctx.originalSubject);

  let valueIntro = "";
  if (ctx.hunterValue !== null) {
    valueIntro = `The self-serve audit for ${ctx.prospectName} pointed at roughly ${formatValue(ctx.hunterValue, ctx.market)} in recoverable inefficiencies.`;
  } else if (ctx.painSummary) {
    valueIntro = `When we looked at ${ctx.prospectName} we spotted a real gap around ${ctx.painSummary} — the kind that quietly costs you revenue every month.`;
  } else {
    valueIntro = `When we looked at ${ctx.prospectName}, we found opportunities I think are worth 20 minutes of your time.`;
  }

  const body = `${hi},

Last note — I promise.

${valueIntro}

If you get on a 20-minute call and don't find it worth your time, coffee's on me. After this I'll leave you alone.

— Pedro`;

  return { subject, body };
}
