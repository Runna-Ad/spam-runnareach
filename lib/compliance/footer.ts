/**
 * The compliance footer on every prospect-facing email.
 *
 * CASL (Canada) requires the sender's identity, a valid mailing address and a
 * working unsubscribe mechanism in every commercial electronic message. Mexico's
 * LFPDPPP adds a link to the privacy notice (aviso de privacidad) when we have one.
 *
 * Kept short and register-neutral: the pitch body already signs off with the
 * sender's name, and the Spanish line is impersonal so it fits both tú and usted
 * emails. No em dashes (the pitch voice bans them).
 *
 * Pure — unit-tested in tests/compliance.test.ts.
 */

export type FooterInput = {
  lang: "en" | "es";
  /** Business name, e.g. "Rünna". */
  senderEntity: string;
  mailingAddress: string;
  unsubscribeUrl: string;
  /** Optional aviso de privacidad / privacy policy URL. */
  privacyUrl?: string | null;
};

export function buildComplianceFooter(input: FooterInput): string {
  const identity = `${input.senderEntity.trim()} · ${input.mailingAddress.replace(/\s*\n\s*/g, ", ").trim()}`;
  if (input.lang === "es") {
    const lines = [identity, `Para dejar de recibir estos correos: ${input.unsubscribeUrl}`];
    if (input.privacyUrl) lines.push(`Aviso de privacidad: ${input.privacyUrl}`);
    return lines.join("\n");
  }
  const lines = [identity, `To stop receiving these emails: ${input.unsubscribeUrl}`];
  if (input.privacyUrl) lines.push(`Privacy: ${input.privacyUrl}`);
  return lines.join("\n");
}
