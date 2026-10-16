/**
 * Everything a prospect-facing send needs to be CASL-compliant: the footer text
 * and the List-Unsubscribe target, built from configuration.
 *
 * FAILS CLOSED. Without a mailing address (or the key that signs unsubscribe
 * links) this returns an error and the caller must not send. A cold email
 * without them is a CASL violation; a skipped send is just a delay.
 *
 * Configuration (Vercel env):
 *   RUNNA_MAILING_ADDRESS  required  postal address shown in every footer
 *   TOKEN_ENCRYPTION_KEY   required  (already set — also encrypts Gmail tokens);
 *                                    the unsubscribe signing key is derived from it
 *   RUNNA_SENDER_ENTITY    optional  business name, default "Rünna"
 *   RUNNA_PRIVACY_URL      optional  aviso de privacidad / privacy policy link
 *   UNSUBSCRIBE_BASE_URL   optional  public origin for the unsubscribe link,
 *                                    default NEXT_PUBLIC_APP_URL
 */

import { createHash } from "node:crypto";
import { buildComplianceFooter } from "./footer.ts";
import { signUnsubscribeToken, type UnsubscribePayload } from "./unsubscribe-token.ts";

export const UNSUBSCRIBE_PATH = "/api/unsubscribe";

export type OutboundCompliance = {
  footer: string;
  listUnsubscribe: { url: string };
};

/**
 * The HMAC key for unsubscribe links. Derived (domain-separated) from the
 * existing TOKEN_ENCRYPTION_KEY so there's no new secret to manage.
 */
export function unsubscribeSecret(): string | null {
  const base = process.env.TOKEN_ENCRYPTION_KEY;
  if (!base) return null;
  return createHash("sha256").update(`spam-unsubscribe-v1:${base}`).digest("hex");
}

function baseUrl(): string {
  const raw =
    process.env.UNSUBSCRIBE_BASE_URL ||
    process.env.NEXT_PUBLIC_APP_URL ||
    "https://spam-runnareach.vercel.app";
  return raw.replace(/\/+$/, "");
}

export function getOutboundCompliance(
  recipient: UnsubscribePayload,
): { ok: true; value: OutboundCompliance } | { ok: false; error: string } {
  const mailingAddress = process.env.RUNNA_MAILING_ADDRESS?.trim();
  if (!mailingAddress) {
    return {
      ok: false,
      error: "Sending blocked: RUNNA_MAILING_ADDRESS is not set (CASL requires a mailing address in every email).",
    };
  }
  const secret = unsubscribeSecret();
  if (!secret) {
    return { ok: false, error: "Sending blocked: TOKEN_ENCRYPTION_KEY is not set (needed to sign unsubscribe links)." };
  }

  const token = signUnsubscribeToken(recipient, secret);
  const url = `${baseUrl()}${UNSUBSCRIBE_PATH}?t=${encodeURIComponent(token)}`;
  const footer = buildComplianceFooter({
    lang: recipient.lang,
    senderEntity: process.env.RUNNA_SENDER_ENTITY?.trim() || "Rünna",
    mailingAddress,
    unsubscribeUrl: url,
    privacyUrl: process.env.RUNNA_PRIVACY_URL?.trim() || null,
  });
  return { ok: true, value: { footer, listUnsubscribe: { url } } };
}

/** Body as it actually went out, for pitches.body_sent. */
export function bodyWithFooter(body: string, footer: string): string {
  return `${body}\n\n${footer}`;
}
