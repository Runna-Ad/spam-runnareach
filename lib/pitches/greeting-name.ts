/**
 * The one rule for "which given name does the greeting use when the contact
 * row has no name": read it from the e-mail local part. The composer greets
 * with it (claude-composer.ts firstNameGuess) and the exemplar scrubber
 * blanks it (exemplars.ts), so both must agree. Pure.
 */

// Generic inbox local-parts that are NOT a person's name — never greet these.
export const GENERIC_LOCALS = new Set([
  "info", "contacto", "contact", "ventas", "sales", "hola", "hello", "hi",
  "admin", "soporte", "support", "ayuda", "help", "gerencia", "direccion",
  "recepcion", "reception", "webmaster", "noreply", "no-reply", "mail",
  "correo", "citas", "office", "general", "team", "equipo",
]);

/**
 * The given name an e-mail local part cleanly reads as (miguel@ → "Miguel"),
 * or null for role inboxes and ambiguous shapes. The caller decides whether
 * the contact is role-based.
 */
export function emailGreetingName(email: string | null | undefined): string | null {
  if (!email) return null;
  const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
  const local = email.split("@")[0]?.toLowerCase() ?? "";
  const segments = local.split(/[._\-+]/);
  const seg = segments[0] ?? "";
  if (!(seg.length >= 3 && /^[a-zñáéíóúü]+$/.test(seg)) || GENERIC_LOCALS.has(seg)) return null;

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
