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
