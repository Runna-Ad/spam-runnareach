/**
 * The compliance footer on every prospect-facing email.
 *
 * CASL (Canada) requires, in every commercial electronic message: who is
 * sending, a valid mailing address, one more way to reach the sender (web,
 * email or phone), and a working unsubscribe mechanism. Mexico's LFPDPPP adds a
 * link to the aviso de privacidad — shown on Spanish emails only, since the
 * notice itself is in Spanish.
 *
 * Layout (Pedro, 2026-11-09): a sign-off style first line ("Runna Advertising ·
 * Mexico · Canada · runnik.ca"), then the mailing address on its own line, then
 * the unsubscribe line. The address stays (CASL) but no longer leads the footer.
 * The website is the contact method; the contact email stands in only when no
 * website is configured, so the CASL contact requirement always holds.
 *
 * Kept short and register-neutral: the pitch body already signs off with the
 * sender's name, and the Spanish unsubscribe line is impersonal so it fits both
 * tú and usted emails. No em dashes (the pitch voice bans them).
 *
 * Pure — unit-tested in tests/compliance.test.ts.
 */

export type FooterInput = {
  lang: "en" | "es";
  /** Business name, e.g. "Runna Advertising". */
  senderEntity: string;
  /** Where we operate, shown after the name, e.g. "Mexico · Canada". */
  locations?: string | null;
  mailingAddress: string;
  /** Website shown as the contact method, e.g. "runnik.ca". */
  website?: string | null;
  /** Contact email, shown only when there is no website. */
  contactEmail?: string | null;
  unsubscribeUrl: string;
  /** Aviso de privacidad URL (Spanish emails). */
  privacyUrl?: string | null;
};

function oneLine(address: string): string {
  return address.replace(/\s*\n\s*/g, ", ").trim();
}

function clean(v: string | null | undefined): string {
  return v?.trim() ?? "";
}

export function buildComplianceFooter(input: FooterInput): string {
  const contact = clean(input.website) || clean(input.contactEmail);
  const signOff = [clean(input.senderEntity), clean(input.locations), contact].filter(Boolean).join(" · ");
  const lines = [signOff, oneLine(input.mailingAddress)];
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
  const signOff = [clean(input.senderEntity), clean(input.locations)].filter(Boolean).map(escapeHtml);
  const site = clean(input.website);
  const email = clean(input.contactEmail);
  if (site) signOff.push(link(/^https?:\/\//i.test(site) ? site : `https://${site}`, site.replace(/^https?:\/\//i, "")));
  else if (email) signOff.push(link(`mailto:${email}`, email));
  lines.push(signOff.join(" · "));
  lines.push(escapeHtml(oneLine(input.mailingAddress)));
  if (input.lang === "es") {
    lines.push(`Para dejar de recibir estos correos: ${link(input.unsubscribeUrl, "darse de baja")}`);
    if (input.privacyUrl) lines.push(link(input.privacyUrl, "Aviso de privacidad"));
  } else {
    lines.push(`To stop receiving these emails: ${link(input.unsubscribeUrl, "unsubscribe")}`);
  }
  return lines.map((l) => `<p style="margin: 0;">${l}</p>`).join("\n");
}
