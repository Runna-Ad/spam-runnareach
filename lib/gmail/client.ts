/**
 * Minimal Gmail API client.
 *
 * Two responsibilities:
 *   1. Exchange a decrypted refresh token for a short-lived access token.
 *   2. Send a multipart email via the Gmail REST API.
 *
 * Email format: multipart/alternative with text/plain + text/html parts.
 * The HTML part renders the CTA line (starting with 👉) as a styled button
 * while keeping the rest of the email plain-text-like for deliverability.
 * The text/plain fallback is identical in content — spam filters read both.
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
  /**
   * Plain-text body — line breaks (\n) preserved.
   * Lines starting with 👉 are automatically converted to a CTA button
   * in the HTML version. The plain text version is unchanged.
   */
  body: string;
  /** Optional Reply-To (defaults to fromEmail). */
  replyTo?: string;
};

export type SendEmailResult =
  | { ok: true; gmailMessageId: string; threadId?: string }
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

  const json = (await res.json()) as { id?: string; threadId?: string };
  return { ok: true, gmailMessageId: json.id ?? "", threadId: json.threadId };
}

// ── RFC 2822 builder (multipart/alternative) ─────────────────────────────────

const MIME_BOUNDARY = "==Runna_Outreach_Boundary==";

function buildRfc2822(input: SendEmailInput): string {
  const from = input.fromName
    ? `"${input.fromName.replace(/"/g, "")}" <${input.fromEmail}>`
    : input.fromEmail;
  const replyTo = input.replyTo ?? input.fromEmail;
  const date = new Date().toUTCString();
  const subject = encodeHeader(input.subject);
  const htmlBody = buildHtmlBody(input.body);

  const headers = [
    `From: ${from}`,
    `To: ${input.to}`,
    `Reply-To: ${replyTo}`,
    `Subject: ${subject}`,
    `Date: ${date}`,
    `MIME-Version: 1.0`,
    `Content-Type: multipart/alternative; boundary="${MIME_BOUNDARY}"`,
  ].join("\r\n");

  const textPart = [
    `--${MIME_BOUNDARY}`,
    `Content-Type: text/plain; charset=UTF-8`,
    `Content-Transfer-Encoding: quoted-printable`,
    ``,
    encodeQP(input.body),
  ].join("\r\n");

  const htmlPart = [
    `--${MIME_BOUNDARY}`,
    `Content-Type: text/html; charset=UTF-8`,
    `Content-Transfer-Encoding: quoted-printable`,
    ``,
    encodeQP(htmlBody),
  ].join("\r\n");

  const closing = `--${MIME_BOUNDARY}--`;

  return `${headers}\r\n\r\n${textPart}\r\n\r\n${htmlPart}\r\n\r\n${closing}`;
}

// ── HTML body builder ─────────────────────────────────────────────────────────

/**
 * Converts the plain-text pitch body into a minimal HTML email.
 * The email looks like a plain-text message — no images, no complex layout —
 * but lines starting with 👉 are rendered as a styled CTA button.
 *
 * Deliverability notes:
 * - No tracking pixels, no external images
 * - Minimal inline CSS only (no external stylesheets)
 * - multipart/alternative means spam filters score the plain-text part too
 */
function buildHtmlBody(plainText: string): string {
  const lines = plainText.split("\n");
  const htmlLines: string[] = [];

  for (const line of lines) {
    const trimmed = line.trim();

    // CTA line — render as button
    if (trimmed.startsWith("👉")) {
      const withoutEmoji = trimmed.replace(/^👉\s*/, "");
      // Extract the URL (last token that starts with http)
      const urlMatch = withoutEmoji.match(/https?:\/\/\S+$/);
      const url = urlMatch ? urlMatch[0] : null;
      const descriptionText = url ? withoutEmoji.replace(url, "").replace(/[:\s—–-]+$/, "").trim() : withoutEmoji;

      if (url) {
        // Button text: use a short action phrase
        const buttonText = deriveButtonText(descriptionText);
        // Render: description text above (if any), then button
        if (descriptionText) {
          htmlLines.push(`<p style="margin: 16px 0 8px;">${escapeHtml(descriptionText)}</p>`);
        }
        htmlLines.push(
          `<p style="margin: 8px 0 16px;">` +
          `<a href="${escapeHtml(url)}" ` +
          `style="display: inline-block; padding: 11px 22px; background-color: #18181b; ` +
          `color: #ffffff; text-decoration: none; border-radius: 6px; font-size: 14px; ` +
          `font-weight: 500; letter-spacing: -0.01em; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;">` +
          `${escapeHtml(buttonText)}` +
          `</a></p>`,
        );
      } else {
        // No URL found — render as plain line
        htmlLines.push(`<p style="margin: 8px 0;">${escapeHtml(withoutEmoji)}</p>`);
      }
      continue;
    }

    // Empty line — paragraph break (skip, handled by paragraph wrapping)
    if (trimmed === "") {
      htmlLines.push(`<p style="margin: 0; line-height: 1.6;">&nbsp;</p>`);
      continue;
    }

    // Regular line
    htmlLines.push(`<p style="margin: 0; line-height: 1.6;">${escapeHtml(trimmed)}</p>`);
  }

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
</head>
<body style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Arial, sans-serif; color: #1a1a1a; max-width: 560px; margin: 0 auto; padding: 24px 20px; font-size: 15px; background: #ffffff;">
${htmlLines.join("\n")}
</body>
</html>`;
}

/** Derive a short action-oriented button label from the CTA description text. */
function deriveButtonText(description: string): string {
  const lower = description.toLowerCase();
  // Spanish
  if (lower.includes("gratis") || lower.includes("diagnóstico") || lower.includes("auditoría") || lower.includes("auditoria")) {
    return "Ver diagnóstico gratis →";
  }
  if (lower.includes("fugas") || lower.includes("pierde") || lower.includes("número")) {
    return "Ver diagnóstico gratis →";
  }
  // English
  if (lower.includes("audit") || lower.includes("leak") || lower.includes("losing")) {
    return "Run free audit →";
  }
  if (lower.includes("number") || lower.includes("revenue")) {
    return "See your store's number →";
  }
  // Fallback
  return "Run free audit →";
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** Encode a header value as RFC 2047 UTF-8 base64 if it contains non-ASCII. */
function encodeHeader(value: string): string {
  // eslint-disable-next-line no-control-regex
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
