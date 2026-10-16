/**
 * Everything a prospect-facing send needs to be CASL-compliant: the footer text
 * and the List-Unsubscribe target, built from configuration.
 *
 * FAILS CLOSED. Without a mailing address (or the key that signs unsubscribe
 * links) this returns an error and the caller must not send. A cold email
 * without them is a CASL violation; a skipped send is just a delay.
 *
 * The sender's details are public business information (they're printed in
 * every email), so they live here as defaults; any of them can be overridden
 * with a Vercel env var without a deploy of new code:
 *   RUNNA_MAILING_ADDRESS   postal address
 *   RUNNA_SENDER_ENTITY     business name
 *   RUNNA_WEBSITE_EN / _ES  website shown on English / Spanish emails
 *   RUNNA_CONTACT_EMAIL     contact email
 *   RUNNA_PRIVACY_URL       aviso de privacidad (Spanish emails)
 *   UNSUBSCRIBE_BASE_URL    public origin for the unsubscribe link (default NEXT_PUBLIC_APP_URL)
 * TOKEN_ENCRYPTION_KEY (already set — it also encrypts Gmail tokens) is
 * required: the unsubscribe signing key is derived from it.
 */

import { createHash } from "node:crypto";
import { buildComplianceFooter } from "./footer.ts";
import { signUnsubscribeToken, type UnsubscribePayload } from "./unsubscribe-token.ts";

export const UNSUBSCRIBE_PATH = "/api/unsubscribe";

/** Provided by Pedro, 2026-10-16. */
export const SENDER_DEFAULTS = {
  entity: "Rünna",
  mailingAddress: "Tizapán San Ángel, Loreto y Campamento, Álvaro Obregón, 01090 Mexico City, Mexico",
  websiteEn: "runnik.ca",
  websiteEs: "runna.com.mx",
  contactEmail: "hola@runna.mx",
  privacyUrl: "https://runna.com.mx/avisop",
} as const;

/** Env override if set (an empty value counts as "use the default"). */
function env(name: string, fallback: string): string {
  return process.env[name]?.trim() || fallback;
}

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
  const mailingAddress = env("RUNNA_MAILING_ADDRESS", SENDER_DEFAULTS.mailingAddress);
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
    senderEntity: env("RUNNA_SENDER_ENTITY", SENDER_DEFAULTS.entity),
    mailingAddress,
    website:
      recipient.lang === "es"
        ? env("RUNNA_WEBSITE_ES", SENDER_DEFAULTS.websiteEs)
        : env("RUNNA_WEBSITE_EN", SENDER_DEFAULTS.websiteEn),
    contactEmail: env("RUNNA_CONTACT_EMAIL", SENDER_DEFAULTS.contactEmail),
    unsubscribeUrl: url,
    privacyUrl: env("RUNNA_PRIVACY_URL", SENDER_DEFAULTS.privacyUrl),
  });
  return { ok: true, value: { footer, listUnsubscribe: { url } } };
}

/** Body as it actually went out, for pitches.body_sent. */
export function bodyWithFooter(body: string, footer: string): string {
  return `${body}\n\n${footer}`;
}
