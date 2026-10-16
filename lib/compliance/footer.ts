/**
 * The compliance footer on every prospect-facing email.
 *
 * CASL (Canada) requires, in every commercial electronic message: who is
 * sending, a valid mailing address, one more way to reach the sender (web,
 * email or phone), and a working unsubscribe mechanism. Mexico's LFPDPPP adds a
 * link to the aviso de privacidad — shown on Spanish emails only, since the
 * notice itself is in Spanish.
 *
 * Kept short and register-neutral: the pitch body already signs off with the
 * sender's name, and the Spanish unsubscribe line is impersonal so it fits both
 * tú and usted emails. No em dashes (the pitch voice bans them).
 *
 * Pure — unit-tested in tests/compliance.test.ts.
 */

export type FooterInput = {
  lang: "en" | "es";
  /** Business name, e.g. "Rünna". */
  senderEntity: string;
  mailingAddress: string;
  /** Website shown as the extra contact method, e.g. "runnik.ca". */
  website?: string | null;
  /** Contact email shown as the extra contact method. */
  contactEmail?: string | null;
  unsubscribeUrl: string;
  /** Aviso de privacidad URL (Spanish emails). */
  privacyUrl?: string | null;
};

export function buildComplianceFooter(input: FooterInput): string {
  const identity = `${input.senderEntity.trim()} · ${input.mailingAddress.replace(/\s*\n\s*/g, ", ").trim()}`;
  const contact = [input.website, input.contactEmail].map((v) => v?.trim()).filter(Boolean).join(" · ");
  const lines = [identity];
  if (contact) lines.push(contact);
  if (input.lang === "es") {
    lines.push(`Para dejar de recibir estos correos: ${input.unsubscribeUrl}`);
    if (input.privacyUrl) lines.push(`Aviso de privacidad: ${input.privacyUrl}`);
  } else {
    lines.push(`To stop receiving these emails: ${input.unsubscribeUrl}`);
  }
  return lines.join("\n");
}

function escapeHtml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function link(href: string, label: string): string {
  return `<a href="${escapeHtml(href)}" style="color: #8a8a8a; text-decoration: underline;">${escapeHtml(label)}</a>`;
}

/**
 * The same footer for the HTML part, where links have readable labels: the
 * reader sees "unsubscribe", not a long token URL. (The plain-text part has to
 * show the URL — text mail can't hide a link.)
 */
export function buildComplianceFooterHtml(input: FooterInput): string {
  const lines: string[] = [];
  lines.push(escapeHtml(`${input.senderEntity.trim()} · ${input.mailingAddress.replace(/\s*\n\s*/g, ", ").trim()}`));
  const contact: string[] = [];
  const site = input.website?.trim();
  if (site) contact.push(link(/^https?:\/\//i.test(site) ? site : `https://${site}`, site.replace(/^https?:\/\//i, "")));
  const email = input.contactEmail?.trim();
  if (email) contact.push(link(`mailto:${email}`, email));
  if (contact.length) lines.push(contact.join(" · "));
  if (input.lang === "es") {
    lines.push(`Para dejar de recibir estos correos: ${link(input.unsubscribeUrl, "darse de baja")}`);
    if (input.privacyUrl) lines.push(link(input.privacyUrl, "Aviso de privacidad"));
  } else {
    lines.push(`To stop receiving these emails: ${link(input.unsubscribeUrl, "unsubscribe")}`);
  }
  return lines.map((l) => `<p style="margin: 0;">${l}</p>`).join("\n");
}
