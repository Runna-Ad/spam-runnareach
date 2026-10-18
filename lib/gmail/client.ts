/**
 * Minimal Gmail API client.
 *
 * Two responsibilities:
 *   1. Exchange a decrypted refresh token for a short-lived access token.
 *   2. Send a multipart email via the Gmail REST API.
 *
 * The message itself (headers, quoted-printable parts, HTML rendering, footer,
 * List-Unsubscribe) is built by the pure, unit-tested ./mime.ts.
 */

import { decryptToken } from "./crypto";
import { buildRfc2822, type MimeMessageInput } from "./mime.ts";

const TOKEN_ENDPOINT = "https://oauth2.googleapis.com/token";
const GMAIL_SEND_URL = "https://gmail.googleapis.com/gmail/v1/users/me/messages/send";
const TOKEN_TIMEOUT_MS = 10_000;

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

  let res: Response;
  try {
    res = await fetch(TOKEN_ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: clientId,
        client_secret: clientSecret,
        refresh_token: refreshToken,
        grant_type: "refresh_token",
      }),
      // A hung token call must not eat a cron's whole maxDuration.
      signal: AbortSignal.timeout(TOKEN_TIMEOUT_MS),
    });
  } catch (err) {
    return { ok: false, error: `Token refresh failed: ${(err as Error).name === "TimeoutError" ? `timed out after ${TOKEN_TIMEOUT_MS / 1000}s` : (err as Error).message}` };
  }

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

export type SendEmailInput = MimeMessageInput & {
  accessToken: string;
  /**
   * Gmail thread ID. When set, the message is appended to the existing thread;
   * pair it with originalMessageId (the RFC 5322 Message-ID) for client threading.
   */
  threadId?: string;
};

export type SendEmailResult =
  | { ok: true; gmailMessageId: string; threadId?: string }
  | { ok: false; error: string };

export async function sendGmailMessage(input: SendEmailInput): Promise<SendEmailResult> {
  const raw = buildRfc2822(input);
  const encoded = Buffer.from(raw).toString("base64url");

  // When replying in-thread, pass threadId to the Gmail API so the message is
  // grouped with the original conversation.
  const requestBody: { raw: string; threadId?: string } = { raw: encoded };
  if (input.threadId) requestBody.threadId = input.threadId;

  const res = await fetch(GMAIL_SEND_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${input.accessToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(requestBody),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    return { ok: false, error: `Gmail send failed (${res.status}): ${body.slice(0, 300)}` };
  }

  const json = (await res.json()) as { id?: string; threadId?: string };
  return { ok: true, gmailMessageId: json.id ?? "", threadId: json.threadId };
}
