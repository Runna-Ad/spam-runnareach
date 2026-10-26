/**
 * The one rule for "which given name does the greeting use when the contact
 * row has no name": read it from the e-mail local part. The composer greets
 * with it (claude-composer.ts firstNameGuess), the critic is shown it
 * (review.ts) and the exemplar scrubber blanks it (exemplars.ts), so all must
 * agree: greetingName is the whole rule, emailGreetingName its address half,
 * isRoleInbox its "this address is a department, not a person" half. Pure.
 */

// Generic inbox local-parts that are NOT a person's name — never greet these.
// Department words since writer-honesty (2026-10-26): the calibration study
// found "Hi Meng" (a program inbox), "Hi Liaisons team" and "Hi admissions and
// registry team" on inboxes the contact row did not flag as role-based.
export const GENERIC_LOCALS = new Set([
  "info", "contacto", "contact", "ventas", "sales", "hola", "hello", "hi",
  "admin", "soporte", "support", "ayuda", "help", "gerencia", "direccion",
  "recepcion", "reception", "webmaster", "noreply", "no-reply", "mail",
  "correo", "citas", "office", "general", "team", "equipo",
  // Departments and functions.
  "library", "registry", "registrar", "admissions", "admission", "international",
  "internationales", "internacional", "communications", "comms", "customersupport",
  "customerservice", "customer", "service", "services", "servicio", "assistance",
  "informes", "informacion", "reservaciones", "reservations", "reservas", "booking",
  "bookings", "liaisons", "liaison", "ceo", "reginfo", "enquiries", "inquiries",
  "marketing", "media", "press", "prensa", "events", "eventos", "hr", "rh", "jobs",
  "careers", "empleo", "billing", "accounts", "facturacion", "orders", "pedidos",
  "store", "shop", "tienda", "studio", "clinic", "clinica", "dental", "front",
  "frontdesk", "desk", "hotel", "spa", "program", "programs", "dept", "department",
  "students", "student", "alumni", "staff", "operations", "ops", "manager", "owner",
  "director", "president", "presidente", "it", "tech", "web", "news", "newsletter",
]);

// Department words long enough to recognise inside a run-together local part
// ("ucwlibrary@", "intlcommunications@"). Short ones (info, hr) are not here:
// as substrings they hide inside real names.
const DEPARTMENT_INFIXES = [
  "library", "registry", "registrar", "admission", "international", "internacional",
  "communications", "customersupport", "customerservice", "assistance", "informes",
  "reservaciones", "reservations", "liaison", "enquiries", "inquiries", "reception",
  "recepcion", "marketing", "frontdesk", "support", "soporte",
];

/** Lower case, accents off, letters only. */
function letters(s: string): string {
  return s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^a-zñ]/g, "");
}

function localParts(email: string): { local: string; segments: string[]; compact: string; domainLabel: string } {
  const [rawLocal = "", rawDomain = ""] = email.trim().toLowerCase().split("@");
  const local = rawLocal.split("+")[0] ?? "";
  const segments = local.split(/[._\-+]/).filter(Boolean);
  const host = rawDomain.replace(/^www\./, "");
  return { local, segments, compact: letters(local), domainLabel: letters(host.split(".")[0] ?? "") };
}

/**
 * The address names a department or function, not a person (reginfo@,
 * ucwlibrary@, manus-sales@, or.international@, ceo@). Independent of the
 * contact row's email_is_role_based flag, which research sets and which
 * misses department inboxes; callers OR the two.
 */
export function isRoleInbox(email: string | null | undefined): boolean {
  if (!email || !email.includes("@")) return false;
  const { segments, compact } = localParts(email);
  if (!compact) return true;
  if (GENERIC_LOCALS.has(compact)) return true;
  if (segments.some((s) => GENERIC_LOCALS.has(letters(s)))) return true;
  return DEPARTMENT_INFIXES.some((w) => compact.includes(w));
}

/**
 * Best-effort first name to greet. Prefers the contact's full_name (its first
 * token, when it is a word of 2+ letters: "P. Parker" greets no one);
 * otherwise infers from the email local-part when it cleanly reads as a given
 * name (miguel@ → "Miguel"), but never for role inboxes (info@, ventas@,
 * reginfo@) or when the contact is role-based. Returns null when there's no
 * confident name. `companyName`: a guess that is the company's own name
 * (ecof@ at ECOF Cabinets) is not a person.
 */
export function greetingName(
  fullName: string | null,
  email: string | null,
  roleBased: boolean,
  companyName?: string | null,
): string | null {
  const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
  if (fullName && fullName.trim()) {
    const tok = fullName.trim().split(/\s+/)[0] ?? "";
    if (/^\p{L}[\p{L}'’-]*\p{L}$/u.test(tok)) return cap(tok);
  }
  if (roleBased || isRoleInbox(email)) return null;
  return emailGreetingName(email, companyName);
}

/**
 * The given name an e-mail local part cleanly reads as (miguel@ → "Miguel"),
 * or null for role inboxes and ambiguous shapes. The caller decides whether
 * the contact is role-based.
 */
export function emailGreetingName(email: string | null | undefined, companyName?: string | null): string | null {
  if (!email) return null;
  const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
  const { segments, domainLabel } = localParts(email);
  const seg = segments[0] ?? "";
  if (!(seg.length >= 3 && /^[a-zñáéíóúü]+$/.test(seg))) return null;
  // Any generic part rules the whole address out: manus-sales@ is the sales
  // inbox, not Manus.
  if (segments.some((s) => GENERIC_LOCALS.has(letters(s)))) return null;
  // The company's own name or its domain is not a person: ecof@ecofcabinets.ca.
  const folded = letters(seg);
  const company = letters(companyName ?? "");
  if (domainLabel.includes(folded) || (company && company.includes(folded))) return null;

  // With an explicit separator the first segment is reliably the given name
  // (john.sipos -> John, ana.lopez -> Ana).
  if (segments.length > 1) return cap(seg);

  // WITHOUT a separator the local-part is ambiguous, and the common law-firm /
  // professional shape is initial(s)+surname: vfournier = V. Fournier,
  // rgjulien = R.G. Julien, calgauthier = Cal Gauthier. Greeting those as
  // "Hi Vfournier," / "Hi Calgauthier," reads as a bot and already cost a real
  // lead. Only accept a short token that can only plausibly BE a given name
  // (miguel, carmen, ana, pedro); anything longer greets the company instead.
  // Losing "alexandra@" to the team greeting is far cheaper than one "Hi Vfournier,".
  return seg.length <= 6 ? cap(seg) : null;
}
