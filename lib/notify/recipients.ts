/**
 * Who hears from the platform. ONE list, used by every notification email.
 *
 *   ops   everything: breaker trips, stage changes, the veto digest, warmup
 *         alerts, the weekly report, emergency alerts (no daily report: Pedro).
 *   lead  the leads themselves (prospect replies, calendar bookings): the ops
 *         list plus the people who follow up with prospects.
 *
 * Pedro, 2026-10-18: "not just send to pedro@runnareach.com but also send a copy
 * of everything to petedv31@gmail.com ... the replies from prospects or calendar
 * bookings send those to nils@runna.com.mx as well".
 *
 * Code defaults, env overrides (comma-separated): NOTIFY_EMAILS replaces the ops
 * list, LEAD_NOTIFY_EMAILS replaces the lead extras. An override with no valid
 * address falls back to the default, so a blank variable never silences alerts.
 *
 * Pure — tested in tests/notify-recipients.test.ts.
 */

export type NotifyKind = "ops" | "lead";

export const DEFAULT_OPS_RECIPIENTS: readonly string[] = ["pedro@runnareach.com", "petedv31@gmail.com"];
export const DEFAULT_LEAD_EXTRA_RECIPIENTS: readonly string[] = ["nils@runna.com.mx"];

const EMAIL_RE = /^[^\s@<>,;"]+@[^\s@<>,;"]+\.[a-z]{2,}$/i;

/** Valid, lower-cased, de-duplicated addresses from a comma/semicolon/space list. */
export function parseEmailList(raw: string | null | undefined): string[] {
  if (!raw) return [];
  const out: string[] = [];
  for (const piece of raw.split(/[\s,;]+/)) {
    const email = piece.trim().toLowerCase();
    if (EMAIL_RE.test(email) && !out.includes(email)) out.push(email);
  }
  return out;
}

type Env = Record<string, string | undefined>;

export function notifyRecipients(kind: NotifyKind, env: Env = process.env): string[] {
  const ops = parseEmailList(env.NOTIFY_EMAILS);
  const list = ops.length > 0 ? ops : [...DEFAULT_OPS_RECIPIENTS];
  if (kind === "lead") {
    const extra = parseEmailList(env.LEAD_NOTIFY_EMAILS);
    list.push(...(extra.length > 0 ? extra : DEFAULT_LEAD_EXTRA_RECIPIENTS));
  }
  return [...new Set(list.map((e) => e.toLowerCase()))];
}
