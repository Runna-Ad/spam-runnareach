/**
 * Minimal Gmail API client.
 *
 * Two responsibilities:
 *   1. Exchange a decrypted refresh token for a short-lived access token.
 *   2. Send a plain-text email via the Gmail REST API.
 *
 * Plain text only — HTML emails from cold outreach domains score higher for
 * spam. The "preview text" lives in the subject/opening line naturally.
 */

import { decryptToken } from "./crypto";

const TOKEN_ENDPOINT = "https://oauth2.googleapis.com/token";
const GMAIL_SEND_URL = "https://gmail.googleapis.com/gmail/v1/users/me/messages/send";

// ── Access token exchange ─────────────────────────────────────────────────────

export type AccessTokenResult =
  | { ok: true; accessToken: string }
  | { ok: false; error: string };

export async function getAccessToken(
  encryptedRefreshToken: string,
): Promise<AccessTokenResult> {
  const clientId = process.env.GOOGLE_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    return { ok: false, error: "GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET not set." };
  }

  let refreshToken: string;
  try {
    refreshToken = decryptToken(encryptedRefreshToken);
  } catch {
    return { ok: false, error: "Could not decrypt refresh token." };
  }

  const res = await fetch(TOKEN_ENDPOINT, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      refresh_token: refreshToken,
      grant_type: "refresh_token",
    }),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    return { ok: false, error: `Token refresh failed (${res.status}): ${body.slice(0, 200)}` };
  }

  const json = (await res.json()) as { access_token?: string; error?: string };
  if (!json.access_token) {
    return { ok: false, error: `Token response missing access_token: ${json.error ?? "unknown"}` };
  }

  return { ok: true, accessToken: json.access_token };
}

// ── Send email ────────────────────────────────────────────────────────────────

export type SendEmailInput = {
  accessToken: string;
  /** The Gmail address authorised to send (inbox.email). */
  fromEmail: string;
  /** Display name shown to recipient, e.g. "Pedro De Velasco". */
  fromName: string;
  /** Recipient email address. */
  to: string;
  subject: string;
  /** Plain-text body — line breaks (\n) preserved. */
  body: string;
  /** Optional Reply-To (defaults to fromEmail). */
  replyTo?: string;
};

export type SendEmailResult =
  | { ok: true; gmailMessageId: string }
  | { ok: false; error: string };

export async function sendGmailMessage(input: SendEmailInput): Promise<SendEmailResult> {
  const raw = buildRfc2822(input);
  const encoded = Buffer.from(raw).toString("base64url");

  const res = await fetch(GMAIL_SEND_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${input.accessToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ raw: encoded }),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    return { ok: false, error: `Gmail send failed (${res.status}): ${body.slice(0, 300)}` };
  }

  const json = (await res.json()) as { id?: string };
  return { ok: true, gmailMessageId: json.id ?? "" };
}

// ── RFC 2822 builder ──────────────────────────────────────────────────────────

function buildRfc2822(input: SendEmailInput): string {
  const from = input.fromName
    ? `"${input.fromName.replace(/"/g, "")}" <${input.fromEmail}>`
    : input.fromEmail;
  const replyTo = input.replyTo ?? input.fromEmail;
  const date = new Date().toUTCString();

  // Encode subject as UTF-8 quoted-printable if it has non-ASCII chars
  const subject = encodeHeader(input.subject);

  const headers = [
    `From: ${from}`,
    `To: ${input.to}`,
    `Reply-To: ${replyTo}`,
    `Subject: ${subject}`,
    `Date: ${date}`,
    `MIME-Version: 1.0`,
    `Content-Type: text/plain; charset=UTF-8`,
    `Content-Transfer-Encoding: quoted-printable`,
  ].join("\r\n");

  const body = encodeQP(input.body);
  return `${headers}\r\n\r\n${body}`;
}

/** Encode a header value as RFC 2047 UTF-8 base64 if it contains non-ASCII. */
function encodeHeader(value: string): string {
  if (/^[\x00-\x7F]*$/.test(value)) return value; // pure ASCII — no encoding needed
  return `=?UTF-8?B?${Buffer.from(value, "utf8").toString("base64")}?=`;
}

/**
 * Minimal quoted-printable encoder for plain text bodies.
 * Encodes non-ASCII bytes and lines longer than 76 chars.
 */
function encodeQP(text: string): string {
  // Encode each line independently
  return text
    .split("\n")
    .map((line) => {
      // Encode non-ASCII and special QP chars byte by byte
      let encoded = "";
      for (const char of line) {
        const code = char.codePointAt(0) ?? 0;
        if (code > 127 || char === "=") {
          // Multi-byte: encode each byte
          const bytes = Buffer.from(char, "utf8");
          for (const byte of bytes) {
            encoded += `=${byte.toString(16).toUpperCase().padStart(2, "0")}`;
          }
        } else {
          encoded += char;
        }
      }
      // Soft line breaks at 76 chars
      return wrapQP(encoded);
    })
    .join("\r\n");
}

function wrapQP(line: string): string {
  if (line.length <= 76) return line;
  const chunks: string[] = [];
  let i = 0;
  while (i < line.length) {
    if (i + 76 >= line.length) {
      chunks.push(line.slice(i));
      break;
    }
    chunks.push(line.slice(i, i + 75) + "=");
    i += 75;
  }
  return chunks.join("\r\n");
}
