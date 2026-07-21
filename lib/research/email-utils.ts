/**
 * Role-based ("generic") inbox detector. Drives:
 *  - contact priority (a personal address always outranks a role inbox)
 *  - the pitch's "if you're not the right person, please forward" line
 *
 * Matches the local-part (before @) against a list of role tokens — exact,
 * separator-normalized ("customer.service" → "customerservice"), and
 * separator-prefixed ("info.calgary@", "ventas-mx@", "contact_us@"). Covers
 * EN + ES (the MX market uses ventas@, contacto@, informacion@, etc.).
 */

const ROLE_LOCALPARTS: readonly string[] = [
  // English
  "info", "hello", "hi", "hey", "contact", "contactus", "enquiry", "enquiries",
  "inquiry", "inquiries", "sales", "support", "help", "helpdesk", "service",
  "services", "customerservice", "customercare", "admin", "administrator",
  "team", "office", "general", "reception", "frontdesk", "mail", "email",
  "webmaster", "postmaster", "marketing", "press", "media", "pr", "billing",
  "accounts", "accounting", "accountspayable", "noreply", "donotreply", "hr",
  "careers", "jobs", "legal", "privacy", "abuse", "feedback", "bookings",
  "booking", "reservations", "reservation", "orders", "order", "shop", "store",
  "newsletter", "subscribe", "hola",
  // Spanish (MX / LATAM market)
  "ventas", "contacto", "informacion", "información", "atencion", "atención",
  "atencionalcliente", "soporte", "ayuda", "administracion", "administración",
  "facturacion", "facturación", "pedidos", "reservas", "prensa", "mercadotecnia",
  "recursoshumanos", "rh", "cobranza", "compras",
];

// Placeholder addresses that look like contacts but can't be pitched. Old
// scraper data may still hold these (insert-time validation rejects them now).
// Exported so the scraper validates against the same lists (they drifted apart
// once already — filler@godaddy.com got scraped, pitched, and bounced).
export const PLACEHOLDER_DOMAINS = new Set([
  "domain.com", "example.com", "example.org", "example.net", "yourdomain.com",
  "email.com", "test.com", "sample.com", "company.com", "yourcompany.com",
  "acme.com", "mail.com", "site.com",
  // Website-builder template defaults. GoDaddy's site builder ships pages with
  // filler@godaddy.com baked in — it's the builder's placeholder, never a contact.
  "godaddy.com", "secureserver.net", "wixsite.com", "squarespace.com",
  "weebly.com", "webador.com", "jimdo.com",
  // Spanish / MX placeholders ("ejemplo" = "example", "tu/mi empresa" = "your/my company").
  "ejemplo.com", "ejemplo.org", "ejemplo.net", "ejemplo.mx", "ejemplo.es",
  "ejemplo.com.mx", "tuempresa.com", "tu-empresa.com", "miempresa.com",
  "empresa.com", "dominio.com", "sitio.com", "correo.com", "prueba.com",
  "nombre.com",
]);
export const PLACEHOLDER_LOCALS = new Set([
  "user", "example", "test", "youremail", "yourname", "name", "firstname",
  "lastname", "email", "username", "your", "filler", "placeholder",
  // Spanish placeholders.
  "ejemplo", "correo", "tunombre", "tucorreo", "nombre", "prueba", "usuario",
]);

// TLD allowlist. Scraped page text glues words onto email domains
// ("filler@godaddy.comreservaciones…" from run-together markup) and the glued
// result still matches a naive email regex. Requiring the final label to be a
// real TLD rejects those. Covers every TLD plausible for CA/MX/US SMB
// prospects; an exotic-TLD contact lost is cheaper than a bounce on a warmed
// sending domain.
const VALID_TLDS = new Set([
  // Generic
  "com", "net", "org", "info", "biz", "co", "io", "me", "app", "dev", "ai",
  "tech", "online", "site", "website", "shop", "store", "boutique", "agency",
  "studio", "digital", "design", "media", "group", "company", "solutions",
  "services", "consulting", "law", "legal", "clinic", "dental", "health",
  "fitness", "fit", "yoga", "salon", "beauty", "restaurant", "cafe", "bar",
  "pizza", "kitchen", "travel", "tours", "rentals", "realty", "properties",
  "homes", "construction", "builders", "plumbing", "repair", "auto", "cars",
  "vet", "pet", "dog", "photography", "gallery", "events", "email", "cloud",
  "xyz", "pro", "world", "life", "live", "today", "now", "club", "team",
  // Country codes relevant to our markets + common others
  "ca", "mx", "us", "es", "uk", "au", "de", "fr", "it", "nl", "br", "ar",
  "cl", "pe", "ec", "uy", "gt", "cr", "pa", "do", "hn", "sv", "ni", "bo",
  "py", "ve", "cu", "eu", "ch", "at", "be", "pt", "ie", "nz", "jp", "kr",
  "cn", "in", "tv", "cc", "ws", "la", "vc",
]);

/** True when the domain's final label is a recognized TLD ("thann.com.mx" → "mx"). */
export function hasValidTld(domain: string): boolean {
  const lastLabel = domain.toLowerCase().split(".").pop() ?? "";
  return VALID_TLDS.has(lastLabel);
}

/**
 * Page-furniture words that sit immediately before an address on a contact
 * page. When the extractor loses the element boundary, the label fuses onto
 * the local-part: "Emails:" + "rgjulien@x.ca" -> "emailsrgjulien@x.ca".
 * That is well-formed, has a valid TLD and no digits — it passed every other
 * check and reached a live draft pitch.
 */
// DELIBERATELY NARROW. The root cause is fixed at extraction (the scraper now
// preserves element boundaries), so this guard only has to protect rows already
// in the DB. Singular labels are excluded because they legitimately START real
// locals — "contactenos@" and "escribenos@" are ordinary Spanish role inboxes,
// and "emailyst@" is a plausible business address. Only plural/compound label
// forms, which essentially never begin a genuine local-part, are listed.
const GLUED_LABEL_PREFIXES = ["emails", "correos", "telefono", "telephone", "direccion"];

/**
 * True when the local-part is a contact-page label fused onto a real address
 * ("Emails:" + "rgjulien@…" -> "emailsrgjulien@…"). Requires a substantial
 * remainder (≥4 chars) so a label that merely shares a prefix with a real
 * local isn't rejected.
 */
export function hasGluedLabelPrefix(local: string): boolean {
  const l = local.toLowerCase();
  return GLUED_LABEL_PREFIXES.some((p) => {
    if (!l.startsWith(p)) return false;
    const rest = l.slice(p.length).replace(/^[.\-_]+/, "");
    return rest.length >= 4 && /^[a-z]/.test(rest);
  });
}

/**
 * True when the local-part begins with the address's OWN domain — the
 * signature of a site printing its domain immediately before an email, which
 * the extractor then swallows as one token:
 *
 *   "julien-cormier.ca" + "vfournier@julien-cormier.ca"
 *     → julien-cormier.cavfournier@julien-cormier.ca
 *
 * A legitimate local-part never starts with its own full domain (including the
 * TLD), so this is safe. Caught late: such an address passes the TLD, digit and
 * placeholder checks and would otherwise be emailed.
 */
export function hasGluedDomainPrefix(local: string, domain: string): boolean {
  const l = local.toLowerCase();
  const d = domain.toLowerCase().replace(/^www\./, "");
  return d.length > 0 && l.startsWith(d) && l.length > d.length;
}

/**
 * Repair the glue above by removing the leading domain, but ONLY when what
 * remains is a plausible local-part. Returns null when it can't be repaired
 * confidently — callers must then drop the address rather than guess.
 */
export function repairGluedDomainPrefix(email: string): string | null {
  const at = email.lastIndexOf("@");
  if (at <= 0) return null;
  const local = email.slice(0, at);
  const domain = email.slice(at + 1);
  if (!hasGluedDomainPrefix(local, domain)) return null;
  const d = domain.toLowerCase().replace(/^www\./, "");
  const rest = local.slice(d.length).replace(/^[._-]+/, "");
  if (rest.length < 2 || !/^[a-z0-9._%+-]+$/i.test(rest)) return null;
  return `${rest}@${domain}`;
}

/**
 * True when the local-part starts with a glued digit run (≥5 digits directly
 * followed by letters) — the signature of a postal code (MX/US = 5 digits) or
 * phone number fused onto a real address by messy page markup ("66220store@…"
 * from "CP 66220 store@…"). Shorter runs stay usable: "24hourplumbing@" and
 * "1800flowers@"-style brand locals are real.
 */
export function hasGluedDigitPrefix(local: string): boolean {
  const m = local.match(/^(\d{5,})[a-z]/i);
  return m !== null;
}

/**
 * A contact email we can actually send to: present, well-formed, and not an
 * obvious placeholder. The single source of truth for "does this prospect have
 * a real contact?" — used by the no-contact badge, the pitch gate, and bulk
 * generation so they never disagree. (A role-based info@ IS usable — it sends
 * with the forwarding ask; that's isRoleBasedEmail's job, not this one.)
 */
/**
 * The ONE rule for "which contact does this pitch address?".
 *
 * Must agree with pickTopUsableContact (the send path): contacts arrive
 * ordered by priority_rank, so the first with a usable email IS the recipient.
 *
 * Every composer previously had its own copy of this choice, preferring "the
 * first non-role contact that happens to have a full_name" — which on a
 * prospect with several contacts greeted a DIFFERENT person than the email was
 * sent to (a real pitch went to john.sipos@waglaw.net opening "Hi Mark,").
 * Keep this as the single source of truth; do not re-derive it inline.
 */
export function pickAddressContact<T extends { email: string | null }>(
  contacts: T[],
): T | null {
  return contacts.find((c) => hasUsableEmail(c.email)) ?? contacts[0] ?? null;
}

export function hasUsableEmail(email: string | null | undefined): boolean {
  if (!email) return false;
  const e = email.trim().toLowerCase();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(e)) return false;
  const [local, domain] = e.split("@");
  if (!local || !domain) return false;
  if (PLACEHOLDER_DOMAINS.has(domain)) return false;
  if (PLACEHOLDER_LOCALS.has(local)) return false;
  // Glued-text artifacts from scraped pages. This gate runs at insert time
  // AND in every send path (manual send, drip cron, follow-up cron), so junk
  // contacts already sitting in the DB can never be emailed.
  if (!hasValidTld(domain)) return false;
  if (hasGluedDigitPrefix(local)) return false;
  // The site's own domain glued onto the front of the address. Rejected here
  // too, so legacy rows already in the DB can never be emailed.
  if (hasGluedDomainPrefix(local, domain)) return false;
  // A contact-page label fused onto the address ("Emails:" + rgjulien@…).
  if (hasGluedLabelPrefix(local)) return false;
  return true;
}

export function isRoleBasedEmail(email: string): boolean {
  const raw = (email.split("@")[0] ?? "").trim().toLowerCase().split("+")[0] ?? "";
  if (!raw) return true; // no local part at all → treat as non-personal
  // Separator-normalized form: "customer.service"/"customer-service" → "customerservice".
  const compact = raw.replace(/[._-]/g, "");
  if (ROLE_LOCALPARTS.includes(raw) || ROLE_LOCALPARTS.includes(compact)) return true;
  // Separator-prefixed role inbox: "info.calgary@", "ventas-mx@", "contact_us@".
  for (const role of ROLE_LOCALPARTS) {
    if (raw.startsWith(`${role}.`) || raw.startsWith(`${role}-`) || raw.startsWith(`${role}_`)) {
      return true;
    }
  }
  return false;
}
