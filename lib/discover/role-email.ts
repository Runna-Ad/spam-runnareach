/**
 * Role-based email detection.
 *
 * Outreach to `info@`, `sales@`, `hello@` etc. correlates with low reply
 * rates and elevated spam reports — they're typically shared inboxes
 * routed to a queue, not a person. Per the plan we DON'T block these
 * but we mark them so the pitch generator can downrank or re-route.
 *
 * These are case-insensitive and match the LOCAL part only — `info@runna.agency`
 * is a role email; `info-pedro@runna.agency` is not.
 */
const ROLE_LOCAL_PARTS = new Set<string>([
  "info",
  "hello",
  "hi",
  "contact",
  "support",
  "help",
  "sales",
  "marketing",
  "team",
  "office",
  "admin",
  "noreply",
  "no-reply",
  "donotreply",
  "press",
  "media",
  "billing",
  "accounts",
  "accounting",
  "careers",
  "jobs",
  "recruiting",
  "hr",
  "legal",
  "general",
  "main",
  "reception",
  "enquiries",
  "inquiries",
]);

export function isRoleEmail(email: string): boolean {
  const trimmed = email.trim().toLowerCase();
  const at = trimmed.indexOf("@");
  if (at <= 0) return false;
  const local = trimmed.slice(0, at);
  return ROLE_LOCAL_PARTS.has(local);
}

/** Extract the lowercased domain from an email, or null if malformed. */
export function emailDomain(email: string): string | null {
  const trimmed = email.trim().toLowerCase();
  const at = trimmed.indexOf("@");
  if (at <= 0 || at === trimmed.length - 1) return null;
  const domain = trimmed.slice(at + 1);
  return /^[a-z0-9.-]+\.[a-z]{2,}$/.test(domain) ? domain : null;
}
