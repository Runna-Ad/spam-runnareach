/**
 * Who a prospect-facing email is from, by the prospect's language.
 *
 * Decided by Pedro, 2026-10-16: Spanish emails are signed by Nils, English
 * emails by Henry — both real Rünna team members who read and answer the
 * replies — under the agency name "Runna Advertising". The sending ADDRESS
 * stays the connected inbox (pedro@runnareach.com); only the display name and
 * the sign-off change.
 *
 * Every composer, template and send path asks this module instead of using the
 * logged-in user's name (which made the sign-off depend on who clicked
 * "Generate") or a hard-coded "Pedro". Overridable without a deploy:
 *   RUNNA_SENDER_NAME_EN / RUNNA_SENDER_NAME_ES / RUNNA_AGENCY_NAME
 *
 * Pure — tested in tests/sender-identity.test.ts.
 */

export type SenderIdentity = {
  /** Name the email is signed with, e.g. "Henry". */
  firstName: string;
  /** Agency line under the name, e.g. "Runna Advertising". */
  agency: string;
  /** From display name, e.g. "Henry · Runna Advertising". */
  displayName: string;
};

export const SENDER_IDENTITY_DEFAULTS = {
  en: "Henry",
  es: "Nils",
  agency: "Runna Advertising",
} as const;

function env(name: string, fallback: string): string {
  return process.env[name]?.trim() || fallback;
}

export function senderIdentity(lang: string | null | undefined): SenderIdentity {
  const es = lang === "es";
  const firstName = es
    ? env("RUNNA_SENDER_NAME_ES", SENDER_IDENTITY_DEFAULTS.es)
    : env("RUNNA_SENDER_NAME_EN", SENDER_IDENTITY_DEFAULTS.en);
  const agency = env("RUNNA_AGENCY_NAME", SENDER_IDENTITY_DEFAULTS.agency);
  return { firstName, agency, displayName: `${firstName} · ${agency}` };
}

/** The `sender` block the pitch generator/composer takes (GeneratorInputSender). */
export function senderForGenerator(lang: string | null | undefined): {
  full_name: string;
  tenant_display_name: string;
} {
  const id = senderIdentity(lang);
  return { full_name: id.firstName, tenant_display_name: id.agency };
}

/** The two-line sign-off used at the bottom of every pitch. */
export function senderSignature(lang: string | null | undefined): string {
  const id = senderIdentity(lang);
  return `${id.firstName}\n${id.agency}`;
}

// A sign-off block written before the switch: "Pedro" / "— Pedro" /
// "Pedro De Velasco", optionally followed by a "Runna"/"Rünna" agency line and
// the old "runna.agency" line, at the very END of the body (the footer is
// appended after this runs, so it is never in the way).
const LEGACY_SIGN_OFF =
  /\n[ \t]*\n[ \t]*(?:[—–-][ \t]*)?Pedro(?:[ \t]+De[ \t]+Velasco)?[ \t]*(?:\n[ \t]*R[uü]nna(?:[ \t]+(?:CA|Advertising|Team))?[ \t]*)?(?:\n[ \t]*runna\.agency[ \t]*)?\s*$/i;

/**
 * Swap a legacy "Pedro" sign-off for the current per-language one, so the body
 * always matches the From line. Drafts generated before the switch (one was
 * still approved and unsent in October) would otherwise go out From
 * "Henry · Runna Advertising" signed "Pedro". Anything else is left untouched.
 */
export function reconcileSignOff(body: string, lang: string | null | undefined): string {
  if (!LEGACY_SIGN_OFF.test(body)) return body;
  return body.replace(LEGACY_SIGN_OFF, `\n\n${senderSignature(lang)}`);
}
